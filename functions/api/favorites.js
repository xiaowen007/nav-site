// 常用收藏（账号维度，跨设备同步）
//
// GET  /api/favorites -> 当前登录账号的收藏列表
// POST /api/favorites -> 全量覆盖保存（body: { items: [...] }）
//
// 存储：KV 键 `fav:<username>`，一个账号一份，互不可见。刻意**不**做成
// 一个大对象按用户名分桶 —— 那样任何一次保存都要读改写整份数据，
// 并发写同一份 KV 会互相覆盖（KV 没有事务）。
//
// 未登录一律 401：前端拿到 401 就静默回落到 localStorage，不再重试。
// 未绑定 KV（本地/未配置）：返回 503，前端同样回落本地，不影响浏览。
import { hasKV, bindingErrorResponse, sendJSON, readBody } from '../_lib.js';
import { resolveIdentity } from '../_accounts.js';

const MAX_ITEMS = 300;        // 单个账号最多收藏条数（够用且能挡住滥用）
const MAX_URL = 500;
const MAX_NAME = 100;
const MAX_DESC = 200;
const MAX_ICON = 500;

const kvKey = (user) => 'fav:' + String(user || '');

/* 入库前把每条收敛成白名单字段，顺带限长、去重（按 url）。
 * 前端传来的结构就是卡片那套（url/name/desc/icon）+ 收藏时间 at，
 * 这里不再做业务判断，只保证「存进去的一定是干净、有界的数据」。 */
function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const it of raw.slice(0, MAX_ITEMS * 2)) {
    if (!it || typeof it !== 'object') continue;
    const url = String(it.url || '').trim().slice(0, MAX_URL);
    if (!/^https?:\/\//i.test(url)) continue;      // 非 http(s) 直接丢弃
    if (seen.has(url)) continue;                   // 同 url 只留第一条（保持前端给的顺序）
    seen.add(url);
    out.push({
      url,
      name: String(it.name || url).trim().slice(0, MAX_NAME) || url,
      desc: String(it.desc || '').trim().slice(0, MAX_DESC),
      icon: String(it.icon || '').trim().slice(0, MAX_ICON),
      at: Number(it.at) > 0 ? Math.floor(Number(it.at)) : 0
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const id = await resolveIdentity(request, env);
    if (!id) return sendJSON({ error: '请先登录', needAuth: true }, 401);
    if (!hasKV(env)) return sendJSON({ error: '存储未绑定', items: [], local: true }, 503);
    try {
      const v = await env.NAV_KV.get(kvKey(id.user), 'json');
      const items = Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
      return sendJSON({ ok: true, user: id.user, items, count: items.length });
    } catch (e) {
      // bindingErrorResponse 对"非未绑定类错误"返回 null —— 直接 return 会给出空响应体，
      // 前端拿不到 error 字段只能显示"请求失败"，所以这里必须兜一个 500。
      return bindingErrorResponse(e) || sendJSON({ error: e.message || '读取收藏失败' }, 500);
    }
  } catch (e) {
    return sendJSON({ error: e.message || '读取收藏失败' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const id = await resolveIdentity(request, env);
    if (!id) return sendJSON({ error: '请先登录', needAuth: true }, 401);
    if (!hasKV(env)) return sendJSON({ error: '存储未绑定', items: [], local: true }, 503);

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }

    const items = sanitizeItems(body && body.items);
    if (!items) return sendJSON({ error: 'items 必须是数组' }, 400);

    try {
      await env.NAV_KV.put(kvKey(id.user), JSON.stringify(items));
    } catch (e) {
      return bindingErrorResponse(e) || sendJSON({ error: e.message || '保存收藏失败' }, 500);
    }
    return sendJSON({ ok: true, user: id.user, count: items.length, savedAt: Date.now() });
  } catch (e) {
    return sendJSON({ error: e.message || '保存收藏失败' }, 500);
  }
}
