/**
 * koishi-plugin-jm —— 禁漫（JMComic）按章节下载并转为 PDF 发送
 *
 * 纯 CommonJS 实现，无需 TypeScript 构建，Koishi 可直接加载。
 *
 * 依赖：
 *   - Python 解释器（已安装 jmcomic + img2pdf）
 *   - data/jm/jm_bridge.py
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { h, Schema } = require('koishi')

const name = 'jm'

const Config = Schema.object({
  pythonPath: Schema.string()
    .description('Python 解释器路径。留空则自动探测（优先读环境变量 `JM_PYTHON`）')
    .default(''),
  bridgePath: Schema.string()
    .description('jm_bridge.py 路径。留空则使用插件内置的那份')
    .default(''),
  workDir: Schema.string()
    .description('临时下载目录。留空则用系统临时目录下的 koishi-plugin-jm')
    .default(''),
  maxSizeMB: Schema.number()
    .description('单个 PDF 上限（MB），超出则拒绝发送')
    .default(100),
  cacheMinutes: Schema.number()
    .description('章节列表缓存时间（分钟）')
    .default(1),
  timeoutSeconds: Schema.number()
    .description('单次下载超时（秒）')
    .default(600),
  keepHours: Schema.number()
    .description('临时文件保留时间（小时）')
    .default(2),
  cleanIntervalMinutes: Schema.number()
    .description('清理任务间隔（分钟）')
    .default(30),
  groupWhitelist: Schema.array(String)
    .description(
      '群白名单（群号）。**留空 = 不限制，所有群都能用**；' +
        '一旦填写，则只有名单内的群能用，其它群发送指令会被**完全忽略**（不回复任何内容）',
    )
    .default([]),
  whitelistEnabled: Schema.boolean()
    .description('是否启用群白名单。关闭后所有群都能用（忽略上面的名单）')
    .default(true),
})

/** 调用 Python 桥接脚本，返回解析后的 JSON */
function runBridge(cfg, args, env, task) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.pythonPath, ['-X', 'utf8', cfg.bridgePath].concat(args), {
      env: Object.assign({}, process.env, env || {}),
      windowsHide: true,
      // 独立进程组：停止时需要杀掉整棵进程树（Python 会再开下载线程）
      detached: process.platform !== 'win32',
    })

    // 把子进程挂到任务上，/jm 停止 才能找到它
    if (task) task.child = child

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn, val) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (task) task.child = null
      fn(val)
    }

    const timer = setTimeout(() => {
      killTree(child)
      finish(reject, new Error('下载超时（' + cfg.timeoutSeconds + ' 秒）'))
    }, cfg.timeoutSeconds * 1000)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    child.on('error', (e) => finish(reject, e))

    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean)
      const last = lines[lines.length - 1]
      if (!last) {
        finish(reject, new Error('桥接脚本无输出 (exit=' + code + ') ' + stderr.slice(-300)))
        return
      }
      try {
        finish(resolve, JSON.parse(last))
      } catch (e) {
        finish(reject, new Error('无法解析桥接输出: ' + last.slice(0, 200)))
      }
    })
  })
}

/**
 * 杀掉进程树。
 * Windows 上 child.kill() 只杀 python.exe 本身，它内部的下载线程/子进程会成为
 * 孤儿继续跑（实测超时后仍占着网络和临时目录）。所以 Windows 走 taskkill /T。
 */
function killTree(child) {
  if (!child || child.killed) return
  const pid = child.pid
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {}
}

/** 清理 Windows 文件名非法字符 */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * 探测 Python 解释器。
 * 顺序：显式配置 → 环境变量 JM_PYTHON → 插件目录下 .venv → 常见虚拟环境 → PATH 里的 python。
 * 只做「路径存在性」判断，不实际执行（真正跑起来失败会在下载时报错，日志里有原因）。
 */
