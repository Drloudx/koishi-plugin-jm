# 技术说明

面向需要修改或二次开发本插件的人。日常使用不需要阅读本文。

> 本文中涉及下载与解密的部分，均基于
> [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python)（`jmcomic`，MIT，[@hect0x7](https://github.com/hect0x7)）的既有实现。
> 本文记录的是**如何正确使用它**，而非重新实现。

## 目录

- [图片解密](#图片解密)
- [PDF 体积控制](#pdf-体积控制)
- [网络与 SSL](#网络与-ssl)
- [APP API](#app-api)
- [部分失败与补页](#部分失败与补页)
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
