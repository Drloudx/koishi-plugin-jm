# -*- coding: utf-8 -*-
"""
/jm 桥接脚本 —— 由 Koishi 插件 koishi-plugin-jm 调用。

两种模式：
  python jm_bridge.py list   <album_id>              → 输出 JSON：专辑信息 + 章节列表
  python jm_bridge.py fetch  <album_id> <pindex>     → 下载指定章节，输出 JSON：PDF 路径

依赖（版权归各自作者）：
  * jmcomic  —— JMComic-Crawler-Python, MIT, https://github.com/hect0x7/JMComic-Crawler-Python
                本脚本的下载与图片解密能力全部来自它。
  * img2pdf  —— LGPL-3.0, https://gitlab.mister-muffin.de/josch/img2pdf
  * curl_cffi —— MIT, https://github.com/lexiforest/curl_cffi

设计要点：
  * decode=True + suffix='.jpg' 是关键：
      decode=True 才会按 scramble_id 还原加密图片（这不是压缩开关，是解密开关）；
      suffix='.jpg' 让 img2pdf 直接嵌原始 JPEG 字节，避免 webp 转无损 PNG 导致体积膨胀约 8 倍。
  * FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = False：bytepluses.com 域名在部分网络不可达
  * verify=False：curl_cffi 在部分环境读 certifi 的 cacert.pem 失败（curl error 77）
  * 结果一律写 JSON 到 stdout，日志走 stderr，避免污染
"""
import io
import json
import os
import re
import shutil
import sys
import time
import traceback

# ---- 先把 jmcomic 的日志压住，避免污染 stdout ----
import logging

logging.disable(logging.CRITICAL)

import jmcomic
import curl_cffi.requests as cffi_req

# ---- 修 SSL：本机 curl_cffi 读 cacert.pem 失败 ----
_orig_request = cffi_req.Session.request


def _patched_request(self, method, url, *args, **kwargs):
    kwargs.setdefault('verify', False)
    return _orig_request(self, method, url, *args, **kwargs)


cffi_req.Session.request = _patched_request

# ---- 关掉不可达的域名自动更新 ----
jmcomic.JmModuleConfig.FLAG_API_CLIENT_AUTO_UPDATE_DOMAIN = False

# ---- 关键参数说明（务必理解，改错会导致图片损坏）----
#
# decode=True 是【必须】的：
#   JM 源站的图片是「横向切片重排」加密的。decode=True 走 decode_and_save，
#   按 scramble_id 还原正确图片；decode=False 走 save_directly，直接把乱序字节
#   落盘，出来的图是错位的（实测 PSNR 9.8dB / SSIM 0.14，完全不可用）。
#
# suffix='.jpg' 是为了控制 PDF 体积：
#   img2pdf 对 webp 会内部转成无损 PNG 再嵌入（131页 webp → PDF 73MB）；
#   对 JPEG 则直接嵌入原始字节（131页 jpg → PDF 9MB）。
#   实测画质代价 PSNR 40.4dB / SSIM 0.9992，肉眼无法分辨。
#
# 实测体积基准（decode=True + suffix='.jpg'）：
#   [3D]我的老婆黃雅岩 第6章  131 页 → 9.08 MB → 70.5 KB/页
#   董卓 上+下 第1章           25 页 → 3.82 MB → 150 KB/页
# 不同作品画质差异可达 2 倍，估算取偏保守的 160，宁可高估触发提示，
# 也不要低估导致下载完才发现发不出去。
IMAGE_CFG = {'decode': True, 'suffix': '.jpg'}
KB_PER_PAGE = 160
MAX_PDF_MB = 100          # QQ 群文件上限
EXACT_PAGE_QUERY_MAX = 5  # 章节数 <= 5 时逐章查精确页数，否则用平均值估算