function resolvePython(configured, pluginRoot) {
  const fsSync = require('node:fs')
  const isWin = process.platform === 'win32'
  const candidates = []

  if (configured) candidates.push(configured)
  if (process.env.JM_PYTHON) candidates.push(process.env.JM_PYTHON)

  const venvBins = isWin
    ? ['Scripts\\python.exe', 'Scripts\\python3.exe']
    : ['bin/python3', 'bin/python']
  for (const rel of venvBins) {
    candidates.push(path.join(pluginRoot, '.venv', rel))
    candidates.push(path.join(process.cwd(), '.venv', rel))
  }

  // PATH 兜底：交给系统解析
  candidates.push(isWin ? 'python.exe' : 'python3')

  for (const c of candidates) {
    if (!c) continue
    // 无路径分隔符的（如 python.exe）视为 PATH 命令，直接采用
    if (!c.includes(path.sep) && !c.includes('/')) return c
    try {
      if (fsSync.existsSync(c)) return c
    } catch {}
  }
  return isWin ? 'python.exe' : 'python3'
}

/** 解析 jm_bridge.py 位置：显式配置优先，否则用包内自带的那份 */
function resolveBridge(configured, pluginRoot) {
  if (configured) return configured
  // lib/index.js 运行时 __dirname 是 <pkg>/lib，桥接脚本在 <pkg>/jm_bridge.py
  return path.join(pluginRoot, 'jm_bridge.py')
}

