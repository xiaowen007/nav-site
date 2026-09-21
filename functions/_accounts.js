// 共享导航 - 账户与申请（Cloudflare Pages Functions 端）
//
// 数据：账户表存 KV 键 `accounts`，申请单存 KV 键 `applications`。
// 说明：本文件以 `_` 开头，不会被当作路由；仅被 api/ 下的函数 import。
// 仅在已绑定 NAV_KV 时可用；未绑定时注册/登录返回「存储未绑定」提示（沿用 _lib 的降级策略）。

import {
  hasKV, requireKV, bindingErrorResponse, sendJSON, readBody, slug,
  loadConfig, verifyTokenRaw, tokenFromRequest, loadData, saveData, upsertCard
} from './_lib.js';

const KV_ACCOUNTS = 'accounts';
const KV_APPS = 'applications';

const PBKDF2_ITER = 100000;          // 密码派生迭代次数（WebCrypto PBKDF2-SHA256）
export const ROLE_ADMIN = 'admin';
export const ROLE_USER = 'user';

// 账户状态机：pending(待审核) -> active(正常) / rejected(审核拒绝)；active 可被 disabled(禁用)
export const ST_PENDING = 'pending';
export const ST_ACTIVE = 'active';
export const ST_DISABLED = 'disabled';
export const ST_REJECTED = 'rejected';
export const STATUS_TEXT = {
  pending: '待审核', active: '正常', disabled: '已禁用', rejected: '未通过'
};

/* ---------- 小工具 ---------- */
function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return toHex(b);
}
function newId(prefix) {
  // 不依赖 crypto.randomUUID（部分运行时可用性不一致），用随机 hex 更稳
  return prefix + '_' + Date.now().toString(36) + randomHex(4);
}
// 定长比较，避免时序侧信道
export function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ---------- 密码哈希（PBKDF2-SHA256，绝不存明文） ---------- */
export async function pbkdf2(password, saltHex, iter) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iter || PBKDF2_ITER, hash: 'SHA-256' },
    key, 256
  );
  return toHex(new Uint8Array(bits));
}
export async function hashPassword(password) {
  const salt = randomHex(16);
  const iter = PBKDF2_ITER;
  return { salt, iter, passHash: await pbkdf2(password, salt, iter) };
}
export async function verifyPassword(password, acc) {
  if (!acc || !acc.salt || !acc.passHash) return false;
  const h = await pbkdf2(password, acc.salt, acc.iter || PBKDF2_ITER);
  return safeEqual(h, acc.passHash);
}

