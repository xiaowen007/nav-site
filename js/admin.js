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
    authConfigured: false,
    // —— 账户体系 ——
    isAdmin: false,          // 当前登录者是否管理员（由 applyRoleGate 写入）
    role: null,              // 'admin' | 'user'
    meUser: '',              // 当前登录账号名（用于识别「这是你」，避免误操作自己）
    accounts: [],            // ⑩ 账户管理面板数据
    applications: []         // ⑪ 申请审核面板数据
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
    // 预览卡上的「有未保存的更改」角标，与顶栏保存按钮保持同一状态源
    const pv = $('#pvDirty');
    if (pv) pv.classList.toggle('on', !!state.dirty);
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
      pushPreview(); // 存盘后把新数据热更新给右侧预览（无需重新加载 iframe）
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
  /* 卡片大小：1 极小 / 2 小号 / 3 中号 / 4 大号 / 5 超大。
     取值与归一化规则必须和 js/app.js 的 cardSizeLevel() 完全一致：
     老数据里是 small/medium/large（small=原来的「紧凑」= 新尺度的中号），
     两边都做同一套映射，才不会出现「后台显示中号、前台按别的档渲染」。 */
  const CARD_SIZE_LABEL = { 1: '极小', 2: '小号', 3: '中号', 4: '大号', 5: '超大' };
  const CARD_SIZE_LEGACY = { small: 3, medium: 4, large: 5 };
  function cardSizeLevel(v) {
    const n = Math.round(+v);
    if (Number.isFinite(n) && n >= 1 && n <= 5) return n;
    return CARD_SIZE_LEGACY[v] || 3;
  }
  function syncCardSizeUI(lv) {
    const out = $('#setCardSizeVal');
    if (out) out.textContent = CARD_SIZE_LABEL[lv] || CARD_SIZE_LABEL[3];
    document.querySelectorAll('#cardSizeScale span').forEach((el) => {
      el.classList.toggle('on', +el.dataset.lv === lv);
    });
  }

  /* ===== 站点图标选择器（首页设置 → 站点信息 → 站点图标） =====
   * #setLogo 是**唯一数据源**：collectSettings() 只读它，点格子 = 往它写值。
   * 之所以不让格子自己存一份状态：侧栏的 click/input 委托统一走 collectSettings，
   * 只要值落在输入框里，「即时预览 + 脏标记 + 保存」三条链路就全都自然联动，
   * 不必为图标单开一条旁路（那样最容易出现「预览变了但保存没带上」）。
   * 预置图标来自 js/logos.js，第一个格子是「默认 🌐」。 */
  function renderLogoPicker() {
    const grid = $('#logoGrid');
    const L = window.NAV_LOGOS;
    if (!grid || !L) return; // logos.js 未加载时保持空网格，输入框仍可手填
    const items = [{ id: L.DEFAULT, name: '默认图标' }].concat(L.list);
    grid.innerHTML = items.map((it) =>
      '<button type="button" class="logo-pick" data-logo="' + esc(it.id) + '" title="' + esc(it.name) + '">' +
        (it.svg || '<span class="lp-emoji">' + esc(it.id) + '</span>') +
      '</button>'
    ).join('');
  }

  /* 把 #setLogo 的值同步到「预览方块 + 格子高亮 + 当前值文案」三处。
     三处读的都是同一个值，所以只需在值变化后调一次。 */
  function syncLogoUI() {
    const L = window.NAV_LOGOS;
    const input = $('#setLogo');
    if (!input) return;
    const val = input.value.trim() || (L ? L.DEFAULT : '');
    const pv = $('#logoPreview');
    if (pv && L) pv.innerHTML = L.markup(val);
    const hit = L && L.get(val);
    const nameEl = $('#logoCurName');
    if (nameEl) {
      nameEl.textContent = hit ? hit.name
        : (L && L.isImage(val) ? '自定义图片' : (val === (L && L.DEFAULT) ? '默认' : '自定义'));
    }
    const valEl = $('#logoCurVal');
    if (valEl) valEl.textContent = val;
    document.querySelectorAll('.logo-pick').forEach((b) => {
      b.classList.toggle('on', b.dataset.logo === val);
    });
  }

  function populateSettings() {
    const s = state.data.site || {};
    $('#setTitle').value = s.title || '';
    // 站点图标：空值 = 用默认图标（前台 renderHead 也是这个约定），
    // 所以回填时把空串原样放进输入框，不要替用户写死一个 '🌐'。
    $('#setLogo').value = s.logo || '';
    syncLogoUI();
    $('#setSubtitle').value = s.subtitle || '';
    $('#setFooter').value = s.footer || '';
    // 主页中心模块（正文顶部大标题）：与顶栏那份独立。空值 = 沿用站点名称 / 站点描述，
    // 所以回填时保持空字符串，不要把回落后的值写进输入框（否则用户一保存就被固化了）。
    $('#setHeroTitle').value = s.heroTitle || '';
    $('#setHeroSub').value = s.heroSub || '';

    ['searchPosition', 'categoryPosition', 'categoryArrangement'].forEach((k) => {
      const cur = s[k] || '';
      document.querySelectorAll('.seg-btn[data-key="' + k + '"]').forEach((b) => {
        b.classList.toggle('on', b.dataset.val === cur);
      });
    });

    // 壁纸类型的高亮**必须与前台真正渲染的东西一致**：
    // 有值却高亮「无」的话，用户看到的界面和保存出来的数据是两回事
    // （老数据 / 只填了值没选类型的情况都属此类）。所以这里按「值」推断一次。
    syncWallpaperTypeUI(s.wallpaperValue, s.wallpaperType);

    const sel = $('#setDefaultCategory');
    sel.innerHTML = '<option value="all">默认 [全部]</option>' +
      flatCats().map((x) =>
        '<option value="' + esc(x.cat.id) + '" ' + (s.defaultCategory === x.cat.id ? 'selected' : '') + '>' +
        '　'.repeat(x.depth - 1) + esc(x.cat.name) + '</option>'
      ).join('');

    $('#setRememberCategory').checked = !!s.rememberCategory;
    $('#setShowFavorites').checked = s.showFavorites !== false;

    const csLv = cardSizeLevel(s.cardSize);
    const csEl = $('#setCardSize');
    if (csEl) { csEl.value = csLv; syncCardSizeUI(csLv); }

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
    // 预置壁纸格子的「当前选中」高亮（值可能是内置款，也可能是用户手填的地址）
    syncWallpaperPickUI();

    // 字体（内置预设 + 自定义字体列表）
    $('#setFontSize').value = s.fontSize || 14;
    $('#setFontSizeVal').textContent = (s.fontSize || 14) + 'px';
    // 顶栏「站点名称 / 站点描述」的独立字号（默认值与 css/style.css 的 :root 保持一致）
    $('#setTitleSize').value = s.titleSize || 18;
    $('#setTitleSizeVal').textContent = (s.titleSize || 18) + 'px';
    $('#setSubtitleSize').value = s.subtitleSize || 12;
    $('#setSubtitleSizeVal').textContent = (s.subtitleSize || 12) + 'px';
    // 主页中心模块「中心名称 / 中心描述」的独立字号（同 :root 默认 24px / 14px）。
    // ⚠️ 必须显式回填：range 滑块在只有 min/max 没有 value 时，浏览器默认落在**量程中点**
    // （中心名称 12~48 → 30），不改的话后台一进来就显示 30px，与页面实际的 24px 不符。
    $('#setHeroTitleSize').value = s.heroTitleSize || 24;
    $('#setHeroTitleSizeVal').textContent = (s.heroTitleSize || 24) + 'px';
    $('#setHeroSubSize').value = s.heroSubSize || 14;
    $('#setHeroSubSizeVal').textContent = (s.heroSubSize || 14) + 'px';
    syncFontOptions();
    renderFonts();

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

  /* 纯函数：由「壁纸值」与「用户点选的类型」推出最终类型。无副作用，两处共用。
   *
   * 规则（按优先级）：
   *   ① 没有值            → 'none'（关闭壁纸）
   *   ② 没点过 / 点的是「无」→ 按值推断（用户直接粘地址是最常见的用法）
   *   ③ 点过具体类型       → 尊重用户选择；但若值与类型**明显矛盾**再纠正
   *      （例如点了「图片」却填了 linear-gradient(...)，前台会把它当 URL 包成
   *       url("linear-gradient(...)") 而渲染失败），'image' 作为兜底值不参与纠正。 */
  function resolveWallpaperType(value, picked) {
    const val = String(value == null ? '' : value).trim();
    if (!val) return 'none';
    const p = picked || '';
    if (!p || p === 'none') return guessWallpaperType(val);
    const guessed = guessWallpaperType(val);
    if (guessed !== 'image' && guessed !== p) return guessed;
    return p;
  }

  /* 把「壁纸类型」四个按钮的高亮，同步成与当前值真正一致的类型。
   *
   * 为什么需要它：有值却高亮「无」的话，界面和保存出来的数据是两回事 ——
   * 用户看着输入框里明明有地址、类型却写着「无」，点保存后主页当然没反应，
   * 而且完全看不出问题出在哪。老数据（只有值没有类型）、只填值没点类型
   * 这两种情况都靠这里纠正。 */
  function syncWallpaperTypeUI(value, type) {
    const cur = resolveWallpaperType(value, type);
    document.querySelectorAll('.seg-btn[data-key="wallpaperType"]').forEach((b) => {
      b.classList.toggle('on', b.dataset.val === cur);
    });
    return cur;
  }

  /* 把侧栏表单里的当前值收集进 state.data.site（只写内存，不落库）。
   * 「保存设置」与「实时预览」共用这一份逻辑：预览要在未保存时就反映改动，
   * 所以必须和保存走同样的取值路径，否则两边会看到不一样的结果。 */
  function collectSettings() {
    const s = state.data.site = state.data.site || {};
    s.title = $('#setTitle').value.trim();
    // 站点图标：空 = 恢复默认（前台 markup('') 同样回落默认图标，两边约定一致）。
    // 内置图标存 id（如 'pv:panel'），也允许 emoji / 图片地址，见 js/logos.js。
    s.logo = $('#setLogo').value.trim() || (window.NAV_LOGOS ? window.NAV_LOGOS.DEFAULT : '🌐');
    s.subtitle = $('#setSubtitle').value.trim();
    s.footer = $('#setFooter').value.trim();
    // 主页中心模块的文字：留空就删掉字段（前台 renderHead 会自动回落到 title / subtitle），
    // 而不是存一个空串 —— 空串虽然结果一样，但导出 / 迁移时看起来像"设了个空标题"。
    const hTitle = $('#setHeroTitle').value.trim();
    const hSub = $('#setHeroSub').value.trim();
    if (hTitle) s.heroTitle = hTitle; else delete s.heroTitle;
    if (hSub) s.heroSub = hSub; else delete s.heroSub;
    s.defaultCategory = $('#setDefaultCategory').value;
    s.rememberCategory = $('#setRememberCategory').checked;
    s.showFavorites = $('#setShowFavorites').checked;
    // 卡片大小：滑块存数字档位（1~5），老值 small/medium/large 由 cardSizeLevel 兜底映射
    s.cardSize = cardSizeLevel($('#setCardSize').value);
    s.cardColumns = +$('#setCardColumns').value || 0;
    s.cardRadius = +$('#setCardRadius').value;
    s.cardShadow = $('#setCardShadow').checked;
    s.showVisits = $('#setShowVisits').checked;
    const wpVal = $('#setWallpaperValue').value.trim();
    s.wallpaperValue = wpVal;
    // 壁纸类型必须与壁纸值**一致**：前台 applyWallpaper() 只要读到
    // type === 'none' 就直接走清理分支（连值都不看），所以类型一旦落错，
    // 表现就是「后台明明设了壁纸、主页毫无变化」。
    //
    // ⚠️ 这里踩过一个坑：原先是
    //     if (wpBtn) s.wallpaperType = wpBtn.dataset.val;
    //     else if (wpVal) s.wallpaperType = guessWallpaperType(wpVal);
    //   而 populateSettings() 在没有类型时会把「无」按钮点亮（避免类型全灭），
    //   于是 wpBtn **永远非空**，guessWallpaperType 那条兜底永远走不到 ——
    //   用户只在输入框填了图片地址、没点「图片」按钮，存出来就是
    //   { type: 'none', value: 'https://…/a.jpg' }，主页一片空白。
    //   现在统一走 resolveWallpaperType（与按钮高亮同一套判断，不会再漂移）。
    const wpBtn = document.querySelector('.seg-btn[data-key="wallpaperType"].on');
    s.wallpaperType = resolveWallpaperType(wpVal, wpBtn && wpBtn.dataset.val);
    s.wallpaperOpacity = +$('#setWallpaperOpacity').value;
    s.wallpaperBlur = +$('#setWallpaperBlur').value;
    // 字体
    s.fontSize = +$('#setFontSize').value || 14;
    // 顶栏站名 / 描述各自的字号（前台 applyTypography 写到 --title-size / --subtitle-size）
    s.titleSize = +$('#setTitleSize').value || 18;
    s.subtitleSize = +$('#setSubtitleSize').value || 12;
    // 主页中心模块的两个字号（前台写到 --hero-title-size / --hero-sub-size）
    s.heroTitleSize = +$('#setHeroTitleSize').value || 24;
    s.heroSubSize = +$('#setHeroSubSize').value || 14;
    s.fontFamily = $('#setFontFamily').value;
    return s;
  }

  async function saveSettings() {
    collectSettings();
    state.dirty = true; updateSaved();
    // 直接落库：原先只写进内存、还必须再点一次「💾 保存」才提交，这一步极易被忽略，
    // 正是「后台改了设置、主页毫无变化」的最常见人为原因。现在点一次即生效。
    const stEl = $('#settingsSaveStatus');
    stEl.className = 'sf-status';
    stEl.textContent = '保存中…';
    try {
      await saveAll();
      stEl.className = 'sf-status ok';
      stEl.textContent = '✓ 已保存，主页立即生效';
    } catch (e) {
      stEl.className = 'sf-status err';
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
    // 卡片大小滑块：拖动时即时更新刻度高亮（左侧预览由侧栏统一的 input 监听节流推送）
    const csEl = $('#setCardSize');
    if (csEl) csEl.addEventListener('input', (e) => syncCardSizeUI(+e.target.value));
    $('#setWallpaperOpacity').addEventListener('input', (e) => { $('#setWallpaperOpacityVal').textContent = (+e.target.value).toFixed(2); });
    $('#setWallpaperBlur').addEventListener('input', (e) => { $('#setWallpaperBlurVal').textContent = e.target.value; });

    // 壁纸「值」输入框：改值的瞬间把类型按钮同步过去。
    // 用户直接粘贴一个图片地址时，类型会自动跳成「图片」——
    // 不再出现「有地址却亮着『无』」的割裂状态（这正是「设了壁纸但主页没反应」的老病根）。
    $('#setWallpaperValue').addEventListener('input', (e) => {
      syncWallpaperTypeUI(e.target.value, '');
      syncWallpaperPickUI();
    });

    // 预置壁纸：点格子 = 把该款的「值 + 类型 + 推荐透明度/模糊」一次性写进表单。
    // 与站点图标选择器同一套路：#setWallpaperValue 仍是唯一数据源，
    // 写完交给侧栏统一的 click 委托去 collectSettings + pushPreview，
    // 不在这里重复调 pushPreview（两边都推会出现先后覆盖）。
    const wpPresetGrid = $('#wpPresetGrid');
    if (wpPresetGrid) {
      wpPresetGrid.addEventListener('click', (e) => {
        const cell = e.target.closest('.wp-pick');
        if (!cell) return;
        const item = window.NAV_WALLPAPERS &&
          window.NAV_WALLPAPERS.list.find((x) => x.id === cell.dataset.wp);
        if (!item) return;
        $('#setWallpaperValue').value = item.value;
        syncWallpaperTypeUI(item.value, item.type);
        if (item.opacity != null) {
          $('#setWallpaperOpacity').value = item.opacity;
          $('#setWallpaperOpacityVal').textContent = (+item.opacity).toFixed(2);
        }
        if (item.blur != null) {
          $('#setWallpaperBlur').value = item.blur;
          $('#setWallpaperBlurVal').textContent = item.blur;
        }
        syncWallpaperPickUI();
        const st = $('#wallpaperPickStatus');
        if (st) st.textContent = '已选「' + item.name + '」，点「保存设置」生效';
      });
      // 切换分组
      const tabs = $('#wpPresetTabs');
      if (tabs) {
        tabs.addEventListener('click', (e) => {
          const b = e.target.closest('.wp-ptab');
          if (!b) return;
          wpPresetGroup = b.dataset.group;
          tabs.querySelectorAll('.wp-ptab').forEach((x) => x.classList.toggle('on', x === b));
          renderWallpaperPresets();
        });
      }
    }

    // 字体：实时显示数值
    $('#setFontSize').addEventListener('input', (e) => { $('#setFontSizeVal').textContent = e.target.value + 'px'; });
    // 顶栏 / 中心四个字号滑块：拖动即时更新数值标签
    // （左侧预览由侧栏统一的 input 监听节流推送）
    $('#setTitleSize').addEventListener('input', (e) => { $('#setTitleSizeVal').textContent = e.target.value + 'px'; });
    $('#setSubtitleSize').addEventListener('input', (e) => { $('#setSubtitleSizeVal').textContent = e.target.value + 'px'; });
    $('#setHeroTitleSize').addEventListener('input', (e) => { $('#setHeroTitleSizeVal').textContent = e.target.value + 'px'; });
    $('#setHeroSubSize').addEventListener('input', (e) => { $('#setHeroSubSizeVal').textContent = e.target.value + 'px'; });

    // 站点图标：点预置格子 = 往 #setLogo 写值（写完后同步预览与高亮）。
    // 这里只负责「把值放进输入框」，随后的即时预览 / 脏标记由侧栏统一的
    // click 委托（bindStudio 里那一段）接管 —— 不要在这里重复调 pushPreview。
    const logoGrid = $('#logoGrid');
    if (logoGrid) {
      logoGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.logo-pick');
        if (!btn) return;
        $('#setLogo').value = btn.dataset.logo || '';
        syncLogoUI();
      });
    }
    // 手填 emoji / 图片地址：输入即刷新预览方块与格子高亮
    // （取空时显示回默认图标的预览，与「留空即恢复默认」的约定一致）
    $('#setLogo').addEventListener('input', syncLogoUI);

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
        // 值已被换成上传的图片地址，预置格子的高亮要跟着撤掉（否则会停在上一次点过的款上）
        syncWallpaperPickUI();
        prev.src = url; prev.style.display = 'inline-block';
        const sv = $('#settingsSaveStatus');
        if (sv) { sv.className = 'sf-status'; sv.textContent = '壁纸已选中，点「保存设置」生效'; }
        pushPreview();
      } catch (err) { st.textContent = '上传失败：' + err.message; }
      e.target.value = '';
    });
  }

  /* ================= 预置壁纸（导航主题 20 张 + 磨砂类为主，随项目自带） ================= */
  // 默认停在「导航主题」——那是本项目的成套装壁纸，进来先看到它最有用。
  let wpPresetGroup = 'nav';

  function renderWallpaperPresets() {
    const grid = $('#wpPresetGrid');
    const tabs = $('#wpPresetTabs');
    if (!grid || !window.NAV_WALLPAPERS) return;
    const W = window.NAV_WALLPAPERS;

    // 分组按钮只建一次，之后只切换高亮
    if (tabs && !tabs.children.length) {
      tabs.innerHTML = W.groups.map((g) =>
        '<button class="wp-ptab' + (g.id === wpPresetGroup ? ' on' : '') + '" type="button" data-group="' +
        esc(g.id) + '" title="' + esc(g.hint) + '">' + esc(g.name) + '</button>'
      ).join('');
    } else if (tabs) {
      tabs.querySelectorAll('.wp-ptab').forEach((b) => b.classList.toggle('on', b.dataset.group === wpPresetGroup));
    }

    const items = W.list.filter((x) => x.group === wpPresetGroup);
    grid.innerHTML = items.map((it) => {
      // 预览块：直接把它自己的背景值铺上去（css 款用 style，图片款用 img），
      // 这样「所见即所得」——不用点进去才知道长什么样。
      // 图片款优先用 thumb 小图：导航主题那 20 张原图单张 300KB+，
      // 后台一屏 20 格全拉原图会卡；小图只有 10KB 左右，铺在 100px 的格子里完全够看。
      const swatch = it.kind === 'img'
        ? '<img src="' + esc(it.thumb || it.value) + '" alt="" loading="lazy"/>'
        : '<i style="background:' + esc(it.value) + '"></i>';
      return '<button class="wp-pick" type="button" data-wp="' + esc(it.id) +
        '" title="' + esc(it.name) + '">' + swatch +
        '<span class="wp-pick-name">' + esc(it.name) + '</span></button>';
    }).join('');
    syncWallpaperPickUI();
  }

  /* 给格子打「当前选中」高亮：按 #setWallpaperValue 反查是哪一款预置。
     值对不上任何一款（用户手填的地址）时就全部取消高亮，不做模糊匹配。 */
  function syncWallpaperPickUI() {
    const grid = $('#wpPresetGrid');
    if (!grid || !window.NAV_WALLPAPERS) return;
    const cur = ($('#setWallpaperValue') ? $('#setWallpaperValue').value : '').trim();
    const hit = window.NAV_WALLPAPERS.find(cur);
    grid.querySelectorAll('.wp-pick').forEach((c) => {
      c.classList.toggle('on', !!hit && c.dataset.wp === hit.id);
    });
    const nameEl = $('#wallpaperCurName');
    if (nameEl) nameEl.textContent = hit ? hit.name : (cur ? '自定义' : '未设置');
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
        $('#wpStatus').textContent = '✓ 已选为壁纸，点「保存设置」生效';
        syncWallpaperPickUI();   // 在线库选的是外链，预置格子的高亮要让位
        pushPreview();
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
      // 预览 iframe 是独立文档，只在加载时读一次主题；这里顺带刷新它，
      // 免得后台切了深色、左侧预览还停在浅色。
      setTimeout(refreshPreview, 150);
    });
  }

  /* ================= 工作台：首页预览 + 右侧系统设置面板 =================
   * 布局：左列「首页预览 + 数据管理面板」，右列是 sticky 的设置侧栏。
   * 预览的实时性来自一条同源数据通道：后台把「内存中尚未保存」的 state.data
   * 写进 localStorage.nav_preview_data 并 postMessage 给 iframe，前台
   * （js/app.js 在 URL 带 preview=1 时）优先读这份数据并热更新重渲染。
   * 因此改设置不必先保存就能在左侧看到效果。
   */
  const SIDE_TAB_KEY = 'nav_admin_side_tab';
  const SIDE_OPEN_KEY = 'nav_admin_side_open';
  const PREVIEW_KEY = 'nav_preview_data';

  function switchSideTab(name) {
    const tabs = document.querySelectorAll('.side-tab');
    if (!tabs.length) return;
    let hit = false;
    tabs.forEach((b) => {
      const on = b.dataset.tab === name;
      if (on) hit = true;
      b.classList.toggle('on', on);
    });
    if (!hit) return; // tab 名已不存在（旧缓存），保持现状
    document.querySelectorAll('.side-view').forEach((v) => v.classList.toggle('on', v.dataset.view === name));
    try { localStorage.setItem(SIDE_TAB_KEY, name); } catch (e) {}
  }

  function setSideOpen(open) {
    const side = $('#studioSide');
    if (!side) return;
    side.classList.toggle('collapsed', !open);
    const btn = $('#sideOpen');
    if (btn) btn.classList.toggle('show', !open);
    try { localStorage.setItem(SIDE_OPEN_KEY, open ? '1' : '0'); } catch (e) {}
  }

  // 把当前 state.data 推给预览 iframe（先落盘、再 postMessage，两条路都走一遍）
  function pushPreview() {
    const frame = $('#pvFrame');
    if (!frame || !state.data) return;
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(state.data)); } catch (e) {}
    try {
      const w = frame.contentWindow;
      // 同源 iframe；显式指定 targetOrigin，避免把站点数据发给无关窗口
      if (w) w.postMessage({ type: 'nav-preview-data', data: state.data }, location.origin);
    } catch (e) {}
  }

  function refreshPreview() {
    const frame = $('#pvFrame');
    if (!frame) return;
    pushPreview(); // 先落盘，保证 iframe 重新加载时读到的是最新一份
    frame.src = 'index.html?preview=1&t=' + Date.now();
  }

  function bindStudio() {
    const side = $('#studioSide');
    if (!side) return;

    // 恢复上次的标签页与展开状态
    let savedTab = 'home', savedOpen = null;
    try { savedTab = localStorage.getItem(SIDE_TAB_KEY) || 'home'; } catch (e) {}
    try { savedOpen = localStorage.getItem(SIDE_OPEN_KEY); } catch (e) {}
    switchSideTab(savedTab);
    setSideOpen(savedOpen !== '0');

    $('#sideTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.side-tab');
      if (b) switchSideTab(b.dataset.tab);
    });
    $('#sideClose').addEventListener('click', () => setSideOpen(false));
    const openBtn = $('#sideOpen');
    if (openBtn) openBtn.addEventListener('click', () => setSideOpen(true));

    // —— 预览工具条 ——
    const seg = $('#pvDeviceSeg');
    if (seg) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b) return;
        seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
        const box = $('#pvDevice');
        if (box) box.className = 'pv-device ' + (b.dataset.device === 'desk' ? 'desk' : 'mob');
      });
    }
    const rf = $('#pvRefresh');
    if (rf) rf.addEventListener('click', refreshPreview);
    const op = $('#pvOpen');
    if (op) op.addEventListener('click', () => window.open('index.html', '_blank', 'noopener'));
    const frame = $('#pvFrame');
    if (frame) frame.addEventListener('load', () => { setTimeout(pushPreview, 80); });

    // —— 「取消」= 放弃未保存的改动，重新从服务端载入 ——
    const rs = $('#settingsReset');
    if (rs) rs.addEventListener('click', async () => {
      if (state.dirty && !confirm('放弃所有未保存的改动，重新载入当前数据？')) return;
      const st = $('#settingsSaveStatus');
      if (st) { st.className = 'sf-status'; st.textContent = '正在重新载入…'; }
      try {
        await loadData();
        populateSettings();
        await loadConfig();
        refreshPreview();
        if (st) { st.className = 'sf-status ok'; st.textContent = '已还原为服务端保存的内容'; }
      } catch (e) {
        if (st) { st.className = 'sf-status err'; st.textContent = '重新载入失败：' + e.message; }
      }
    });

    // —— 侧栏内的任何交互：先把表单值收进 state，再推给预览（节流 120ms）——
    // 这样开关 / 分段按钮这类「只在保存时才读值」的控件也能即时预览。
    let timer = null;
    const schedule = () => {
      try { collectSettings(); } catch (e) {}
      // 拖滑块 / 在输入框里打字同样是「有未保存的改动」，这里统一点亮脏标记。
      // 之前只有分段按钮和开关会置脏，于是拖完滑块后顶栏「保存更改」既不变色也不呼吸，
      // 用户很容易以为已经保存过了（预览虽然即时变了，但没落库）。
      if (!state.dirty) { state.dirty = true; updateSaved(); }
      clearTimeout(timer);
      timer = setTimeout(pushPreview, 120);
    };
    side.addEventListener('click', (e) => { if (e.target.closest('.seg-btn, button, .switch')) schedule(); });
    side.addEventListener('input', schedule);
    side.addEventListener('change', schedule);
  }

  /* ================= 主流程 ================= */
  async function main() {
    // 角色门禁放在最前：普通用户直接返回，既不加载导航数据也不请求账户/申请接口
    if (!(await applyRoleGate())) return;
    // 站点图标格子先铺好：它只依赖 js/logos.js，不依赖导航数据，
    // 且必须在 populateSettings()（里面会调 syncLogoUI 打高亮）之前完成。
    renderLogoPicker();
    // 预置壁纸同理：只依赖 js/wallpapers.js；高亮由 populateSettings 里的
    // syncWallpaperPickUI 补（那时才有真实的 wallpaperValue 可比对）
    renderWallpaperPresets();
    await loadData();
    populateSettings();
    await loadConfig();
    // 首次把数据同步给预览 iframe：iframe 可能先于数据到达就加载完，
    // 此时它读到的还是上一次会话残留的预览缓存，这里补一次热更新纠正。
    pushPreview();
    // 管理员专属：账户列表 + 待审申请（并发拉取，失败不影响主流程）
    await Promise.all([loadAccounts(), loadApplications()]);
  }

  /* ================= 账户管理 / 申请审核（仅管理员） =================
   * 角色门禁：普通用户虽然能登录（比如从首页登进来），但后台的管理面板一律隐藏，
   * 且服务端也会对 /api/accounts、/api/applications 审核动作返回 403。
   */
  const STATUS_TAG = { pending: '待审核', active: '正常', disabled: '已禁用', rejected: '未通过' };
  const STATUS_TEXT_APP = { pending: '待审核', active: '已通过', rejected: '未通过', disabled: '已禁用' };

  function fmtTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString('zh-CN'); } catch (e) { return ''; }
  }

  async function applyRoleGate() {
    let me = null;
    try { me = await apiPublic('/api/auth/me', 'GET'); } catch (e) { me = null; }
    // 未启用登录保护（ADMIN_REQUIRED=false）时后台整体开放，
    // 必须与服务端 requireAdmin 的放行策略一致，否则本地开发会把所有面板误隐藏。
    const openMode = !me || !me.required;
    state.isAdmin = openMode ? true : !!me.isAdmin;
    state.role = openMode ? 'admin' : ((me && me.role) || null);
    state.meUser = (me && me.user) || state.user || '';

    const notice = $('#roleNotice');
    if (state.isAdmin) {
      if (notice) notice.style.display = 'none';
      return true;
    }
    // 非管理员：隐藏全部管理面板与右侧设置侧栏，只留提示
    document.querySelectorAll('.panel, .studio-side').forEach((p) => { p.style.display = 'none'; });
    if (notice) {
      const u = $('#roleNoticeUser');
      if (u) u.textContent = (me && (me.nickname || me.user)) || state.meUser;
      notice.style.display = '';
    }
    return false;
  }

  /* ---------- 账户管理 ---------- */
  async function loadAccounts() {
    const box = $('#acctList');
    if (!box) return;
    box.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const r = await api('/api/accounts', 'GET');
      state.accounts = r.accounts || [];
      const badge = $('#acctPending');
      if (badge) {
        badge.textContent = (r.pending || 0) + ' 待审核';
        badge.className = 'ai-status ' + (r.pending ? 'ai-on' : 'ai-off');
      }
      const stat = $('#acctStat');
      if (stat) stat.textContent = '共 ' + (r.total || 0) + ' 个账户';
      renderAccounts();
    } catch (e) {
      box.innerHTML = '<p class="hint">读取失败：' + esc(e.message) + '</p>';
    }
  }

  function renderAccounts() {
    const box = $('#acctList');
    if (!box) return;
    const kw = (($('#acctFilter') && $('#acctFilter').value) || '').trim().toLowerCase();
    let list = state.accounts || [];
    if (kw) list = list.filter((a) => (a.username + ' ' + (a.nickname || '')).toLowerCase().includes(kw));
    if (!list.length) { box.innerHTML = '<p class="hint">' + (kw ? '没有匹配的账户' : '暂无注册账户') + '</p>'; return; }

    box.innerHTML = list.map((a) => {
      const isSelf = a.username === state.meUser;
      const ops = [];
      if (a.status === 'pending') {
        ops.push('<button class="btn sm tiny" data-act="approve" data-id="' + esc(a.id) + '">✓ 通过审核</button>');
        ops.push('<button class="btn sm tiny ghost" data-act="reject" data-id="' + esc(a.id) + '">✕ 驳回</button>');
      }
      if (a.status === 'active') {
        ops.push('<button class="btn sm tiny ghost" data-act="disable" data-id="' + esc(a.id) + '">禁用</button>');
      }
      if (a.status === 'disabled' || a.status === 'rejected') {
        ops.push('<button class="btn sm tiny" data-act="enable" data-id="' + esc(a.id) + '">恢复正常</button>');
      }
      if (a.status === 'active' || a.status === 'pending') {
        if (a.role === 'admin') {
          ops.push('<button class="btn sm tiny ghost" data-act="demote" data-id="' + esc(a.id) + '">降为普通用户</button>');
        } else {
          ops.push('<button class="btn sm tiny ghost" data-act="promote" data-id="' + esc(a.id) + '">设为管理员</button>');
        }
      }
      ops.push('<button class="btn sm tiny ghost" data-act="resetPassword" data-id="' + esc(a.id) + '">重置密码</button>');
      ops.push('<button class="btn sm tiny ghost" data-act="remove" data-id="' + esc(a.id) + '">删除</button>');

      return '<div class="row-card">' +
        '<div class="rc-main">' +
          '<div class="rc-title">' + esc(a.nickname || a.username) +
            ' <span class="tag ' + esc(a.role) + '">' + (a.role === 'admin' ? '管理员' : '普通用户') + '</span>' +
            (isSelf ? ' <span class="tag self">这是你</span>' : '') +
          '</div>' +
          '<div class="rc-sub">账号 ' + esc(a.username) +
            ' · 注册于 ' + esc(fmtTime(a.createdAt)) +
            (a.lastLoginAt ? ' · 最近登录 ' + esc(fmtTime(a.lastLoginAt)) : '') +
            (a.note ? ' · 备注：' + esc(a.note) : '') +
          '</div>' +
        '</div>' +
        '<span class="tag ' + esc(a.status) + '">' + esc(a.statusText || STATUS_TAG[a.status] || a.status) + '</span>' +
        '<div class="rc-ops">' + ops.join('') + '</div>' +
      '</div>';
    }).join('');

    box.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => onAcctAction(b.getAttribute('data-act'), b.getAttribute('data-id')));
    });
  }

  async function onAcctAction(action, id) {
    const acc = (state.accounts || []).find((a) => a.id === id);
    if (!acc) return;
    const label = { approve: '通过审核', reject: '驳回注册', disable: '禁用', enable: '恢复正常',
      promote: '设为管理员', demote: '降为普通用户', resetPassword: '重置密码', remove: '删除' }[action] || action;

    if (action === 'remove') {
      if (!confirm('确定删除账户「' + acc.username + '」？该操作不可恢复。')) return;
      try {
        await api('/api/accounts/' + encodeURIComponent(id), 'DELETE');
        await loadAccounts();
      } catch (e) { alert('删除失败：' + e.message); }
      return;
    }

    const body = { action };
    if (action === 'reject') {
      const note = prompt('请填写驳回理由（会展示给该用户，可留空）', '') || '';
      body.note = note;
    }
    if (action === 'resetPassword') {
      const pwd = prompt('请输入该账户的新密码（至少 6 位）', '');
      if (!pwd) return;
      body.password = pwd;
    }
    if (action === 'disable' && !confirm('确定禁用「' + acc.username + '」？其登录状态会立即失效。')) return;

    try {
      await api('/api/accounts/' + encodeURIComponent(id), 'PATCH', body);
      await loadAccounts();
    } catch (e) { alert(label + '失败：' + e.message); }
  }

  /* ---------- 申请审核 ---------- */
  function categoryOptions(selected) {
    const cats = (state.data && state.data.categories) || [];
    return '<option value="">选择归类…</option>' + cats.map((c) =>
      '<option value="' + esc(c.name) + '"' + (c.name === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>'
    ).join('');
  }

  async function loadApplications() {
    const box = $('#appList');
    if (!box) return;
    box.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const r = await api('/api/applications', 'GET');
      state.applications = r.applications || [];
      const badge = $('#appPending');
      if (badge) {
        badge.textContent = (r.pending || 0) + ' 待审核';
        badge.className = 'ai-status ' + (r.pending ? 'ai-on' : 'ai-off');
      }
      const stat = $('#appStat');
      if (stat) stat.textContent = '共 ' + (r.total || 0) + ' 条申请';
      renderApplications();
    } catch (e) {
      box.innerHTML = '<p class="hint">读取失败：' + esc(e.message) + '</p>';
    }
  }

  function renderApplications() {
    const box = $('#appList');
    if (!box) return;
    const list = state.applications || [];
    if (!list.length) { box.innerHTML = '<p class="hint">暂无用户申请</p>'; return; }

    box.innerHTML = list.map((a) => {
      const ops = [];
      if (a.status === 'pending') {
        ops.push('<select class="app-cat" data-id="' + esc(a.id) + '">' + categoryOptions(a.category) + '</select>');
        ops.push('<button class="btn sm tiny" data-app-act="approve" data-id="' + esc(a.id) + '">✓ 通过并收录</button>');
        ops.push('<button class="btn sm tiny ghost" data-app-act="reject" data-id="' + esc(a.id) + '">✕ 驳回</button>');
      } else {
        ops.push('<button class="btn sm tiny ghost" data-app-act="remove" data-id="' + esc(a.id) + '">删除记录</button>');
      }
      return '<div class="row-card">' +
        '<div class="rc-main">' +
          '<div class="rc-title">' + esc(a.name || '(未命名)') +
            (a.category ? ' <span class="tag">建议：' + esc(a.category) + '</span>' : '') +
          '</div>' +
          '<div class="rc-sub"><a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.url) + '</a>' +
            (a.desc ? '<br/>' + esc(a.desc) : '') +
            '<br/>由 ' + esc(a.nickname || a.username) + ' 提交于 ' + esc(fmtTime(a.createdAt)) +
            (a.reviewer ? ' · ' + esc(a.reviewer) + ' 已处理' : '') +
            (a.note ? ' · 意见：' + esc(a.note) : '') +
          '</div>' +
        '</div>' +
        '<span class="tag ' + esc(a.status === 'active' ? 'active' : a.status) + '">' +
          esc(STATUS_TEXT_APP[a.status] || a.statusText || a.status) + '</span>' +
        '<div class="rc-ops">' + ops.join('') + '</div>' +
      '</div>';
    }).join('');

    box.querySelectorAll('[data-app-act]').forEach((b) => {
      b.addEventListener('click', () => onAppAction(b.getAttribute('data-app-act'), b.getAttribute('data-id'), box));
    });
  }

  async function onAppAction(action, id, box) {
    if (action === 'remove') {
      if (!confirm('删除这条申请记录？')) return;
      try {
        await api('/api/applications/' + encodeURIComponent(id), 'DELETE');
        await loadApplications();
      } catch (e) { alert('删除失败：' + e.message); }
      return;
    }
    if (action === 'reject') {
      const note = prompt('请填写驳回理由（会展示给提交者，可留空）', '') || '';
      try {
        await api('/api/applications/' + encodeURIComponent(id), 'PATCH', { action: 'reject', note });
        await loadApplications();
      } catch (e) { alert('驳回失败：' + e.message); }
      return;
    }
    // 通过：取该行选中的分类
    const sel = box.querySelector('select.app-cat[data-id="' + id + '"]');
    const category = sel ? sel.value : '';
    if (!category) { alert('请先选择要收录到哪个分类'); return; }
    try {
      const r = await api('/api/applications/' + encodeURIComponent(id), 'PATCH', { action: 'approve', category });
      alert(r.message || '已通过并收录');
      await loadApplications();
      await loadAll();   // 重新拉导航数据，让①面板立刻能看到新增链接
    } catch (e) { alert('通过失败：' + e.message); }
  }

  function bindAccountsUI() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    on('#acctReload', 'click', () => loadAccounts());
    on('#acctFilter', 'input', () => renderAccounts());
    on('#appReload', 'click', () => loadApplications());
  }

  function bindAll() {
    bindAuth();
    bindTheme();
    bindSettings();
    bindCollapse();
    bindStudio();       // 右侧设置侧栏 + 首页预览（元素缺失时内部自动跳过）
    bindAccountsUI();   // ⑩ 账户管理 / ⑪ 申请审核 的刷新与筛选（元素缺失时内部自动跳过）

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
