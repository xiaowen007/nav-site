// GET /api/wallpapers?source=bing|360|wallhaven&page=1&q=关键词
// 在线壁纸库：服务端（Worker）代理抓取，规避浏览器 CORS 限制（需登录）
import { sendJSON, requireAuth } from '../../_lib.js';

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (!r.ok) throw new Error('上游返回 HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function fetchWallpapers(source, page, q) {
  if (source === 'bing') {
    const n = 8;
    const idx = (page - 1) * n;
    const j = await fetchJSON(`https://cn.bing.com/HPImageArchive.aspx?format=js&idx=${idx}&n=${n}&mkt=zh-CN`);
    return (j.images || []).map((im) => ({
      url: 'https://cn.bing.com' + (im.url || ''),
      thumb: 'https://cn.bing.com' + (im.urlbase || '') + '_400x240.jpg',
      title: (im.copyright || im.title || 'Bing 每日壁纸').toString()
    })).filter((x) => x.url && x.url !== 'https://cn.bing.com');
  }

  if (source === '360') {
    const start = (page - 1) * 20;
    const cid = String(q || 1).replace(/\D/g, '') || '1';
    const j = await fetchJSON(`https://wallpaper.apc.360.cn/index.php?c=WallPaperAndroid&a=getAppsByCategory&cid=${cid}&start=${start}&count=20`);
    const arr = (j && j.data) || [];
    return arr.map((it) => ({
      url: it.url || it.img || '',
      thumb: it.thumb || it.small || it.url || '',
      title: (it.name || it.title || '360 壁纸').toString()
    })).filter((x) => x.url);
  }

  if (source === 'wallhaven') {
    const p = Math.max(1, page);
    const query = encodeURIComponent(q || 'landscape');
    const j = await fetchJSON(`https://wallhaven.cc/api/v1/search?q=${query}&sorting=relevance&page=${p}&categories=111&purity=100`);
    return (j.data || []).map((it) => ({
      url: it.path || '',
      thumb: (it.thumbs && (it.thumbs.small || it.thumbs.large)) || it.path || '',
      title: 'Wallhaven #' + it.id
    })).filter((x) => x.url);
  }

  throw new Error('不支持的壁纸源：' + source);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await requireAuth(request, env))) {
    return sendJSON({ error: '请先登录后台', needAuth: true }, 401);
  }
  const url = new URL(request.url);
  const source = url.searchParams.get('source') || 'bing';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const q = url.searchParams.get('q') || '';
  try {
    const list = await fetchWallpapers(source, page, q);
    return sendJSON({ ok: true, source, page, list });
  } catch (e) {
    return sendJSON({ error: '获取壁纸失败：' + e.message }, 502);
  }
}
