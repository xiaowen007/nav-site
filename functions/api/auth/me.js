// GET /api/auth/me -> 当前登录身份（用户名 / 角色 / 是否管理员），供前端决定显示哪些入口
// 公开可访问：未登录时返回 loggedIn:false，不泄露任何敏感信息
import { sendJSON, loadConfig, hasKV } from '../../_lib.js';
import { resolveIdentity, ROLE_ADMIN } from '../../_accounts.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const cfg = await loadConfig(env);
    const base = {
      required: !!cfg.ADMIN_REQUIRED,
      configured: !!cfg.ADMIN_PASSWORD,
      loggedIn: false,
      user: null,
      role: null,
      isAdmin: false,
      nickname: '',
      canRegister: hasKV(env) && !!cfg.ADMIN_REQUIRED
    };
    const id = await resolveIdentity(request, env);
    if (!id) return sendJSON(base);
    return sendJSON({
      ...base,
      loggedIn: true,
      user: id.user,
      role: id.role,
      isAdmin: id.role === ROLE_ADMIN,
      nickname: (id.account && id.account.nickname) || id.user,
      super: !!id.super
    });
  } catch (e) {
    return sendJSON({ error: e.message || '读取身份失败' }, 500);
  }
}
