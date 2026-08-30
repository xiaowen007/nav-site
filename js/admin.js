/* 共享导航 - 后台管理逻辑
 * 功能：账号密码登录 + 数据管理 + 批量选择与转移分类 + 分类生图
 *      + 搜索 + 拖拽排序 + AI 收录 + 导入导出（JSON / 浏览器书签 HTML）+ 配置
 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const TOKEN_KEY = 'navAdminToken';

  const state = {
    data: null,
    activeCatId: null,
    dirty: false,
    aiResults: [],
    filter: '',
    catModalEditId: null,
    catModalParentId: '',   // 新增分类时的父分类 id（空 = 建在顶层）
    catCollapsed: {},       // 后台分类树：已折叠的分类 id
    catUploadedIcon: '',
    sel: new Set(),          // 当前分类下已勾选的书签下标
    user: '',
    authRequired: true,
    authConfigured: false
  };

  // 轻量提示条（顶部浮现，自动消失）
  let toastTimer = null;
  function toast(msg, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;'
        + 'background:#1f2937;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;'
        + 'box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .2s,top .2s;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => { el.style.top = '18px'; el.style.opacity = '1'; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; el.style.top = '14px'; }, ms || 2200);
  }

  /* ================= 请求封装 ================= */
  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return ''; }
  }
  function setToken(tok, remember) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      if (remember) localStorage.setItem(TOKEN_KEY, tok);
      else sessionStorage.setItem(TOKEN_KEY, tok);
    } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  async function request(path, method, body, withToken) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (withToken) {
      const t = getToken();
      if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    }
    if (body) opt.body = JSON.stringify(body);
    const res = await fetch(path, opt);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  // 需要登录态的接口：401 时弹出登录框，登录成功后自动重试一次
  async function api(path, method, body, retry = 0) {
    const { res, data } = await request(path, method, body, true);
    if (res.status === 401) {
      clearToken();
      if (retry >= 1) throw new Error(data.error || '登录已失效');
      const ok = await showLogin(data.error || '登录已失效，请重新登录');
      if (!ok) throw new Error('已取消登录');
      return api(path, method, body, retry + 1);
    }
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // 无需登录态的接口（登录、初始化、状态查询）
  // 注意：仍会附带本地 token（若存在）。否则 /api/auth 拿不到 token 会一直返回
  // loggedIn=false，导致刷新/切换页面后明明已登录却被要求重新输入账号密码。
  async function apiPublic(path, method, body) {
    const { res, data } = await request(path, method, body, true);
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /* ================= 登录 ================= */
  let loginResolver = null;
  let loginPromise = null;
  let authMode = 'login'; // login | setup

  // 并发请求同时 401 时复用同一个登录弹窗，避免后一次覆盖前一次的 resolver 造成挂起
  function showLogin(msg) {
    if (loginPromise) {
      if (msg) $('#loginErr').textContent = msg;
      return loginPromise;
    }
    loginPromise = new Promise((resolve) => {
      const mask = $('#loginMask');
      mask.style.display = 'flex';
      $('#adminMain').style.display = 'none';
      $('#whoBox').style.display = 'none';
      $('#loginErr').textContent = msg || '';
      loginResolver = resolve;
      setTimeout(() => {
        const el = authMode === 'setup' ? $('#loginUser') : $('#loginUser');
        if (el) el.focus();
      }, 30);
    });
    return loginPromise;
  }
  function resolveLogin(ok) {
    const r = loginResolver;
    loginResolver = null;
    loginPromise = null;
    if (r) r(ok);
  }
  function hideLogin() {
    $('#loginMask').style.display = 'none';
    $('#adminMain').style.display = '';
    $('#whoBox').style.display = '';
  }

  function renderLoginForm(st) {
    const isSetup = authMode === 'setup';
    $('#loginTitle').textContent = isSetup ? '初始化管理员账号' : '后台登录';
    $('#loginDesc').textContent = isSetup
      ? '首次使用，请设置用于登录后台的账号与密码'
      : '该导航站已启用登录保护，请输入管理员账号与密码';
    $('#loginConfirmWrap').style.display = isSetup ? '' : 'none';
    $('#loginBtn').textContent = isSetup ? '创建并登录' : '登 录';
    $('#loginTip').textContent = isSetup
      ? '账号密码保存在服务端配置文件中，请妥善保管'
      : '登录状态仅保存在本机浏览器，不会上传';
    if (!isSetup && st && st.user) $('#loginUser').value = st.user;
    $('#loginPwd').value = '';
    $('#loginPwd2').value = '';
  }

  async function bootstrapAuth() {
    let st;
    try { st = await apiPublic('/api/auth', 'GET'); }
    catch (e) { $('#loginErr').textContent = '无法连接服务：' + e.message; return; }

    state.authRequired = !!st.required;
    state.authConfigured = !!st.configured;

    if (!st.required) { state.user = ''; hideLogin(); return; }
    if (st.loggedIn) { state.user = st.loginUser || ''; afterLogin(); return; }

    authMode = st.configured ? 'login' : 'setup';
    renderLoginForm(st);
    await showLogin();
  }

  function afterLogin() {
    hideLogin();
    $('#whoName').textContent = state.user || 'admin';
    $('#whoBox').style.display = '';
  }

  async function doLogin() {
    const err = $('#loginErr');
    err.textContent = '';
    const user = $('#loginUser').value.trim();
    const pwd = $('#loginPwd').value;
    const remember = $('#loginRemember').checked;

    if (!user) { err.textContent = '请输入账号'; return; }
    if (!pwd) { err.textContent = '请输入密码'; return; }
    if (authMode === 'setup') {
      if (pwd.length < 6) { err.textContent = '密码至少 6 位'; return; }
      if (pwd !== $('#loginPwd2').value) { err.textContent = '两次输入的密码不一致'; return; }
    }

    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '请稍候…';
    try {
      const r = authMode === 'setup'
        ? await apiPublic('/api/auth/setup', 'POST', { user, password: pwd })
        : await apiPublic('/api/auth/login', 'POST', { user, password: pwd, remember });
      setToken(r.token, remember);
      state.user = r.user || user;
      state.authConfigured = true;
      state.authRequired = true;
      afterLogin();
      resolveLogin(true);
    } catch (e) {
      err.textContent = e.message;
      // 初始化/登录时若后端返回「存储未绑定 NAV_KV」，顶部同步显示警示横幅
      if (e.message && (e.message.includes('NAV_KV') || e.message.includes('存储未绑定'))) toggleKvWarn(true);
    } finally {
      btn.disabled = false;
      $('#loginBtn').textContent = authMode === 'setup' ? '创建并登录' : '登 录';
    }
  }

  async function doLogout() {
    if (state.dirty && !confirm('有未保存的修改，确定退出登录？')) return;
    try { await apiPublic('/api/auth/logout', 'POST', {}); } catch (e) {}
    clearToken();
    state.dirty = false;
    location.reload();
  }

  function bindAuth() {
    $('#loginBtn').addEventListener('click', doLogin);
    ['#loginUser', '#loginPwd', '#loginPwd2'].forEach((s) => {
      $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    });
    $('#logoutBtn').addEventListener('click', doLogout);
  }

  /* ================= 工具 ================= */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'cat';
  }
  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }
  function isImgIcon(icon) { return !!icon && /^(https?:\/\/|\/uploads\/)/.test(icon); }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }
  async function uploadImage(file) {
    const dataUrl = await fileToDataURL(file);
    const r = await api('/api/upload', 'POST', { filename: file.name, data: dataUrl });
    return r.url;
  }
  function uniqueId(base, existing) {
    let id = base, n = 2;
    while (existing.has(id)) id = base + '-' + (n++);
    return id;
  }
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function stamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  }

  /* ================= 数据加载 ================= */
  async function loadData() {
    const d = await api('/api/sites', 'GET');
    // 递归规范化：确保所有层级都有 id / links，兼容旧的扁平数据
    walkCats(d.categories, (c) => {
      if (!c.id) c.id = slug(c.name || 'cat');
      c.links = c.links || [];
      c.links.forEach((l) => { if (l.visits == null) l.visits = 0; });
    });
    state.data = d;
    toggleKvWarn(!!d.readOnly); // KV 未绑定（部署后尚未手动绑定）时顶部显示警示横幅
    if (!state.activeCatId || !d.categories.find((c) => c.id === state.activeCatId)) {
      state.activeCatId = d.categories[0] ? d.categories[0].id : null;
    }
    state.dirty = false;
    state.sel.clear();
    renderCats(); renderLinks(); updateSaved();
  }

  /* ================= 分类管理 ================= */
  function iconInner(icon, fallback) {
    if (isImgIcon(icon)) {
      return `<img class="cat-ico" style="width:16px;height:16px;border-radius:4px;object-fit:contain;flex:none" src="${esc(icon)}" onerror="this.replaceWith(document.createTextNode('${esc(fallback)}'))"/>`;
    }
    return esc(icon || fallback);
  }

  /* ---------- 分类层级工具（支持 1~3 级） ---------- */
  const MAX_CAT_DEPTH = 3;
  function kids(c) { return Array.isArray(c && c.children) ? c.children : []; }
  // 深度优先遍历；回调返回 false 可跳过其子树
  function walkCats(list, fn, parent, depth) {
    (list || []).forEach((c) => {
      const goDown = fn(c, parent || null, depth || 1);
      if (goDown !== false && kids(c).length) walkCats(kids(c), fn, c, (depth || 1) + 1);
    });
  }
  // 按 id 定位，返回 { cat, parent, siblings, index, depth } 或 null
  function findCat(id) {
    let hit = null;
    walkCats(state.data.categories, (c, parent, depth) => {
      if (hit) return false;
      if (c.id === id) {
        const siblings = parent ? kids(parent) : state.data.categories;
        hit = { cat: c, parent, siblings, index: siblings.indexOf(c), depth };
        return false;
      }
    });
    return hit;
  }
  // 扁平化（带层级），供下拉框等使用
  function flatCats() {
    const out = [];
    walkCats(state.data.categories, (c, parent, depth) => { out.push({ cat: c, depth }); });
    return out;
  }
  // 含所有子孙的链接总数
  function countLinksDeep(c) {
    let n = (c.links || []).length;
    kids(c).forEach((k) => { n += countLinksDeep(k); });
    return n;
  }
  function countKidsDeep(c) {
    let n = 0;
    walkCats(kids(c), () => { n++; });
    return n;
  }
  function allCatIds() {
    const s = new Set();
    walkCats(state.data.categories, (c) => { s.add(c.id); });
    return s;
  }
  // id 是否为 node 的子孙（删除父分类后需重置选中项）
  function isDescendant(id, node) {
    let found = false;
    walkCats(kids(node), (c) => { if (c.id === id) found = true; });
    return found;
  }

  function renderCats() {
    const list = $('#catList'); list.innerHTML = '';
    (function renderLevel(items, parent, depth) {
      items.forEach((c) => {
        const children = kids(c);
        const collapsed = !!state.catCollapsed[c.id];
        const div = document.createElement('div');
        div.className = 'cat-item lv' + depth + (c.id === state.activeCatId ? ' active' : '');
        div.draggable = true;
        div.dataset.cid = c.id;
        div.dataset.parent = parent ? parent.id : '';
        div.dataset.depth = String(depth);
        const arrow = children.length
          ? '<span class="cat-arrow' + (collapsed ? ' collapsed' : '') + '" data-act="toggle" title="展开 / 收起">▾</span>'
          : '<span class="cat-arrow placeholder"></span>';
        const addChild = depth < MAX_CAT_DEPTH
          ? '<button class="mini" data-act="addchild" title="添加子分类">＋</button>'
          : '';
        div.innerHTML = `<span class="drag-handle">⋮⋮</span>${arrow}<span>${iconInner(c.icon, '🔗')}</span>
          <span class="cname">${esc(c.name)}</span>
          <span class="lv-tag">${depth} 级</span>
          <span class="cact">
            ${addChild}
            <button class="mini" data-act="rename" title="重命名/编辑">✎</button>
            <button class="mini" data-act="del" title="删除">🗑</button>
          </span>`;
        div.addEventListener('click', (e) => {
          const act = e.target.dataset.act;
          if (act) {
            e.stopPropagation();
            if (act === 'toggle') { state.catCollapsed[c.id] = !collapsed; renderCats(); return; }
            if (act === 'addchild') { openCatModal(null, c.id); return; }
            if (act === 'rename') openCatModal(c); else deleteCat(c);
            return;
          }
          if (state.activeCatId !== c.id) state.sel.clear();
          state.activeCatId = c.id; renderCats(); renderLinks();
        });
        list.appendChild(div);
        if (children.length && !collapsed) renderLevel(children, c, depth + 1);
      });
    })(state.data.categories, null, 1);
    bindCatDrag();
    fillMoveTarget();
  }

  function addCat() { openCatModal(null, ''); }
  function deleteCat(c) {
    const kidCount = countKidsDeep(c);
    let msg = `确定删除分类「${c.name}」`;
    if (kidCount) msg += ` 及其 ${kidCount} 个子分类`;
    msg += `（共 ${countLinksDeep(c)} 个链接）？`;
    if (!confirm(msg)) return;
    const hit = findCat(c.id);
    if (!hit) return;
    hit.siblings.splice(hit.index, 1);
    if (state.activeCatId === c.id || isDescendant(state.activeCatId, c)) {
      state.activeCatId = state.data.categories[0] ? state.data.categories[0].id : null;
    }
    delete state.catCollapsed[c.id];
    state.sel.clear();
    state.dirty = true; renderCats(); renderLinks(); updateSaved();
  }

  /* ---------- 分类生图（Canvas 本地生成，无需外部素材） ---------- */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const PALETTES = [
    ['#2f6fed', '#1aa179'], ['#f5576c', '#f093fb'], ['#4facfe', '#00f2fe'],
    ['#43e97b', '#38f9d7'], ['#fa709a', '#fee140'], ['#30cfd0', '#330867'],
    ['#667eea', '#764ba2'], ['#f6d365', '#fda085'], ['#5ee7df', '#b490ca'],
    ['#c471f5', '#fa71cd'], ['#0ba360', '#3cba92'], ['#ff9a9e', '#fad0c4']
  ];
  function firstChar(name) {
    const arr = Array.from(String(name || '').trim());
    return arr.length ? arr[0] : '?';
  }
  function drawIconCanvas(text, palette, size) {
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const r = size * 0.24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0); ctx.quadraticCurveTo(size, 0, size, r);
    ctx.lineTo(size, size - r); ctx.quadraticCurveTo(size, size, size - r, size);
    ctx.lineTo(r, size); ctx.quadraticCurveTo(0, size, 0, size - r);
    ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath(); ctx.clip();

    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, palette[0]); g.addColorStop(1, palette[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);

    // 装饰光斑
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(size * 0.84, size * 0.18, size * 0.30, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(size * 0.16, size * 0.90, size * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // 文字 / emoji
    const t = firstChar(text);
    let isEmoji = false;
    try { isEmoji = /\p{Extended_Pictographic}/u.test(t); } catch (e) { isEmoji = false; }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = size * 0.06; ctx.shadowOffsetY = size * 0.02;
    ctx.font = isEmoji
      ? `${Math.round(size * 0.5)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`
      : `700 ${Math.round(size * 0.52)}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    ctx.fillText(t, size / 2, size * 0.54);
    return cv;
  }

  let genSeed = 0;
  async function generateCatIcon(isRegenerate) {
    const name = $('#catNameInput').value.trim();
    const st = $('#catIconStatus');
    if (!name) { st.textContent = '请先填写分类名称'; $('#catNameInput').focus(); return; }
    genSeed = genSeed + (isRegenerate ? 1 : 0);
    const h = hashStr(name + '#' + genSeed);
    const palette = PALETTES[h % PALETTES.length];
    const cv = drawIconCanvas(name, palette, 160);

    const prev = $('#catIconPrev');
    prev.src = cv.toDataURL('image/png');
    prev.style.display = 'inline-block';
    $('#catIconGenNext').style.display = '';

    st.textContent = '生成中…';
    try {
      const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'cat-' + slug(name) + '-' + h.toString(36) + '.png', { type: 'image/png' });
      const url = await uploadImage(file);
      state.catUploadedIcon = url;
      $('#catIconInput').value = url;
      $('#catIconUrl').textContent = url;
      st.textContent = '✓ 已生成并设为图标';
    } catch (e) {
      st.textContent = '上传失败：' + e.message;
    }
  }

  /* 分类编辑模态框（emoji / 上传 / 生成图片） */
  function openCatModal(cat, parentId) {
    state.catModalEditId = cat ? cat.id : null;
    // 新增时记录父分类 id；为空表示建在顶层
    state.catModalParentId = cat ? '' : (parentId || '');
    state.catUploadedIcon = '';
    genSeed = 0;
    let title = '新增分类';
    if (cat) title = '编辑分类';
    else if (parentId) {
      const ph = findCat(parentId);
      title = '在「' + (ph ? ph.cat.name : '') + '」下新增子分类（' + ((ph ? ph.depth : 0) + 1) + ' 级）';
    }
    $('#catModalTitle').textContent = title;
    $('#catNameInput').value = cat ? cat.name : '';
    $('#catIconInput').value = cat ? (cat.icon || '') : '';
    $('#catIconStatus').textContent = '';
    $('#catIconGenNext').style.display = 'none';
    const prev = $('#catIconPrev');
    if (cat && isImgIcon(cat.icon)) {
      prev.src = cat.icon; prev.style.display = 'inline-block'; $('#catIconUrl').textContent = cat.icon;
    } else { prev.style.display = 'none'; $('#catIconUrl').textContent = ''; }
    $('#catModal').style.display = 'flex';
    $('#catNameInput').focus();
  }
  function closeCatModal() { $('#catModal').style.display = 'none'; state.catModalEditId = null; }
  function saveCatModal() {
    const name = $('#catNameInput').value.trim();
    if (!name) { alert('请输入分类名称'); return; }
    const icon = state.catUploadedIcon || $('#catIconInput').value.trim();
    if (state.catModalEditId) {
      const hit = findCat(state.catModalEditId);
      if (!hit) return;
      hit.cat.name = name; hit.cat.icon = icon;
    } else {
      const ids = allCatIds();
      if (ids.has(slug(name))) { alert('分类已存在'); return; }
      const id = uniqueId(slug(name), ids);
      const node = { id, name, icon, links: [], children: [] };
      const parentId = state.catModalParentId;
      if (parentId) {
        const hit = findCat(parentId);
        if (!hit) return;
        if (hit.depth >= MAX_CAT_DEPTH) { alert('最多只支持 ' + MAX_CAT_DEPTH + ' 级分类'); return; }
        hit.cat.children = kids(hit.cat);
        hit.cat.children.push(node);
        state.catCollapsed[parentId] = false; // 展开父级，让新建的子分类立刻可见
      } else {
        state.data.categories.push(node);
      }
      state.activeCatId = id;
    }
    state.dirty = true; renderCats(); renderLinks(); updateSaved(); closeCatModal();
  }

  /* ================= 链接管理 ================= */
  function activeCat() { const h = findCat(state.activeCatId); return h ? h.cat : null; }

  function visibleIndices(cat) {
    const kw = state.filter.trim().toLowerCase();
    const out = [];
    cat.links.forEach((l, i) => {
      if (kw && !(l.name + ' ' + (l.desc || '') + ' ' + l.url).toLowerCase().includes(kw)) return;
      out.push(i);
    });
    return out;
  }

  function renderLinks() {
    const cat = activeCat();
    const body = $('#linkBody');
    $('#curCatName').textContent = cat ? ('当前分类：' + cat.name + '（' + cat.links.length + '）') : '（无分类）';
    const totalCat = cat ? cat.links.reduce((a, l) => a + (l.visits || 0), 0) : 0;
    const totalAll = flatCats().reduce((a, x) => a + (x.cat.links || []).reduce((b, l) => b + (l.visits || 0), 0), 0);
    $('#statHint').innerHTML = `分类访问 <b>${totalCat}</b> · 总访问 <b>${totalAll}</b>`;
    body.innerHTML = '';
    if (!cat) { updateBatchBar(); return; }

    const idxs = visibleIndices(cat);
    idxs.forEach((i) => {
      const l = cat.links[i];
      const tr = document.createElement('tr');
      tr.draggable = !state.filter.trim(); tr.dataset.i = i;
      if (state.sel.has(i)) tr.classList.add('sel');
      tr.innerHTML = `
        <td class="col-chk"><input type="checkbox" class="selbox" data-i="${i}" ${state.sel.has(i) ? 'checked' : ''}/></td>
        <td><input data-f="name" data-i="${i}" value="${esc(l.name)}" placeholder="名称"/></td>
        <td><input data-f="url" data-i="${i}" value="${esc(l.url)}" placeholder="https://"/></td>
        <td class="col-desc"><input data-f="desc" data-i="${i}" value="${esc(l.desc)}" placeholder="简介"/></td>
        <td class="col-icon">
          <div class="icon-cell">
            <input data-f="icon" data-i="${i}" value="${esc(l.icon)}" placeholder="图标URL(留空自动)"/>
            <div class="icon-btns">
              <button class="mini" data-act="autoicon" data-i="${i}" title="自动匹配 favicon">🪄</button>
              <button class="mini" data-act="uploadicon" data-i="${i}" title="上传图标">⬆</button>
              <input type="file" class="upfile" data-i="${i}" accept="image/*" style="display:none"/>
              <img class="thumb-sm" id="prev-${i}" src="${esc(l.icon)}" onerror="this.style.display='none'" style="${l.icon ? '' : 'display:none'}"/>
            </div>
          </div>
        </td>
        <td class="col-visits">${l.visits || 0}</td>
        <td><div class="row-actions">
          <button class="btn sm ghost" data-act="up" data-i="${i}" title="上移">↑</button>
          <button class="btn sm ghost" data-act="down" data-i="${i}" title="下移">↓</button>
          <button class="btn sm ghost" data-act="del" data-i="${i}" title="删除">✕</button>
        </div></td>`;
      body.appendChild(tr);
    });
    if (!body.children.length) {
      body.innerHTML = '<tr><td colspan="7" class="hint" style="padding:14px">无匹配链接</td></tr>';
    }

    // 文本编辑
    body.querySelectorAll('input[data-f]').forEach((el) => {
      el.addEventListener('input', (e) => {
        cat.links[+e.target.dataset.i][e.target.dataset.f] = e.target.value;
        state.dirty = true; updateSaved();
      });
    });
    // 勾选
    body.querySelectorAll('.selbox').forEach((el) => {
      el.addEventListener('change', (e) => {
        const i = +e.target.dataset.i;
        if (e.target.checked) state.sel.add(i); else state.sel.delete(i);
        e.target.closest('tr').classList.toggle('sel', e.target.checked);
        updateBatchBar();
      });
    });
    // 操作按钮
    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onLinkAction(btn));
    });
    // 图标上传
    body.querySelectorAll('.upfile').forEach((inp) => {
      inp.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const i = +inp.dataset.i;
        try {
          const url = await uploadImage(file);
          cat.links[i].icon = url;
          state.dirty = true; renderLinks(); updateSaved();
        } catch (err) { alert('上传失败：' + err.message); }
        e.target.value = '';
      });
    });
    bindLinkDrag();
    updateBatchBar();
  }

  function onLinkAction(btn) {
    const i = +btn.dataset.i, act = btn.dataset.act, cat = activeCat();
    if (act === 'up' && i > 0) { [cat.links[i - 1], cat.links[i]] = [cat.links[i], cat.links[i - 1]]; state.sel.clear(); }
    else if (act === 'down' && i < cat.links.length - 1) { [cat.links[i + 1], cat.links[i]] = [cat.links[i], cat.links[i + 1]]; state.sel.clear(); }
    else if (act === 'del') { cat.links.splice(i, 1); state.sel.clear(); }
    else if (act === 'autoicon') {
      const h = hostnameOf(cat.links[i].url);
      if (!h) { alert('该链接没有有效网址，无法自动匹配'); return; }
      cat.links[i].icon = 'https://icons.duckduckgo.com/ip3/' + h + '.ico';
      state.dirty = true; renderLinks(); updateSaved(); return;
    }
    else if (act === 'uploadicon') {
      const inp = btn.parentElement.querySelector('.upfile');
      if (inp) inp.click();
      return;
    }
    state.dirty = true; renderLinks(); updateSaved();
  }

  function addLink() {
    const cat = activeCat();
    if (!cat) { alert('请先选择或新增一个分类'); return; }
    cat.links.push({ name: '', url: '', desc: '', icon: '', visits: 0 });
    state.dirty = true; renderLinks(); updateSaved();
  }

  function sortVisits() {
    const cat = activeCat(); if (!cat) return;
    cat.links.sort((a, b) => (b.visits || 0) - (a.visits || 0));
    state.sel.clear();
    state.dirty = true; renderLinks(); updateSaved();
  }

  /* ---------- 批量选择与转移 ---------- */
  function fillMoveTarget() {
    const sel = $('#moveTargetCat');
    if (!sel) return;
    const cur = state.activeCatId;
    const opts = state.data
      ? flatCats().filter((x) => x.cat.id !== cur)
          .map((x) => `<option value="${esc(x.cat.id)}">${'　'.repeat(x.depth - 1)}${esc(x.cat.name)}</option>`).join('')
      : '';
    sel.innerHTML = opts || '<option value="">（无其他分类）</option>';
  }

  function updateBatchBar() {
    const n = state.sel.size;
    $('#batchBar').style.display = n ? '' : 'none';
    $('#selCount').textContent = n;
    const cat = activeCat();
    const visible = cat ? visibleIndices(cat) : [];
    const all = $('#chkAll');
    if (all) {
      const selVisible = visible.filter((i) => state.sel.has(i)).length;
      all.checked = visible.length > 0 && selVisible === visible.length;
      all.indeterminate = selVisible > 0 && selVisible < visible.length;
    }
  }

  function selectedLinkObjects() {
    const cat = activeCat(); if (!cat) return [];
    return [...state.sel].sort((a, b) => a - b).map((i) => ({ i, link: cat.links[i] })).filter((x) => x.link);
  }

  function moveSelected() {
    const cat = activeCat();
    const targetId = $('#moveTargetCat').value;
    const tHit = findCat(targetId);
    const target = tHit ? tHit.cat : null;
    const items = selectedLinkObjects();
    if (!cat || !target) { alert('请选择目标分类'); return; }
    if (target.id === cat.id) { alert('目标分类与当前分类相同，无需转移'); return; }
    if (!items.length) return;
    if (!confirm(`将选中的 ${items.length} 个书签转移到「${target.name}」？`)) return;

    const moved = items.map((x) => x.link);
    items.map((x) => x.i).sort((a, b) => b - a).forEach((i) => cat.links.splice(i, 1));
    target.links = target.links || [];
    moved.forEach((l) => target.links.push(l));

    state.sel.clear();
    state.dirty = true;
    renderCats(); renderLinks(); updateSaved();
    const hint = $('#batchHint');
    hint.textContent = `已转移 ${moved.length} 个书签 → ${target.name}（记得点「💾 保存」）`;
    setTimeout(() => { hint.textContent = ''; }, 6000);
  }

  function deleteSelected() {
    const cat = activeCat();
    const items = selectedLinkObjects();
    if (!items.length) return;
    if (!confirm(`确定删除选中的 ${items.length} 个书签？`)) return;
    items.map((x) => x.i).sort((a, b) => b - a).forEach((i) => cat.links.splice(i, 1));
    state.sel.clear();
    state.dirty = true; renderLinks(); renderCats(); updateSaved();
  }

  function toggleSelectAll(on) {
    const cat = activeCat(); if (!cat) return;
    visibleIndices(cat).forEach((i) => { if (on) state.sel.add(i); else state.sel.delete(i); });
    renderLinks();
  }

  function updateSaved() {
    $('#savedDot').textContent = state.dirty ? '● 有未保存修改' : '✓ 已保存';
    $('#savedDot').style.color = state.dirty ? '#e8543f' : '#1aa179';
    const sb = $('#saveAll');
    if (sb) sb.classList.toggle('dirty', state.dirty); // 有未保存改动时保存按钮呼吸提示
  }

  // KV 未绑定（部署后尚未手动绑定）时显示顶部警示横幅
  // 登录遮罩内与后台页顶部各有一份，同 class 统一显隐
  function toggleKvWarn(show) {
    document.querySelectorAll('.kv-warn').forEach((el) => {
      el.style.display = show ? 'flex' : 'none';
    });
  }

  /* ---------- 面板折叠 ---------- */
  const COLLAPSE_KEY = 'nav_admin_collapsed';
  function getCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function bindCollapse() {
    const saved = getCollapsed();
    document.querySelectorAll('.panel > h2.ph-toggle').forEach((h2) => {
      const panel = h2.closest('.panel');
      const id = h2.dataset.panel;
      if (saved[id]) panel.classList.add('collapsed');
      h2.addEventListener('click', (e) => {
        // 标题内的按钮（如 AI 状态徽标）不触发折叠
        if (e.target.closest('button, a, input, label')) return;
        panel.classList.toggle('collapsed');
        const cur = getCollapsed();
        if (panel.classList.contains('collapsed')) cur[id] = 1; else delete cur[id];
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(cur)); } catch (err) {}
      });
    });
  }

  async function saveAll() {
    if (state.data && state.data.readOnly) {
      const msg = '存储未绑定 NAV_KV，无法保存：请到 Cloudflare 后台 Workers & Pages → nav-site → Settings → Functions 绑定 KV（变量名 NAV_KV）后重试。';
      $('#consoleStatus').textContent = msg;
      $('#consoleStatus').className = 'status err';
      throw new Error(msg); // 抛出，让调用方（如「保存设置」）也能感知失败
    }
    const btn = $('#saveAll'); btn.disabled = true;
    try {
      const r = await api('/api/sites', 'POST', state.data);
      state.dirty = false; updateSaved();
      $('#consoleStatus').textContent = `已保存：${r.categories} 个分类 / ${r.links} 条链接。`;
      $('#consoleStatus').className = 'status ok';
    } catch (e) {
      $('#consoleStatus').textContent = '保存失败：' + e.message;
      $('#consoleStatus').className = 'status err';
      throw e; // 抛出，让调用方（如「保存设置」）也能感知失败
    } finally { btn.disabled = false; }
  }

  /* ================= 拖拽排序 ================= */
  let dragFrom = null;
  function bindLinkDrag() {
    const body = $('#linkBody');
    body.querySelectorAll('tr[draggable="true"]').forEach((tr) => {
      tr.addEventListener('dragstart', () => { dragFrom = +tr.dataset.i; tr.classList.add('dragging'); });
      tr.addEventListener('dragend', () => { dragFrom = null; tr.classList.remove('dragging'); body.querySelectorAll('tr').forEach((x) => x.classList.remove('drop-over')); });
      tr.addEventListener('dragover', (e) => { e.preventDefault(); tr.classList.add('drop-over'); });
      tr.addEventListener('dragleave', () => tr.classList.remove('drop-over'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault(); tr.classList.remove('drop-over');
        const to = +tr.dataset.i; const cat = activeCat();
        if (dragFrom == null || dragFrom === to) return;
        const [item] = cat.links.splice(dragFrom, 1);
        cat.links.splice(to, 0, item);
        state.sel.clear();
        state.dirty = true; renderLinks(); updateSaved();
      });
    });
  }
  function bindCatDrag() {
    const list = $('#catList');
    list.querySelectorAll('.cat-item').forEach((el) => {
      el.addEventListener('dragstart', () => { dragFrom = el.dataset.cid; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { dragFrom = null; el.classList.remove('dragging'); list.querySelectorAll('.cat-item').forEach((x) => x.classList.remove('drop-over')); });
      el.addEventListener('dragover', (e) => {
        if (!dragFrom) return;
        // 仅允许在同一父级内重排：跨层级拖拽会把整棵子树误移进别的分支
        const a = findCat(dragFrom), b = findCat(el.dataset.cid);
        if (!a || !b || a.parent !== b.parent) return;
        e.preventDefault(); el.classList.add('drop-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); el.classList.remove('drop-over');
        const to = el.dataset.cid;
        if (!dragFrom || dragFrom === to) return;
        const a = findCat(dragFrom), b = findCat(to);
        if (!a || !b || a.parent !== b.parent) return;
        const sibs = a.siblings;
        const [item] = sibs.splice(a.index, 1);
        sibs.splice(sibs.indexOf(b.cat), 0, item);
        state.dirty = true; renderCats(); updateSaved();
      });
    });
  }

  /* ================= AI 自动收录 ================= */
  async function recognize() {
    const urls = $('#urlInput').value.trim().split(/\s+/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) { alert('请先粘贴至少一个网址'); return; }
    const btn = $('#recognizeBtn'); btn.disabled = true; btn.textContent = '识别中…';
    state.aiResults = [];
    try {
      for (const u of urls) {
        try { state.aiResults.push({ ...(await api('/api/recognize', 'POST', { url: u })), include: true }); }
        catch (e) { state.aiResults.push({ url: u, name: '(失败)', desc: e.message, category: '', icon: '', include: false, error: true }); }
      }
      renderResults(); $('#resultPanel').style.display = 'block';
    } finally { btn.disabled = false; btn.textContent = '识别并预览'; }
  }

  function renderResults() {
    const list = $('#resultList'); list.innerHTML = '';
    const cats = flatCats().map((x) => x.cat.name);
    state.aiResults.forEach((r, i) => {
      const div = document.createElement('div');
      div.style.cssText = 'display:grid;grid-template-columns:28px 1fr 1.4fr 1fr;gap:8px;align-items:center;padding:8px;border-bottom:1px solid var(--border)';
      const opts = cats.map((c) => `<option ${c === r.category ? 'selected' : ''}>${esc(c)}</option>`).join('')
        + `<option ${!cats.includes(r.category) ? 'selected' : ''} value="__new__">＋ 新建分类…</option>`;
      div.innerHTML = `
        <span><input type="checkbox" data-i="${i}" ${r.include ? 'checked' : ''}></span>
        <input type="text" data-i="${i}" data-f="name" value="${esc(r.name)}" placeholder="名称"/>
        <input type="url" data-i="${i}" data-f="url" value="${esc(r.url)}" placeholder="网址"/>
        <select data-i="${i}" data-f="category">${opts}</select>`;
      list.appendChild(div);
    });
    list.querySelectorAll('input,select').forEach((el) => {
      el.addEventListener('input', (e) => { state.aiResults[+e.target.dataset.i][e.target.dataset.f] = e.target.value; });
    });
  }

  async function writeSelected() {
    const sel = state.aiResults.filter((r) => r.include && r.url && !r.error);
    if (!sel.length) { $('#status').textContent = '没有可写入的项'; $('#status').className = 'status err'; return; }
    let ok = 0, fail = 0;
    for (const r of sel) {
      try { await api('/api/save', 'POST', { name: r.name, url: r.url, desc: r.desc, category: r.category, icon: r.icon || '' }); ok++; }
      catch (e) { fail++; console.warn(e); }
    }
    $('#status').textContent = `已写入 ${ok} 条${fail ? '，失败 ' + fail : ''}。已刷新控制台。`;
    $('#status').className = 'status ok';
    await loadData();
    populateSettings();
  }

  /* ================= 导入 / 导出 ================= */
  function exportPayload() {
    const scope = $('#exportScope').value;
    const withSite = $('#exportIncludeSite').checked;
    const site = withSite ? (state.data.site || {}) : undefined;
    if (scope === 'all') {
      return { site, categories: state.data.categories };
    }
    if (scope === 'current') {
      const c = activeCat();
      if (!c) { alert('请先选择一个分类'); return null; }
      return { site, categories: [JSON.parse(JSON.stringify(c))] };
    }
    // selected
    const items = selectedLinkObjects().map((x) => JSON.parse(JSON.stringify(x.link)));
    if (!items.length) { alert('请先在「① 导航数据管理」中勾选要导出的书签'); return null; }
    const c = activeCat();
    return { site, categories: [{ id: c ? c.id : 'selected', name: (c ? c.name : '选中书签'), icon: c ? c.icon : '', links: items }] };
  }

  function toBookmarkHtml(payload) {
    const lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<!-- This is an automatically generated file. Do not edit. -->');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Bookmarks</TITLE>');
    lines.push('<H1>Bookmarks</H1>');
    lines.push('');
    lines.push('<DL><p>');
    const t = Math.floor(Date.now() / 1000);
    for (const c of payload.categories) {
      lines.push(`    <DT><H3 ADD_DATE="${t}" LAST_MODIFIED="${t}">${esc(c.name || '未命名')}</H3>`);
      lines.push('    <DL><p>');
      for (const l of (c.links || [])) {
        const icon = l.icon ? ` ICON="${esc(l.icon)}"` : '';
        lines.push(`        <DT><A HREF="${esc(l.url)}" ADD_DATE="${t}"${icon}>${esc(l.name || l.url)}</A>`);
        if (l.desc) lines.push(`        <DD>${esc(l.desc)}`);
      }
      lines.push('    </DL><p>');
    }
    lines.push('</DL><p>');
    return lines.join('\n') + '\n';
  }

  function doExport() {
    const payload = exportPayload();
    if (!payload) return;
    const fmt = $('#exportFormat').value;
    const ts = stamp();
    try {
      if (fmt === 'html') {
        download(`bookmarks-${ts}.html`, toBookmarkHtml(payload), 'text/html;charset=utf-8');
      } else {
        download(`sites-${ts}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      }
      const hint = $('#exportHint');
      hint.textContent = '✓ 已导出';
      setTimeout(() => { hint.textContent = ''; }, 3000);
    } catch (e) {
      $('#exportHint').textContent = '导出失败：' + e.message;
    }
  }

  // 解析浏览器导出的 Netscape 书签 HTML
  // 注意：HTML5 解析器会把文件夹的 <DL> 解析为 <DT> 的子元素（而非兄弟节点），
  // 因此必须按「DT 容器内找 H3 / A / DL」的层级遍历，不能按兄弟顺序推断。
  function parseBookmarksHtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const cats = [];
    let lastLink = null;
    const ensureCat = (name) => {
      const n = (name || '').trim() || '导入书签';
      let c = cats.find((x) => x.name === n);
      if (!c) { c = { name: n, icon: '', links: [] }; cats.push(c); }
      return c;
    };
    const addLink = (a, cat) => {
      const href = (a.getAttribute('href') || '').trim();
      if (!/^https?:\/\//i.test(href)) return null;
      const c = cat || ensureCat('导入书签');
      const link = {
        name: (a.textContent || '').trim() || href,
        url: href,
        desc: (a.getAttribute('title') || '').trim(),
        icon: (a.getAttribute('icon') || '').trim(),
        visits: 0
      };
      c.links.push(link);
      return link;
    };
    const childByTag = (el, tag) => Array.from(el.children).find((x) => x.tagName.toUpperCase() === tag);
    const walkDl = (dl, folderCat) => {
      for (const dt of Array.from(dl.children)) {
        const tag = dt.tagName.toUpperCase();
        if (tag === 'DD') { // 上一条书签的描述
          if (lastLink && !lastLink.desc) lastLink.desc = (dt.textContent || '').trim();
          continue;
        }
        if (tag !== 'DT') continue;
        const h3 = childByTag(dt, 'H3');
        const a = childByTag(dt, 'A');
        const sub = childByTag(dt, 'DL');
        if (h3) {
          const cat = ensureCat(h3.textContent);
          if (sub) walkDl(sub, cat);
        } else if (a) {
          lastLink = addLink(a, folderCat);
        } else if (sub) {
          walkDl(sub, folderCat);
        }
      }
    };
    const root = doc.querySelector('DL');
    if (root) walkDl(root, null);

    // 兜底：非标准文件（无 DL 结构）时直接扫描全部链接
    if (!cats.length) {
      doc.querySelectorAll('a[href]').forEach((a) => { lastLink = addLink(a, null); });
    }
    return cats.filter((c) => c.links.length);
  }

  function normalizeImported(obj) {
    if (obj && Array.isArray(obj.categories)) {
      return obj.categories
        .map((c) => ({
          name: (String((c && c.name) || '').trim() || String((c && c.id) || '').trim()),
          icon: typeof c.icon === 'string' ? c.icon : '',
          links: Array.isArray(c.links) ? c.links.map((l) => ({
            name: String((l && l.name) || (l && l.url) || '').trim(),
            url: String((l && l.url) || '').trim(),
            desc: String((l && l.desc) || '').trim(),
            icon: String((l && l.icon) || '').trim(),
            visits: Number((l && l.visits) || 0) || 0
          })).filter((l) => l.url) : []
        }))
        .filter((c) => c.name && c.links.length);
    }
    return null;
  }

  // 递归合并：按层级在对应父节点下找同名分类，找不到就新建，并保留子分类结构
  function mergeImported(cats) {
    const stat = { newCats: 0, newLinks: 0, skipped: 0 };
    (function mergeLevel(list, parentNode) {
      const pool = parentNode ? kids(parentNode) : state.data.categories;
      for (const c of (list || [])) {
        if (!c || !c.name) continue;
        let target = pool.find((x) => x.name === c.name) || pool.find((x) => x.id === slug(c.name));
        if (!target) {
          const ids = allCatIds();
          target = { id: uniqueId(slug(c.name), ids), name: c.name, icon: c.icon || '', links: [], children: [] };
          pool.push(target);
          stat.newCats++;
        }
        const urls = new Set(target.links.map((l) => l.url));
        for (const l of (c.links || [])) {
          if (urls.has(l.url)) { stat.skipped++; continue; }
          target.links.push(l);
          urls.add(l.url);
          stat.newLinks++;
        }
        if (c.children && c.children.length) mergeLevel(c.children, target);
      }
    })(cats, null);
    return stat;
  }
  function countLinksOfList(list) {
    return (list || []).reduce((a, c) => a + (c.links || []).length + countLinksOfList(c.children), 0);
  }

  async function importDataFile(file) {
    const st = $('#importStatus');
    st.className = 'status'; st.textContent = '读取中…';
    try {
      const text = await file.text();
      const isHtml = /\.html?$/i.test(file.name) || /^\s*<!DOCTYPE NETSCAPE-Bookmark-file-1>/i.test(text);
      let cats;
      if (isHtml) {
        cats = parseBookmarksHtml(text);
        if (!cats.length) throw new Error('未能从书签文件中解析出任何网址');
      } else {
        const obj = JSON.parse(text);
        cats = normalizeImported(obj);
        if (!cats) throw new Error('JSON 格式不正确（缺少 categories 数组）');
      }

      const mode = $('#importMode').value;
      const total = countLinksOfList(cats);
      if (mode === 'replace') {
        if (!confirm(`覆盖导入：将清空现有 ${state.data.categories.length} 个分类，写入 ${cats.length} 个分类 / ${total} 条书签。确定继续？`)) {
          st.textContent = '已取消'; return;
        }
        const ids = new Set();
        const conv = (list) => (list || []).map((c) => {
          const id = uniqueId(slug(c.name) || 'cat', ids);
          ids.add(id); // 防止同名分类拿到重复 id
          return {
            id, name: c.name, icon: c.icon || '',
            links: Array.isArray(c.links) ? c.links.slice() : [],
            children: (c.children && c.children.length) ? conv(c.children) : []
          };
        });
        state.data.categories = conv(cats);
        state.activeCatId = state.data.categories[0] ? state.data.categories[0].id : null;
        state.sel.clear();
        st.textContent = `已覆盖导入：${cats.length} 个分类 / ${total} 条书签（尚未保存，请点「💾 保存」）`;
        st.className = 'status ok';
        state.dirty = true; renderCats(); renderLinks(); updateSaved(); populateSettings();
        return;
      }

      // 合并模式：先落库再刷新，避免丢失未保存的其它改动
      if (!confirm(`合并导入：将追加 ${cats.length} 个分类 / ${total} 条书签（重复网址会跳过）。确定继续？`)) {
        st.textContent = '已取消'; return;
      }
      const stat = mergeImported(cats);
      state.dirty = true; renderCats(); renderLinks(); updateSaved();
      st.textContent = `已合并：新增分类 ${stat.newCats} 个、书签 ${stat.newLinks} 条${stat.skipped ? `，跳过重复 ${stat.skipped} 条` : ''}（请点「💾 保存」）`;
      st.className = 'status ok';
      populateSettings();
    } catch (e) {
      st.textContent = '导入失败：' + e.message;
      st.className = 'status err';
    }
  }

  /* ================= 配置 ================= */
  async function loadConfig() {
    try {
      const cfg = await api('/api/config', 'GET');
      $('#cfgBase').value = cfg.base || '';
      $('#cfgModel').value = cfg.model || '';
      $('#cfgUser').value = cfg.user || 'admin';
      if (cfg.aiEnabled) { $('#aiStatus').textContent = '已开启 · ' + cfg.model; $('#aiStatus').className = 'ai-status ai-on'; }
      else { $('#aiStatus').textContent = '未开启（启发式）'; $('#aiStatus').className = 'ai-status ai-off'; }
      setAuthSeg(!!cfg.required);
    } catch (e) { console.warn(e); }
  }
  function setAuthSeg(on) {
    document.querySelectorAll('.seg-btn[data-auth="required"]').forEach((b) => {
      b.classList.toggle('on', (b.dataset.val === 'on') === !!on);
    });
  }
  async function saveCfg() {
    const payload = {
      AI_API_BASE: $('#cfgBase').value.trim(),
      AI_API_KEY: $('#cfgKey').value.trim(),
      AI_MODEL: $('#cfgModel').value.trim()
    };
    try {
      const r = await api('/api/config', 'POST', payload);
      $('#aiStatus').textContent = r.aiEnabled ? ('已开启 · ' + r.model) : '未开启（启发式）';
      $('#aiStatus').className = 'ai-status ' + (r.aiEnabled ? 'ai-on' : 'ai-off');
      alert(r.aiEnabled ? 'AI 已开启，已保存 config.json' : '已保存（未填 Key，使用启发式）');
    } catch (e) { alert('保存失败：' + e.message); }
  }
  async function saveAccount() {
    const hint = $('#accountHint');
    hint.textContent = '';
    const user = $('#cfgUser').value.trim();
    const oldPwd = $('#cfgOldPwd').value;
    const newPwd = $('#cfgNewPwd').value;
    const newPwd2 = $('#cfgNewPwd2').value;
    const requiredOn = document.querySelector('.seg-btn[data-auth="required"][data-val="on"]').classList.contains('on');

    if (user.length < 2) { hint.textContent = '账号至少 2 个字符'; return; }
    if (newPwd || newPwd2) {
      if (!oldPwd) { hint.textContent = '修改密码需填写当前密码'; return; }
      if (newPwd.length < 6) { hint.textContent = '新密码至少 6 位'; return; }
      if (newPwd !== newPwd2) { hint.textContent = '两次输入的新密码不一致'; return; }
    }
    if (!requiredOn && !confirm('关闭登录保护后，任何人都能直接打开后台并修改数据。确定关闭？')) return;

    const payload = { ADMIN_USER: user, ADMIN_REQUIRED: requiredOn };
    if (newPwd) { payload.ADMIN_PASSWORD = newPwd; payload.oldPassword = oldPwd; }
    try {
      const r = await api('/api/config', 'POST', payload);
      state.authRequired = !!r.required;
      setAuthSeg(!!r.required);
      $('#cfgOldPwd').value = ''; $('#cfgNewPwd').value = ''; $('#cfgNewPwd2').value = '';
      hint.textContent = '✓ 已保存' + (newPwd ? '（密码已更新，下次登录请用新密码）' : '');
      setTimeout(() => { hint.textContent = ''; }, 4000);
    } catch (e) { hint.textContent = '保存失败：' + e.message; }
  }

  /* ================= 系统设置（内联面板） ================= */
  function populateSettings() {
    const s = state.data.site || {};
    $('#setTitle').value = s.title || '';
    $('#setSubtitle').value = s.subtitle || '';
    $('#setFooter').value = s.footer || '';

    ['searchPosition', 'categoryPosition', 'categoryArrangement', 'cardSize', 'wallpaperType'].forEach((k) => {
      // 壁纸类型为空时默认高亮「无」，避免类型按钮全灭导致类型与壁纸值不同步
      const cur = s[k] || (k === 'wallpaperType' ? 'none' : '');
      document.querySelectorAll('.seg-btn[data-key="' + k + '"]').forEach((b) => {
        b.classList.toggle('on', b.dataset.val === cur);
      });
    });

    const sel = $('#setDefaultCategory');
    sel.innerHTML = '<option value="all">默认 [全部]</option>' +
      flatCats().map((x) =>
        '<option value="' + esc(x.cat.id) + '" ' + (s.defaultCategory === x.cat.id ? 'selected' : '') + '>' +
        '　'.repeat(x.depth - 1) + esc(x.cat.name) + '</option>'
      ).join('');

    $('#setRememberCategory').checked = !!s.rememberCategory;
    $('#setShowFavorites').checked = s.showFavorites !== false;

    $('#setCardColumns').value = s.cardColumns || 0;
    $('#setCardRadius').value = s.cardRadius != null ? s.cardRadius : 14;
    $('#setCardRadiusVal').textContent = s.cardRadius != null ? s.cardRadius : 14;
    $('#setCardShadow').checked = s.cardShadow !== false;
    $('#setShowVisits').checked = !!s.showVisits;

    $('#setWallpaperValue').value = s.wallpaperValue || '';
    $('#setWallpaperOpacity').value = s.wallpaperOpacity != null ? s.wallpaperOpacity : 0.08;
    $('#setWallpaperOpacityVal').textContent = s.wallpaperOpacity != null ? (+s.wallpaperOpacity).toFixed(2) : '0.08';
    $('#setWallpaperBlur').value = s.wallpaperBlur || 0;
    $('#setWallpaperBlurVal').textContent = s.wallpaperBlur || 0;

    // 字体（内置预设 + 自定义字体列表）
    $('#setFontSize').value = s.fontSize || 14;
    $('#setFontSizeVal').textContent = (s.fontSize || 14) + 'px';
    syncFontOptions();
    renderFonts();

    // 背景板
    $('#setContentPanel').checked = !!s.contentPanel;
    const cpo = s.contentPanelOpacity != null ? s.contentPanelOpacity : 0.85;
    $('#setContentPanelOpacity').value = cpo;
    $('#setContentPanelOpacityVal').textContent = (+cpo).toFixed(2);
    const cpr = s.contentPanelRadius != null ? s.contentPanelRadius : 16;
    $('#setContentPanelRadius').value = cpr;
    $('#setContentPanelRadiusVal').textContent = cpr;

    renderFuncIcons(s.functionIcons || []);

    // 缓存开关（顶栏）
    $('#cacheEnabled').checked = s.cacheEnabled === true;
    updateCacheStatus();

    // 搜索引擎管理
    renderEngines();
  }

  // 顶栏缓存控件：清除本机缓存（不含收藏 / 主题 / 登录态）
  const CACHE_KEYS = ['nav_data_cache', 'nav_active', 'nav_admin_collapsed', 'nav_search_engine'];
  function clearCache() {
    let n = 0;
    CACHE_KEYS.forEach((k) => {
      if (localStorage.getItem(k) != null) { localStorage.removeItem(k); n++; }
    });
    updateCacheStatus();
    toast('已清除本机缓存（' + n + ' 项）');
    return n;
  }
  function updateCacheStatus() {
    const el = $('#cacheStatus');
    if (!el) return;
    const has = CACHE_KEYS.some((k) => localStorage.getItem(k) != null);
    el.textContent = has ? '有缓存' : '';
  }

  function renderFuncIcons(list) {
    const wrap = $('#setFuncIcons'); wrap.innerHTML = '';
    if (!list.length) { wrap.innerHTML = '<p class="hint" style="margin:0">暂无功能图标，点击下方按钮添加</p>'; return; }
    list.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'func-icon-row';
      row.innerHTML =
        '<input class="fi-name" placeholder="名称" value="' + esc(f.name) + '" />' +
        '<input class="fi-url" placeholder="https://…" value="' + esc(f.url) + '" />' +
        '<input class="fi-icon" placeholder="🖼️" value="' + esc(f.icon || '') + '" title="emoji 或图片 URL" />' +
        '<label class="hint" style="display:flex;align-items:center;gap:3px;margin:0"><input type="checkbox" class="fi-ext" ' + (f.external ? 'checked' : '') + '/>新窗口</label>' +
        '<button class="fi-del" title="删除">✕</button>';
      row.querySelector('.fi-name').addEventListener('input', (e) => { f.name = e.target.value; state.dirty = true; updateSaved(); });
      row.querySelector('.fi-url').addEventListener('input', (e) => { f.url = e.target.value; state.dirty = true; updateSaved(); });
      row.querySelector('.fi-icon').addEventListener('input', (e) => { f.icon = e.target.value; state.dirty = true; updateSaved(); });
      row.querySelector('.fi-ext').addEventListener('change', (e) => { f.external = e.target.checked; state.dirty = true; updateSaved(); });
      row.querySelector('.fi-del').addEventListener('click', () => {
        list.splice(i, 1); renderFuncIcons(list); state.dirty = true; updateSaved();
      });
      wrap.appendChild(row);
    });
  }

  function addFuncIcon() {
    const s = state.data.site = state.data.site || {};
    s.functionIcons = s.functionIcons || [];
    s.functionIcons.push({ name: '新图标', url: '', icon: '🔗', external: true });
    renderFuncIcons(s.functionIcons);
    state.dirty = true; updateSaved();
  }

  /* ===== 搜索引擎管理（后台 ⑧ 面板） ===== */
  // 与 js/app.js 的 DEFAULT_ENGINES 保持一致，增删引擎时请同步两处
  const BUILTIN_ENGINES = [
    { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
    { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q=' },
    { id: 'google', name: '谷歌', url: 'https://www.google.com/search?q=' },
    { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query=' },
    { id: 'so360', name: '360', url: 'https://www.so.com/s?q=' },
    { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q=' },
    { id: 'bilibili', name: 'B站', url: 'https://search.bilibili.com/all?keyword=' },
    { id: 'taobao', name: '淘宝', url: 'https://s.taobao.com/search?q=' },
    { id: 'jd', name: '京东', url: 'https://search.jd.com/Search?keyword=' }
  ];

  // 保证 site.searchEngines 是可用数组；缺省视为启用
  function ensureEngines() {
    const s = state.data.site = state.data.site || {};
    if (!Array.isArray(s.searchEngines) || !s.searchEngines.length) {
      s.searchEngines = BUILTIN_ENGINES.map((e) => ({ id: e.id, name: e.name, url: e.url, enabled: true }));
    }
    s.searchEngines.forEach((e) => {
      if (!e) return;
      if (e.enabled === undefined) e.enabled = true;
      if (!e.id) e.id = 'e' + Math.random().toString(36).slice(2, 8);
    });
    return s.searchEngines;
  }

  function renderEngines() {
    const wrap = $('#engineList');
    if (!wrap) return;
    const list = ensureEngines();
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="hint font-empty">暂无搜索引擎，点「＋ 新增引擎」添加</p>';
      return;
    }
    list.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'engine-row' + (e.enabled === false ? ' off' : '');
      row.innerHTML =
        '<label class="switch" title="启用 / 停用"><input type="checkbox" class="eg-on"' +
        (e.enabled !== false ? ' checked' : '') + '><span class="slider"></span></label>' +
        '<input class="eg-name" type="text" placeholder="名称" value="' + esc(e.name || '') + '" />' +
        '<input class="eg-url" type="text" placeholder="https://…/s?wd=" value="' + esc(e.url || '') + '" />' +
        '<button class="eg-del" title="删除">✕</button>';
      row.querySelector('.eg-on').addEventListener('change', (ev) => {
        e.enabled = ev.target.checked;
        row.classList.toggle('off', !e.enabled);
        state.dirty = true; updateSaved();
      });
      row.querySelector('.eg-name').addEventListener('input', (ev) => {
        e.name = ev.target.value; state.dirty = true; updateSaved();
      });
      row.querySelector('.eg-url').addEventListener('input', (ev) => {
        e.url = ev.target.value; state.dirty = true; updateSaved();
      });
      row.querySelector('.eg-del').addEventListener('click', () => {
        list.splice(i, 1);
        renderEngines();
        state.dirty = true; updateSaved();
      });
      wrap.appendChild(row);
    });
  }

  function addEngine() {
    const list = ensureEngines();
    list.push({ id: 'e' + Date.now().toString(36), name: '新引擎', url: 'https://www.baidu.com/s?wd=', enabled: true });
    renderEngines();
    state.dirty = true; updateSaved();
  }

  function resetEngines() {
    const s = state.data.site = state.data.site || {};
    s.searchEngines = BUILTIN_ENGINES.map((e) => ({ id: e.id, name: e.name, url: e.url, enabled: true }));
    renderEngines();
    state.dirty = true; updateSaved();
  }

  /* ===== 自定义字体管理（站点信息 → 字体） ===== */
  // 重建「字体」下拉：内置预设 + 自定义字体分组
  function syncFontOptions() {
    const sel = $('#setFontFamily');
    if (!sel) return;
    const s = state.data.site || {};
    const cur = s.fontFamily || 'default';
    sel.innerHTML =
      '<option value="default">系统默认</option>' +
      '<option value="sans">无衬线（苹方 / 微软雅黑）</option>' +
      '<option value="serif">衬线（宋体 / 思源宋体）</option>' +
      '<option value="rounded">圆体</option>' +
      '<option value="kai">楷体</option>' +
      '<option value="mono">等宽</option>';
    const custom = (s.fonts || []).filter((f) => f && f.name);
    if (custom.length) {
      const g = document.createElement('optgroup');
      g.label = '自定义字体';
      custom.forEach((f) => {
        const o = document.createElement('option');
        o.value = f.id || f.name;
        o.textContent = f.name;
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    sel.value = cur;
    // 选中的字体已不存在（例如刚被删除）时回退到系统默认
    if (sel.value !== cur) sel.value = 'default';
  }

  function renderFonts() {
    const wrap = $('#fontList');
    if (!wrap) return;
    const s = state.data.site = state.data.site || {};
    const list = s.fonts || (s.fonts = []);
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<p class="hint font-empty">暂无自定义字体，点「＋ 新增字体」添加</p>';
      return;
    }
    list.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'font-row';
      row.innerHTML =
        '<input class="ft-name" type="text" placeholder="字体名" value="' + esc(f.name || '') + '" />' +
        '<input class="ft-stack" type="text" placeholder="字体栈，如 &quot;PingFang SC&quot;,sans-serif" value="' + esc(f.stack || '') + '" />' +
        '<button class="ft-del" title="删除字体">✕</button>';
      row.querySelector('.ft-name').addEventListener('input', (ev) => {
        f.name = ev.target.value;
        syncFontOptions();
        state.dirty = true; updateSaved();
      });
      row.querySelector('.ft-stack').addEventListener('input', (ev) => {
        f.stack = ev.target.value; state.dirty = true; updateSaved();
      });
      row.querySelector('.ft-del').addEventListener('click', () => {
        const removed = list[i];
        list.splice(i, 1);
        // 删掉的正是当前选中字体时，自动回退系统默认
        if (s.fontFamily && removed && (s.fontFamily === removed.id || s.fontFamily === removed.name)) {
          s.fontFamily = 'default';
        }
        syncFontOptions();
        renderFonts();
        state.dirty = true; updateSaved();
      });
      wrap.appendChild(row);
    });
  }

  function addFont() {
    const s = state.data.site = state.data.site || {};
    s.fonts = s.fonts || [];
    s.fonts.push({
      id: 'f' + Date.now().toString(36),
      name: '自定义字体',
      stack: '"PingFang SC","Microsoft YaHei",sans-serif'
    });
    syncFontOptions();
    renderFonts();
    state.dirty = true; updateSaved();
  }

  // 兼容早期只填了壁纸值、没选类型的数据：按内容推断类型
  function guessWallpaperType(v) {
    if (!v) return 'none';
    if (/gradient\(/i.test(v)) return 'gradient';
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v)) return 'color';
    return 'image';
  }

  async function saveSettings() {
    const s = state.data.site = state.data.site || {};
    s.title = $('#setTitle').value.trim();
    s.subtitle = $('#setSubtitle').value.trim();
    s.footer = $('#setFooter').value.trim();
    s.defaultCategory = $('#setDefaultCategory').value;
    s.rememberCategory = $('#setRememberCategory').checked;
    s.showFavorites = $('#setShowFavorites').checked;
    s.cardColumns = +$('#setCardColumns').value || 0;
    s.cardRadius = +$('#setCardRadius').value;
    s.cardShadow = $('#setCardShadow').checked;
    s.showVisits = $('#setShowVisits').checked;
    const wpVal = $('#setWallpaperValue').value.trim();
    s.wallpaperValue = wpVal;
    // 壁纸类型必须与壁纸值一起保存：缺失类型时前台会直接跳过壁纸渲染，
    // 表现为「后台设置了壁纸、主页毫无变化」。
    const wpBtn = document.querySelector('.seg-btn[data-key="wallpaperType"].on');
    if (wpBtn) s.wallpaperType = wpBtn.dataset.val;
    else if (wpVal) s.wallpaperType = guessWallpaperType(wpVal);
    else s.wallpaperType = 'none';
    s.wallpaperOpacity = +$('#setWallpaperOpacity').value;
    s.wallpaperBlur = +$('#setWallpaperBlur').value;
    // 字体
    s.fontSize = +$('#setFontSize').value || 14;
    s.fontFamily = $('#setFontFamily').value;
    // 背景板
    s.contentPanel = $('#setContentPanel').checked;
    s.contentPanelOpacity = +$('#setContentPanelOpacity').value;
    s.contentPanelRadius = +$('#setContentPanelRadius').value;
    state.dirty = true; updateSaved();
    // 直接落库：原先只写进内存、还必须再点一次「💾 保存」才提交，这一步极易被忽略，
    // 正是「后台改了设置、主页毫无变化」的最常见人为原因。现在点一次即生效。
    const stEl = $('#settingsSaveStatus');
    stEl.textContent = '保存中…';
    try {
      await saveAll();
      stEl.textContent = '✓ 已保存，刷新主页即可看到效果';
    } catch (e) {
      stEl.textContent = '✗ 保存失败：' + (e && e.message ? e.message : '未知错误');
    }
  }

  function bindSettings() {
    // saveSettings 为异步，需兜住可能的 rejection
    $('#settingsSave').addEventListener('click', () => { saveSettings().catch(() => {}); });

    document.querySelectorAll('.seg-btn[data-key]').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.key, val = b.dataset.val;
        b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.val === val));
        state.data.site = state.data.site || {};
        state.data.site[key] = val;
        state.dirty = true; updateSaved();
      });
    });

    document.querySelectorAll('.seg-btn[data-auth="required"]').forEach((b) => {
      b.addEventListener('click', () => {
        b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.val === b.dataset.val));
      });
    });

    $('#setCardRadius').addEventListener('input', (e) => { $('#setCardRadiusVal').textContent = e.target.value; });
    $('#setWallpaperOpacity').addEventListener('input', (e) => { $('#setWallpaperOpacityVal').textContent = (+e.target.value).toFixed(2); });
    $('#setWallpaperBlur').addEventListener('input', (e) => { $('#setWallpaperBlurVal').textContent = e.target.value; });

    // 字体与背景板：实时显示数值
    $('#setFontSize').addEventListener('input', (e) => { $('#setFontSizeVal').textContent = e.target.value + 'px'; });
    $('#setContentPanelOpacity').addEventListener('input', (e) => { $('#setContentPanelOpacityVal').textContent = (+e.target.value).toFixed(2); });
    $('#setContentPanelRadius').addEventListener('input', (e) => { $('#setContentPanelRadiusVal').textContent = e.target.value; });

    $('#addFuncIcon').addEventListener('click', addFuncIcon);
    $('#addEngine').addEventListener('click', addEngine);
    $('#resetEngines').addEventListener('click', resetEngines);
    $('#addFont').addEventListener('click', addFont);

    // 顶栏缓存控件
    $('#cacheEnabled').addEventListener('change', (e) => {
      state.data.site = state.data.site || {};
      state.data.site.cacheEnabled = e.target.checked;
      state.dirty = true; updateSaved();
    });
    $('#clearCacheBtn').addEventListener('click', clearCache);

    // 在线壁纸库
    bindWallpaperLib();

    // Ctrl / ⌘ + S 保存
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveAll().catch(() => {});
      }
    });

    $('#wallpaperUploadBtn').addEventListener('click', () => $('#wallpaperUploadFile').click());
    $('#wallpaperUploadFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const st = $('#wallpaperUploadStatus'); const prev = $('#wallpaperPreview');
      st.textContent = '上传中…'; prev.style.display = 'none';
      try {
        const url = await uploadImage(file);
        $('#setWallpaperValue').value = url;
        state.data.site = state.data.site || {};
        state.data.site.wallpaperType = 'image';
        state.data.site.wallpaperValue = url;
        document.querySelectorAll('.seg-btn[data-key="wallpaperType"]').forEach((x) => x.classList.toggle('on', x.dataset.val === 'image'));
        state.dirty = true; updateSaved();
        st.textContent = '✓ 已上传并设为壁纸';
        prev.src = url; prev.style.display = 'inline-block';
        $('#settingsSaveStatus').textContent = '✓ 已写入内存，点「① 导航数据管理」的「💾 保存」即可生效';
      } catch (err) { st.textContent = '上传失败：' + err.message; }
      e.target.value = '';
    });
  }

  /* ================= 在线壁纸库 ================= */
  const wpState = { source: 'bing', page: 1 };

  function renderWallpaperGrid() {
    const grid = $('#wpGrid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!wpState.list || !wpState.list.length) {
      grid.innerHTML = '<div class="wp-empty">暂无壁纸</div>';
      return;
    }
    const cur = ($('#setWallpaperValue').value || '').trim();
    wpState.list.forEach((w) => {
      const d = document.createElement('div');
      d.className = 'wp-item' + (w.url === cur ? ' on' : '');
      d.title = w.title || w.url;
      const img = document.createElement('img');
      img.src = w.thumb || w.url;
      img.alt = w.title || '';
      img.loading = 'lazy';
      d.appendChild(img);
      if (w.title) {
        const n = document.createElement('div');
        n.className = 'wp-name';
        n.textContent = w.title;
        d.appendChild(n);
      }
      d.addEventListener('click', () => {
        $('#setWallpaperValue').value = w.url;
        state.data.site = state.data.site || {};
        state.data.site.wallpaperType = 'image';
        state.data.site.wallpaperValue = w.url;
        document.querySelectorAll('.seg-btn[data-key="wallpaperType"]').forEach((x) => {
          x.classList.toggle('on', x.dataset.val === 'image');
        });
        grid.querySelectorAll('.wp-item').forEach((x) => x.classList.remove('on'));
        d.classList.add('on');
        state.dirty = true; updateSaved();
        $('#wpStatus').textContent = '✓ 已选为壁纸，点右上角「💾 保存更改」生效';
      });
      grid.appendChild(d);
    });
  }

  async function fetchWallpapers(page) {
    const st = $('#wpStatus');
    const grid = $('#wpGrid');
    if (!st || !grid) return;
    wpState.page = Math.max(1, page || 1);
    st.textContent = '获取中…';
    grid.innerHTML = '<div class="wp-empty">正在获取…</div>';
    const needQuery = (wpState.source === 'wallhaven' || wpState.source === '360');
    const q = needQuery ? ($('#wpQuery').value || '').trim() : '';
    try {
      const url = '/api/wallpapers?source=' + encodeURIComponent(wpState.source) +
        '&page=' + wpState.page + '&q=' + encodeURIComponent(q);
      const r = await api(url, 'GET');
      wpState.list = r.list || [];
      renderWallpaperGrid();
      st.textContent = wpState.list.length
        ? `共 ${wpState.list.length} 张（第 ${wpState.page} 页）`
        : '该源暂无结果，可换一页或换源试试';
    } catch (e) {
      wpState.list = [];
      grid.innerHTML = '<div class="wp-empty">获取失败：' + esc(e.message) + '</div>';
      st.textContent = '获取失败：' + e.message;
    }
  }

  function bindWallpaperLib() {
    const segs = document.querySelectorAll('.seg-btn[data-wsrc]');
    if (!segs.length) return;
    segs.forEach((b) => {
      b.classList.toggle('on', b.dataset.val === wpState.source);
      b.addEventListener('click', () => {
        segs.forEach((x) => x.classList.toggle('on', x.dataset.val === b.dataset.val));
        wpState.source = b.dataset.val;
        const needQuery = (wpState.source === 'wallhaven' || wpState.source === '360');
        $('#wpQueryRow').style.display = needQuery ? '' : 'none';
        fetchWallpapers(1);
      });
    });
    $('#wpQueryRow').style.display = 'none';
    $('#wpFetch').addEventListener('click', () => fetchWallpapers(wpState.page));
    $('#wpPrev').addEventListener('click', () => fetchWallpapers(wpState.page - 1));
    $('#wpNext').addEventListener('click', () => fetchWallpapers(wpState.page + 1));
    $('#wpQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchWallpapers(1); });
  }

  /* ================= 主题 ================= */
  function bindTheme() {
    $('#themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('theme', cur); } catch (e) {}
    });
  }

  /* ================= 主流程 ================= */
  async function main() {
    await loadData();
    populateSettings();
    await loadConfig();
  }

  function bindAll() {
    bindAuth();
    bindTheme();
    bindSettings();
    bindCollapse();

    $('#addCat').addEventListener('click', addCat);
    $('#addLink').addEventListener('click', addLink);
    // saveAll 失败时会 throw，需兜住 rejection
    $('#saveAll').addEventListener('click', () => { saveAll().catch(() => {}); });
    $('#recognizeBtn').addEventListener('click', recognize);
    $('#writeBtn').addEventListener('click', writeSelected);
    $('#saveCfg').addEventListener('click', saveCfg);
    $('#saveAccount').addEventListener('click', saveAccount);
    $('#sortVisits').addEventListener('click', sortVisits);

    // 批量操作
    $('#moveSelected').addEventListener('click', moveSelected);
    $('#deleteSelected').addEventListener('click', deleteSelected);
    $('#clearSelection').addEventListener('click', () => { state.sel.clear(); renderLinks(); });
    $('#chkAll').addEventListener('change', (e) => toggleSelectAll(e.target.checked));

    // 导入导出
    $('#doExport').addEventListener('click', doExport);
    $('#importDataFile').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (f) importDataFile(f);
      e.target.value = '';
    });

    // 分类模态框
    $('#catSave').addEventListener('click', saveCatModal);
    $('#catCancel').addEventListener('click', closeCatModal);
    $('#catModal').addEventListener('click', (e) => { if (e.target === $('#catModal')) closeCatModal(); });
    $('#catIconUpload').addEventListener('click', () => $('#catIconFile').click());
    $('#catIconGen').addEventListener('click', () => generateCatIcon(false));
    $('#catIconGenNext').addEventListener('click', () => generateCatIcon(true));
    $('#catIconFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const url = await uploadImage(file);
        state.catUploadedIcon = url;
        $('#catIconInput').value = url;
        const prev = $('#catIconPrev'); prev.src = url; prev.style.display = 'inline-block';
        $('#catIconUrl').textContent = url;
        $('#catIconStatus').textContent = '✓ 已上传';
      } catch (err) { alert('上传失败：' + err.message); }
      e.target.value = '';
    });

    $('#linkSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderLinks(); });
    $('#clearBtn').addEventListener('click', () => { $('#urlInput').value = ''; state.aiResults = []; $('#resultPanel').style.display = 'none'; });
    window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindAll();
    await bootstrapAuth();
    // bootstrapAuth 在需要登录时会等待登录完成；只有无需登录或已登录状态才继续
    if ($('#loginMask').style.display === 'none') await main();
  });
})();
