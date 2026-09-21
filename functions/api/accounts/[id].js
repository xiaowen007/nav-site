// PATCH  /api/accounts/:id -> 管理员对账户执行审核 / 禁用 / 提权 / 降级 / 重置密码 / 改昵称
// DELETE /api/accounts/:id -> 删除账户
import { sendJSON, readBody, hasKV, bindingErrorResponse } from '../../_lib.js';
import {
  requireAdmin, loadAccounts, saveAccounts, publicAccount, hashPassword,
  resolveIdentity, validatePassword, ROLE_ADMIN, ROLE_USER,
  ST_ACTIVE, ST_PENDING, ST_DISABLED, ST_REJECTED
} from '../../_accounts.js';

// 动作表：把「受支持的改动」集中在一处，避免散落的字符串判断
const ACTIONS = {
  approve: '通过审核',
  reject: '驳回注册',
  disable: '禁用账户',
  enable: '恢复正常',
  promote: '设为管理员',
  demote: '降为普通用户',
  resetPassword: '重置密码',
  rename: '修改昵称'
};

function findTarget(list, id) {
  return list.find((a) => String(a.id) === String(id)) || null;
}

// 统计「仍然可用的管理员」数量：用于防止把最后一个管理员降级/禁用/删除而锁死后台
function countAdmins(list) {
  return list.filter((a) => a.role === ROLE_ADMIN && a.status === ST_ACTIVE).length;
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  try {
    if (!(await requireAdmin(request, env))) {
      return sendJSON({ error: '需要管理员权限', needAdmin: true }, 403);
    }
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }

    const action = String((body && body.action) || '').trim();
    if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      return sendJSON({ error: '不支持的操作：' + action }, 400);
    }

    const list = await loadAccounts(env);
    const acc = findTarget(list, params.id);
    if (!acc) return sendJSON({ error: '账户不存在' }, 404);

    const me = await resolveIdentity(request, env);
    const isSelf = me && me.user === acc.username;
    const note = String((body && body.note) || '').trim().slice(0, 100);

    // —— 防锁死：不能把自己降级/禁用/删除；不能让管理员数量归零 ——
    const wouldLoseAdmin = ['demote', 'disable'].includes(action) && acc.role === ROLE_ADMIN;
    if (isSelf && ['demote', 'disable'].includes(action)) {
      return sendJSON({ error: '不能对自己执行「' + ACTIONS[action] + '」，请让其他管理员操作' }, 400);
    }
    if (wouldLoseAdmin && countAdmins(list) <= 1) {
      return sendJSON({ error: '这是最后一个可用的管理员，请先指定另一位管理员' }, 400);
    }

    switch (action) {
      case 'approve':
        acc.status = ST_ACTIVE;
        acc.reviewedAt = Date.now();
        acc.reviewedBy = me ? me.user : '';
        acc.note = note;
        break;
      case 'reject':
        acc.status = ST_REJECTED;
        acc.reviewedAt = Date.now();
        acc.reviewedBy = me ? me.user : '';
        acc.note = note;
        break;
      case 'disable':
        acc.status = ST_DISABLED;
        acc.note = note;
        break;
      case 'enable':
        acc.status = ST_ACTIVE;
        acc.note = note;
        break;
      case 'promote':
        acc.role = ROLE_ADMIN;
        if (acc.status === ST_PENDING) acc.status = ST_ACTIVE; // 提权顺带完成审核
        break;
      case 'demote':
        acc.role = ROLE_USER;
        break;
      case 'rename': {
        const nick = String((body && body.nickname) || '').trim().slice(0, 20);
        if (!nick) return sendJSON({ error: '昵称不能为空' }, 400);
        acc.nickname = nick;
        break;
      }
      case 'resetPassword': {
        const pwd = String((body && body.password) || '');
        const err = validatePassword(pwd);
        if (err) return sendJSON({ error: err }, 400);
        const h = await hashPassword(pwd);
        acc.salt = h.salt; acc.iter = h.iter; acc.passHash = h.passHash;
        break;
      }
    }

    await saveAccounts(env, list);
    return sendJSON({ ok: true, action, actionText: ACTIONS[action], account: publicAccount(acc) });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '操作失败' }, 500);
  }
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  try {
    if (!(await requireAdmin(request, env))) {
      return sendJSON({ error: '需要管理员权限', needAdmin: true }, 403);
    }
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));

    const list = await loadAccounts(env);
    const acc = findTarget(list, params.id);
    if (!acc) return sendJSON({ error: '账户不存在' }, 404);

    const me = await resolveIdentity(request, env);
    if (me && me.user === acc.username) {
      return sendJSON({ error: '不能删除自己的账户' }, 400);
    }
    if (acc.role === ROLE_ADMIN && acc.status === ST_ACTIVE && countAdmins(list) <= 1) {
      return sendJSON({ error: '这是最后一个可用的管理员，不能删除' }, 400);
    }

    const next = list.filter((a) => String(a.id) !== String(params.id));
    await saveAccounts(env, next);
    return sendJSON({ ok: true, deleted: acc.username });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '删除失败' }, 500);
  }
}
