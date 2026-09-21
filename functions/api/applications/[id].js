// PATCH  /api/applications/:id -> 管理员审核（通过则自动收录进导航）/ 驳回
//                              普通用户可撤回自己的待审申请
// DELETE /api/applications/:id -> 管理员删除申请记录
import { sendJSON, readBody, hasKV, bindingErrorResponse, loadData } from '../../_lib.js';
import {
  requireAdmin, resolveIdentity, loadApps, saveApps, publicApp, applyAppToData,
  ROLE_ADMIN, ST_PENDING, ST_ACTIVE, ST_REJECTED, STATUS_TEXT
} from '../../_accounts.js';

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  try {
    if (!hasKV(env)) return bindingErrorResponse(new Error('no kv'));
    const me = await resolveIdentity(request, env);
    if (!me) return sendJSON({ error: '请先登录', needLogin: true }, 401);

    let body;
    try { body = await readBody(request); }
    catch (e) { return sendJSON({ error: e.message }, 400); }
    const action = String((body && body.action) || '').trim();
    const note = String((body && body.note) || '').trim().slice(0, 100);

    const list = await loadApps(env);
    const app = list.find((a) => String(a.id) === String(params.id));
    if (!app) return sendJSON({ error: '申请不存在' }, 404);

    const isAdmin = me.role === ROLE_ADMIN;
    const isOwner = app.username === me.user;

    /* 普通用户：只能撤回自己的待审申请 */
    if (!isAdmin) {
      if (action !== 'withdraw') return sendJSON({ error: '只有管理员可以审核申请', needAdmin: true }, 403);
      if (!isOwner) return sendJSON({ error: '只能撤回自己的申请' }, 403);
      if (app.status !== ST_PENDING) return sendJSON({ error: '该申请已被处理，无法撤回' }, 400);
      const next = list.filter((a) => String(a.id) !== String(app.id));
      await saveApps(env, next);
      return sendJSON({ ok: true, action: 'withdraw', message: '已撤回申请' });
    }

    /* 管理员：通过与驳回 */
    if (!['approve', 'reject'].includes(action)) {
      return sendJSON({ error: '不支持的操作：' + action }, 400);
    }
    if (app.status !== ST_PENDING) {
      return sendJSON({ error: '该申请已处理过（当前：' + (STATUS_TEXT[app.status] || app.status) + '）' }, 400);
    }

    if (action === 'reject') {
      app.status = ST_REJECTED;
      app.reviewedAt = Date.now();
      app.reviewer = me.user;
      app.note = note;
      await saveApps(env, list);
      return sendJSON({ ok: true, action, application: publicApp(app) });
    }

    // 通过：先把链接真正写进导航数据，写成功才改申请状态（避免标记通过却没收录）
    const data = await loadData(env);
    const cats = data.categories || [];
    let targetName = String((body && body.category) || '').trim();
    if (!targetName || !cats.some((c) => c.name === targetName)) {
      targetName = app.category || (cats[0] && cats[0].name) || '';
    }
    if (!targetName) return sendJSON({ error: '导航里还没有任何分类，请先在后台新建分类' }, 400);

    const savedTo = await applyAppToData(env, app, targetName);

    app.status = ST_ACTIVE;   // 复用「正常」表示已通过
    app.reviewedAt = Date.now();
    app.reviewer = me.user;
    app.category = savedTo;
    app.note = note;
    await saveApps(env, list);

    return sendJSON({
      ok: true, action,
      savedTo,
      message: '已通过并收录到分类「' + savedTo + '」',
      application: publicApp(app)
    });
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
    const list = await loadApps(env);
    const app = list.find((a) => String(a.id) === String(params.id));
    if (!app) return sendJSON({ error: '申请不存在' }, 404);
    await saveApps(env, list.filter((a) => String(a.id) !== String(params.id)));
    return sendJSON({ ok: true, deleted: app.id });
  } catch (e) {
    const r = bindingErrorResponse(e);
    if (r) return r;
    return sendJSON({ error: e.message || '删除失败' }, 500);
  }
}