function apply(ctx, cfg) {
  const logger = ctx.logger('jm')

  // 包根目录（lib 的上一级）
  const pluginRoot = path.resolve(__dirname, '..')

  // 解析出实际使用的路径，并回填到 cfg，后续逻辑不用再判断空值
  cfg.pythonPath = resolvePython(cfg.pythonPath, pluginRoot)
  cfg.bridgePath = resolveBridge(cfg.bridgePath, pluginRoot)
  if (!cfg.workDir) {
    cfg.workDir = path.join(os.tmpdir(), 'koishi-plugin-jm')
  }

  logger.info(
    '加载完成 python=' + cfg.pythonPath + ' bridge=' + cfg.bridgePath + ' workDir=' + cfg.workDir,
  )

  // 启动时做一次前置检查，早失败早报错，比等到用户发指令才发现好
  const fsSync = require('node:fs')
  if (!fsSync.existsSync(cfg.bridgePath)) {
    logger.error('找不到桥接脚本: ' + cfg.bridgePath + '（插件安装不完整？）')
  }

  // 文件名候选：QQ 群文件有两类拒绝原因，都要能兜住：
  //   1) 名字过长（>80 字）→ -303 文件名称格式错误
  //   2) 命中整串敏感词黑名单（如「少女與觸手編織出愛」）→ -134 文件上传失败
  // 顺序：原名（截断）→ 去括号空格（截断）→ 纯编号中性名。第一个能过就用。
  // single=true（单本）中性名不带章节号：JM259194.pdf
  // single=false（连载）才加章节：JM259194_第2话.pdf
  function buildFileNames(original, res, single) {
    const trunc = (s, n) => {
      if (s.length <= n) return s
      const ext = '.pdf'
      const base = s.endsWith(ext) ? s.slice(0, -ext.length) : s
      return base.slice(0, n - ext.length) + ext
    }

    const list = [trunc(original, 80)]

    const noBracket = trunc(
      original.replace(/[[\]()（）【】]/g, '').replace(/\s+/g, ' ').trim(),
      80,
    )
    if (noBracket && !list.includes(noBracket)) list.push(noBracket)

    // 中性名：只用编号（+ 连载时的章节），不带任何标题文字，几乎不可能命中过滤
    const neutral = single
      ? 'JM' + res.albumId + '.pdf'
      : 'JM' + res.albumId + '_第' + res.index + '话.pdf'
    if (!list.includes(neutral)) list.push(neutral)

    return list
  }

  // sessionKey -> { albumId, chapters, expireAt }
  const pending = new Map()
  // sessionKey -> { albumId, chapter, userId, startedAt, child, cancelled }
  // 用 Map 而不是 Set：要挂子进程句柄给「jm 停止」用
  const busy = new Map()

  // ---------- 定时清理 ----------
  async function cleanTemp() {
    let entries
    try {
      entries = await fs.readdir(cfg.workDir)
    } catch {
      return
    }
    const cutoff = Date.now() - cfg.keepHours * 3600 * 1000
    let removed = 0
    for (const n of entries) {
      const full = path.join(cfg.workDir, n)
      try {
        const st = await fs.stat(full)
        if (st.birthtimeMs < cutoff) {
          await fs.rm(full, { recursive: true, force: true })
          removed++
        }
      } catch {}
    }
    if (removed) logger.info('清理临时目录 ' + removed + ' 项')
  }

  // 确保工作目录存在（默认值在系统临时目录下，首次运行时可能还没有）
  fs.mkdir(cfg.workDir, { recursive: true }).catch((e) => {
    logger.error('无法创建临时目录 ' + cfg.workDir + ': ' + (e && e.message))
  })

  ctx.setInterval(cleanTemp, cfg.cleanIntervalMinutes * 60 * 1000)

  // ---------- 发送 PDF ----------
  // 群聊与私聊走【不同】的 OneBot 接口，必须分开：
  //   群聊   channelId = 群号          -> upload_group_file(group_id, ...)
  //   私聊   channelId = "private:<QQ>" -> upload_private_file(user_id, ...)
  // 之前不区分，私聊把 "private:1965161643" 当群号传给 upload_group_file，
  // 被 QQ 以 retcode 1400 拒绝，随后静默降级、用户收不到文件。
  // 判据用 session.isDirect（适配器自己也是这么判的，见其 sendFile 实现）。
  const PRIVATE_PFX = 'private:'

  function isDirectSession(session) {
    if (session.isDirect) return true
    const cid = String(session.channelId || '')
    // 老版本/特殊情况可能没有 isDirect，用前缀兜底
    return cid.startsWith(PRIVATE_PFX)
  }

  async function sendPdf(session, pdfPath, fileName) {
    const internal = session.bot && session.bot.internal
    if (!internal || !session.channelId) return false

    if (isDirectSession(session)) {
      if (typeof internal.uploadPrivateFile !== 'function') return false
      const cid = String(session.channelId)
      const userId = cid.startsWith(PRIVATE_PFX)
        ? cid.slice(PRIVATE_PFX.length)
        : String(session.userId || '')
      if (!userId) return false
      await internal.uploadPrivateFile(userId, pdfPath, fileName)
      return true
    }

    if (typeof internal.uploadGroupFile !== 'function') return false
    await internal.uploadGroupFile(session.channelId, pdfPath, fileName)
    return true
  }

  // ---------- 下载并发送 ----------
  // opts.single：单话作品（不显示「第 N 章」，避免让人以为还有别的话）
  async function downloadAndSend(session, albumId, chapter, opts) {
    const sessionKey = session.platform + ':' + session.channelId

    const running = busy.get(sessionKey)
    if (running) {
      logger.info('[下载] 群 ' + session.channelId + ' 已有任务在跑，拒绝 ' + albumId + '-' + chapter)
      return '这个群正在下载中，请稍候再试 ~（发送 jm 停止 可以取消）'
    }

    // 任务对象：停止命令通过它找到子进程
    const task = {
      albumId,
      chapter,
      userId: session.userId,
      startedAt: Date.now(),
      child: null,
      cancelled: false,
    }
    busy.set(sessionKey, task)

    const single = !!(opts && opts.single)
    const workDir = path.join(cfg.workDir, albumId + '-' + Date.now())
    const t0 = Date.now()
    try {
      logger.info(
        '[下载] 开始 JM' + albumId + ' 第' + chapter + '话' + (single ? '（单话）' : '') +
          ' 群' + session.channelId + ' 用户' + (session.userId || '?'),
      )

      await session.send(single ? '正在下载，请稍候…' : '正在下载第 ' + chapter + ' 章，请稍候…（可能需要 1 分钟）')

      logger.info('[下载] 调用 Python 桥，工作目录 ' + workDir)
      const res = await runBridge(cfg, ['fetch', albumId, chapter], {
        JM_WORK_DIR: workDir,
      }, task)

      // 被 /jm 停止 主动取消时，子进程会被杀，这里走过场不要再报错
      if (task.cancelled) {
        logger.info('[下载] 用户取消 ' + albumId + '-' + chapter)
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
        return '已停止下载'
      }

      if (!res.ok) {
        logger.warn('[下载] 桥返回失败 ' + albumId + '-' + chapter + ': ' + (res.error || res.message))
        if (res.error === 'chapter_not_found') {
          return '第 ' + chapter + ' 章不存在，发送 jm ' + albumId + ' 查看章节列表'
        }
        if (res.error === 'MissingAlbumPhotoException') {
          return albumId + ' 不存在，请检查后重试'
        }
        return '下载失败：' + (res.message || res.error)
      }

      logger.info(
        '[下载] 桥返回成功 《' + res.title + '》第' + res.index + '话 ' +
          res.pages + '页 ' + res.sizeMB + 'MB 耗时' + res.elapsed + 's' +
          (res.recovered ? ' 补页' + res.recovered : '') +
          (res.missingPages ? ' 仍缺' + res.missingPages + '页' : ''),
      )

      if (res.oversize) {
        logger.warn('[下载] ' + albumId + '-' + chapter + ' 体积 ' + res.sizeMB + 'MB 超限 ' + cfg.maxSizeMB + 'MB，放弃发送')
        return (
          '第 ' +
          chapter +
          ' 章生成后为 ' +
          res.sizeMB +
          ' MB，超过 ' +
          cfg.maxSizeMB +
          ' MB 上限，无法发送。请换一章试试。'
        )
      }

      const st = await fs.stat(res.pdfPath).catch(() => null)
      if (!st) {
        logger.warn('[下载] PDF 文件不存在: ' + res.pdfPath)
        return 'PDF 生成后未能找到文件，请重试'
      }

      const label = res.chapterName
        ? '第' + res.index + '话_' + safeName(res.chapterName)
        : '第' + res.index + '话'
      const fileName = safeName(res.title) + '_' + label + '.pdf'

      logger.info(
        '[发送] 上传 ' + fileName + '（' + (st.size / 1024 / 1024).toFixed(2) + 'MB）到' +
          (isDirectSession(session) ? '私聊 ' : '群 ') + session.channelId,
      )
      const tSend = Date.now()

      // 尝试多种文件名：QQ 有整串敏感词黑名单（如「少女與觸手編織出愛」），
      // 命中会返回 -134 且无法通过改写单个字绕过，只能退化成中性名重试。
      const candidates = buildFileNames(fileName, res, single)
      let sent = false
      let usedName = fileName
      let lastErr = null

      for (const name of candidates) {
        try {
          sent = await sendPdf(session, res.pdfPath, name)
          if (sent) {
            usedName = name
            break
          }
          lastErr = isDirectSession(session)
            ? '私聊文件上传接口不可用（uploadPrivateFile）'
            : '群文件上传接口不可用（uploadGroupFile）'
        } catch (e) {
          lastErr = (e && e.message) || String(e)
          logger.warn('[发送] 文件名「' + name + '」被拒: ' + lastErr)
          // 命中内容黑名单时换下一个候选名；其他错误（网络等）直接放弃
          if (!/retcode:\s*100|code=-134|code=-303/.test(lastErr)) break
        }
      }

      // 兜底：作为消息附件发送（注意：本地路径必须转成 file:// 才会被适配器直接读取，
      // 否则适配器会把它当 URL 去 downloadFile，必然失败）
      //
      // ⚠️ 这里【不能】用 session.send()：
      //   Koishi 的 Session.send() 内部是
      //     bot.sendMessage(...).catch(err => { logger.warn(err); return [] })
      //   即【吞掉所有异常、永远不抛】。用它就永远无法判断到底发没发出去，
      //   结果就是「用户没收到文件，插件却报已发送」。
      //   改用 bot.sendMessage() 才能拿到真实失败。
      if (!sent) {
        try {
          logger.info('[发送] 文件上传失败，改用消息附件发送')
          const elements = h.normalize(h.file('file:///' + res.pdfPath.replace(/\\/g, '/'), { title: usedName }))
          await session.bot.sendMessage(session.channelId, elements, session.event && session.event.referrer)
          sent = true
        } catch (e) {
          logger.warn('[发送] 消息附件也失败: ' + (e && e.message))
          lastErr = (e && e.message) || lastErr
        }
      }

      if (!sent) {
        logger.warn('[发送] 全部方式失败 JM' + albumId + '-' + chapter + ': ' + lastErr)
        return (
          '文件发送失败：' + (lastErr || '未知原因') +
          '\n可能是文件名触发了 QQ 的过滤，或文件过大。可换个作品再试。'
        )
      }

      logger.info(
        '[完成] JM' + albumId + ' 第' + chapter + '话 《' + res.title + '》' +
          res.sizeMB + 'MB ' + res.pages + '页 ' +
          '下载' + res.elapsed + 's 发送' + ((Date.now() - tSend) / 1000).toFixed(1) + 's ' +
          '总计' + ((Date.now() - t0) / 1000).toFixed(1) + 's',
      )

      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})

      // 缺页提示：补页也补不回来的少数页，如实告知，避免用户以为拿到了完整版
      const missNote = res.missingPages
        ? '（其中 ' + res.missingPages + ' 页下载失败已跳过）'
        : ''
      if (single) {
        return '《' + res.title + '》已发送（' + res.sizeMB + ' MB，' + res.pages + ' 页）' + missNote
      }
      return '《' + res.title + '》第 ' + res.index + ' 话 已发送（' + res.sizeMB + ' MB，' + res.pages + ' 页）' + missNote
    } catch (e) {
      // 被「jm 停止」杀进程时，runBridge 会 reject（子进程无输出），
      // 这里必须先判 cancelled —— 否则用户点了停止却收到「下载失败」。
      if (task.cancelled) {
        logger.info('[下载] 用户取消 ' + albumId + '-' + chapter)
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {})
        return '已停止下载'
      }
      logger.warn('[下载] 异常 ' + albumId + '-' + chapter + ': ' + (e && e.message))
      return '下载失败：' + (e && e.message)
    } finally {
      busy.delete(sessionKey)
    }
  }

  // ---------- 群白名单 ----------
  // 返回 true = 允许使用。
  // 规则：名单为空 → 不限制（所有人都能用，保持向后兼容）；
  //       名单非空 → 只有名单内的群能用。
  // 判断前先归一化：去掉空格/前缀、只留数字，这样填 "onebot:123456" 或
  // " 123456 " 也能正确匹配。
  function isGroupAllowed(session) {
    if (!cfg.whitelistEnabled) return true

    const list = Array.isArray(cfg.groupWhitelist) ? cfg.groupWhitelist : []
    const ids = list
      .map((x) => String(x == null ? '' : x).trim())
      .map((x) => x.replace(/^[^:]*:/, '')) // 容忍 "onebot:123456" 这种写法
      .filter((x) => /^\d+$/.test(x))
    // 没填（或填的全是无效值）→ 视为不限制
    if (ids.length === 0) return true

    // 私聊一律放行。
    // 注意：私聊时 channelId 是「用户 QQ 号」而不是群号，也是纯数字，
    // 所以**不能**用 channelId 判断是不是群。真正的判据是 guildId：
    // 群聊必有 guildId，私聊没有。
    if (!session.guildId) return true

    // 群聊：channelId 就是群号
    const gid = String(session.guildId || '').trim()
    if (!/^\d+$/.test(gid)) return true

    return ids.includes(gid)
  }

  // ---------- jm ----------
  ctx
    .command('jm [albumId:string] [chapter:string]', '禁漫下载（按章节）')
    .usage('发送 jm 编号 查看章节列表，再回复序号下载对应章节。发送 jm 停止 可取消正在进行的下载。')
    .example('jm 350234')
    .example('jm 350234 2')
    .example('jm 停止')
    .action(async ({ session }, albumId, chapter) => {
      if (!session) return

      // 白名单外的群：完全静默。
      // 返回空串（而不是 undefined/null）—— Koishi 对空串不会发送任何消息，
      // 且不会落进「命令执行了但没回复」的告警分支。
      if (!isGroupAllowed(session)) {
        logger.info(
          '[白名单] 忽略群' + session.guildId + ' 用户' + (session.userId || '?') +
            ' 的指令（不在白名单）',
        )
        return ''
      }

      const sessionKey = session.platform + ':' + session.channelId

      logger.info(
        '[指令] jm 群' + session.channelId + ' 用户' + (session.userId || '?') +
          ' 参数=' + JSON.stringify([albumId, chapter]),
      )

      // ---- 停止下载 ----
      if (albumId === '停止' || albumId === '取消' || albumId === 'stop') {
        const t = busy.get(sessionKey)
        if (!t) return '当前没有正在进行的下载'

        logger.info(
          '[停止] 群' + session.channelId + ' 用户' + (session.userId || '?') +
            ' 取消 JM' + t.albumId + ' 第' + t.chapter + '话（已运行 ' +
            Math.round((Date.now() - t.startedAt) / 1000) + 's）',
        )

        t.cancelled = true
        killTree(t.child)
        busy.delete(sessionKey)

        return '已停止下载（JM' + t.albumId + ' 第' + t.chapter + '话）'
      }

      if (!albumId) {
        return '用法：jm 编号\n例如：jm 350234\n\n先查看章节列表，再回复序号下载。'
      }

      // 纯数字 + 命中缓存 → 当作章节序号
      // 注意：只有当该数字确实是缓存里的章节序号时才拦截，
      // 否则用户输入的合法编号会被误当成序号（如缓存了 350234 时输入 999999999）
      if (/^\d+$/.test(albumId) && pending.has(sessionKey)) {
        const cached = pending.get(sessionKey)
        const asIndex = cached.chapters.some((c) => Number(c.index) === Number(albumId))
        if (asIndex) {
          logger.info('[指令] ' + albumId + ' 命中缓存序号，转为 JM' + cached.albumId + ' 第' + albumId + '话')
          chapter = albumId
          albumId = cached.albumId
        }
      }

      if (!/^\d+$/.test(albumId)) {
        logger.warn('[指令] 非法编号 ' + albumId)
        return '编号必须是纯数字，例如 jm 350234'
      }

      // 第二步：下载
      if (chapter) {
        if (!/^\d+$/.test(chapter)) {
          return '章节序号必须是数字，例如 jm 350234 2'
        }
        return downloadAndSend(session, albumId, chapter)
      }

      // 第一步：查列表
      // 列表查询也可能很慢（网络差时实测有 300s+ 的），所以同样注册任务，
      // 让「jm 停止」在这个阶段也能用。
      const listTask = {
        albumId,
        chapter: '列表',
        userId: session.userId,
        startedAt: Date.now(),
        child: null,
        cancelled: false,
        isList: true,
      }
      if (busy.has(sessionKey)) {
        return '这个群正在下载中，请稍候再试 ~（发送 jm 停止 可以取消）'
      }
      busy.set(sessionKey, listTask)

      try {
        logger.info('[列表] 查询 JM' + albumId + ' 章节信息')
        const tList = Date.now()
        const res = await runBridge(cfg, ['list', albumId], null, listTask)

        if (listTask.cancelled) {
          logger.info('[列表] 用户取消 JM' + albumId)
          return '已停止查询'
        }

        if (!res.ok) {
          logger.warn('[列表] JM' + albumId + ' 查询失败: ' + (res.error || res.message))
          if (res.error === 'MissingAlbumPhotoException') {
            return albumId + ' 不存在，请检查后重试'
          }
          return '查询失败：' + (res.message || res.error)
        }

        logger.info(
          '[列表] JM' + albumId + ' 《' + res.title + '》' + res.chapterCount + '章 ' +
            res.pageCount + '页 耗时' + ((Date.now() - tList) / 1000).toFixed(1) + 's' +
            (res.pagesExact ? '（页数精确）' : '（页数估算）'),
        )

        // 只有 1 章 → 直接下载（单话作品，不显示「第 N 章」）
        if (res.chapterCount === 1) {
          logger.info('[列表] 单话作品，直接下载')
          busy.delete(sessionKey) // 交给 downloadAndSend 自己占位
          return downloadAndSend(session, res.albumId, '1', { single: true })
        }

        pending.set(sessionKey, {
          albumId: res.albumId,
          chapters: res.chapters,
          expireAt: Date.now() + cfg.cacheMinutes * 60 * 1000,
        })

        const authors = (res.authors || []).filter((a) => a && a !== 'N/A')
        const lines = []
        lines.push('📖 ' + res.title)
        lines.push(
          '🆔 JM' +
            res.albumId +
            ' · ' +
            res.chapterCount +
            ' 章 · ' +
            res.pageCount +
            ' 页' +
            (authors.length ? ' · ' + authors.slice(0, 2).join('/') : ''),
        )
        lines.push('')

        for (const c of res.chapters) {
          const nm = c.name ? ' ' + c.name : ''
          const warn = c.oversize ? ' ⚠️超限' : ''
          lines.push(
            String(c.index).padStart(2) +
              '. 第' +
              c.index +
              '话' +
              nm +
              '  ' +
              c.pages +
              '页 ≈' +
              c.sizeMB +
              'MB' +
              warn,
          )
        }

        lines.push('')
        if (!res.pagesExact) lines.push('（页数为估算值）')
        lines.push('回复序号选择章节，例如：jm ' + res.albumId + ' 2')
        lines.push('列表 ' + cfg.cacheMinutes + ' 分钟内有效，也可直接回复数字')

        return lines.join('\n')
      } catch (e) {
        // 同 downloadAndSend：被「jm 停止」杀掉时不要报「查询失败」
        if (listTask.cancelled) {
          logger.info('[列表] 用户取消 JM' + albumId)
          return '已停止查询'
        }
        logger.warn('[列表] 异常: ' + (e && e.message))
        return '查询失败：' + (e && e.message)
      } finally {
        // 只有还是「列表」任务时才释放（单话会转交 downloadAndSend 自己管）
        if (busy.get(sessionKey) === listTask) busy.delete(sessionKey)
      }
    })

  // ---------- 裸数字回复 ----------
  ctx.middleware(async (session, next) => {
    const sessionKey = session.platform + ':' + session.channelId
    const cached = pending.get(sessionKey)
    if (!cached) return next()

    // 白名单外的群：静默放行（交给别的插件处理，自己什么都不做）
    if (!isGroupAllowed(session)) return next()

    const text = (session.content || '').trim()
    if (!/^\d+$/.test(text)) return next()

    if (Date.now() > cached.expireAt) {
      logger.info('[缓存] 群 ' + session.channelId + ' 的章节列表已过期，忽略数字 ' + text)
      pending.delete(sessionKey)
      return next()
    }

    const idx = Number(text)
    const hit = cached.chapters.find((c) => Number(c.index) === idx)
    if (!hit) return next()

    logger.info('[缓存] 群 ' + session.channelId + ' 回复序号 ' + text + '，匹配 JM' + cached.albumId)
    pending.delete(sessionKey)
    return downloadAndSend(session, cached.albumId, text)
  })
}

module.exports = { name, Config, apply }
