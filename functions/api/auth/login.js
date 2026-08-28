// POST /api/auth/login -> 账号 + 密码登录，成功后返回 HMAC 签名会话 token
import { loadConfig, sendJSON, readBody, issueToken } from '../../../_lib.js';

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
  if (user !== cfg.ADMIN_USER || pwd !== cfg.ADMIN_PASSWORD) {
    const cur = ATTEMPTS.get(key) || { n: 0, until: 0 };
    cur.n += 1;
    if (cur.n >= MAX_ATTEMPTS) { cur.until = Date.now() + COOLDOWN_MS; cur.n = 0; }
    ATTEMPTS.set(key, cur);
    return sendJSON({ error: '账号或密码不正确' }, 401);
  }

  ATTEMPTS.delete(key);
  const t = await issueToken(env, user, !!body.remember);
  return sendJSON({ ok: true, ...t });
}
