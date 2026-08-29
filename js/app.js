/* 共享导航 - 前端逻辑
 * 数据来源：在线优先读后端 /api/sites（与后台管理同源，保证实时同步；
 *          Cloudflare 走 KV、本地 server.js 走 data/sites.json）；
 *          file:// 直接打开或后端不可用时，回落 data/sites.json → data/sites.js 兜底。
 */
(() => {
  'use strict';

  const state = {
    data: null,
    active: 'all',
    view: 'sections',
    keyword: ''
  };

  const $ = (sel) => document.querySelector(sel);

  // 颜色池：用于无图标时的字母头像
  const COLORS = ['#2f6fed','#e8543f','#1aa179','#f0a020','#8b5cf6','#0ea5e9','#ef5da8','#14b8a6'];
  const colorFor = (s) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

  /* ===== 常用收藏（localStorage，按浏览器保存） ===== */
  const FAV_KEY = 'nav_favorites';
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch { return []; }
  }
  function saveFavorites(arr) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function isFav(url) { return getFavorites().some((f) => f.url === url); }
  function toggleFav(link) {
    const favs = getFavorites();
    const i = favs.findIndex((f) => f.url === link.url);
    if (i >= 0) favs.splice(i, 1);
    else favs.unshift(link); // 新收藏置顶
    saveFavorites(favs);
  }
  function updateFavCount() {
    const n = getFavorites().length;
    const el = document.getElementById('favCount');
    if (el) { el.textContent = n; el.style.display = n ? '' : 'none'; }
  }
  function reorderFavorites(fromUrl, toUrl) {
    const favs = getFavorites();
    const fromIdx = favs.findIndex((f) => f.url === fromUrl);
    if (fromIdx < 0) return;
    const [item] = favs.splice(fromIdx, 1);
    const toIdx = favs.findIndex((f) => f.url === toUrl);
    if (toIdx < 0) favs.push(item);
    else favs.splice(toIdx, 0, item);
    saveFavorites(favs);
    renderFavorites();
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }

  function faviconUrl(link, site) {
    if (link.icon) return link.icon;
    const h = hostnameOf(link.url);
    if (!h) return '';
    const base = (site && site.faviconService) || 'https://icons.duckduckgo.com/ip3/';
    return base + h + '.ico';
  }

  /* ===== 数据加载：三级兜底 =====
   * 1) fetch data/sites.json —— http(s) 访问时的正常路径
   * 2) <script src="data/sites.js"> —— 以 file:// 直接打开时 fetch 会被浏览器拦截
   *    （报 Failed to fetch），改用脚本标签读取由 sites.json 同步生成的同名 .js，
   *    脚本标签不受 file:// 限制
   * 3) 本机快照 —— 前两者都不可用时的最后兜底（需后台开启缓存）
   */
  const DATA_CACHE_KEY = 'nav_data_cache';
  const DATA_CACHE_TTL = 12 * 60 * 60 * 1000; // 快照有效期 12 小时，仅作兜底

  function readDataCache() {
    try {
      const raw = localStorage.getItem(DATA_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.data || !o.ts) return null;
      if (Date.now() - o.ts > DATA_CACHE_TTL) return null;
      return o.data;
    } catch (e) { return null; }
  }
  function writeDataCache(data) {
    try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch (e) {}
  }
  function clearDataCache() {
    try { localStorage.removeItem(DATA_CACHE_KEY); } catch (e) {}
  }

  // 经 <script> 标签读取数据（file:// 兜底）
  function loadDataViaScript() {
    return new Promise((resolve, reject) => {
      if (window.__NAV_DATA__) return resolve(window.__NAV_DATA__);
      const s = document.createElement('script');
      // 注意：file:// 下带查询串会被当成文件名的一部分导致 404，故不加缓存戳
      s.src = 'data/sites.js';
      s.onload = () => {
        if (window.__NAV_DATA__) resolve(window.__NAV_DATA__);
        else reject(new Error('data/sites.js 未返回数据'));
      };
      s.onerror = () => reject(new Error('data/sites.js 读取失败'));
      document.head.appendChild(s);
    });
  }

  async function fetchSiteData() {
    const isOnline = location.protocol === 'http:' || location.protocol === 'https:';
    // 在线环境优先读后端 /api/sites（Cloudflare 走 KV、本地 server.js 走 data/sites.json），
    // 与后台管理写入的是同一份数据，保证前台展示与后台修改实时同步。
    if (isOnline) {
      try {
        const res = await fetch('/api/sites?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch (e) {
        // /api/sites 不可用（如未部署 Functions）→ 落到下方静态兜底
      }
    }
    // file:// 直接打开，或 /api/sites 不可用时，读静态文件兜底
    try {
      const res = await fetch('data/sites.json?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch (e) {
      // fetch 被拦截（file://）→ 退回脚本标签读取
    }
    return await loadDataViaScript();
  }

  async function loadData() {
    let fresh;
    try {
      fresh = await fetchSiteData();
    } catch (e) {
      const snap = readDataCache();
      if (!snap) throw new Error(e.message || '无法加载导航数据');
      state.data = snap; // 离线兜底：用上次快照渲染
      return;
    }
    state.data = fresh;
    // 缓存开关：开启才保留快照；关闭则清掉，保证每次都拿最新数据
    if (fresh.site && fresh.site.cacheEnabled === true) writeDataCache(fresh);
    else clearDataCache();
  }

  function renderHead() {
    const s = state.data.site || {};
    if (s.logo) $('#siteLogo').textContent = s.logo;
    if (s.title) {
      $('#siteTitle').textContent = s.title;
      document.title = s.title;
      $('#heroTitle').textContent = s.title;
    }
    if (s.subtitle) $('#heroSub').textContent = s.subtitle;
    if (s.footer) $('#footer').textContent = s.footer;
    $('#sideFoot').textContent = (s.subtitle || '') + '\n数据：data/sites.json';
  }

  function buildSidebar() {
    const nav = $('#sideNav');
    // 保留“全部”按钮，注入分类
    nav.querySelectorAll('.side-item.cat').forEach((n) => n.remove());
    state.data.categories.forEach((c) => {
      const a = document.createElement('a');
      a.className = 'side-item cat';
      a.dataset.target = c.id;
      a.href = '#' + c.id;
      a.innerHTML = `<span>${c.icon || '🔗'}</span><span class="lbl">${escapeHtml(c.name)}</span>`;
      nav.appendChild(a);
    });
    nav.querySelectorAll('.side-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        const t = item.dataset.target;
        if (t === 'all') {
          e.preventDefault();
          if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
          setActive('all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        if (t === '__fav') {
          e.preventDefault();
          if (state.keyword) clearSearch();
          state.view = 'fav';
          setActive('__fav');
          renderFavorites();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          closeSidebar();
          return;
        }
        // 分类点击：若正在搜索则先清除搜索，再跳转
        if (state.keyword) { clearSearch(); }
        if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
        setActive(t);
        const sec = document.getElementById('sec-' + t);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeSidebar();
      });
    });
  }

  /* 顶部导航模式（替代侧栏） */
  function buildTopNav() {
    const layout = document.querySelector('.layout');
    if (!layout || document.getElementById('topNav')) return;
    const s = state.data.site || {};
    const nav = document.createElement('nav');
    nav.className = 'top-nav' + (s.categoryArrangement === 'multi' ? ' multi' : '');
    nav.id = 'topNav';
    const allCls = 'top-nav-item';
    nav.innerHTML = '<a class="' + allCls + '" data-target="all" href="#all">🏠 全部</a>' +
      state.data.categories.map((c) => '<a class="' + allCls + '" data-target="' + c.id + '" href="#' + c.id + '">' + (c.icon || '🔗') + ' ' + escapeHtml(c.name) + '</a>').join('');
    layout.insertBefore(nav, layout.querySelector('.content'));
    nav.querySelectorAll('.' + allCls).forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const t = a.dataset.target;
        if (t === 'all') {
          if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
          setActive('all');
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        if (state.keyword) clearSearch();
        if (state.view !== 'sections') { state.view = 'sections'; renderSections(); }
        setActive(t);
        const sec = document.getElementById('sec-' + t);
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  /* 功能图标（顶栏） */
  function renderFuncIcons() {
    const s = state.data.site || {};
    const list = s.functionIcons || [];
    if (!list.length) return;
    const topbar = document.querySelector('.topbar');
    if (!topbar) return;
    const wrap = document.createElement('div');
    wrap.className = 'func-icons';
    list.forEach((f) => {
      if (!f || !f.url) return;
      const a = document.createElement('a');
      a.href = f.url;
      a.title = f.name || '';
      const isImg = isImgIcon(f.icon);
      a.innerHTML = (f.icon && !isImg ? '<span>' + escapeHtml(f.icon) + '</span>' : '') +
                    (isImg ? '<img src="' + escapeHtml(f.icon) + '" style="width:16px;height:16px;object-fit:contain;border-radius:4px"/>' : '') +
                    '<span class="fi-txt">' + escapeHtml(f.name || '') + '</span>';
      if (f.external !== false) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      wrap.appendChild(a);
    });
    if (wrap.children.length) topbar.appendChild(wrap);
  }
  function isImgIcon(icon) { return !!icon && /^(https?:\/\/|\/uploads\/|\/api\/uploads\/|data:image\/)/.test(icon); }

  /* ===== 搜索引擎快速入口 ===== */
  // 默认引擎：可用 data/sites.json 的 site.searchEngines 覆盖（[{id,name,url}]，url 需以查询参数结尾）
  const DEFAULT_ENGINES = [
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
  const WS_KEY = 'nav_search_engine';

  function getEngines() {
    const s = state.data && state.data.site;
    if (s && Array.isArray(s.searchEngines)) {
      // enabled 缺省视为启用（兼容旧数据）；全部停用则回退内置默认引擎，避免搜索栏空白
      const custom = s.searchEngines.filter((e) => e && e.name && e.url && e.enabled !== false);
      if (custom.length) return custom;
    }
    return DEFAULT_ENGINES;
  }
  function currentEngine() {
    const list = getEngines();
    let id = null;
    try { id = localStorage.getItem(WS_KEY); } catch (e) {}
    return list.find((e) => e.id === id) || list[0];
  }
  function syncEngineBadge() {
    const e = currentEngine();
    const badge = $('#wsBadge');
    if (!e || !badge) return;
    badge.textContent = Array.from(e.name)[0] || '搜';
    badge.style.background = colorFor(e.name);
    const input = $('#wsInput');
    if (input) input.placeholder = '用' + e.name + '搜索…';
  }
  function renderWebSearch() {
    const wrap = $('#wsEngines');
    if (!wrap) return;
    const list = getEngines();
    const cur = currentEngine();
    wrap.innerHTML = '';
    list.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ws-engine' + (cur && e.id === cur.id ? ' on' : '');
      b.textContent = e.name;
      b.title = '使用「' + e.name + '」搜索';
      b.addEventListener('click', () => {
        try { localStorage.setItem(WS_KEY, e.id); } catch (err) {}
        wrap.querySelectorAll('.ws-engine').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        wrap.classList.remove('open'); // 手机端选完即收起下拉
        syncEngineBadge();
        const input = $('#wsInput');
        if (input) input.focus();
      });
      wrap.appendChild(b);
    });
    syncEngineBadge();
  }

  // 看起来像网址时直接跳转，否则交给搜索引擎
  const URL_LIKE = /^(https?:\/\/)?([\w-]+\.)+(com|cn|net|org|io|dev|co|me|info|edu|gov|xyz|top|site|online|cc|tv|app|ai|tech|store|blog|wiki)([/?#].*)?$/i;
  function doWebSearch() {
    const input = $('#wsInput');
    if (!input) return;
    const q = (input.value || '').trim();
    if (!q) { input.focus(); return; }
    let target;
    if (/^https?:\/\//i.test(q)) target = q;
    else if (URL_LIKE.test(q)) target = 'https://' + q.replace(/^https?:\/\//i, '');
    else target = currentEngine().url + encodeURIComponent(q);
    window.open(target, '_blank', 'noopener');
  }

  /* ===== 字体（后台「首页设置 → 字体」可调） ===== */
  const FONT_FAMILIES = {
    default: '',
    sans: '"PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif',
    serif: '"Songti SC","SimSun","Source Han Serif SC","Noto Serif CJK SC",Georgia,serif',
    rounded: '"PingFang SC","Hiragino Maru Gothic ProN","Yuanti SC","YouYuan","Microsoft YaHei",sans-serif',
    kai: '"Kaiti SC","KaiTi","STKaiti",serif',
    mono: '"SF Mono",SFMono-Regular,Menlo,Consolas,"Courier New",monospace'
  };
  function applyTypography() {
    const s = state.data.site || {};
    const root = document.documentElement;
    if (s.fontSize) root.style.setProperty('--font-size', s.fontSize + 'px');

    let stack = '';
    if (s.fontFamily && s.fontFamily !== 'default') {
      if (FONT_FAMILIES[s.fontFamily] !== undefined) {
        stack = FONT_FAMILIES[s.fontFamily];
      } else {
        // 自定义字体：按 id 或名称匹配 site.fonts
        const custom = (s.fonts || []).find((f) => f && (f.id === s.fontFamily || f.name === s.fontFamily));
        stack = custom && custom.stack ? custom.stack : '';
      }
    }
    // 未设置 / 系统默认 / 字体已被删除 → 清掉行内变量，回退 :root 里的设计字体栈
    if (stack) root.style.setProperty('--font-family', stack);
    else root.style.removeProperty('--font-family');
  }

  /* ===== 内容背景板 ===== */
  function applyContentPanel() {
    const s = state.data.site || {};
    document.body.classList.toggle('content-panel', !!s.contentPanel);
    if (s.contentPanel) {
      document.body.style.setProperty('--cp-opacity', s.contentPanelOpacity != null ? s.contentPanelOpacity : 0.85);
      document.body.style.setProperty('--cp-radius', (s.contentPanelRadius != null ? s.contentPanelRadius : 16) + 'px');
    }
  }

  /* 壁纸 */
  function applyWallpaper() {
    const s = state.data.site || {};
    if (!s.wallpaperType || s.wallpaperType === 'none' || !s.wallpaperValue) return;
    document.body.classList.add('wallpaper');
    let bg = '';
    if (s.wallpaperType === 'image') bg = 'url("' + s.wallpaperValue.replace(/"/g, '\\"') + '")';
    else if (s.wallpaperType === 'gradient' || s.wallpaperType === 'color') bg = s.wallpaperValue;
    document.body.style.setProperty('--wp-bg', bg);
    document.body.style.setProperty('--wp-opacity', s.wallpaperOpacity != null ? s.wallpaperOpacity : 0.08);
    document.body.style.setProperty('--wp-blur', (s.wallpaperBlur || 0) + 'px');
  }

  /* 集中应用所有设置（在数据加载完成后调用） */
  function applySettings() {
    const s = state.data.site || {};
    // 隐藏常用收藏
    if (s.showFavorites === false) {
      document.querySelectorAll('.fav-entry').forEach((e) => e.style.display = 'none');
      // 若当前在收藏视图，自动退回全部
      if (state.active === '__fav') state.active = 'all';
    }
    // 分类位置：顶部
    if (s.categoryPosition === 'top') {
      document.documentElement.classList.add('layout-top');
      buildTopNav();
    }
    // 搜索框位置：上方
    if (s.searchPosition === 'above') {
      document.documentElement.classList.add('search-above');
    }
    // 功能图标
    renderFuncIcons();
    // 字体与背景板
    applyTypography();
    applyContentPanel();
    // 壁纸
    applyWallpaper();
    // 默认 / 记住分类
    const remembered = (s.rememberCategory && sessionStorage.getItem('nav_active')) || s.defaultCategory || 'all';
    state.active = remembered;
    setActive(remembered);
    if (remembered !== 'all' && remembered !== '__fav') {
      // 首次进入直接滚动到目标分类
      setTimeout(() => {
        const sec = document.getElementById('sec-' + remembered);
        if (sec) window.scrollTo({ top: sec.offsetTop - topOffset() - 10, behavior: 'auto' });
      }, 50);
    }
  }

  function renderSections() {
    state.view = 'sections';
    const wrap = $('#sections');
    wrap.innerHTML = '';
    const s = state.data.site || {};
    const kw = state.keyword.trim().toLowerCase();
    let anyVisible = false;

    state.data.categories.forEach((c) => {
      const links = (c.links || []).filter((l) => {
        if (!kw) return true;
        return (l.name + ' ' + (l.desc || '') + ' ' + l.url + ' ' + c.name)
          .toLowerCase().includes(kw);
      });
      if (links.length === 0) return;
      anyVisible = true;

      const sec = document.createElement('section');
      sec.className = 'section';
      sec.id = 'sec-' + c.id;
      sec.innerHTML = `
        <div class="section-head">
          <span class="sec-icon">${c.icon || '🔗'}</span>
          <span>${escapeHtml(c.name)}</span>
          <span class="sec-count">${links.length}</span>
        </div>
        <div class="cards ${cardClasses(s)}" style="--card-radius:${s.cardRadius != null ? s.cardRadius : 14}px"></div>`;
      const cards = sec.querySelector('.cards');
      links.forEach((l) => cards.appendChild(buildCard(l)));
      wrap.appendChild(sec);
    });

    if (!anyVisible) {
      wrap.innerHTML = '<div class="empty">没有找到匹配的站点 🔍</div>';
    }
    initScrollSpy();
  }

  function cardClasses(s) {
    const cls = [];
    if (s.cardSize && s.cardSize !== 'medium') cls.push('size-' + s.cardSize);
    if (s.cardColumns && s.cardColumns >= 2 && s.cardColumns <= 6) cls.push('cols-' + s.cardColumns);
    if (s.cardShadow === false) cls.push('no-shadow');
    return cls.join(' ');
  }

  function buildCard(link) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = link.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const fu = faviconUrl(link, state.data.site);
    if (fu) {
      const img = document.createElement('img');
      img.src = fu;
      img.alt = link.name;
      img.onerror = () => {
        thumb.style.background = colorFor(link.name);
        thumb.textContent = link.name.charAt(0).toUpperCase();
      };
      thumb.appendChild(img);
    } else {
      thumb.style.background = colorFor(link.name);
      thumb.textContent = link.name.charAt(0).toUpperCase();
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="name">${escapeHtml(link.name)}</div>
      <div class="desc">${escapeHtml(link.desc || hostnameOf(link.url))}</div>`;

    card.appendChild(thumb);
    card.appendChild(meta);

    // 显示访问量
    if ((state.data.site || {}).showVisits && link.visits) {
      const tag = document.createElement('span');
      tag.className = 'visits-tag';
      tag.textContent = '🔥 ' + link.visits;
      card.appendChild(tag);
    }

    // 收藏按钮（⭐ 常用收藏）
    const star = document.createElement('span');
    star.className = 'fav-star' + (isFav(link.url) ? ' on' : '');
    star.setAttribute('role', 'button');
    star.title = isFav(link.url) ? '取消收藏' : '加入常用收藏';
    star.textContent = isFav(link.url) ? '★' : '☆';
    star.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(link);
      const on = isFav(link.url);
      star.classList.toggle('on', on);
      star.textContent = on ? '★' : '☆';
      star.title = on ? '取消收藏' : '加入常用收藏';
      updateFavCount();
      if (state.view === 'fav') renderFavorites();
    });
    card.appendChild(star);

    // 访问统计：点击时上报（不阻塞跳转，keepalive 保证请求完成）
    card.addEventListener('click', () => {
      try {
        fetch('api/visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: link.url }),
          keepalive: true
        });
      } catch (e) { /* 上报失败不影响使用 */ }
    });
    return card;
  }

  /* 常用收藏视图：渲染收藏卡片 + 拖拽排序 */
  function renderFavorites() {
    const wrap = $('#sections');
    wrap.innerHTML = '';
    const favs = getFavorites();
    const kw = state.keyword.trim().toLowerCase();
    const list = favs.filter((f) =>
      !kw || (f.name + ' ' + (f.desc || '') + ' ' + f.url).toLowerCase().includes(kw));

    if (list.length === 0) {
      wrap.innerHTML = '<div class="empty">还没有收藏的站点 ⭐<br/>' +
        '浏览任意分类，点击卡片右上角的 ☆ 即可加入常用收藏</div>';
      return;
    }

    const sec = document.createElement('section');
    sec.className = 'section';
    sec.innerHTML = `
      <div class="section-head">
        <span class="sec-icon">⭐</span>
        <span>常用收藏</span>
        <span class="sec-count">${list.length}</span>
        <span class="fav-hint">拖动卡片可调整顺序</span>
      </div>
      <div class="cards"></div>`;
    const cards = sec.querySelector('.cards');
    list.forEach((f) => {
      const card = buildCard(f);
      card.draggable = true;
      bindFavDrag(card, f);
      cards.appendChild(card);
    });
    wrap.appendChild(sec);
  }

  function bindFavDrag(card, fav) {
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', fav.url);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drop-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-over');
      const fromUrl = e.dataTransfer.getData('text/plain');
      if (fromUrl && fromUrl !== fav.url) reorderFavorites(fromUrl, fav.url);
    });
  }

  function setActive(id) {
    state.active = id;
    document.querySelectorAll('.side-item, .top-nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.target === id);
    });
    // 记住分类
    const s = state.data && state.data.site;
    if (s && s.rememberCategory && id !== 'all' && id !== '__fav') {
      try { sessionStorage.setItem('nav_active', id); } catch (e) {}
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 滚动高亮（scrollspy） */
  // 吸顶元素总高度（顶栏 + 搜索引擎条），用于锚点偏移与滚动监听
  function topOffset() {
    // 搜索引擎搜索已并入顶栏，吸顶高度 = 顶栏实测高度（手机端顶栏为两行）
    const topbar = document.querySelector('.topbar');
    return topbar ? topbar.offsetHeight : 60;
  }
  let spyObserver = null;
  function initScrollSpy() {
    if (spyObserver) spyObserver.disconnect();
    spyObserver = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting && !state.keyword && state.view === 'sections') {
          const id = en.target.id.replace('sec-', '');
          setActive(id);
        }
      });
    // 顶部偏移 = 顶栏 + 搜索引擎条，避免分类被吸顶元素盖住
    }, { rootMargin: '-' + (topOffset() + 20) + 'px 0px -70% 0px' });
    document.querySelectorAll('.section[id^="sec-"]').forEach((el) => spyObserver.observe(el));
  }

  /* 搜索 */
  function onSearch(v) {
    state.keyword = v;
    $('#searchClear').classList.toggle('show', !!v);
    if (state.view === 'fav') renderFavorites();
    else renderSections();
    if (v && state.view !== 'fav') setActive('all');
  }
  function clearSearch() {
    $('#searchInput').value = '';
    onSearch('');
  }

  /* 移动端侧栏 */
  function openSidebar() { $('#sidebar').classList.add('open'); $('#sidebarMask').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebarMask').classList.remove('show'); }

  function bindUI() {
    $('#searchInput').addEventListener('input', (e) => onSearch(e.target.value));
    $('#searchClear').addEventListener('click', clearSearch);

    // 搜索引擎快速入口
    const wsForm = $('#wsForm');
    if (wsForm) {
      wsForm.addEventListener('submit', (e) => { e.preventDefault(); doWebSearch(); });
      $('#wsInput').addEventListener('input', (e) => {
        $('#wsClear').classList.toggle('show', !!e.target.value);
      });
      $('#wsClear').addEventListener('click', () => {
        $('#wsInput').value = '';
        $('#wsClear').classList.remove('show');
        $('#wsInput').focus();
      });
      // 手机端：点击引擎徽标展开 / 收起引擎列表
      $('#wsBadge').addEventListener('click', (e) => {
        e.preventDefault();
        $('#wsEngines').classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        const eng = $('#wsEngines');
        if (!eng || !eng.classList.contains('open')) return;
        if (eng.contains(e.target) || e.target.closest('#wsBadge')) return;
        eng.classList.remove('open');
      });
    }
    $('#menuToggle').addEventListener('click', openSidebar);
    $('#sidebarMask').addEventListener('click', closeSidebar);
    $('#themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      try { localStorage.setItem('theme', cur); } catch (e) {}
    });
  }

  async function init() {
    bindUI();
    try {
      await loadData();
    } catch (err) {
      $('#sections').innerHTML = '<div class="empty">加载数据失败：' + escapeHtml(err.message) +
        '<br/>推荐用 <code>node server.js</code> 启动后访问 <code>http://localhost:8787</code>。' +
        '<br/>若直接双击打开本文件（file:// 协议），需确保同目录存在 <code>data/sites.js</code> 兜底文件' +
        '（由 <code>node scripts/gen-data-js.mjs</code> 生成，保存数据时会自动同步）。</div>';
      return;
    }
    renderHead();
    renderWebSearch();
    buildSidebar();
    renderSections();
    applySettings();
    updateFavCount();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
