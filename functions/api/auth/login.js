// POST /api/auth/login -> 账号 + 密码登录，成功后返回 HMAC 签名会话 token
//
// 两类身份：
//   1. 超级管理员：config 里的 ADMIN_USER / ADMIN_PASSWORD（向后兼容，始终可用）
//   2. 注册账户：KV `accounts` 里的记录，必须 status=active（管理员审核通过）才能登录
import { loadConfig, sendJSON, readBody, issueToken, hasKV, bindingErrorResponse } from '../../_lib.js';
import {
  loadAccounts, saveAccounts, verifyPassword, safeEqual,
  ST_ACTIVE, ST_PENDING, ST_DISABLED, ST_REJECTED, ROLE_ADMIN, ROLE_USER
} from '../../_accounts.js';

// 轻量防爆破：仅作用于单个边缘 isolate 内存；生产级限流建议改用 KV / Durable Object / WAF 规则
const ATTEMPTS = new Map();
const MAX_ATTEMPTS = 8;
const COOLDOWN_MS = 5 * 60 * 1000;

function clientKey(request) {
  return request.headers.get('cf-connecting-ip')
    || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const cfg = await loadConfig(env);
    if (!cfg.ADMIN_PASSWORD) {
      return sendJSON({ error: '尚未初始化管理员账号', needSetup: true }, 409);
    }

    const key = clientKey(request);
    const rec = ATTEMPTS.get(key);
    if (rec && rec.until && Date.now() < rec.until) {
      return sendJSON({ error: '尝试过于频繁，请稍后再试' }, 429);
    }
    if (rec && rec.until && Date.now() >= rec.until) ATTEMPTS.delete(key);

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }

    const user = String((body && body.user) || '').trim();
    const pwd = String((body && body.password) || '');

    const fail = () => {
      const cur = ATTEMPTS.get(key) || { n: 0, until: 0 };
      cur.n += 1;
      if (cur.n >= MAX_ATTEMPTS) { cur.until = Date.now() + COOLDOWN_MS; cur.n = 0; }
      ATTEMPTS.set(key, cur);
      return sendJSON({ error: '账号或密码不正确' }, 401);
    };

    // ① 超级管理员优先（避免被同名注册账户遮蔽）
    const isSuper = !!cfg.ADMIN_USER
      && user.toLowerCase() === String(cfg.ADMIN_USER).toLowerCase()
      && safeEqual(pwd, cfg.ADMIN_PASSWORD);
    if (isSuper) {
      ATTEMPTS.delete(key);
      const t = await issueToken(env, cfg.ADMIN_USER, !!body.remember, ROLE_ADMIN);
      return sendJSON({ ok: true, ...t });
    }

    // ② 注册账户
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const list = await loadAccounts(env);
    const acc = list.find((a) => String(a.username).toLowerCase() === user.toLowerCase());
    if (!acc) return fail();

    const okPwd = await verifyPassword(pwd, acc);
    if (!okPwd) return fail();

    // 密码正确后再回状态，避免暴露账号是否存在
    if (acc.status === ST_PENDING) {
      return sendJSON({ error: '账号正在等待管理员审核，通过后即可登录', pending: true }, 403);
    }
    if (acc.status === ST_REJECTED) {
      return sendJSON({ error: '注册申请未通过' + (acc.note ? '：' + acc.note : ''), rejected: true }, 403);
    }
    if (acc.status !== ST_ACTIVE) {
      return sendJSON({ error: '账号已被禁用，请联系管理员', disabled: true }, 403);
    }

    ATTEMPTS.delete(key);
    acc.lastLoginAt = Date.now();
    await saveAccounts(env, list);
    const role = acc.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER;
    const t = await issueToken(env, acc.username, !!body.remember, role);
    return sendJSON({
      ok: true, ...t,
      nickname: acc.nickname || acc.username,
      status: acc.status
    });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '登录失败' }, 500);
  }
}
