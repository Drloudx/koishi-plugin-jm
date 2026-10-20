# koishi-plugin-jm

![version](https://img.shields.io/badge/version-1.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![koishi](https://img.shields.io/badge/koishi-%5E4.18.0-orange)
![python](https://img.shields.io/badge/python-3.9%2B-3776AB?logo=python&logoColor=white)

在 [Koishi](https://koishi.chat) 里按章节下载禁漫（JMComic），自动转成 PDF 发到群里。

发一个作品编号，机器人回章节列表（页数 + 预估体积），回复序号就把那一章下下来发出去。

> 本插件本身只做「指令交互 + 调起子进程 + 发送文件」。
> 实际的下载与解密能力来自 **[JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python)**（`jmcomic`），版权归 [@hect0x7](https://github.com/hect0x7) 所有，MIT 许可。

```
用户   jm 350234
机器人 📖 董卓 上+下
       🆔 JM350234 · 2 章 · 50 页 · 孫笑川/薑萍

       1. 第1话  25页 ≈3.9MB
       2. 第2话  25页 ≈3.9MB

       回复序号选择章节，例如：jm 350234 2

用户   2
机器人 正在下载第 2 章，请稍候…（可能需要 1 分钟）
       《董卓 上+下》第 2 话 已发送（3.48 MB，26 页）
```

单话作品会跳过列表直接下载。

## 目录

- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [技术说明](#技术说明)
- [已知限制](#已知限制)
- [致谢](#致谢)
- [免责声明](#免责声明)
- [许可](#许可)

## 特性

- **两步交互** — 先看章节列表，再选章节，避免下错
- **体积预估** — 列表里直接显示每章页数和预估体积，超限的会标 ⚠️
- **单话直达** — 只有一章的作品自动跳过列表
- **文件名自适应** — 遇到 QQ 的文件名限制会自动降级重试，不会静默失败
- **自动清理** — 临时文件默认保留 2 小时后删除
- **零配置可用** — Python 解释器路径自动探测，装完就能跑

## 环境要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 18 |
| Koishi | ^4.18.0 |
| Python | ≥ 3.9 |

Python 侧需要三个包，实测通过的版本：

| 包 | 版本 | 出处 |
| --- | --- | --- |
| [`jmcomic`](https://github.com/hect0x7/JMComic-Crawler-Python) | 2.7.9 | 禁漫下载核心库（MIT） |
| [`img2pdf`](https://gitlab.mister-muffin.de/josch/img2pdf) | 0.6.3 | 图片转 PDF（LGPL-3.0） |
| [`curl_cffi`](https://github.com/lexiforest/curl_cffi) | 0.16.3 | HTTP 客户端（MIT） |

## 安装

### 1. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

或手动安装：

```bash
pip install jmcomic img2pdf curl_cffi
```

建议装在虚拟环境里，避免污染系统 Python。

### 2. 安装插件

```bash
npm install koishi-plugin-jm
```

或从本地 tgz 安装：

```bash
npm install ./koishi-plugin-jm-1.1.0.tgz
```

### 3. 启用插件

编辑 `koishi.yml`，在 `plugins:` 下添加：

```yaml
plugins:
  jm:jm001: {}
```

其余全部使用默认值即可。

### 4. 重启 Koishi

日志中出现下面这行表示加载成功：

```
jm 加载完成 python=... bridge=... workDir=...
```

## 使用

| 指令 | 作用 |
| --- | --- |
| `jm <编号>` | 查看章节列表 |
| `jm <编号> <章节>` | 直接下载指定章节 |
| `<数字>` | 列表发出后 1 分钟内，直接回复序号 |

> **关于 `/` 前缀**
>
> 指令名是 `jm`，带不带 `/` 取决于你的 Koishi 全局 `prefix` 配置。
> 默认 `prefix: ['']`（空串）表示不需要斜杠；配置了 `/` 之后 `/jm 350234` 也能用。

## 配置

所有配置项都可以留空，留空即使用默认值。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonPath` | 自动探测 | Python 解释器路径 |
| `bridgePath` | 包内自带 | `jm_bridge.py` 路径，一般不用改 |
| `workDir` | 系统临时目录 | 下载中转目录 |
| `maxSizeMB` | `100` | 单个 PDF 上限（MB），超出则拒绝发送 |
| `cacheMinutes` | `1` | 章节列表有效期（分钟） |
| `timeoutSeconds` | `600` | 单次下载超时（秒） |
| `keepHours` | `2` | 临时文件保留时间（小时） |
| `cleanIntervalMinutes` | `30` | 清理任务间隔（分钟） |

### pythonPath 探测顺序

按顺序查找，使用第一个存在的：

1. 配置项 `pythonPath`
2. 环境变量 `JM_PYTHON`
3. 插件目录下的 `.venv/Scripts/python.exe`（Linux 为 `.venv/bin/python`）
4. Koishi 项目目录下的 `.venv/...`
5. `PATH` 中的 `python.exe` / `python3`

如果第 5 步找到的不是你要的 Python（例如系统 Python 未安装 `jmcomic`），请显式指定：

```yaml
jm:jm001:
  pythonPath: 'D:\my-venv\Scripts\python.exe'
```

## 工作原理

```
Koishi 插件 (Node.js)
  ├─ 解析指令、查询列表、发送消息
  └─ spawn Python 子进程
       └─ jm_bridge.py
            ├─ list  <编号>          → 查询专辑信息 + 章节列表，输出 JSON
            └─ fetch <编号> <章节>   → 下载图片、转换 PDF，输出 JSON 路径
```

Python 层只负责「获取数据 + 生成 PDF」，结果以一行 JSON 输出到 stdout，日志走 stderr。
Node 层读取最后一行 JSON 判断成败。

**为什么拆成 Python**：`jmcomic` 是目前最完整的禁漫下载库，但只有 Python 实现。
Node 侧没有等价方案，自行实现签名与图片解密并不现实。

## 常见问题

<details>
<summary><b>指令没有反应</b></summary>

先确认 Koishi 日志里有没有这行：

```
jm 加载完成 python=... bridge=...
```

如果没有，说明插件未加载，检查 `koishi.yml` 中是否添加了 `jm:jm001`。

</details>

<details>
<summary><b>提示「桥接脚本无输出」</b></summary>

Python 进程崩溃了。手动执行查看真实报错：

```bash
python jm_bridge.py list 350234
```

stderr 中会有完整的 traceback。

</details>

<details>
<summary><b>ModuleNotFoundError: No module named 'jmcomic'</b></summary>

Python 解释器选错了 —— 安装 `jmcomic` 的 Python 和插件使用的不是同一个。

解决办法是把 `pythonPath` 指向安装过依赖的解释器，并用下面的命令验证：

```bash
"D:\your-venv\Scripts\python.exe" -c "import jmcomic; print('ok')"
```

</details>

<details>
<summary><b>下载很慢或超时</b></summary>

默认超时 600 秒。页数较多的章节（100 页以上）本身就需要 30 秒以上，属正常范围。
如果网络条件确实较差，可以调大 `timeoutSeconds`。

</details>

<details>
<summary><b>文件发送失败</b></summary>

通常是文件名触发了 QQ 的过滤规则。插件已内置三级降级策略（原名 → 去括号 → 中性编号名），
如果仍然失败，日志中会给出具体原因。

</details>

## 技术说明

实现细节与踩坑记录见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

几个关键点：

- `decode` 是**解密开关**而非压缩开关，必须为 `True`
- 图片格式必须为 `.jpg`，否则 PDF 体积膨胀约 8 倍
- 使用移动端 APP API，无 Cloudflare 验证、无需 cookie

## 已知限制

- **不支持整本下载**，只能逐章选择 —— 整本数百页会超出群文件上限
- 章节数超过 5 时，页数为估算值（误差约 9%），列表会标注「页数为估算值」
- 下载速度取决于网络：25 页约 15~30 秒，131 页约 35 秒
- 同一个群同时只允许一个下载任务

## 致谢

本插件能跑起来，核心能力全部来自这些项目，**版权归各自作者所有**：

| 项目 | 作者 | 许可 | 在本插件中的作用 |
| --- | --- | --- | --- |
| [JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) (`jmcomic`) | [@hect0x7](https://github.com/hect0x7) | MIT | **下载与图片解密**，本插件的核心依赖 |
| [img2pdf](https://gitlab.mister-muffin.de/josch/img2pdf) | Johannes Schauer Marin Rodrigues | LGPL-3.0 | 图片合成 PDF |
| [curl_cffi](https://github.com/lexiforest/curl_cffi) | [@lexiforest](https://github.com/lexiforest) | MIT | HTTP 客户端（浏览器指纹模拟） |
| [Koishi](https://koishi.chat) | [@shigma](https://github.com/shigma) 及社区 | MIT | 机器人框架 |

特别感谢 `jmcomic` —— 它把 JM 的接口签名、图片切片重排解密这些最麻烦的部分都封装好了，
否则这个插件需要从零实现整套协议，工作量不是一个量级。

如果这个插件对你有用，**请优先去给 `jmcomic` 点个 Star**：
<https://github.com/hect0x7/JMComic-Crawler-Python>

## 免责声明

本项目仅供个人学习与技术研究使用。

- 请遵守当地法律法规，不要用于传播
- 下载内容的版权归原作者所有，请支持正版
- 使用本工具产生的一切后果由使用者自行承担

## 许可

[MIT](LICENSE)

本插件自身的代码以 MIT 许可发布。所依赖的第三方库各自遵循其原有许可，
其中 **img2pdf 为 LGPL-3.0** —— 它以**独立子进程**方式调用，未修改、未静态链接，
不构成衍生作品，不影响本项目的 MIT 许可。

