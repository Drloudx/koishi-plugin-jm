# 技术说明

面向需要修改或二次开发本插件的人。日常使用不需要阅读本文。

> 本文中涉及下载与解密的部分，均基于
> [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python)（`jmcomic`，MIT，[@hect0x7](https://github.com/hect0x7)）的既有实现。
> 本文记录的是**如何正确使用它**，而非重新实现。

## 目录

- [图片解密](#图片解密)
- [PDF 体积控制](#pdf-体积控制)
- [网络与 SSL](#网络与-ssl)
- [域名与连接复用](#域名与连接复用性能关键)
- [APP API](#app-api)
- [部分失败与补页](#部分失败与补页)
- [停止下载](#停止下载)
- [文件名降级策略](#文件名降级策略)
- [本地文件发送](#本地文件发送)
- [性能优化](#性能优化)
- [Koishi 插件约定](#koishi-插件约定)

---

## 图片解密

JM 源站的图片经过「横向切片重排」加密，需要按 `scramble_id` 还原。

`jmcomic` 中 `decode` 参数控制这一行为：

| 取值 | 行为 | 结果 |
| --- | --- | --- |
| `decode=True` | 走 `decode_and_save`，按 `scramble_id` 还原 | 正常图片 |
| `decode=False` | 走 `save_directly`，直接落盘乱序字节 | 图片错位，不可用 |

使用 `decode=False` 时实测 PSNR 9.8 dB / SSIM 0.14，肉眼可见严重错位。

> **这是解密开关，不是压缩开关。** 早期误将其理解为压缩选项，导致一批体积测试数据作废。

## PDF 体积控制

`img2pdf` 对不同图片格式的处理方式差异很大：

| 输入格式 | 131 页 PDF 体积 | 原因 |
| --- | --- | --- |
| webp | 73 MB | 内部先转为无损 PNG 再嵌入 |
| **jpg** | **9 MB** | 直接嵌入原始 JPEG 字节 |

因此下载时固定使用 `suffix='.jpg'`，让源图转为 JPEG 后再交给 `img2pdf`。

画质代价实测 PSNR 40.4 dB / SSIM 0.9992 —— 超过 40 dB 即视为视觉无损。

最终配置：

```python
IMAGE_CFG = {'decode': True, 'suffix': '.jpg'}
```

### 体积估算基准

实测范围 70~150 KB/页，不同作品画质差异可达 2 倍。

代码中取 **160 KB/页**（保守值）：宁可高估触发「超限」提示，也不要低估导致下载完成后才发现发不出去。

## 网络与 SSL

### 强制关闭 SSL 验证

`jm_bridge.py` 中 monkey-patch 了 `curl_cffi` 的 `Session.request`：

```python
_orig_request = cffi_req.Session.request

def _patched_request(self, method, url, *args, **kwargs):
    kwargs.setdefault('verify', False)
    return _orig_request(self, method, url, *args, **kwargs)

cffi_req.Session.request = _patched_request
```

**原因**：部分环境下 `curl_cffi` 读取 certifi 的 `cacert.pem` 失败，报 `curl: (77) error adding trust anchors`。

如果你的环境证书正常，这段代码保留也无害。

### 关闭域名自动更新

```python
jmcomic.JmModuleConfig.FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = False
```

`jmcomic` 会定期从 `bytepluses.com` 拉取新域名。该地址在部分网络环境下不可达，不关闭会导致启动阶段长时间阻塞。

**但仅仅关闭是不够的**，见下节。

## 域名与连接复用（性能关键）

这两个问题曾让一个 25 页的章节从 32 秒劣化到 381 秒，务必理解。

### 问题一：坏域名混在列表里，且顺序随机

`jmcomic` 内置的 `DOMAIN_API_LIST` 本身就**包含**那个连不通的域名：

```python
# jm_config.py L198，实际是用 shuffled(...) 处理的
DOMAIN_API_LIST = shuffled('''
    www.cdnhjk.net
    www.cdngwc.cc      ← 实测必挂（20s 超时 / HTTP 522）
    www.cdngwc.net
    www.cdngwc.club
''')
```

注意 `shuffled()` 是 `random.shuffle`，**每次启动顺序都不一样**（实测 5 次加载，5 种顺序）。
所以这不是「某个域名总在第一位」，而是：

> **4 个域名里 1 个是坏的，而 `retry_times=5`，于是每个请求都有概率先撞上它，
> 一撞就是 6 次 × 20 秒 ≈ 120 秒。**

这解释了两个现象：

- **为什么时快时慢**：坏域名排得靠前就慢，排得靠后就快
- **为什么同样代码昨天 13s、今天 354s**：`shuffled()` 每次进程启动重新洗牌

`request_with_retry` 的策略是「同一域名重试 `retry_times` 次再换下一个域名」，默认 `retry_times=5`。
最坏情况（坏域名排第一）：`6 × 20 秒 ≈ 120 秒/请求`，多来几个请求就上了 300 秒。

**做法**：启动时并发探测候选域名，只保留真正能通的，按延迟排序后显式传给 `client.domain`，
同时把 `retry_times` 从 5 降到 2。

```python
'client': {'domain': [...], 'retry_times': 2}
```

探测用 `/setting` 接口，超时 8 秒，只要 HTTP 状态 < 500 就算活。全部不通时退回默认列表
（宁可慢也不要直接失败）。

> 顺带说明：`www.cdngwc.cc` 不在 `DOMAIN_API_LIST` 里这种说法是**错的**——它一直在里面。
> 关掉 `FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN` 只是不再从 `bytepluses.com` 拉「更新列表」
> （那个地址在本机连不上），并不会把坏域名从内置列表里去掉。

### 问题二：`postman` 不复用连接（影响最大）

`jmcomic` 的 postman 有两个容易混淆的取值：

| 配置值 | 实现类 | 行为 |
| --- | --- | --- |
| `curl_cffi` | `CurlCffiPostman` | 调用**模块级** `curl_cffi.requests.get()`，**每次新建连接** |
| `curl_cffi_session` | `CurlCffiSessionPostman` | 持有 `Session`，**连接池复用** |

默认配置给的是 `curl_cffi`，意味着**每张图片都要重新握手**。实测单次冷连接固定吃
6~21 秒（TLS 握手 + 代理链路），连接一旦复用后续每张仅 0.35~0.66 秒。

同一批图片的对比：

| postman | 建连 | `get_photo_detail` | 连取 8 张图 |
| --- | --- | --- | --- |
| `curl_cffi` | 6.75s | 21.96s | **59.28s（7.41s/张）** |
| `curl_cffi_session` | 0.00s | 6.79s | **10.44s（1.30s/张）** |

**必须用 `curl_cffi_session`。** 它把「每张图付一次握手」变成「整个任务只付一次」，
实测 25 页章节的下载耗时 381.7s → 10.5s。

这也解释了为什么同样的代码「有时快有时慢」：**网络好时握手快，网络差时握手慢，
而旧配置把这个波动乘以了页数**。

## APP API

客户端配置使用 `impl: 'api'`，即移动端接口：

```python
{
    'client': {
        'impl': 'api',
        'domain': [],
        'postman': {'type': 'curl_cffi', 'meta_data': {'impersonate': 'chrome'}},
    },
}
```

相比网页版：

- **没有 Cloudflare 人机验证**
- **不需要 cookie**
- **不需要登录**

这是本方案能够在一般网络环境下跑通的关键前提 —— 网页版基本都会被 Cloudflare 拦截。

## 部分失败与补页

`jmcomic` 的 `download_photo()` 默认 `check_exception=True`，会在 `after_photo`
（即 img2pdf 生成 PDF）**之后**调用 `raise_if_has_exception()`。只要有一张图失败，
就抛 `PartialDownloadFailedException`。

问题在于**执行顺序**：

```
photo（214 页）
  ├─ 下载 212 页成功、2 页失败
  ├─ after_photo → img2pdf 用这 212 张图生成了完整 PDF  ✓
  └─ raise_if_has_exception() → 抛异常  ✗
```

结果是 **PDF 已经生成好了，但异常把成功结果掩盖了**，插件误报「下载失败」，
什么都不发。实测遇到过：214 页的作品，113.9 MB 的 PDF 已完整落盘，
用户却收到「下载失败：部分下载失败」。

### 处理方式

改为 `check_exception=False`，拿到 `DownloadResult` 后自行检查
`downloader.download_failed_image`：

1. 无失败 → 直接返回成功
2. 有失败 → 对失败的那几张图**逐页重试**（每页最多 3 轮，间隔递增）
3. 补回若干页 → **重新生成 PDF**（否则 PDF 里仍是缺页的旧版本）
4. 仍有缺页 → 如实返回 `missingPages`，由插件提示用户

关键点：

- 补页只重下失败的那几张，不重下整章
- 补页调用的是 `client.download_by_image_detail(image, image.save_path)`，
  `decode_image` 默认 `True`，与首次下载一致
- 页数用 PDF 内 `/Type /Page` 计数，且必须减去 `/Type /Pages`（页面树节点），
  否则会多算 1
- 重新生成 PDF 复用 `Img2pdfPlugin`，保证输出路径与首次一致

实测效果：注入 2 页瞬时失败 → 补回 2 页 → 14/14 页完整，`missingPages=0`；
注入 2 页永久失败 → 3 轮重试全败 → 如实返回 `pages=12/14, missingPages=2`。

## 停止下载

### 为什么不能直接 `child.kill()`

插件用 `spawn` 起 Python 桥接脚本，而 Python 内部还有下载线程池（`threading.image = 16`）。
Node 的 `child.kill()` 在 Windows 上**只结束 `python.exe` 本身**，它派生的线程/子进程可能
变成孤儿继续占用网络和临时目录。

实测：执行 `child.kill()` 前后各查一次进程，能从 2 个进程清到 0 个——但这依赖进程处于
「尚未真正进入下载」的状态。一旦进入多线程下载，就必须按进程树处理。

### 做法

Windows 上用 `taskkill /pid <pid> /T /F`，其中 `/T` 是「连子进程一起杀」：

```js
function killTree(child) {
  if (!child || child.killed) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      })
    } else {
      try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
  } catch {}
}
```

非 Windows 用 `detached: true` + 负 PID 杀整个进程组。

### 任务登记

`busy` 从 `Set` 改成 `Map`，把子进程句柄挂到任务上，`/jm 停止` 才找得到它：

```js
busy.set(sessionKey, { albumId, chapter, userId, startedAt, child, cancelled })
```

列表查询阶段同样登记（网络差时列表查询也能跑几百秒），所以那个阶段也能停。

### 取消后的处理

点了停止后，子进程被杀 → `runBridge` 会 **reject**（桥接脚本无输出、exit≠0）。
这意味着 `await runBridge(...)` **直接跳进 `catch`**，写在 `await` 之后的
`if (task.cancelled)` 判断**根本执行不到**。

所以 `task.cancelled` 的判断必须放在 **`catch` 里**（放 `try` 里只覆盖「正常返回」这一条路径）：

```js
} catch (e) {
  if (task.cancelled) {           // ← 必须在这里
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
    return '已停止下载'
  }
  logger.warn('[下载] 异常 ...')
  return '下载失败：' + (e && e.message)
}
```

列表查询那个 `catch` 同理。取消时还要顺手删掉半截的临时目录。

> 这个 bug 实测表现：点停止后 368ms 就结束了（说明杀进程是成功的），
> 但用户收到的却是「下载失败：桥接脚本无输出 (exit=1)」。

### 验证方法

**两层都要测**，只测其中一层会漏：

1. **桥接层**（Python）：直接跑 `jm_bridge.py`，看 JSON 输出对不对
2. **命令层**（JS）：起一个 mock `ctx` 加载插件、真的驱动 `/jm` 命令

本次 `busy.set is not a function`（把 `Set` 改成 `Map` 却漏改声明）就是
**只测了桥接层**导致的——Python 那边全绿，JS 一进命令就崩。命令层测试的最小骨架：

```js
const ctx = {
  logger: () => logger,
  setInterval: () => () => {},
  middleware: () => {},   // 缺这个会报 ctx.middleware is not a function
  command() {
    const c = { usage(){return c}, example(){return c}, action(fn){ action = fn; return c } }
    return c
  },
}
await require('./lib/index.js').apply(ctx, cfg)
await action({ session, ... }, '350234', undefined)
```

判定「是否真的停了」不能只看进程是否消失，要看**文件是否还在增长**：

```
download active: 2.86 MB @ 25.0s
killTree() issued
  +2s: 3.35 MB   ← 已发出的请求正在落盘（缓冲）
  +4s: 3.35 MB
  +8s: 3.35 MB   ← 零增长 → 真的停了
```

⚠️ **必须跳过 kill 后头 2 秒再判定**。第一次测试时用「kill 后是否增长」直接判定，
得到了 2334 KB 的增长并误判为 FAIL，实际那是进程被杀的瞬间、已经下发的请求在落盘，
2 秒后就完全静止了。

## 文件名降级策略

QQ 群文件对文件名有两类限制，表现都是 `retcode: 100`，但原因完全不同：

| 错误码 | 含义 | 触发条件 |
| --- | --- | --- |
| `-303` | 文件名称格式错误 | 文件名过长（实测 80 字通过、90 字被拒） |
| `-134` | 文件上传失败 | 命中敏感词黑名单 |

### 敏感词是整串匹配

这一点非常隐蔽。以「少女與觸手編織出愛」为例：

| 测试 | 结果 |
| --- | --- |
| `少女與觸手` | 通过 |
| `少女與觸手編織出愛` | **被拒** |
| 单独 `編` / `織` / `出` / `愛` | 通过 |
| 换掉任意一个字 | 通过 |
| 中性长文件名（29 字） | 通过 |

拆开、单字、替换任一字符都能通过，**只有原样连在一起才被拒绝**。

因此这不是长度问题，也无法通过改写单个字符绕过，只能使用中性文件名。

### 三级降级

```
1. 原始文件名（截断至 80 字）
2. 去掉方括号与多余空格（截断至 80 字）
3. 中性名：单本 JM259194.pdf / 连载 JM259194_第2话.pdf
```

按顺序尝试，第一个成功的即采用。正常作品在第一步就通过，保留完整标题。

## 本地文件发送

兜底走「消息附件」时，必须使用 `file://` 协议：

```js
h.file('file:///' + pdfPath.replace(/\\/g, '/'), { title: fileName })
```

**不能**直接传本地路径：

```js
h.file(pdfPath)  // ✗ 会失败
```

原因在 OneBot 适配器：

```js
const file = src.startsWith("file:")
  ? fileURLToPath(src)
  : await this.bot.internal.downloadFile(src)
```

传入本地路径时 `src` 不以 `file:` 开头，适配器会把它当作 **URL** 去 `downloadFile`，必然失败（日志中表现为 `download_file ... retcode: 100`）。

### 不允许静默失败

早期版本在兜底分支抛出的异常被外层 `catch` 吞掉后，代码继续执行到成功路径，导致**上传失败却回复「已发送」**。

现在的实现要求：兜底分支单独 try/catch 并设置 `sent` 标志，最后统一判断 —— 失败必须如实返回错误信息。

## 性能优化

初版章节查询耗时 32 秒，经三处优化降至 13 秒。

### 耗时分解

| 阶段 | 原耗时 | 问题 |
| --- | --- | --- |
| 构建 client | 6.1s | `JmOption.default()` 是 web 模式，需调用 `/setting` 获取 cookie |
| `photo_detail` | 18.0s | 仅为获取页数，却附带请求了 album 与 scramble_id |

### 三处改动

**1. 查询改用轻量 option**

```python
def build_list_option():
    return jmcomic.JmOption.construct({
        'client': {'impl': 'api', 'domain': [],
                   'postman': {'type': 'curl_cffi', 'meta_data': {'impersonate': 'chrome'}}},
    })
```

使用 api 模式，跳过 `/setting` 调用。

**2. 单章作品直接用 `album.page_count`**

单话作品的总页数就是该章节的页数，完全不需要调用 `photo_detail`。

**3. 多章关闭附带请求**

```python
client.get_photo_detail(pid, False, False)
```

后两个参数分别关闭 `fetch_album` 与 `fetch_scramble_id`，并发数提升至 `min(n_ch, 8)`。

### 优化结果

| 场景 | 优化前 | 优化后 |
| --- | --- | --- |
| 单章 | 31.9s | **13.3s** |
| 双章 | 30.5s | **21.3s** |
| 10 章 | 12.8s | 12.8s |

页数结果全部一致，无精度损失。剩余耗时主要是网络往返延迟。

## Koishi 插件约定

### 「静默」返回什么？

想让命令**什么都不回复**，返回**空串 `''`** 是安全的，实测链路：

```
action 返回 ''  →  h.normalize('') 得到 0 个元素  →  session.send() 里 `if (!elements.length) return`
```

即**不会发出任何消息，也不会进 Koishi 的「未响应」告警分支**，日志干净。

⚠️ 注意 `cosmokit` 的 `isNullable('')` 是 **`false`**（只有 `undefined`/`null` 才为 true），
所以别以为「返回空串 = 没返回」；但在 `session.send()` 这一层空串会被正确吞掉。

### 群白名单：别用 channelId 判断是不是群

私聊时 `session.channelId` 是**用户 QQ 号**，也是纯数字。用 `channelId` 做群判断会把私聊
误伤成「群」并被白名单拦掉。

正确判据是 **`session.guildId`**：群聊才有 `guildId`，私聊没有。

```js
if (!session.guildId) return true        // 私聊放行
return ids.includes(String(session.guildId))   // 群聊按群号比对
```

白名单还要覆盖**两条入口**，否则会漏：

1. 命令 `.action()` —— `jm 350234`
2. `ctx.middleware()` —— 列表发出后用户回复的裸数字 `1`

middleware 那条记得用 `return next()` 放行（别的插件可能还要处理这条消息），
而不是 `return ''`。

### Config 必须是 Schema

```js
const Config = Schema.object({ ... })  // ✓
const Config = { ... }                 // ✗ 报 schema is not a function
```

### 不要声明用不到的 inject

```js
inject: ['http']  // 若实际未使用 http，在缺少该服务的环境中整个 apply 不会执行
```

这种情况下**命令不会注册，且没有任何报错**，极难排查。同理，`package.json` 中的 `koishi.service.required` 也要与实际情况一致。

### 打包分发注意事项

**1. `files` 白名单会漏文件**

```json
"files": ["lib", "jm_bridge.py", "requirements.txt", "README.md"]
```

只写 `["lib"]` 会导致 `jm_bridge.py` 不进包，安装后必然报「找不到桥接脚本」。
打包前请用 `npm pack --dry-run` 核对清单。

**2. `__dirname` 的层级**

安装后 `__dirname` 指向 `<pkg>/lib`，取包根目录需要：

```js
const pluginRoot = path.resolve(__dirname, '..')
```

**3. 默认值不能包含本机绝对路径**

```js
.default('D:\\my-machine\\venv\\python.exe')  // ✗ 别人装了跑不起来
```

分发版本改为自动探测（配置 → `JM_PYTHON` → 插件目录 `.venv` → 项目 `.venv` → PATH）。
