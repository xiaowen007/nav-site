// 共享导航 - Cloudflare Pages Functions 共享库
// 注意：本文件以 "_" 开头，不会被当作路由，仅供各 API 函数 import。
// 运行在 Workers 运行时（V8），仅使用 Web 标准 API，不依赖 Node 内置模块。

import { SEED } from './_seed.js';

const KV_SITES = 'sites';   // KV 中导航数据键
const KV_CONFIG = 'config'; // KV 中配置键

const DEFAULT_CFG = {
  AI_API_BASE: 'https://api.siliconflow.cn/v1',
  AI_API_KEY: '',
  AI_MODEL: 'Qwen/Qwen2.5-7B-Instruct',
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: '',
  ADMIN_REQUIRED: true,
  SESSION_SECRET: ''
};

const TOKEN_TTL = 7 * 24 * 3600 * 1000; // 登录有效期 7 天
const SESSION_TTL_SHORT = 12 * 3600 * 1000; // 不勾选“记住我”时 12 小时

/* ---------- 基础工具 ---------- */
export function sendJSON(obj, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function readBody(request) {
  const text = await request.text();
  if (text.length > 5e6) throw new Error('请求体过大');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error('JSON 解析失败'); }
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '') || 'cat';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/* ---------- 配置：环境变量(secrets) 优先，其次 KV ---------- */
export async function loadConfig(env) {
  let stored = {};
  try { stored = (await env.NAV_KV.get(KV_CONFIG, 'json')) || {}; }
  catch { stored = {}; }
  let required = stored.ADMIN_REQUIRED !== undefined ? !!stored.ADMIN_REQUIRED : DEFAULT_CFG.ADMIN_REQUIRED;
  if (env.ADMIN_REQUIRED === 'false' || env.ADMIN_REQUIRED === '0') required = false;
  if (env.ADMIN_REQUIRED === 'true' || env.ADMIN_REQUIRED === '1') required = true;
  return {
    AI_API_BASE: env.AI_API_BASE || stored.AI_API_BASE || DEFAULT_CFG.AI_API_BASE,
    AI_API_KEY: env.AI_API_KEY || stored.AI_API_KEY || '',
    AI_MODEL: env.AI_MODEL || stored.AI_MODEL || DEFAULT_CFG.AI_MODEL,
    ADMIN_USER: env.ADMIN_USER || stored.ADMIN_USER || DEFAULT_CFG.ADMIN_USER,
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || stored.ADMIN_PASSWORD || '',
    ADMIN_REQUIRED: required,
    SESSION_SECRET: env.SESSION_SECRET || stored.SESSION_SECRET || ''
  };
}

export async function saveConfig(env, cfg) {
  const persist = {
    AI_API_BASE: cfg.AI_API_BASE,
    AI_API_KEY: cfg.AI_API_KEY,
    AI_MODEL: cfg.AI_MODEL,
    ADMIN_USER: cfg.ADMIN_USER,
    ADMIN_PASSWORD: cfg.ADMIN_PASSWORD,
    ADMIN_REQUIRED: cfg.ADMIN_REQUIRED,
    SESSION_SECRET: cfg.SESSION_SECRET
  };
  await env.NAV_KV.put(KV_CONFIG, JSON.stringify(persist));
}

// 会话签名密钥：缺失时生成并持久化，避免每次部署后所有登录态失效
export async function ensureSessionSecret(env) {
  const cfg = await loadConfig(env);
  if (cfg.SESSION_SECRET) return cfg;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  cfg.SESSION_SECRET = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  await saveConfig(env, cfg);
  return cfg;
}

/* ---------- 数据读写（KV） ---------- */
export async function loadData(env) {
  let data = null;
  try { data = await env.NAV_KV.get(KV_SITES, 'json'); } catch { data = null; }
  if (!data || !Array.isArray(data.categories)) {
    // 首次访问：使用种子数据并写回 KV，保证后续编辑可持久化
    data = JSON.parse(JSON.stringify(SEED));
    await env.NAV_KV.put(KV_SITES, JSON.stringify(data));
  }
  data.site = data.site || {};
  data.categories = data.categories || [];
  return data;
}

export async function saveData(env, data) {
  await env.NAV_KV.put(KV_SITES, JSON.stringify(data));
}

/* ---------- 鉴权（账号密码登录 + HMAC 签名会话 token） ---------- */
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToStr(str) {
  const pad = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function toB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

export async function issueToken(env, user, remember) {
  const cfg = await ensureSessionSecret(env);
  const exp = Date.now() + (remember ? TOKEN_TTL : SESSION_TTL_SHORT);
  const payload = b64urlEncode(JSON.stringify({ u: user, exp }));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(cfg.SESSION_SECRET), new TextEncoder().encode(payload));
  return { token: payload + '.' + toB64url(sig), exp, user };
}