/* ---------- 存储读写 ---------- */
export async function loadAccounts(env) {
  if (!hasKV(env)) return [];
  try {
    const list = await env.NAV_KV.get(KV_ACCOUNTS, 'json');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export async function saveAccounts(env, list) {
  await requireKV(env).put(KV_ACCOUNTS, JSON.stringify(list || []));
}
export async function loadApps(env) {
  if (!hasKV(env)) return [];
  try {
    const list = await env.NAV_KV.get(KV_APPS, 'json');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export async function saveApps(env, list) {
  await requireKV(env).put(KV_APPS, JSON.stringify(list || []));
}

// 对外输出的账户视图：务必剔除 salt / passHash
export function publicAccount(a) {
  if (!a) return null;
  return {
    id: a.id,
    username: a.username,
    nickname: a.nickname || '',
    role: a.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    status: a.status,
    statusText: STATUS_TEXT[a.status] || a.status,
    createdAt: a.createdAt || 0,
    reviewedAt: a.reviewedAt || 0,
    lastLoginAt: a.lastLoginAt || 0,
    note: a.note || ''
  };
}

/* ---------- 身份解析 ----------
 * 角色以「库里账户的当前状态」为准，而不是只看 token 里签的 r 字段，
 * 这样管理员禁用某个账户、或把它降级后，对方手里的旧 token 立即失效。
 * 向后兼容：老 token 没有 r 字段，但历史上只有超级管理员能登录，故视为 admin。
 */
export async function resolveIdentity(request, env) {
  const s = await verifyTokenRaw(env, tokenFromRequest(request));
  if (!s) return null;
  const cfg = await loadConfig(env);
  const role = s.r === ROLE_USER ? ROLE_USER : ROLE_ADMIN; // 老 token 无 r => admin
  // 超级管理员：config 里的 ADMIN_USER + ADMIN_PASSWORD 登录
  if (role === ROLE_ADMIN && s.u === cfg.ADMIN_USER) {
    return { user: s.u, role: ROLE_ADMIN, super: true, status: ST_ACTIVE };
  }
  const acc = (await loadAccounts(env)).find((a) => a.username === s.u);
  if (!acc) return null;                                  // 账户已被删除 -> 立即失效
  if (acc.status !== ST_ACTIVE) return null;              // 被禁用/未通过 -> 立即失效
  return {
    user: acc.username,
    role: acc.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER,
    super: false,
    status: acc.status,
    account: acc
  };
}

/* 是否管理员（写导航数据、管理账户、审核申请都要求） */
export async function requireAdmin(request, env) {
  if (!hasKV(env)) return true;              // 未绑定 KV：沿用只读降级策略
  const cfg = await loadConfig(env);
  if (!cfg.ADMIN_REQUIRED) return true;      // 显式关闭登录保护
  const id = await resolveIdentity(request, env);
  if (id && id.role === ROLE_ADMIN) return true;
  // 兼容旧的明文密码头（仅超级管理员）
  const pwd = request.headers.get('x-admin-password');
  return !!(pwd && cfg.ADMIN_PASSWORD && pwd === cfg.ADMIN_PASSWORD);
}

/* 是否已登录（任意有效账户） */
export async function requireLogin(request, env) {
  if (!hasKV(env)) return true;
  return !!(await resolveIdentity(request, env));
}

/* ---------- 校验 ---------- */
export function validateUsername(u) {
  const s = String(u || '').trim();
  if (s.length < 3) return '账号至少 3 个字符';
  if (s.length > 20) return '账号最多 20 个字符';
  if (!/^[A-Za-z0-9_.@-]+$/.test(s)) return '账号只能包含字母、数字、下划线、点、@ 和短横线';
  return '';
}
export function validatePassword(p) {
  const s = String(p || '');
  if (s.length < 6) return '密码至少 6 位';
  if (s.length > 64) return '密码最多 64 位';
  return '';
}
export function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { new URL(s); } catch { return ''; }
  return s;
}

/* ---------- 申请单的辅助 ---------- */
export const KINDS = { link: '添加网站' };
export function publicApp(a) {
  return {
    id: a.id,
    kind: a.kind || 'link',
    kindText: KINDS[a.kind] || '添加网站',
    username: a.username,
    nickname: a.nickname || '',
    name: a.name || '',
    url: a.url || '',
    desc: a.desc || '',
    category: a.category || '',
    icon: a.icon || '',
    status: a.status,
    statusText: STATUS_TEXT[a.status] || a.status,
    createdAt: a.createdAt || 0,
    reviewedAt: a.reviewedAt || 0,
    reviewer: a.reviewer || '',
    note: a.note || ''
  };
}

/* 申请审核通过后把链接写进导航数据；返回收录到的分类名 */
export async function applyAppToData(env, app, categoryName) {
  const data = await loadData(env);
  if (data.readOnly) { const e = new Error('存储未绑定，无法写入导航数据'); e.needBinding = true; throw e; }
  const cats = data.categories || [];
  // 指定的分类不存在时，落到第一个分类，避免凭空造出分类
  let target = cats.find((c) => c.name === categoryName) || cats[0];
  if (!target) throw new Error('导航里还没有任何分类，请先在后台新建分类');
  // 复用 upsertCard：同 url 已存在则更新，不会产生重复条目
  const card = {
    name: app.name, url: app.url, desc: app.desc || '',
    icon: app.icon || ('https://icons.duckduckgo.com/ip3/' + (safeHost(app.url)) + '.ico'),
    category: target.name
  };
  const r = upsertCard(data, card);
  await saveData(env, data);
  return r.category;
}
function safeHost(u) {
  try { return new URL(u).hostname; } catch { return 'example.com'; }
}

export { bindingErrorResponse, sendJSON, readBody, slug };
