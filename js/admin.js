/* 共享导航 - 后台管理逻辑
 * 功能：数据管理 + 搜索 + 拖拽排序 + 登录保护 + AI 收录 + 配置
 *      + 图标上传/自动匹配 + 分类图标上传 + 链接访问统计 + 导入/导出 JSON
 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const state = { data: null, activeCatId: null, dirty: false, aiResults: [], password: '', protected: false, filter: '', catModalEditId: null, catUploadedIcon: '' };

  /* ---------- 带鉴权的请求 ---------- */
  async function api(path, method, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const opt = { method, headers: { 'Content-Type': 'application/json' } };
      if (state.password) opt.headers['X-Admin-Password'] = state.password;
      if (body) opt.body = JSON.stringify(body);
      const res = await fetch(path, opt);
      if (res.status === 401) {
        state.password = ''; try { sessionStorage.removeItem('adminPwd'); } catch (e) {}
        $('#loginErr').textContent = '密码错误，请重试';
        await showLogin();
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }
    throw new Error('认证失败');
  }

  function showLogin() {
    return new Promise((resolve) => {
      const mask = $('#loginMask'); mask.style.display = 'flex'; $('#loginPwd').value = '';
      const submit = () => {
        const p = $('#loginPwd').value;
        if (!p) { $('#loginErr').textContent = '请输入密码'; return; }
        state.password = p; try { sessionStorage.setItem('adminPwd', p); } catch (e) {}
        mask.style.display = 'none';
        $('#loginBtn').removeEventListener('click', submit);
        $('#loginPwd').removeEventListener('keydown', onKey);
        resolve();
      };
      const onKey = (e) => { if (e.key === 'Enter') submit(); };
      $('#loginBtn').addEventListener('click', submit);
      $('#loginPwd').addEventListener('keydown', onKey);
      $('#loginPwd').focus();
    });
  }

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

  /* ---------- 数据加载 ---------- */
  async function loadData() {
    const d = await api('/api/sites', 'GET');
    d.categories.forEach((c) => { if (!c.id) c.id = slug(c.name || 'cat'); c.links = c.links || []; c.links.forEach((l) => { if (l.visits == null) l.visits = 0; }); });
    state.data = d;
    if (!state.activeCatId || !d.categories.find((c) => c.id === state.activeCatId)) {
      state.activeCatId = d.categories[0] ? d.categories[0].id : null;
    }
    state.dirty = false;
    renderCats(); renderLinks(); updateSaved();
  }

  /* ---------- 分类管理 ---------- */
  function iconInner(icon, fallback) {
    if (isImgIcon(icon)) {
      return `<img class="cat-ico" style="width:16px;height:16px;border-radius:4px;object-fit:contain;flex:none" src="${esc(icon)}" onerror="this.replaceWith(document.createTextNode('${esc(fallback)}'))"/>`;
    }
    return esc(icon || fallback);
  }

  function renderCats() {
    const list = $('#catList'); list.innerHTML = '';
    state.data.categories.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'cat-item' + (c.id === state.activeCatId ? ' active' : '');
      div.draggable = true; div.dataset.cid = c.id;
      div.innerHTML = `<span class="drag-handle">⋮⋮</span><span>${iconInner(c.icon, '🔗')}</span>
        <span class="cname">${esc(c.name)}</span>
        <span class="cact">
          <button class="mini" data-act="rename" title="重命名/编辑">✎</button>
          <button class="mini" data-act="del" title="删除">🗑</button>
        </span>`;
      div.addEventListener('click', (e) => {
        if (e.target.dataset.act) {
          e.stopPropagation();
          if (e.target.dataset.act === 'rename') openCatModal(c); else deleteCat(c);
          return;
        }
        state.activeCatId = c.id; renderCats(); renderLinks();
      });
      list.appendChild(div);
    });
    bindCatDrag();
  }

  function addCat() { openCatModal(null); }
  function deleteCat(c) {
    if (!confirm(`确定删除分类「${c.name}」及其 ${c.links.length} 个链接？`)) return;
    state.data.categories = state.data.categories.filter((x) => x.id !== c.id);
    if (state.activeCatId === c.id) state.activeCatId = state.data.categories[0]?.id || null;
    state.dirty = true; renderCats(); renderLinks(); updateSaved();
  }

  /* 分类编辑模态框（支持 emoji + 图片上传） */
  function openCatModal(cat) {
    state.catModalEditId = cat ? cat.id : null;
    state.catUploadedIcon = '';
    $('#catModalTitle').textContent = cat ? '编辑分类' : '新增分类';
    $('#catNameInput').value = cat ? cat.name : '';
    $('#catIconInput').value = cat ? (cat.icon || '') : '';
    const prev = $('#catIconPrev');
    if (cat && isImgIcon(cat.icon)) { prev.src = cat.icon; prev.style.display = 'inline-block'; $('#catIconUrl').textContent = cat.icon; }
    else { prev.style.display = 'none'; $('#catIconUrl').textContent = ''; }
    $('#catModal').style.display = 'flex';
    $('#catNameInput').focus();
  }
  function closeCatModal() { $('#catModal').style.display = 'none'; state.catModalEditId = null; }
  function saveCatModal() {
    const name = $('#catNameInput').value.trim();
    if (!name) { alert('请输入分类名称'); return; }
    const icon = state.catUploadedIcon || $('#catIconInput').value.trim();
    if (state.catModalEditId) {
      const c = state.data.categories.find((x) => x.id === state.catModalEditId);
      if (!c) return;
      c.name = name; c.icon = icon;
    } else {
      const id = slug(name);
      if (state.data.categories.find((c) => c.id === id)) { alert('分类已存在'); return; }
      state.data.categories.push({ id, name, icon, links: [] });
      state.activeCatId = id;
    }
    state.dirty = true; renderCats(); renderLinks(); updateSaved(); closeCatModal();
  }

  /* ---------- 链接管理 ---------- */
  function activeCat() { return state.data.categories.find((c) => c.id === state.activeCatId); }

  function renderLinks() {
    const cat = activeCat();
    const body = $('#linkBody');
    $('#curCatName').textContent = cat ? ('当前分类：' + cat.name + '（' + cat.links.length + '）') : '（无分类）';
    // 访问量统计
    const totalCat = cat ? cat.links.reduce((a, l) => a + (l.visits || 0), 0) : 0;
    const totalAll = state.data.categories.reduce((a, c) => a + (c.links || []).reduce((b, l) => b + (l.visits || 0), 0), 0);
    $('#statHint').innerHTML = `分类访问 <b>${totalCat}</b> · 总访问 <b>${totalAll}</b>`;
    body.innerHTML = '';
    if (!cat) return;
    const kw = state.filter.trim().toLowerCase();
    cat.links.forEach((l, i) => {
      if (kw && !(l.name + ' ' + (l.desc || '') + ' ' + l.url).toLowerCase().includes(kw)) return;
      const tr = document.createElement('tr');
      tr.draggable = !kw; tr.dataset.i = i;
      tr.innerHTML = `
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
    if (!body.children.length) body.innerHTML = '<tr><td colspan="6" class="hint" style="padding:14px">无匹配链接</td></tr>';
    // 编辑绑定（跳过无 data-f 的文件输入）
    body.querySelectorAll('input').forEach((el) => {
      if (!el.dataset.f) return;
      el.addEventListener('input', (e) => {
        cat.links[+e.target.dataset.i][e.target.dataset.f] = e.target.value;
        state.dirty = true; updateSaved();
      });
    });
    // 操作按钮
    body.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onLinkAction(btn));
    });
    // 上传文件
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
  }

  function onLinkAction(btn) {
    const i = +btn.dataset.i, act = btn.dataset.act, cat = activeCat();
    if (act === 'up' && i > 0) { [cat.links[i - 1], cat.links[i]] = [cat.links[i], cat.links[i - 1]]; }
    else if (act === 'down' && i < cat.links.length - 1) { [cat.links[i + 1], cat.links[i]] = [cat.links[i], cat.links[i + 1]]; }
    else if (act === 'del') { cat.links.splice(i, 1); }
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
    state.dirty = true; renderLinks(); updateSaved();
  }

  function updateSaved() {
    $('#savedDot').textContent = state.dirty ? '● 有未保存修改' : '✓ 已保存';
    $('#savedDot').style.color = state.dirty ? '#e8543f' : '#1aa179';
  }

  async function saveAll() {
    const btn = $('#saveAll'); btn.disabled = true;
    try {
      const r = await api('/api/sites', 'POST', state.data);
      state.dirty = false; updateSaved();
      $('#consoleStatus').textContent = `已保存：${r.categories} 个分类 / ${r.links} 条链接。`;
      $('#consoleStatus').className = 'status ok';
    } catch (e) {
      $('#consoleStatus').textContent = '保存失败：' + e.message;
      $('#consoleStatus').className = 'status err';
    } finally { btn.disabled = false; }
  }

  /* ---------- 拖拽排序 ---------- */
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
        state.dirty = true; renderLinks(); updateSaved();
      });
    });
  }
  function bindCatDrag() {
    const list = $('#catList');
    list.querySelectorAll('.cat-item').forEach((el) => {
      el.addEventListener('dragstart', () => { dragFrom = el.dataset.cid; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => { dragFrom = null; el.classList.remove('dragging'); list.querySelectorAll('.cat-item').forEach((x) => x.classList.remove('drop-over')); });
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-over'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault(); el.classList.remove('drop-over');
        const to = el.dataset.cid;
        if (!dragFrom || dragFrom === to) return;
        const cats = state.data.categories;
        const fromIdx = cats.findIndex((c) => c.id === dragFrom);
        const toIdx = cats.findIndex((c) => c.id === to);
        if (fromIdx < 0 || toIdx < 0) return;
        const [item] = cats.splice(fromIdx, 1);
        cats.splice(toIdx, 0, item);
        state.dirty = true; renderCats(); updateSaved();
      });
    });
  }

  /* ---------- AI 自动收录 ---------- */
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
    const cats = state.data.categories.map((c) => c.name);
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
  }

  /* ---------- 导入 / 导出 ---------- */
  async function importFile(file) {
    if (!confirm('导入将覆盖当前全部导航数据（含分类与链接）。建议先点「⬇ 导出」备份，确定继续？')) return;
    try {
      const obj = JSON.parse(await file.text());
      if (!obj || !Array.isArray(obj.categories)) throw new Error('文件格式不正确（缺少 categories 数组）');
      const r = await api('/api/sites', 'POST', obj);
      await loadData();
      $('#consoleStatus').textContent = `已导入：${r.categories} 个分类 / ${r.links} 条链接。`;
      $('#consoleStatus').className = 'status ok';
    } catch (e) {
      $('#consoleStatus').textContent = '导入失败：' + e.message;
      $('#consoleStatus').className = 'status err';
    }
  }
  function exportFile() {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'sites.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------- 配置 ---------- */
  async function loadConfig() {
    try {
      const cfg = await api('/api/config', 'GET');
      $('#cfgBase').value = cfg.base || ''; $('#cfgModel').value = cfg.model || '';
      state.protected = !!cfg.protected;
      if (cfg.aiEnabled) { $('#aiStatus').textContent = '已开启 · ' + cfg.model; $('#aiStatus').className = 'ai-status ai-on'; }
      else { $('#aiStatus').textContent = '未开启（启发式）'; $('#aiStatus').className = 'ai-status ai-off'; }
    } catch (e) { console.warn(e); }
  }
  async function saveCfg() {
    const payload = {
      AI_API_BASE: $('#cfgBase').value.trim(),
      AI_API_KEY: $('#cfgKey').value.trim(),
      AI_MODEL: $('#cfgModel').value.trim()
    };
    const pwd = $('#cfgPwd').value;
    if (pwd) payload.ADMIN_PASSWORD = pwd;
    try {
      const r = await api('/api/config', 'POST', payload);
      state.protected = !!r.protected;
      $('#aiStatus').textContent = r.aiEnabled ? ('已开启 · ' + r.model) : '未开启（启发式）';
      $('#aiStatus').className = 'ai-status ' + (r.aiEnabled ? 'ai-on' : 'ai-off');
      alert(r.aiEnabled ? 'AI 已开启，已保存 config.json' : '已保存（未填 Key，使用启发式）');
    } catch (e) { alert('保存失败：' + e.message); }
  }
  async function clearPwd() {
    if (!confirm('确定关闭后台密码保护？')) return;
    try { await api('/api/config', 'POST', { ADMIN_PASSWORD: '' }); state.protected = false; alert('已关闭密码保护'); }
    catch (e) { alert('操作失败：' + e.message); }
  }

  /* ---------- 系统设置 ---------- */
  function openSettings() {
    populateSettings();
    $('#settingsModal').style.display = 'flex';
  }
  function closeSettings() { $('#settingsModal').style.display = 'none'; }

  function populateSettings() {
    const s = state.data.site || {};
    $('#setTitle').value = s.title || '';
    $('#setSubtitle').value = s.subtitle || '';
    $('#setFooter').value = s.footer || '';

    // 分段按钮（seg）：按当前值高亮
    ['searchPosition','categoryPosition','categoryArrangement','cardSize','wallpaperType'].forEach((k) => {
      document.querySelectorAll('.seg-btn[data-key="' + k + '"]').forEach((b) => {
        b.classList.toggle('on', b.dataset.val === s[k]);
      });
    });

    // 默认分类下拉
    const sel = $('#setDefaultCategory');
    sel.innerHTML = '<option value="all">默认 [全部]</option>' +
      state.data.categories.map((c) =>
        '<option value="' + esc(c.id) + '" ' + (s.defaultCategory === c.id ? 'selected' : '') + '>' + esc(c.name) + '</option>'
      ).join('');

    // 开关
    $('#setRememberCategory').checked = !!s.rememberCategory;
    $('#setShowFavorites').checked = s.showFavorites !== false;

    // 卡片
    $('#setCardColumns').value = s.cardColumns || 0;
    $('#setCardRadius').value = s.cardRadius != null ? s.cardRadius : 14;
    $('#setCardRadiusVal').textContent = s.cardRadius != null ? s.cardRadius : 14;
    $('#setCardShadow').checked = s.cardShadow !== false;
    $('#setShowVisits').checked = !!s.showVisits;

    // 壁纸
    $('#setWallpaperValue').value = s.wallpaperValue || '';
    $('#setWallpaperOpacity').value = s.wallpaperOpacity != null ? s.wallpaperOpacity : 0.08;
    $('#setWallpaperOpacityVal').textContent = s.wallpaperOpacity != null ? (+s.wallpaperOpacity).toFixed(2) : '0.08';
    $('#setWallpaperBlur').value = s.wallpaperBlur || 0;
    $('#setWallpaperBlurVal').textContent = s.wallpaperBlur || 0;

    // 功能图标
    renderFuncIcons(s.functionIcons || []);

    // AI 配置
    loadSettingsCfg();
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

  async function loadSettingsCfg() {
    try {
      const cfg = await api('/api/config', 'GET');
      $('#setCfgBase').value = cfg.base || '';
      $('#setCfgModel').value = cfg.model || '';
      $('#setCfgKey').value = '';
      $('#setCfgPwd').value = '';
      $('#setCfgStatus').textContent = cfg.aiEnabled ? ('已开启 · ' + cfg.model) : '未开启（启发式）';
    } catch (e) {}
  }

  async function saveSettingsCfg() {
    const payload = {
      AI_API_BASE: $('#setCfgBase').value.trim(),
      AI_API_KEY: $('#setCfgKey').value.trim(),
      AI_MODEL: $('#setCfgModel').value.trim()
    };
    const pwd = $('#setCfgPwd').value;
    if (pwd) payload.ADMIN_PASSWORD = pwd;
    try {
      const r = await api('/api/config', 'POST', payload);
      state.protected = !!r.protected;
      $('#setCfgStatus').textContent = r.aiEnabled ? ('已开启 · ' + r.model) : '未开启（启发式）';
      alert(r.aiEnabled ? 'AI 已开启，已保存 config.json' : '已保存（未填 Key，使用启发式）');
      // 同步回主控制台 ③ 卡的显示
      if ($('#cfgBase')) $('#cfgBase').value = $('#setCfgBase').value;
      if ($('#cfgModel')) $('#cfgModel').value = $('#setCfgModel').value;
      if ($('#aiStatus')) {
        $('#aiStatus').textContent = r.aiEnabled ? ('已开启 · ' + r.model) : '未开启（启发式）';
        $('#aiStatus').className = 'ai-status ' + (r.aiEnabled ? 'ai-on' : 'ai-off');
      }
    } catch (e) { alert('保存失败：' + e.message); }
  }

  async function clearSettingsPwd() {
    if (!confirm('确定关闭后台密码保护？')) return;
    try { await api('/api/config', 'POST', { ADMIN_PASSWORD: '' }); state.protected = false; alert('已关闭密码保护'); }
    catch (e) { alert('操作失败：' + e.message); }
  }

  function saveSettings() {
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
    s.wallpaperValue = $('#setWallpaperValue').value.trim();
    s.wallpaperOpacity = +$('#setWallpaperOpacity').value;
    s.wallpaperBlur = +$('#setWallpaperBlur').value;
    // seg 按钮（搜索/分类/卡片大小/壁纸类型）已经在点击时即时写回
    state.dirty = true; updateSaved();
    closeSettings();
    alert('已保存到内存，点「① 保存」一键写入 sites.json 后即可在首页生效。');
  }

  function switchSettingsTab(name) {
    document.querySelectorAll('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.settings-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'ai') loadSettingsCfg();
  }

  function bindSettings() {
    $('#openSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsCancel').addEventListener('click', closeSettings);
    $('#settingsSave').addEventListener('click', saveSettings);
    $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettings(); });

    // Tab 切换
    document.querySelectorAll('.settings-tab').forEach((t) => {
      t.addEventListener('click', () => switchSettingsTab(t.dataset.tab));
    });

    // 分段按钮（点击即时写入 state.data.site）
    document.querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.key, val = b.dataset.val;
        b.parentElement.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x.dataset.val === val));
        state.data.site = state.data.site || {};
        state.data.site[key] = val;
        state.dirty = true; updateSaved();
      });
    });

    // Range 实时显示数值
    $('#setCardRadius').addEventListener('input', (e) => { $('#setCardRadiusVal').textContent = e.target.value; });
    $('#setWallpaperOpacity').addEventListener('input', (e) => { $('#setWallpaperOpacityVal').textContent = (+e.target.value).toFixed(2); });
    $('#setWallpaperBlur').addEventListener('input', (e) => { $('#setWallpaperBlurVal').textContent = e.target.value; });

    // 功能图标
    $('#addFuncIcon').addEventListener('click', addFuncIcon);

    // AI 配置
    $('#setSaveCfg').addEventListener('click', saveSettingsCfg);
    $('#setClearPwd').addEventListener('click', clearSettingsPwd);
  }

  /* ---------- 主题 ---------- */
  function bindTheme() {
    $('#themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('theme', cur); } catch (e) {}
    });
  }

  /* ---------- 绑定 ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    bindTheme();
    bindSettings();
    $('#addCat').addEventListener('click', addCat);
    $('#addLink').addEventListener('click', addLink);
    $('#saveAll').addEventListener('click', saveAll);
    $('#recognizeBtn').addEventListener('click', recognize);
    $('#writeBtn').addEventListener('click', writeSelected);
    $('#saveCfg').addEventListener('click', saveCfg);
    $('#clearPwd').addEventListener('click', clearPwd);
    $('#sortVisits').addEventListener('click', sortVisits);
    $('#exportBtn').addEventListener('click', (e) => { e.preventDefault(); exportFile(); });
    $('#importFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });

    // 分类模态框
    $('#catSave').addEventListener('click', saveCatModal);
    $('#catCancel').addEventListener('click', closeCatModal);
    $('#catModal').addEventListener('click', (e) => { if (e.target === $('#catModal')) closeCatModal(); });
    $('#catIconUpload').addEventListener('click', () => $('#catIconFile').click());
    $('#catIconFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const url = await uploadImage(file);
        state.catUploadedIcon = url;
        $('#catIconInput').value = url;
        const prev = $('#catIconPrev'); prev.src = url; prev.style.display = 'inline-block'; $('#catIconUrl').textContent = url;
      } catch (err) { alert('上传失败：' + err.message); }
      e.target.value = '';
    });

    $('#linkSearch').addEventListener('input', (e) => { state.filter = e.target.value; renderLinks(); });
    $('#clearBtn').addEventListener('click', () => { $('#urlInput').value = ''; state.aiResults = []; $('#resultPanel').style.display = 'none'; });
    window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });

    await loadConfig();
    try { state.password = sessionStorage.getItem('adminPwd') || ''; } catch (e) {}
    if (state.protected && !state.password) await showLogin();
    await loadData();
  });
})();