export async function verifyTokenRaw(env, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx), sig = token.slice(idx + 1);
  if (!payload || !sig) return null;
  const cfg = await ensureSessionSecret(env);
  const expect = await crypto.subtle.sign('HMAC', await hmacKey(cfg.SESSION_SECRET), new TextEncoder().encode(payload));
  if (sig !== toB64url(expect)) return null;
  try {
    const obj = JSON.parse(b64urlDecodeToStr(payload));
    if (!obj || typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

export function tokenFromRequest(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return request.headers.get('x-admin-token') || '';
}

export async function requireAuth(request, env) {
  const cfg = await loadConfig(env);
  if (!cfg.ADMIN_REQUIRED) return true; // 显式关闭登录保护
  if (await verifyTokenRaw(env, tokenFromRequest(request))) return true;
  // 兼容旧的明文密码头
  const pwd = request.headers.get('x-admin-password');
  return !!(pwd && cfg.ADMIN_PASSWORD && pwd === cfg.ADMIN_PASSWORD);
}

export async function currentUser(request, env) {
  const s = await verifyTokenRaw(env, tokenFromRequest(request));
  return s ? s.u : null;
}

/* ---------- 网页抓取与元信息提取 ---------- */
export async function fetchMeta(targetUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NavBot/1.0; +https://example.com/bot)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    const html = new TextDecoder('utf-8').decode(buf.slice(0, 256 * 1024));
    return extractMeta(html, targetUrl);
  } finally {
    clearTimeout(timer);
  }
}

function extractMeta(html, targetUrl) {
  const get = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1].trim()) : '';
  };
  const title = get(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const desc = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  let hostname = '';
  try { hostname = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
  return { title, desc, ogImage, hostname, url: targetUrl };
}

/* ---------- 调用大模型（OpenAI 兼容） ---------- */
export async function aiRecognize(cfg, meta, categories) {
  const catList = categories.map((c) => c.name).join('、');
  const prompt = `你是一个网址导航站的内容收录助手。根据用户提供的网页信息，输出该网站的标准导航卡片，必须只返回 JSON（不要任何解释、不要 markdown 代码块），字段如下：
{
  "name": "站点简称（简洁，中文或英文，不超过 12 字）",
  "desc": "一句话中文简介（不超过 30 字）",
  "category": "从已有分类中选择最合适的一个，若都不合适可给出新分类名",
  "icon": "站点图标 URL（优先用 favicon，例如 https://${meta.hostname}/favicon.ico；如果没有就留空字符串）"
}
已有分类：${catList}
网页信息：
- 标题：${meta.title || '(无)'}
- 描述：${meta.desc || '(无)'}
- 网址：${meta.url}
- 域名：${meta.hostname}
请直接输出 JSON。`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.AI_TIMEOUT || 15000);
  try {
    const resp = await fetch(cfg.AI_API_BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + cfg.AI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.AI_MODEL,
        temperature: 0.3,
        messages: [
          { role: 'system', content: '你是导航站收录助手，只输出 JSON。' },
          { role: 'user', content: prompt }
        ]
      })
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('AI 接口错误 ' + resp.status + ' ' + txt.slice(0, 200));
    }
    const j = await resp.json();
    const content = j.choices?.[0]?.message?.content || '{}';
    return parseJSONCard(content, meta);
  } finally {
    clearTimeout(timer);
  }
}

function parseJSONCard(content, meta) {
  let txt = content.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf('{');
  const end = txt.lastIndexOf('}');
  if (start >= 0 && end > start) txt = txt.slice(start, end + 1);
  const obj = JSON.parse(txt);
  return {
    name: (obj.name || meta.title || meta.hostname || '未命名').toString().slice(0, 40),
    desc: (obj.desc || meta.desc || '').toString().slice(0, 60),
    category: (obj.category || '').toString().trim(),
    icon: (obj.icon || '').toString().trim()
  };
}

/* 无 AI 时的启发式识别 */
export function heuristicRecognize(meta, categories) {
  let category = '常用推荐';
  const pool = (meta.title + ' ' + meta.hostname + ' ' + meta.desc).toLowerCase();
  const kwMap = {
    '社区咨询': ['社区', '论坛', 'news', 'bbs'],
    '图标素材': ['icon', '图标'],
    '字体资源': ['font', '字体'],
    '摄影图库': ['photo', 'image', '图库', '摄影'],
    '在线工具': ['tool', '工具', 'convert', '压缩'],
    '在线配色': ['color', '配色'],
    'UI资源': ['ui', 'sketch', 'figma'],
    '视频教程': ['video', '教程', 'course']
  };
  for (const [cat, kws] of Object.entries(kwMap)) {
    if (kws.some((k) => pool.includes(k))) { category = cat; break; }
  }
  const icon = `https://icons.duckduckgo.com/ip3/${meta.hostname}.ico`;
  return {
    name: (meta.title || meta.hostname || '未命名').split(/[|—\-·]/)[0].trim().slice(0, 20) || meta.hostname,
    desc: (meta.desc || meta.hostname).slice(0, 50),
    category,
    icon
  };
}

/* ---------- 写入数据（upsert 单条链接） ---------- */
export function upsertCard(data, card) {
  const cats = data.categories || (data.categories = []);
  let cat = cats.find((c) => c.name === card.category);
  if (!cat && card.category) {
    cat = { id: slug(card.category), name: card.category, icon: '🆕', links: [] };
    cats.push(cat);
  }
  if (!cat) cat = cats[0];
  cat.links = cat.links || [];
  const link = {
    name: card.name,
    url: card.url,
    desc: card.desc || '',
    icon: card.icon || ''
  };
  const idx = cat.links.findIndex((l) => l.url === card.url);
  if (idx >= 0) cat.links[idx] = { ...cat.links[idx], ...link };
  else cat.links.push(link);
  return { category: cat.name, link };
}

/* ---------- base64 -> ArrayBuffer ---------- */
export function b64ToArrayBuffer(b64) {
  const clean = String(b64).replace(/^data:.*?;base64,/, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export const UPLOAD_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
};