def out(obj):
    """把结果以 JSON 写到 stdout（唯一的输出通道）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + '\n')
    sys.stderr.flush()


def build_option(base_dir, pdf_dir):
    """构造 JmOption。注意用 construct 而不是 default()，否则 plugins 配置会被忽略。"""
    option_dict = {
        'dir_rule': {'rule': 'Bd_Pindex', 'base_dir': base_dir},
        'download': {
            'cache': False,
            'image': dict(IMAGE_CFG),
            'threading': {'image': 16, 'photo': 2},
        },
        'client': {
            'impl': 'api',
            'domain': [],
            'postman': {'type': 'curl_cffi', 'meta_data': {'impersonate': 'chrome'}},
        },
        'plugins': {
            'valid': 'log',
            'dependencies_strategy': 'failed-fast',
            'after_photo': [
                {'plugin': 'img2pdf',
                 'kwargs': {'pdf_dir': pdf_dir, 'filename_rule': 'Pindex'}}
            ],
        },
    }
    return jmcomic.JmOption.construct(option_dict)


def build_list_option():
    """只查信息用的轻量 option：api 模式（免 /setting 取 cookie，省 6s）。"""
    return jmcomic.JmOption.construct({
        'client': {
            'impl': 'api',
            'domain': [],
            'postman': {'type': 'curl_cffi', 'meta_data': {'impersonate': 'chrome'}},
        },
    })


def cmd_list(album_id):
    """查询专辑详情 + 章节列表（含页数与体积估算），不下载任何图片。"""
    opt = build_list_option()
    client = opt.build_jm_client()

    album = client.get_album_detail(album_id)
    episodes = list(album.episode_list)  # [(pid, pindex, pname), ...]
    n_ch = len(episodes)

    # 页数来源，按代价从低到高：
    #   1) 单章作品：album.page_count 就是这一章的页数，直接可用（最省，省掉 photo_detail）
    #   2) 章节少：并发查 photo_detail 拿精确页数
    #   3) 章节多：用 album.page_count 平均值估算
    page_counts = {}
    if n_ch == 1:
        page_counts[episodes[0][0]] = album.page_count
        exact = True
    elif n_ch <= EXACT_PAGE_QUERY_MAX:
        from concurrent.futures import ThreadPoolExecutor

        def fetch(pid):
            try:
                # 只要页数：关掉 album 与 scramble_id 的附带请求，能省一半以上时间
                return pid, len(client.get_photo_detail(pid, False, False))
            except Exception as e:
                log('get_photo_detail(%s) failed: %s' % (pid, e))
                return pid, 0

        with ThreadPoolExecutor(max_workers=min(n_ch, 8)) as ex:
            for pid, n in ex.map(fetch, [e[0] for e in episodes]):
                page_counts[pid] = n
        exact = True
    else:
        avg = int(album.page_count / n_ch) if n_ch else 0
        for pid, _, _ in episodes:
            page_counts[pid] = avg
        exact = False

    chapters = []
    for pid, pindex, pname in episodes:
        n = page_counts.get(pid, 0)
        size_mb = round(n * KB_PER_PAGE / 1024, 1)
        chapters.append({
            'index': str(pindex),
            'photoId': str(pid),
            'name': (pname or '').strip(),
            'pages': n,
            'sizeMB': size_mb,
            'oversize': size_mb > MAX_PDF_MB,
        })

    out({
        'ok': True,
        'albumId': str(album.album_id),
        'title': album.name,
        'authors': album.authors or [],
        'pageCount': album.page_count,
        'chapterCount': n_ch,
        'chapters': chapters,
        'pagesExact': exact,
    })


def _count_pdf_pages(pdf_path):
    """统计 PDF 真实页数。

    直接数 '/Type /Page' 会把 '/Type /Pages'（页面树节点）也算进去，
    所以要先减掉 /Pages 的个数。用二进制读，避免编码问题。
    """
    try:
        with open(pdf_path, 'rb') as f:
            data = f.read()
        total = data.count(b'/Type /Page')
        tree = data.count(b'/Type /Pages')
        return max(0, total - tree)
    except Exception:
        return 0


def _regenerate_pdf(photo, pdf_dir):
    """用 photo 目录下现有的图片重新生成 PDF。

    补页之后必须重做 PDF，否则 PDF 里仍是缺页的旧版本。
    复用 img2pdf 的插件配置（pdf_dir / filename_rule='Pindex'），
    直接调用 Img2pdfPlugin，保证输出路径与首次生成时一致。
    """
    try:
        from jmcomic.jm_plugin import Img2pdfPlugin
        plugin = Img2pdfPlugin
        # 插件实例需要 option，这里用与下载时相同的 option 构造
        opt = build_option(os.path.dirname(photo.save_path) if photo.save_path else '',
                           pdf_dir)
        inst = plugin(opt)
        inst.invoke(photo=photo, pdf_dir=pdf_dir, filename_rule='Pindex')
        return True
    except Exception as e:
        log('重新生成 PDF 失败: %s: %s' % (type(e).__name__, e))
        return False


def cmd_fetch(album_id, pindex):
    """下载指定章节（按 pindex 定位），生成 PDF，输出路径。

    关于「部分下载失败」（假失败问题）：
      jmcomic 的 download_photo 默认 check_exception=True，会在 after_photo（即
      img2pdf 生成 PDF）之后调用 raise_if_has_exception()，只要有一张图失败就抛
      PartialDownloadFailedException —— 但此时 PDF 其实已经完整生成好了。
      结果是：明明成功却报失败，插件什么都不发。

      所以这里改为 check_exception=False，拿到 DownloadResult 后自己检查
      downloader.download_failed_image：
        1) 没有失败 → 直接返回成功
        2) 有失败   → 针对失败的那几张图逐页重试（只补缺的，不重下全部）
        3) 补完仍有缺 → 用剩余图片重新生成 PDF，并在结果里标记缺页
    """
    work = os.environ.get('JM_WORK_DIR')
    if not work:
        raise RuntimeError('JM_WORK_DIR not set')

    base_dir = os.path.join(work, 'img')
    pdf_dir = os.path.join(work, 'pdf')
    for d in (base_dir, pdf_dir):
        os.makedirs(d, exist_ok=True)

    opt = build_option(base_dir, pdf_dir)
    client = opt.build_jm_client()

    album = client.get_album_detail(album_id)
    target = None
    for pid, pi, pname in album.episode_list:
        if str(pi) == str(pindex):
            target = (pid, pi, (pname or '').strip())
            break
    if target is None:
        out({'ok': False, 'error': 'chapter_not_found',
             'message': '第 %s 章不存在' % pindex})
        return

    pid, pi, pname = target
    log('downloading album=%s chapter=%s photo=%s name=%s' % (album_id, pi, pid, pname))

    t0 = time.time()
    # check_exception=False：不让个别图片失败把整批结果废掉
    result = opt.download_photo(pid, check_exception=False)
    elapsed = round(time.time() - t0, 1)

    dler = result.downloader
    photo = result.detail

    # ---- 补页：只重下失败的那几张 ----
    failed_imgs = list(getattr(dler, 'download_failed_image', []) or [])
    retried = 0
    recovered = 0
    if failed_imgs:
        log('部分失败 %d 张，开始逐页补下' % len(failed_imgs))
        still_failed = []
        for img, err in failed_imgs:
            idx = getattr(img, 'index', '?')
            ok = False
            # 每页最多重试 3 轮，每轮之间稍等，避开瞬时风控
            for attempt in range(1, 4):
                try:
                    client.download_by_image_detail(img, img.save_path)
                    ok = True
                    recovered += 1
                    log('补页成功: 第%s页（第%d次）' % (idx, attempt))
                    break
                except Exception as e:
                    log('补页失败: 第%s页 第%d次 %s' % (idx, attempt, type(e).__name__))
                    time.sleep(attempt)
            retried += 1
            if not ok:
                still_failed.append(str(idx))
        if recovered:
            # 有页补回来了 → 用现在完整的图片集重新生成 PDF
            log('补回 %d 页，重新生成 PDF' % recovered)
            _regenerate_pdf(photo, pdf_dir)
        if still_failed:
            log('最终仍缺页: %s' % ','.join(still_failed))

    # 找生成的 PDF
    pdf_path = None
    for f in os.listdir(pdf_dir):
        if f.lower().endswith('.pdf'):
            pdf_path = os.path.join(pdf_dir, f)
            break
    if pdf_path is None:
        out({'ok': False, 'error': 'pdf_missing',
             'message': 'PDF 生成失败'})
        return

    size_mb = round(os.path.getsize(pdf_path) / 1024 / 1024, 2)
    # 页数用 PDF 内真实的 /Type /Page 计数（比 split 更准，不把 /Pages 算进去）
    pdf_pages = _count_pdf_pages(pdf_path)
    expected = len(photo) if photo is not None else 0
    missing = max(0, expected - pdf_pages) if expected else 0

    out({
        'ok': True,
        'albumId': str(album_id),
        'title': album.name,
        'index': str(pi),
        'photoId': str(pid),
        'chapterName': pname,
        'pdfPath': pdf_path,
        'sizeMB': size_mb,
        'pages': pdf_pages,
        'expectedPages': expected,
        'missingPages': missing,
        'recovered': recovered,
        'elapsed': elapsed,
        'oversize': size_mb > MAX_PDF_MB,
    })


def main():
    if len(sys.argv) < 3:
        out({'ok': False, 'error': 'usage',
             'message': 'usage: jm_bridge.py list|fetch <album_id> [pindex]'})
        return 1

    mode = sys.argv[1]
    try:
        if mode == 'list':
            cmd_list(sys.argv[2])
        elif mode == 'fetch':
            if len(sys.argv) < 4:
                out({'ok': False, 'error': 'usage', 'message': 'fetch 需要 pindex'})
                return 1
            cmd_fetch(sys.argv[2], sys.argv[3])
        else:
            out({'ok': False, 'error': 'usage', 'message': 'unknown mode: %s' % mode})
            return 1
    except Exception as e:
        log(traceback.format_exc())
        out({'ok': False, 'error': type(e).__name__,
             'message': str(e)[:300]})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
