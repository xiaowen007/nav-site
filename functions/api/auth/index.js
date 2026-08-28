// GET /api/auth -> 后台登录状态（公开接口，不返回任何密钥或密码）
import { loadConfig, sendJSON, verifyTokenRaw, tokenFromRequest } from '../../../_lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const cfg = await loadConfig(env);
  const s = await verifyTokenRaw(env, tokenFromRequest(request));
  return sendJSON({
    required: !!cfg.ADMIN_REQUIRED,
    configured: !!cfg.ADMIN_PASSWORD,
    user: cfg.ADMIN_USER || 'admin',
    loggedIn: !!s,
    loginUser: s ? s.u : null
  });
}
