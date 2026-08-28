// GET /api/auth/verify -> 校验当前会话 token 是否有效
import { sendJSON, verifyTokenRaw, tokenFromRequest } from '../../../_lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const s = await verifyTokenRaw(env, tokenFromRequest(request));
  if (!s) return sendJSON({ error: '登录已失效，请重新登录', needAuth: true }, 401);
  return sendJSON({ ok: true, user: s.u, exp: s.exp });
}
