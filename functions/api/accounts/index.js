// GET /api/accounts -> 账户列表（仅管理员）
import { sendJSON, hasKV, bindingErrorResponse } from '../../_lib.js';
import { requireAdmin, loadAccounts, publicAccount, ST_PENDING } from '../../_accounts.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    if (!(await requireAdmin(request, env))) {
      return sendJSON({ error: '需要管理员权限', needAdmin: true }, 403);
    }
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const list = await loadAccounts(env);
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const accounts = list.map(publicAccount);
    return sendJSON({
      ok: true,
      accounts,
      total: accounts.length,
      pending: accounts.filter((a) => a.status === ST_PENDING).length
    });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '读取账户失败' }, 500);
  }
}
