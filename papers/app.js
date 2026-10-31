/* app.js：知识库阅读器主逻辑（文件夹树 / 本地读入 / 路由 / 目录 / 搜索） */
(function () {
  'use strict';

  const E = MDR.escapeHtml;
  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar: $('sidebar'), tree: $('tree'), article: $('article'), scroll: $('articleScroll'),
    crumbs: $('breadcrumbs'), headerStats: $('headerStats'), tocPane: $('tocPane'), tocList: $('tocList'),
    search: $('searchInput'), searchClear: $('searchClear'), treeStat: $('treeStat'),
    vaultName: $('vaultName'), vaultPath: $('vaultPath'), lightbox: $('lightbox'), lightboxImg: $('lightboxImg'),
    folderInput: $('folderInput'), filesInput: $('filesInput'), hideAssetBtn: $('hideAssetBtn'),
    sidebarTabs: $('sidebarTabs'), favCountBadge: $('favCountBadge'), recentCountBadge: $('recentCountBadge'),
    treeToolbarActions: $('treeToolbarActions'), listToolbarActions: $('listToolbarActions'), clearListBtn: $('clearListBtn')
  };
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const state = {
    src: null, hideAssets: true, currentPath: null, currentFolder: '', openFolders: new Set(),
    query: '', pendingHeading: null, headings: [], dashCache: null, noteIndex: null, objectUrls: [],
    assetBuster: new Map(), sidebarTab: 'tree', favorites: [], recent: []
  };
  let defaultSource = null;

  /* ---------- 工具函数 ---------- */
  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
  function normPath(p) {
    const out = [];
    p.split('/').forEach(function (s) { if (s === '' || s === '.') return; if (s === '..') out.pop(); else out.push(s); });
    return out.join('/');
  }
  function joinPath(a, b) { return normPath((a ? a + '/' : '') + b); }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; }
  function fmtDate(sec) { return sec ? new Date(sec * 1000).toLocaleDateString('zh-CN') : ''; }
  function fmtRelTime(ms) {
    if (!ms) return '';
    const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
    return new Date(ms).toLocaleDateString('zh-CN');
  }
  const tick = () => new Promise(function (r) { setTimeout(r, 16); });

  /* ---------- 收藏与最近阅读（浏览器本地存储） ---------- */
  const FAV_STORAGE_KEY = 'md-reader-favorites';
  const RECENT_STORAGE_KEY = 'md-reader-recent';
  const MAX_RECENT_COUNT = 40;

  function loadUserLists() {
    try {
      const favRaw = JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]');
      if (Array.isArray(favRaw)) {
        state.favorites = favRaw.filter(function (x) { return x && typeof x.path === 'string'; });
      }
    } catch (e) { state.favorites = []; }
    try {
      const recRaw = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
      if (Array.isArray(recRaw)) {
        state.recent = recRaw.filter(function (x) { return x && typeof x.path === 'string'; });
      }
    } catch (e) { state.recent = []; }
  }

  function saveFavorites() {
    try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(state.favorites)); } catch (e) { /* quota ignore */ }
    updateListBadges();
  }

  function saveRecent() {
    try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(state.recent)); } catch (e) { /* quota ignore */ }
    updateListBadges();
  }

  function isFavorited(path) {
    return state.favorites.some(function (x) { return x.path === path; });
  }

  function toggleFavorite(path) {
    if (!path) return false;
    const idx = state.favorites.findIndex(function (x) { return x.path === path; });
    let added = false;
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
    } else {
      state.favorites.unshift({ path: path, time: Date.now() });
      added = true;
    }
    saveFavorites();
    renderTree();
    updateHeaderStarBtn();
    return added;
  }

  function removeFavorite(path) {
    const idx = state.favorites.findIndex(function (x) { return x.path === path; });
    if (idx >= 0) {
      state.favorites.splice(idx, 1);
      saveFavorites();
      renderTree();
      updateHeaderStarBtn();
    }
  }

  function recordRecentRead(path) {
    if (!path) return;
    state.recent = state.recent.filter(function (x) { return x.path !== path; });
    state.recent.unshift({ path: path, time: Date.now() });
    if (state.recent.length > MAX_RECENT_COUNT) state.recent.length = MAX_RECENT_COUNT;
    saveRecent();
    if (state.sidebarTab === 'recent') renderTree();
  }

  function removeRecentItem(path) {
    const idx = state.recent.findIndex(function (x) { return x.path === path; });
    if (idx >= 0) {
      state.recent.splice(idx, 1);
      saveRecent();
      renderTree();
    }
  }

  function validListItems(list) {
    if (!state.src || !state.src.fileMap) return [];
    const terms = state.query ? state.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const out = [];
    list.forEach(function (item) {
      const f = state.src.fileMap.get(item.path);
      if (!f) return;
      if (terms.length) {
        const hay = (f.path + ' ' + f.title + ' ' + f.tags.join(' ') + ' ' + f.arxiv).toLowerCase();
        if (!terms.every(function (t) { return hay.indexOf(t) >= 0; })) return;
      }
      out.push({ file: f, time: item.time || 0 });
    });
    return out;
  }

  function updateListBadges() {
    if (!state.src || !state.src.fileMap) return;
    const favCount = state.favorites.filter(function (x) { return state.src.fileMap.has(x.path); }).length;
    const recCount = state.recent.filter(function (x) { return state.src.fileMap.has(x.path); }).length;
    if (el.favCountBadge) el.favCountBadge.textContent = String(favCount);
    if (el.recentCountBadge) el.recentCountBadge.textContent = String(recCount);
  }

  function updateHeaderStarBtn() {
    const btn = $('headerStarBtn');
    if (!btn || !state.currentPath) return;
    const starred = isFavorited(state.currentPath);
    btn.classList.toggle('starred', starred);
    btn.innerHTML = (starred ? '⭐ 已收藏' : '☆ 收藏');
    btn.title = starred ? '点击取消收藏此文章' : '收藏此文章到浏览器本地书签';
  }

  /* ---------- 数据源 ---------- */
  function buildAssetIndex(paths) {
    const idx = Object.create(null);
    paths.forEach(function (p) { idx[p] = p; });
    paths.forEach(function (p) {
      const parts = p.split('/');
      for (let i = 1; i <= Math.min(4, parts.length); i++) {
        const k = parts.slice(-i).join('/');
        if (!(k in idx)) idx[k] = p;
      }
    });
    return idx;
  }

  /* ---------- 多通道后端 API 探测与回写 ---------- */
  const API_ENDPOINTS = window.READER_READONLY ? [] : ['/api', 'http://127.0.0.1:60051/api', 'http://localhost:60051/api'];
  const LOCAL_EDIT_PREFIX = 'md-vault-edited:';

  function getLocalSavedDoc(p) {
    try { return localStorage.getItem(LOCAL_EDIT_PREFIX + p); } catch (e) { return null; }
  }
  function setLocalSavedDoc(p, content) {
    try { localStorage.setItem(LOCAL_EDIT_PREFIX + p, content); } catch (e) { /* quota ignore */ }
  }

  async function apiReadDoc(p) {
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/read?path=' + encodeURIComponent(p), { mode: 'cors' });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok && typeof j.content === 'string') return j.content;
        }
      } catch (e) { /* try next endpoint */ }
    }
    return null;
  }

  async function apiSaveDoc(p, newContent) {
    setLocalSavedDoc(p, newContent);
    let lastErr = null;
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/save', {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p, content: newContent })
        });
        const j = await r.json();
        if (r.ok && j && j.ok) return j;
        lastErr = new Error((j && j.error) || ('HTTP ' + r.status));
      } catch (e) {
        lastErr = e;
      }
    }
    // 如果当前处于纯离线 file:// 且 60051 未通，返回内存+本地缓存成功标记，不阻塞用户界面渲染
    return {
      ok: true,
      offlineCached: true,
      savedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      warn: lastErr ? lastErr.message : ''
    };
  }

  async function apiFetchManifest() {
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/manifest?t=' + Date.now(), { mode: 'cors', cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok && j.manifest && Array.isArray(j.manifest.files)) return j.manifest;
        }
      } catch (e) { /* try next endpoint */ }
    }
    return null;
  }

  async function apiReadImageDataUrl(vaultRelPath) {
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/image/read?path=' + encodeURIComponent(vaultRelPath) + '&t=' + Date.now(), { mode: 'cors', cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok && j.dataUrl) return j.dataUrl;
        }
      } catch (e) { /* try next endpoint */ }
    }
    return null;
  }

  async function apiOverwriteImage(vaultRelPath, dataUrl) {
    let lastErr = null;
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/image/overwrite', {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: vaultRelPath, imageData: dataUrl })
        });
        const j = await r.json();
        if (r.ok && j && j.ok) return j;
        lastErr = new Error((j && j.error) || ('HTTP ' + r.status));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('未连接到本地读写服务 (server.py)，无法写入原图片文件');
  }

  async function apiUploadNewImage(docPath, dataUrl, fileName) {
    let lastErr = null;
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/image/upload', {
          method: 'POST',
          mode: 'cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docPath: docPath, imageData: dataUrl, fileName: fileName || null })
        });
        const j = await r.json();
        if (r.ok && j && j.ok) return j;
        lastErr = new Error((j && j.error) || ('HTTP ' + r.status));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('未连接到本地读写服务 (server.py)，无法上传保存图片');
  }

  function createDefaultSource() {
    const M = window.OBSIDIAN_VAULT_MANIFEST;
    if (!M) return null;
    const inVault = /\/obsidian_bk\/[^\/]*$/.test(decodeURIComponent(location.pathname));
    const prefix = inVault ? '' : 'vault/';
    const url = function (rel) {
      const base = prefix + rel.split('/').map(encodeURIComponent).join('/');
      const bust = state.assetBuster && state.assetBuster.get(rel);
      return bust ? (base + '?t=' + bust) : base;
    };
    return {
      mode: 'default', name: M.vaultPath.split('/').pop(), pathLabel: M.vaultPath, files: M.files,
      assetIndex: M.assetMap, docs: window.OBSIDIAN_VAULT_DOCS || null,
      assetUrl: url,
      getText: async function (p) {
        const apiContent = await apiReadDoc(p);
        if (apiContent !== null) {
          if (this.docs) this.docs[p] = apiContent;
          return apiContent;
        }
        const cached = getLocalSavedDoc(p);
        if (cached !== null) {
          if (this.docs) this.docs[p] = cached;
          return cached;
        }
        if (this.docs && this.docs[p] !== undefined) return this.docs[p];
        const r = await fetch(url(p));
        if (!r.ok) throw new Error('无法读取 ' + p + '（请确认以 web 服务或知识库目录方式打开）');
        return r.text();
      },
      saveText: async function (p, newContent) {
        if (this.docs) this.docs[p] = newContent;
        const f = this.fileMap && this.fileMap.get(p);
        if (f) f.size = new Blob([newContent]).size;
        const j = await apiSaveDoc(p, newContent);
        if (f && j.mtime) f.mtime = j.mtime;
        return j;
      }
    };
  }

  function makeRecord(path, text, size, mtime) {
    const fm = MDR.parseFrontmatter(text);
    const meta = fm.meta;
    let title = Array.isArray(meta.title) ? meta.title[0] : meta.title;
    if (!title) { const m = fm.body.match(/^#\s+(.+)$/m); if (m) title = m[1].trim(); }
    const name = basename(path).replace(/\.md$/i, '');
    const tags = Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []);
    const block = (text.match(/\$\$[\s\S]*?\$\$/g) || []).length;
    const inline = (text.match(/(?<!\$)\$(?!\$)[^$\n]+?\$(?!\$)/g) || []).length;
    return {
      path: path, name: name, fileName: basename(path), title: title || name, size: size, mtime: mtime,
      folder: dirname(path), tags: tags.slice(0, 6), arxiv: meta.arxiv || '', year: meta.year || '',
      status: meta.status || '', mathCount: block + inline,
      isAssetDoc: ('/' + path).indexOf('/assets/') >= 0 || basename(path) === 'sources.md'
    };
  }

  async function createLocalSource(fileList, isFolder) {
    const arr = Array.from(fileList);
    let rootName = '本地文件';
    const mds = [], assets = [], fileByPath = new Map();
    arr.forEach(function (f) {
      let segs = (f.webkitRelativePath || f.name).split('/');
      if (isFolder && f.webkitRelativePath) { rootName = segs[0]; segs = segs.slice(1); }
      if (!segs.length || segs.some(function (s) { return s.charAt(0) === '.' || s === 'node_modules'; })) return;
      const path = segs.join('/');
      if (/\.(md|markdown)$/i.test(path)) mds.push({ file: f, path: path });
      else if (/\.(png|jpe?g|gif|svg|webp|bmp|pdf)$/i.test(path)) { assets.push(path); fileByPath.set(path, f); }
    });
    const docs = {}, files = [];
    for (let i = 0; i < mds.length; i += 24) {
      el.treeStat.textContent = '读取中 ' + Math.min(i + 24, mds.length) + ' / ' + mds.length;
      await Promise.all(mds.slice(i, i + 24).map(async function (m) {
        const text = await m.file.text();
        docs[m.path] = text;
        files.push(makeRecord(m.path, text, m.file.size, Math.floor(m.file.lastModified / 1000)));
      }));
    }
    const urlCache = new Map();
    return {
      mode: 'local', name: rootName, pathLabel: '本地读入：' + rootName, files: files, docs: docs,
      assetIndex: buildAssetIndex(assets),
      assetUrl: function (rel) {
        if (!urlCache.has(rel)) { const u = URL.createObjectURL(fileByPath.get(rel)); urlCache.set(rel, u); state.objectUrls.push(u); }
        return urlCache.get(rel);
      },
      getText: async function (p) { return docs[p]; },
      saveText: async function (p, newContent) {
        docs[p] = newContent;
        const f = this.fileMap && this.fileMap.get(p);
        if (f) f.size = new Blob([newContent]).size;
        return await apiSaveDoc(p, newContent);
      }
    };
  }

  function setSource(src) {
    state.objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.objectUrls = [];
    src.fileMap = new Map(src.files.map(function (f) { return [f.path, f]; }));
    const byPath = new Map(), byName = new Map();
    src.files.forEach(function (f) {
      const noExt = f.path.replace(/\.md$/i, '').toLowerCase();
      byPath.set(noExt, f.path);
      const b = f.name.toLowerCase();
      if (!byName.has(b)) byName.set(b, []);
      byName.get(b).push(f.path);
    });
    state.noteIndex = { byPath: byPath, byName: byName };
    state.src = src; state.query = ''; el.search.value = ''; el.searchClear.style.display = 'none';
    state.openFolders = new Set(); state.dashCache = null; state.currentPath = null; state.currentFolder = '';
    el.vaultName.textContent = src.name;
    el.vaultPath.textContent = src.pathLabel; el.vaultPath.title = src.pathLabel;
    document.title = src.name + ' · 知识库阅读器';
    renderTree();
  }

  /* ---------- 资源 / 双链解析 ---------- */
  function resolveAssetInfo(raw, docPath) {
    const idx = state.src.assetIndex;
    const r = MDR.safeDecode(String(raw).trim()).split('#')[0].split('?')[0];
    if (!r) return null;
    const cands = [joinPath(dirname(docPath), r), normPath(r)];
    for (let i = 0; i < cands.length; i++) {
      if (has(idx, cands[i])) {
        const relPath = idx[cands[i]];
        return { url: state.src.assetUrl(relPath), relPath: relPath };
      }
      // 对于刚上传但尚未在静态 manifest 中的新图片，只要以 assets/ 开头也可直接构造路径
      if (cands[i].indexOf('/assets/') >= 0 || cands[i].indexOf('assets/') === 0) {
        idx[cands[i]] = cands[i];
        return { url: state.src.assetUrl(cands[i]), relPath: cands[i] };
      }
    }
    const b = basename(r);
    if (has(idx, b)) {
      const relPath = idx[b];
      return { url: state.src.assetUrl(relPath), relPath: relPath };
    }
    return null;
  }

  function resolveAsset(raw, docPath) {
    const info = resolveAssetInfo(raw, docPath);
    return info ? info.url : null;
  }

  function resolveNote(target, docPath) {
    const ni = state.noteIndex;
    const t = MDR.safeDecode(String(target).trim()).replace(/\.md$/i, '').toLowerCase();
    if (!t) return null;
    const rel = joinPath(dirname(docPath), t);
    if (ni.byPath.has(rel)) return ni.byPath.get(rel);
    const abs = normPath(t);
    if (ni.byPath.has(abs)) return ni.byPath.get(abs);
    let cands = ni.byName.get(abs.slice(abs.lastIndexOf('/') + 1)) || [];
    if (abs.indexOf('/') >= 0) cands = cands.filter(function (p) { return p.replace(/\.md$/i, '').toLowerCase().endsWith(abs); });
    if (!cands.length) return null;
    const dsegs = dirname(docPath).split('/');
    const score = function (p) {
      const ps = dirname(p).split('/'); let n = 0;
      while (n < ps.length && n < dsegs.length && ps[n] === dsegs[n]) n++;
      const f = state.src.fileMap.get(p);
      return n * 10 - (f && f.isAssetDoc ? 5 : 0) - p.length / 1000;
    };
    return cands.slice().sort(function (a, b) { return score(b) - score(a); })[0];
  }

  /* ---------- 文件夹树 ---------- */
  function buildTree(files) {
    const root = { name: state.src.name, path: '', folders: new Map(), files: [], count: 0 };
    files.forEach(function (f) {
      const segs = f.folder ? f.folder.split('/') : [];
      let node = root, cur = '';
      root.count++;
      segs.forEach(function (s) {
        cur = cur ? cur + '/' + s : s;
        let ch = node.folders.get(s);
        if (!ch) { ch = { name: s, path: cur, folders: new Map(), files: [], count: 0 }; node.folders.set(s, ch); }
        ch.count++; node = ch;
      });
      node.files.push(f);
    });
    return root;
  }

  function indexNodes(node, map) { map.set(node.path, node); node.folders.forEach(function (c) { indexNodes(c, map); }); return map; }

  function getDash() {
    const key = state.hideAssets ? 1 : 0;
    if (!state.dashCache || state.dashCache.key !== key) {
      const fs = state.hideAssets ? state.src.files.filter(function (f) { return !f.isAssetDoc; }) : state.src.files;
      const root = buildTree(fs);
      state.dashCache = { key: key, root: root, map: indexNodes(root, new Map()) };
    }
    return state.dashCache;
  }

  function visibleFiles() {
    let fs = state.src.files;
    if (state.query) {
      const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      return fs.filter(function (f) {
        const hay = (f.path + ' ' + f.title + ' ' + f.tags.join(' ') + ' ' + f.arxiv).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
      });
    }
    return state.hideAssets ? fs.filter(function (f) { return !f.isAssetDoc; }) : fs;
  }

  function folderHtml(node, force) {
    const open = force || state.openFolders.has(node.path);
    const sel = !state.currentPath && state.currentFolder === node.path && node.path !== '';
    let h = '<div class="tree-folder' + (open ? ' open' : '') + '" data-fpath="' + E(node.path) + '">' +
      '<div class="tree-folder-header' + (sel ? ' selected-folder' : '') + '" data-fpath="' + E(node.path) + '">' +
      '<span class="folder-caret">▶</span><span class="folder-icon">📁</span>' +
      '<span class="folder-name" title="' + E(node.name) + '">' + E(node.name) + '</span>' +
      '<span class="folder-count">' + node.count + '</span></div><div class="tree-children">';
    h += childrenHtml(node, force);
    return h + '</div></div>';
  }

  function childrenHtml(node, force) {
    let h = '';
    Array.from(node.folders.values()).sort(function (a, b) { return collator.compare(a.name, b.name); })
      .forEach(function (c) { h += folderHtml(c, force); });
    node.files.slice().sort(function (a, b) { return collator.compare(a.fileName, b.fileName); }).forEach(function (f) {
      const starred = isFavorited(f.path);
      h += '<div class="tree-file" data-path="' + E(f.path) + '" title="' + E(f.path) + '"><span class="file-icon">📄</span>' +
        '<span class="file-title">' + E(f.title) + '</span>' +
        (f.mathCount ? '<span class="math-pill">∑' + f.mathCount + '</span>' : '') +
        '<button type="button" class="file-star-btn' + (starred ? ' starred' : '') + '" data-star-path="' + E(f.path) + '" title="' + (starred ? '取消收藏' : '收藏此文章') + '">' + (starred ? '★' : '☆') + '</button></div>';
    });
    return h;
  }

  function renderFlatList(mode) {
    const isFav = mode === 'fav';
    const items = validListItems(isFav ? state.favorites : state.recent);
    if (el.treeToolbarActions) el.treeToolbarActions.classList.add('hidden');
    if (el.listToolbarActions) el.listToolbarActions.classList.toggle('hidden', items.length === 0);
    if (el.clearListBtn) {
      el.clearListBtn.textContent = isFav ? '清空收藏' : '清空记录';
      el.clearListBtn.title = isFav ? '清空所有浏览器本地收藏' : '清空所有浏览器最近阅读记录';
    }
    el.treeStat.textContent = (isFav ? '收藏文章 · ' : '最近阅读 · ') + items.length + ' 篇';
    if (!items.length) {
      const emptyMsg = state.query
        ? '没有匹配的记录'
        : (isFav ? '暂无收藏文章<br><span style="font-size:11.5px;opacity:.75">可在目录列表或文章右上角点击 ☆ 收藏</span>' : '暂无最近阅读记录');
      el.tree.innerHTML = '<div class="empty-hint">' + emptyMsg + '</div>';
      return;
    }
    let h = '';
    items.forEach(function (it) {
      const f = it.file;
      const sub = isFav ? (f.folder || '根目录') : ((fmtRelTime(it.time) ? fmtRelTime(it.time) + ' · ' : '') + (f.folder || '根目录'));
      h += '<div class="tree-file" data-path="' + E(f.path) + '" title="' + E(f.path) + '">' +
        '<span class="file-icon">' + (isFav ? '⭐' : '🕒') + '</span>' +
        '<div class="flat-item-wrap"><span class="file-title">' + E(f.title) + '</span>' +
        '<span class="flat-item-sub">' + E(sub) + '</span></div>' +
        (f.mathCount ? '<span class="math-pill">∑' + f.mathCount + '</span>' : '') +
        '<button type="button" class="file-remove-btn" data-remove-mode="' + mode + '" data-remove-path="' + E(f.path) + '" title="' + (isFav ? '取消收藏' : '移除此条记录') + '">✕</button></div>';
    });
    el.tree.innerHTML = h;
    syncActive();
  }

  function renderTree() {
    updateListBadges();
    if (state.sidebarTab === 'fav' || state.sidebarTab === 'recent') {
      renderFlatList(state.sidebarTab);
      return;
    }
    if (el.treeToolbarActions) el.treeToolbarActions.classList.remove('hidden');
    if (el.listToolbarActions) el.listToolbarActions.classList.add('hidden');
    const fs = visibleFiles();
    const root = buildTree(fs);
    el.tree.innerHTML = childrenHtml(root, !!state.query) || '<div class="empty-hint">没有匹配的文档</div>';
    const folders = new Set(); fs.forEach(function (f) { if (f.folder) folders.add(f.folder); });
    el.treeStat.textContent = fs.length + ' 篇文档 · ' + folders.size + ' 个文件夹';
    syncActive();
  }

  function syncActive() {
    el.tree.querySelectorAll('.tree-file.active').forEach(function (n) { n.classList.remove('active'); });
    el.tree.querySelectorAll('.tree-folder-header.selected-folder').forEach(function (n) { n.classList.remove('selected-folder'); });
    const cur = state.currentPath;
    if (cur) {
      el.tree.querySelectorAll('.tree-folder').forEach(function (f) {
        const p = f.dataset.fpath;
        if (cur.indexOf(p + '/') === 0) { f.classList.add('open'); state.openFolders.add(p); }
      });
      const target = Array.from(el.tree.querySelectorAll('.tree-file')).find(function (n) { return n.dataset.path === cur; });
      if (target) { target.classList.add('active'); target.scrollIntoView({ block: 'nearest' }); }
    } else if (state.currentFolder) {
      const hd = Array.from(el.tree.querySelectorAll('.tree-folder-header')).find(function (n) { return n.dataset.fpath === state.currentFolder; });
      if (hd) hd.classList.add('selected-folder');
    }
  }

  function setFolderOpen(f, open) {
    f.classList.toggle('open', open);
    if (open) state.openFolders.add(f.dataset.fpath); else state.openFolders.delete(f.dataset.fpath);
  }

  el.tree.addEventListener('click', function (e) {
    const starBtn = e.target.closest('.file-star-btn');
    if (starBtn) {
      e.stopPropagation();
      const p = starBtn.getAttribute('data-star-path');
      const added = toggleFavorite(p);
      showToast(added ? '⭐ 已加入本地收藏' : '已取消收藏');
      return;
    }
    const rmBtn = e.target.closest('.file-remove-btn');
    if (rmBtn) {
      e.stopPropagation();
      const mode = rmBtn.getAttribute('data-remove-mode');
      const p = rmBtn.getAttribute('data-remove-path');
      if (mode === 'fav') { removeFavorite(p); showToast('已取消收藏'); }
      else { removeRecentItem(p); showToast('已移除该条浏览记录'); }
      return;
    }
    const fe = e.target.closest('.tree-file');
    if (fe) { navigate('d', fe.dataset.path); return; }
    const hd = e.target.closest('.tree-folder-header');
    if (!hd) return;
    const folder = hd.parentElement;
    if (e.target.closest('.folder-caret')) { setFolderOpen(folder, !folder.classList.contains('open')); return; }
    const showing = !state.currentPath && state.currentFolder === hd.dataset.fpath;
    setFolderOpen(folder, showing ? !folder.classList.contains('open') : true);
    navigate('f', hd.dataset.fpath);
  });

  if (el.sidebarTabs) {
    el.sidebarTabs.addEventListener('click', function (e) {
      const tabBtn = e.target.closest('.sidebar-tab');
      if (!tabBtn) return;
      const tab = tabBtn.getAttribute('data-tab') || 'tree';
      if (state.sidebarTab === tab) return;
      state.sidebarTab = tab;
      el.sidebarTabs.querySelectorAll('.sidebar-tab').forEach(function (b) {
        const active = b.getAttribute('data-tab') === tab;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      renderTree();
    });
  }

  if (el.clearListBtn) {
    el.clearListBtn.addEventListener('click', function () {
      if (state.sidebarTab === 'fav') {
        if (!state.favorites.length) return;
        state.favorites = [];
        saveFavorites();
        renderTree();
        updateHeaderStarBtn();
        showToast('已清空所有本地收藏');
      } else if (state.sidebarTab === 'recent') {
        if (!state.recent.length) return;
        state.recent = [];
        saveRecent();
        renderTree();
        showToast('已清空所有最近浏览记录');
      }
    });
  }

  /* ---------- 路由 ---------- */
  function navigate(kind, path) {
    const h = kind === 'h' ? '' : '#/' + kind + '/' + encodeURIComponent(path);
    if (location.hash === h || (!h && !location.hash)) route(); else location.hash = h;
  }

  function route() {
    if (!state.src) return;
    const h = location.hash;
    let m;
    if ((m = h.match(/^#\/d\/(.+)$/))) {
      const p = decodeURIComponent(m[1]);
      if (state.src.fileMap.has(p)) return openDoc(p);
    }
    if ((m = h.match(/^#\/f\/(.*)$/))) return openFolder(decodeURIComponent(m[1]));
    return openFolder('');
  }
  window.addEventListener('hashchange', route);

  function setCrumbs(folder, docTitle) {
    let h = '<span class="crumb-item" data-fpath="">' + E(state.src.name) + '</span>';
    let acc = '';
    (folder ? folder.split('/') : []).forEach(function (p) {
      acc = acc ? acc + '/' + p : p;
      h += '<span>/</span><span class="crumb-item" data-fpath="' + E(acc) + '">' + E(p) + '</span>';
    });
    if (docTitle) h += '<span>/</span><span class="crumb-current">' + E(docTitle) + '</span>';
    el.crumbs.innerHTML = h;
  }
  el.crumbs.addEventListener('click', function (e) {
    const c = e.target.closest('.crumb-item');
    if (c) navigate(c.dataset.fpath ? 'f' : 'h', c.dataset.fpath);
  });

  /* ---------- 文件夹概览 ---------- */
  function docCard(f) {
    return '<div class="doc-card" data-path="' + E(f.path) + '"><div class="doc-card-title">' + E(f.title) + '</div>' +
      (f.tags.length ? '<div class="meta-badges">' + f.tags.slice(0, 3).map(function (t) { return '<span class="meta-tag">' + E(t) + '</span>'; }).join('') + '</div>' : '') +
      '<div class="doc-card-footer"><span>' + fmtSize(f.size) + '</span><span>' + (f.mathCount ? '∑ ' + f.mathCount + ' 公式' : fmtDate(f.mtime)) + '</span></div></div>';
  }

  function openFolder(path) {
    const dash = getDash();
    const node = dash.map.get(path) || dash.root;
    path = node.path;
    state.currentPath = null; state.currentFolder = path; state.headings = [];
    el.tocPane.classList.add('hidden');
    setCrumbs(path, '');
    const isHome = path === '';
    const subs = Array.from(node.folders.values()).sort(function (a, b) { return collator.compare(a.name, b.name); });
    const files = node.files.slice().sort(function (a, b) { return collator.compare(a.title, b.title); });
    const all = state.src.files;
    let h = '<div class="folder-dashboard"><div class="dashboard-header"><div class="dashboard-title">' + (isHome ? '📚 ' : '📁 ') + E(node.name) + '</div>' +
      '<div class="dashboard-subtitle">' + (isHome ? E(state.src.pathLabel) : E(path)) + ' · 共 ' + node.count + ' 篇文档</div></div>';
    if (isHome) {
      const math = all.reduce(function (s, f) { return s + f.mathCount; }, 0);
      h += '<div class="stat-cards"><div class="stat-card"><b>' + dash.root.count + '</b><span>笔记</span></div>' +
        '<div class="stat-card"><b>' + math.toLocaleString() + '</b><span>公式</span></div>' +
        '<div class="stat-card"><b>' + (dash.map.size - 1) + '</b><span>文件夹</span></div>' +
        '<div class="stat-card"><b>' + fmtSize(all.reduce(function (s, f) { return s + f.size; }, 0)) + '</b><span>Markdown 体积</span></div></div>';
      const recent = dash.root && Array.from(dash.map.values()).reduce(function (a, n) { return a.concat(n.files); }, [])
        .sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 8);
      if (recent.length) h += '<div class="section-label">最近更新</div><div class="doc-grid">' + recent.map(docCard).join('') + '</div>';
    }
    if (subs.length) {
      h += '<div class="section-label">子文件夹 · ' + subs.length + '</div><div class="subfolder-grid">' +
        subs.map(function (s) {
          return '<div class="subfolder-card" data-fpath="' + E(s.path) + '"><span>📁 ' + E(s.name) + '</span><span class="folder-count">' + s.count + '</span></div>';
        }).join('') + '</div>';
    }
    if (files.length) h += '<div class="section-label">本层文档 · ' + files.length + '</div><div class="doc-grid">' + files.map(docCard).join('') + '</div>';
    h += '</div>';
    el.article.innerHTML = h;
    el.headerStats.innerHTML = '';
    el.scroll.scrollTop = 0;
    syncActive();
  }

  el.article.addEventListener('click', function (e) {
    const card = e.target.closest('.doc-card, .search-result');
    if (card) { navigate('d', card.dataset.path); return; }
    const sub = e.target.closest('.subfolder-card');
    if (sub) { navigate('f', sub.dataset.fpath); return; }
    const il = e.target.closest('a.internal-link');
    if (il) {
      e.preventDefault();
      const p = il.dataset.path;
      if (!p) return;
      if (p === state.currentPath) { scrollToHeading(il.dataset.heading); return; }
      state.pendingHeading = il.dataset.heading || null;
      navigate('d', p); return;
    }
    const an = e.target.closest('a.anchor-link');
    if (an) { e.preventDefault(); scrollToHeading(MDR.safeDecode(an.getAttribute('href').slice(1))); return; }
    const imgToolBtn = e.target.closest('.img-tool-btn');
    if (imgToolBtn) {
      e.preventDefault();
      e.stopPropagation();
      const fig = imgToolBtn.closest('.md-img-figure');
      const vpath = fig && fig.getAttribute('data-vault-path');
      const act = imgToolBtn.getAttribute('data-img-act');
      if (vpath && act === 'crop') openCropModal(vpath);
      else if (vpath && act === 'replace') openImagePickerModal('replace', vpath);
      else if (vpath && act === 'reveal') revealPathInFinder(vpath);
      return;
    }
    const img = e.target.closest('.markdown-rendered img');
    if (img) { el.lightboxImg.src = img.src; el.lightbox.classList.add('open'); }
  });
  el.lightbox.addEventListener('click', function () { el.lightbox.classList.remove('open'); });

  function scrollToHeading(h) {
    if (!h) return;
    const norm = function (s) { return s.toLowerCase().replace(/[\s\-_]+/g, ''); };
    const hs = Array.from(el.article.querySelectorAll('.markdown-rendered h1, h2, h3, h4, h5, h6'));
    const t = norm(h);
    const hit = hs.find(function (x) { return x.id === h || norm(x.textContent) === t; }) ||
      hs.find(function (x) { return norm(x.textContent).indexOf(t) >= 0; });
    if (hit) hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 文档渲染 ---------- */
  const CALLOUT_ICON = { note: '📝', info: 'ℹ️', tip: '💡', warning: '⚠️', important: '❗', summary: '📋', abstract: '📋', question: '❓',
    success: '✅', danger: '⛔', quote: '💬', example: '🔎', bug: '🐞', todo: '☑️', failure: '❌' };

  function postProcess(root) {
    root.querySelectorAll('table').forEach(function (t) {
      const w = document.createElement('div'); w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
    root.querySelectorAll('blockquote').forEach(function (bq) {
      const first = bq.firstElementChild;
      if (!first || first.tagName !== 'P') return;
      const m = first.innerHTML.match(/^\s*\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*([^\n<]*)(?:<br\s*\/?>\s*)?/);
      if (!m) return;
      const type = m[1].toLowerCase();
      const title = m[2].trim() || (type.charAt(0).toUpperCase() + type.slice(1));
      const rest = first.innerHTML.slice(m[0].length);
      const box = document.createElement('div');
      box.className = 'callout-box'; box.dataset.callout = type;
      box.innerHTML = '<div class="callout-header"><span>' + (CALLOUT_ICON[type] || '📌') + '</span><span>' + title + '</span></div>';
      if (rest.trim()) first.innerHTML = rest; else first.remove();
      const body = document.createElement('div');
      while (bq.firstChild) body.appendChild(bq.firstChild);
      box.appendChild(body);
      bq.parentNode.replaceChild(box, bq);
    });

    // 为所有本地知识库内的图片注入悬浮快捷操作栏（原地裁剪 / 替换原图 / 在 Finder 中显示）
    root.querySelectorAll('img[data-vault-path]').forEach(function (img) {
      const vpath = img.getAttribute('data-vault-path');
      if (!vpath) return;
      const wrap = document.createElement('span');
      wrap.className = 'md-img-figure';
      wrap.setAttribute('data-vault-path', vpath);
      img.parentNode.insertBefore(wrap, img);
      wrap.appendChild(img);

      const bar = document.createElement('span');
      bar.className = 'img-edit-toolbar';
      bar.setAttribute('contenteditable', 'false');
      bar.innerHTML =
        '<button type="button" class="img-tool-btn" data-img-act="crop" title="原地裁剪此图片并覆盖保存到原文件">✂️ 裁剪</button>' +
        '<button type="button" class="img-tool-btn" data-img-act="replace" title="用剪贴板 (⌘V) 或本地新图片直接替换文件夹中的这张原图">🔄 替换图片</button>' +
        '<button type="button" class="img-tool-btn" data-img-act="reveal" title="在 Finder 中定位此图片原文件">📂</button>';
      wrap.appendChild(bar);
    });
  }

  async function openDoc(path, preserveScroll) {
    const f = state.src.fileMap.get(path);
    const savedScrollTop = preserveScroll ? el.scroll.scrollTop : 0;
    state.currentPath = path; state.currentFolder = f.folder;
    if (!preserveScroll) recordRecentRead(path);
    setCrumbs(f.folder, f.title);
    syncActive();
    if (!preserveScroll) {
      el.article.innerHTML = '<div class="loading-hint">正在渲染 ' + E(f.title) + '（' + fmtSize(f.size) + '，约 ' + f.mathCount + ' 处公式）…</div>';
      await tick();
    }
    if (state.currentPath !== path) return;
    let html = '', meta = {}, rawText = '';
    try {
      rawText = await state.src.getText(path);
      state.currentMarkdown = rawText;
      const out = MDR.render(rawText, {
        docPath: path,
        resolveAsset: function (r) { return resolveAsset(r, path); },
        resolveAssetInfo: function (r) { return resolveAssetInfo(r, path); },
        resolveNote: function (t) { return resolveNote(t, path); }
      });
      html = out.html; meta = out.meta;
    } catch (err) {
      el.article.innerHTML = '<div class="img-missing">渲染失败：' + E(err.message || String(err)) + '</div>';
      return;
    }
    if (state.currentPath !== path) return;
    const tags = Array.isArray(meta.tags) ? meta.tags : f.tags;
    let badges = tags.map(function (t) { return '<span class="meta-tag">#' + E(t) + '</span>'; }).join('');
    if (meta.status) badges += '<span class="meta-tag" style="background:rgba(16,185,129,.14);color:#059669">' + E(meta.status) + '</span>';
    let info = '';
    if (f.arxiv) info += '<a class="meta-info-item" href="https://arxiv.org/abs/' + E(f.arxiv) + '" target="_blank" rel="noopener">arXiv:' + E(f.arxiv) + '</a>';
    if (f.year) info += '<span class="meta-info-item">' + E(f.year) + '</span>';
    info += '<span class="meta-info-item" title="' + E(path) + '">' + E(path) + '</span>';
    el.article.innerHTML = '<div class="doc-meta-banner"><div class="meta-badges">' + (badges || '<span class="meta-info-item">无标签</span>') +
      '</div><div class="meta-badges">' + info + '</div></div><div class="markdown-rendered">' + html + '</div>';
    postProcess(el.article.querySelector('.markdown-rendered'));
    const starred = isFavorited(path);
    el.headerStats.innerHTML =
      '<button type="button" class="stat-chip stat-chip-btn' + (starred ? ' starred' : '') + '" id="headerStarBtn" title="' + (starred ? '点击取消收藏此文章' : '收藏此文章到浏览器本地书签') + '">' + (starred ? '⭐ 已收藏' : '☆ 收藏') + '</button>' +
      (f.mathCount ? '<span class="stat-chip">∑ ' + f.mathCount + ' 公式</span>' : '') +
      '<span class="stat-chip">' + fmtSize(f.size) + '</span>' + (f.mtime ? '<span class="stat-chip">' + fmtDate(f.mtime) + '</span>' : '');
    const starBtnEl = $('headerStarBtn');
    if (starBtnEl) {
      starBtnEl.addEventListener('click', function () {
        if (!state.currentPath) return;
        const added = toggleFavorite(state.currentPath);
        showToast(added ? '⭐ 已加入本地收藏' : '已取消收藏');
      });
    }
    updateUndoButtons();
    buildToc();
    if (preserveScroll) {
      el.scroll.scrollTop = savedScrollTop;
    } else if (state.pendingHeading) {
      const h = state.pendingHeading; state.pendingHeading = null; setTimeout(function () { scrollToHeading(h); }, 60);
    } else {
      el.scroll.scrollTop = 0;
    }
  }

  function buildToc() {
    const hs = Array.from(el.article.querySelectorAll('.markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3, .markdown-rendered h4'));
    state.headings = hs;
    if (hs.length < 2) { el.tocPane.classList.add('hidden'); return; }
    el.tocList.innerHTML = hs.map(function (h, i) {
      return '<li class="toc-item toc-lvl-' + h.tagName.charAt(1) + '" data-i="' + i + '" title="' + E(h.textContent) + '">' + E(h.textContent) + '</li>';
    }).join('');
    el.tocPane.classList.remove('hidden');
    onScroll();
  }
  el.tocList.addEventListener('click', function (e) {
    const it = e.target.closest('.toc-item');
    if (it && state.headings[+it.dataset.i]) state.headings[+it.dataset.i].scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      const hs = state.headings;
      if (!hs.length) return;
      const top = el.scroll.getBoundingClientRect().top + 30;
      let cur = 0;
      for (let i = 0; i < hs.length; i++) { if (hs[i].getBoundingClientRect().top <= top) cur = i; else break; }
      const items = el.tocList.children;
      for (let i = 0; i < items.length; i++) items[i].classList.toggle('active', i === cur);
      if (items[cur]) items[cur].scrollIntoView({ block: 'nearest' });
    });
  }
  el.scroll.addEventListener('scroll', onScroll);

  /* ---------- 搜索 ---------- */
  function fullTextSearch(q) {
    const docs = state.src.docs;
    state.currentPath = null; state.headings = [];
    el.tocPane.classList.add('hidden'); el.headerStats.innerHTML = '';
    setCrumbs('', '全文搜索：' + q);
    if (!docs) { el.article.innerHTML = '<div class="empty-hint">全文索引未加载（缺少 vault-docs.js），仅支持标题 / 路径搜索。</div>'; return; }
    const ql = q.toLowerCase(), res = [];
    state.src.files.forEach(function (f) {
      const text = docs[f.path];
      if (text == null) return;
      const tl = text.toLowerCase();
      let idx = tl.indexOf(ql);
      const titleHit = f.title.toLowerCase().indexOf(ql) >= 0;
      if (idx < 0 && !titleHit) return;
      let count = 0, p = idx;
      while (p >= 0 && count < 500) { count++; p = tl.indexOf(ql, p + ql.length); }
      res.push({ f: f, idx: idx, count: count, score: count + (titleHit ? 1000 : 0) - (f.isAssetDoc ? 500 : 0) });
    });
    res.sort(function (a, b) { return b.score - a.score; });
    let h = '<div class="dashboard-header"><div class="dashboard-title">🔍 “' + E(q) + '”</div><div class="dashboard-subtitle">命中 ' + res.length + ' 篇文档' + (res.length > 80 ? '，显示前 80 篇' : '') + '</div></div>';
    res.slice(0, 80).forEach(function (r) {
      let snip = '';
      if (r.idx >= 0) {
        const text = docs[r.f.path], s = Math.max(0, r.idx - 50);
        const pre = text.slice(s, r.idx).replace(/\s+/g, ' '), hit = text.slice(r.idx, r.idx + q.length), post = text.slice(r.idx + q.length, r.idx + q.length + 100).replace(/\s+/g, ' ');
        snip = (s > 0 ? '…' : '') + E(pre) + '<mark>' + E(hit) + '</mark>' + E(post) + '…';
      }
      h += '<div class="search-result" data-path="' + E(r.f.path) + '"><div class="sr-title">' + E(r.f.title) + '</div>' +
        '<div class="sr-path">' + E(r.f.path) + ' · ' + r.count + ' 处匹配</div>' + (snip ? '<div class="sr-snippet">' + snip + '</div>' : '') + '</div>';
    });
    if (!res.length) h += '<div class="empty-hint">没有找到相关内容</div>';
    el.article.innerHTML = h;
    el.scroll.scrollTop = 0;
  }

  let searchTimer = 0;
  el.search.addEventListener('input', function () {
    el.searchClear.style.display = el.search.value ? 'block' : 'none';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.query = el.search.value.trim(); renderTree(); }, 120);
  });
  el.search.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && el.search.value.trim()) { state.query = el.search.value.trim(); renderTree(); fullTextSearch(state.query); }
  });
  el.searchClear.addEventListener('click', function () {
    el.search.value = ''; state.query = ''; el.searchClear.style.display = 'none'; renderTree(); route();
  });

  /* ---------- 工具栏 ---------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('hljs-light').disabled = t === 'dark'; $('hljs-dark').disabled = t !== 'dark';
    try { localStorage.setItem('md-reader-theme', t); } catch (e) { /* ignore */ }
  }
  function setSidebarCollapsed(isCollapsed) {
    const sidebarBtn = $('sidebarBtn');
    const actionLabel = isCollapsed ? '展开左侧列表' : '收起左侧列表';
    el.sidebar.classList.toggle('collapsed', isCollapsed);
    sidebarBtn.title = actionLabel;
    sidebarBtn.setAttribute('aria-label', actionLabel);
    sidebarBtn.setAttribute('aria-expanded', String(!isCollapsed));
  }
  $('themeBtn').addEventListener('click', function () { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); });
  $('sidebarBtn').addEventListener('click', function () { setSidebarCollapsed(!el.sidebar.classList.contains('collapsed')); });
  $('sidebarCollapseBtn').addEventListener('click', function () { setSidebarCollapsed(true); });
  $('expandAllBtn').addEventListener('click', function () {
    el.tree.querySelectorAll('.tree-folder').forEach(function (f) { setFolderOpen(f, true); });
  });
  $('collapseAllBtn').addEventListener('click', function () {
    el.tree.querySelectorAll('.tree-folder').forEach(function (f) { setFolderOpen(f, false); });
  });
  el.hideAssetBtn.addEventListener('click', function () {
    state.hideAssets = !state.hideAssets;
    el.hideAssetBtn.classList.toggle('active', state.hideAssets);
    el.hideAssetBtn.textContent = state.hideAssets ? '隐藏附件文档' : '显示附件文档';
    renderTree();
    if (!state.currentPath) route();
  });

  async function loadLocal(fileList, isFolder) {
    el.article.innerHTML = '<div class="loading-hint">正在读取本地文件…</div>';
    const src = await createLocalSource(fileList, isFolder);
    if (!src.files.length) { el.article.innerHTML = '<div class="empty-hint">所选内容里没有找到 .md 文件</div>'; renderTree(); return; }
    setSource(src);
    history.replaceState(null, '', location.pathname);
    route();
  }
  $('pickFolderBtn').addEventListener('click', function () { el.folderInput.click(); });
  $('pickFilesBtn').addEventListener('click', function () { el.filesInput.click(); });
  el.folderInput.addEventListener('change', function () {
    const files = Array.from(el.folderInput.files); el.folderInput.value = '';
    if (files.length) loadLocal(files, true);
  });
  el.filesInput.addEventListener('change', function () {
    const files = Array.from(el.filesInput.files); el.filesInput.value = '';
    if (files.length) loadLocal(files, false);
  });
  async function refreshVaultIndex(silent) {
    const m = await apiFetchManifest();
    if (!m) {
      if (!silent) showToast('未连接到本地服务，无法刷新目录（请确认 server.py 正在运行）', true);
      return false;
    }
    const oldCount = defaultSource && defaultSource.files ? defaultSource.files.length : 0;
    const oldPaths = new Set((defaultSource && defaultSource.files ? defaultSource.files : []).map(function (f) { return f.path; }));
    window.OBSIDIAN_VAULT_MANIFEST = m;
    const keepDocs = defaultSource ? defaultSource.docs : null;
    defaultSource = createDefaultSource();
    if (defaultSource && keepDocs) defaultSource.docs = keepDocs;
    const wasDefault = state.src && state.src.mode === 'default';
    if (wasDefault) {
      const keepPath = state.currentPath, keepFolder = state.currentFolder, keepOpen = state.openFolders;
      setSource(defaultSource);
      state.openFolders = keepOpen;
      renderTree();
      if (keepPath && defaultSource.fileMap.has(keepPath)) { state.currentPath = keepPath; state.currentFolder = keepFolder; syncActive(); }
      else if (!keepPath) route();
    }
    const added = m.files.filter(function (f) { return !oldPaths.has(f.path); }).length;
    const removed = Math.max(0, oldCount + added - m.files.length);
    if (!silent || added || removed) showToast('目录已刷新：共 ' + m.files.length + ' 篇' + (added ? '，新增 ' + added : '') + (removed ? '，移除 ' + removed : ''));
    return true;
  }

  /* ---------- 打开源文件夹（由本地服务调用 Finder） ---------- */
  async function revealPathInFinder(relPath) {
    if (!state.src || state.src.mode !== 'default') {
      showToast('当前内容是通过「读入本地文件夹」载入的，浏览器拿不到它的真实路径，无法定位；默认知识库可用', true);
      return;
    }
    const payload = JSON.stringify({ path: relPath || '' });
    let lastErr = '本地服务未连接，请确认 server.py 正在运行';
    for (let i = 0; i < API_ENDPOINTS.length; i++) {
      const base = API_ENDPOINTS[i];
      if (location.protocol === 'file:' && base.startsWith('/')) continue;
      try {
        const r = await fetch(base + '/reveal', { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'application/json' }, body: payload });
        const j = await r.json();
        if (r.ok && j && j.ok) return;
        lastErr = (j && j.error) || ('HTTP ' + r.status);
        break;
      } catch (e) { lastErr = e.message || String(e); }
    }
    showToast('打开源文件夹失败：' + lastErr, true);
  }
  function openSourceFolder(rootOnly) {
    return revealPathInFinder(rootOnly ? '' : (state.currentPath || ''));
  }
  $('openFolderBtn').addEventListener('click', function () { openSourceFolder(false); });
  el.vaultPath.style.cursor = 'pointer';
  el.vaultPath.addEventListener('click', function () { openSourceFolder(true); });

  $('resetBtn').addEventListener('click', async function () {
    if (!defaultSource) return;
    await refreshVaultIndex(false);
    setSource(defaultSource); history.replaceState(null, '', location.pathname); route();
  });

  window.addEventListener('focus', function () {
    if (state.src && state.src.mode === 'default' && !editingState) refreshVaultIndex(true);
  });

  /* ---------- 顶部固定工具栏 + 全快捷键 + 段落原位渲染编辑 ---------- */
  const topEditorBar = $('topEditorBar');
  const commentPanel = $('commentPanel');
  const commentInput = $('commentInput');
  const commentQuotePreview = $('commentQuotePreview');
  const headerUndoBtn = $('headerUndoBtn');
  const selBlockEditBtn = $('selBlockEditBtn');
  const toastEl = $('toastNotice');

  let activeSelInfo = null;
  let lastHoveredBlock = null;
  let lastClickedBlock = null;
  let editingState = null; // { blockEl, loc, originalHtml }
  let toastTimer = 0;

  function showToast(msg, isError) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#dc2626' : '#1e293b';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  /* ---------- 顶部圆形保存指示器 ---------- */
  const saveInd = $('saveIndicator');
  const SAVE_ANIM_MS = 650;
  let indTimer = 0, indStartTs = 0;

  function indStart() {
    if (!saveInd) return;
    clearTimeout(indTimer);
    saveInd.classList.remove('saving', 'saved', 'failed');
    void saveInd.getBoundingClientRect();
    saveInd.classList.add('saving');
    saveInd.title = '正在写入原文件…';
    indStartTs = Date.now();
  }

  function indFinish(ok, msg) {
    if (!saveInd) return;
    const wait = Math.max(0, SAVE_ANIM_MS - (Date.now() - indStartTs));
    clearTimeout(indTimer);
    indTimer = setTimeout(function () {
      saveInd.classList.remove('saving');
      saveInd.classList.add(ok ? 'saved' : 'failed');
      saveInd.title = msg || (ok ? '已同步到原文件' : '未能写入原文件');
    }, wait);
  }

  // 保存结果是否真正落到了原文件（离线暂存不算）
  function saveResultOk(res) {
    return !!(res && res.ok && !res.offlineCached && !res.localOnly);
  }
  function saveResultNote(res) {
    if (saveResultOk(res)) return '已同步到原文件' + (res.savedAt ? ' · ' + res.savedAt : '');
    return '未写入原文件：本地服务未连接或该文档不在知识库目录内，修改仅暂存在浏览器里';
  }

  function updateUndoButtons() {
    const ok = !!(state.currentPath && window.MDEditor && MDEditor.canUndo(state.currentPath));
    if (headerUndoBtn) headerUndoBtn.disabled = !ok;
  }

  function closeCommentPanel() {
    if (!commentPanel) return;
    commentPanel.classList.add('hidden');
    commentInput.value = '';
  }

  // 记录鼠标所在段落与划选文本（不再弹出浮动条，静默记录供顶部工具栏和快捷键使用）
  el.article.addEventListener('mousemove', function (e) {
    const container = el.article.querySelector('.markdown-rendered');
    if (!container) return;
    const blk = MDEditor.findClosestEditableBlock(e.target, container);
    if (blk) lastHoveredBlock = blk;
  });

  el.article.addEventListener('mousedown', function (e) {
    const container = el.article.querySelector('.markdown-rendered');
    if (!container) return;
    const blk = MDEditor.findClosestEditableBlock(e.target, container);
    if (blk) lastClickedBlock = blk;
  });

  el.article.addEventListener('mouseup', function () {
    setTimeout(function () {
      if (!state.currentPath || !window.MDEditor) return;
      const info = MDEditor.extractSelectionInfo(el.article);
      if (info && info.text.length > 0) {
        activeSelInfo = info;
        if (info.blockElement) lastClickedBlock = info.blockElement;
      } else {
        activeSelInfo = null;
      }
    }, 15);
  });

  document.addEventListener('mousedown', function (e) {
    if (commentPanel && !commentPanel.classList.contains('hidden')) {
      if (!topEditorBar.contains(e.target)) {
        closeCommentPanel();
      }
    }
  });

  async function commitMarkdownEdit(newMarkdown, actionLabel, opts) {
    const path = state.currentPath;
    if (!path || !state.src) return;
    const oldMarkdown = state.currentMarkdown || await state.src.getText(path);
    if (newMarkdown === oldMarkdown) {
      closeCommentPanel();
      return;
    }
    if (!(opts && opts.skipUndo)) MDEditor.pushUndo(path, oldMarkdown);
    state.currentMarkdown = newMarkdown;
    indStart();
    try {
      const res = await state.src.saveText(path, newMarkdown);
      closeCommentPanel();
      const preservedSel = opts && opts.keepSelection ? opts.keepSelection : null;
      window.getSelection().removeAllRanges();
      activeSelInfo = null;
      await openDoc(path, true);
      if (preservedSel && MDEditor.restoreSelectionInfo) {
        activeSelInfo = MDEditor.restoreSelectionInfo(el.article, preservedSel);
      }
      const ok = saveResultOk(res);
      indFinish(ok, saveResultNote(res));
      if (!ok) showToast('「' + actionLabel + '」已显示，但没有写入原文件：' + saveResultNote(res), true);
    } catch (err) {
      indFinish(false, '写入失败：' + (err.message || err));
      showToast('写入失败：' + (err.message || err), true);
    }
  }

  async function runSelectionTransform(transformFn, actionLabel, keepSel) { if (window.READER_READONLY) return;
    const path = state.currentPath;
    if (!path || !window.MDEditor) return;
    const info = MDEditor.extractSelectionInfo(el.article) || activeSelInfo;
    if (editingState) {
      await finishBlockEdit(true);
    }
    if (!info || !info.text) {
      showToast('请先用鼠标在正文中选中文字，再执行「' + actionLabel + '」', true);
      return;
    }
    const rawMd = state.currentMarkdown || await state.src.getText(path);
    const loc = MDEditor.locateInMarkdown(rawMd, info);
    if (!loc) {
      showToast('未能在原始 md 中唯一定位该选区（建议缩小选中范围重试）', true);
      return;
    }
    const updated = transformFn(rawMd, loc);
    await commitMarkdownEdit(updated, actionLabel, {
      keepSelection: keepSel === false ? null : info
    });
  }

  async function triggerUndo() { if (window.READER_READONLY) return;
    if (editingState) { await cancelBlockEdit(); return; }
    const path = state.currentPath;
    if (!path || !window.MDEditor || !MDEditor.canUndo(path)) {
      showToast('当前文档没有可撤销的修改');
      return;
    }
    const curMd = state.currentMarkdown || await state.src.getText(path);
    const entry = MDEditor.popUndo(path, curMd);
    if (!entry) return;

    // 情况 1：撤销原地裁剪或图片替换（将备份的原图二进制写回原路径）
    if (entry.type === 'img') {
      indStart();
      try {
        await apiOverwriteImage(entry.imagePath, entry.previousDataUrl);
        state.assetBuster.set(entry.imagePath, Date.now());
        await openDoc(path, true);
        indFinish(true, '已恢复原图片文件：' + entry.imagePath);
        showToast('↩ 已恢复原图片：' + basename(entry.imagePath));
      } catch (err) {
        indFinish(false, '撤销图片修改失败：' + (err.message || err));
        showToast('撤销图片修改失败：' + (err.message || err), true);
      }
      return;
    }

    // 情况 2：撤销文本或插入图片修改
    const prevMd = typeof entry === 'string' ? entry : entry.markdown;
    if (prevMd == null) return;
    state.currentMarkdown = prevMd;
    indStart();
    try {
      const res = await state.src.saveText(path, prevMd);
      closeCommentPanel();
      await openDoc(path, true);
      const ok = saveResultOk(res);
      indFinish(ok, saveResultNote(res));
      if (!ok) showToast('已撤销，但没有写入原文件：' + saveResultNote(res), true);
    } catch (err) {
      indFinish(false, '撤销保存失败：' + (err.message || err));
      showToast('撤销保存失败：' + (err.message || err), true);
    }
  }

  /* ---------- 段落级原位渲染态编辑（保持渲染效果，仅加 border 边界框） ---------- */
  async function startBlockEdit(targetBlock) { if (window.READER_READONLY) return;
    const path = state.currentPath;
    if (!path || !window.MDEditor) return;
    const container = el.article.querySelector('.markdown-rendered');
    if (!container) return;

    const blockEl = targetBlock ||
      (activeSelInfo && activeSelInfo.blockElement && container.contains(activeSelInfo.blockElement) ? activeSelInfo.blockElement : null) ||
      (lastClickedBlock && container.contains(lastClickedBlock) ? lastClickedBlock : null) ||
      (lastHoveredBlock && container.contains(lastHoveredBlock) ? lastHoveredBlock : null);

    if (!blockEl) {
      showToast('请先将鼠标放在或点击你要编辑的段落上，再按 ⌘E 或点击「段落编辑」', true);
      return;
    }

    if (editingState && editingState.blockEl === blockEl) {
      await finishBlockEdit(true);
      return;
    }
    if (editingState) {
      await finishBlockEdit(true);
    }

    const blkInfo = MDEditor.getBlockSelectionInfo(blockEl, container);
    if (!blkInfo && blockEl.querySelector && blockEl.querySelector('img')) {
      showToast('图片请直接将鼠标移至图片右上角，使用「✂️ 裁剪」或「🔄 替换图片」', false);
      return;
    }
    const rawMd = state.currentMarkdown || await state.src.getText(path);
    const loc = blkInfo ? MDEditor.locateInMarkdown(rawMd, blkInfo) : null;
    if (!loc) {
      showToast('该段落包含复杂嵌套结构，暂无法原位映射回源码', true);
      return;
    }

    // 把段落内的 KaTeX 公式节点、子列表与图片工具条设为 contenteditable="false"，保持渲染且不被误删内部 DOM
    blockEl.querySelectorAll('.katex, ul, ol, .img-edit-toolbar').forEach(function (k) {
      k.setAttribute('contenteditable', 'false');
    });

    const st = {
      blockEl: blockEl,
      loc: loc,
      originalHtml: blockEl.innerHTML,
      baseMd: rawMd,
      undoPushed: false,
      composing: false,
      busy: false,
      dirty: false,
      timer: 0,
      lastRes: null,
      handlers: null
    };
    st.handlers = {
      input: function () { if (!st.composing) scheduleAutosave(st); },
      compStart: function () { st.composing = true; clearTimeout(st.timer); },
      compEnd: function () { st.composing = false; scheduleAutosave(st); }
    };
    blockEl.addEventListener('input', st.handlers.input);
    blockEl.addEventListener('compositionstart', st.handlers.compStart);
    blockEl.addEventListener('compositionend', st.handlers.compEnd);
    editingState = st;

    blockEl.setAttribute('contenteditable', 'true');
    blockEl.classList.add('md-block-editing');
    selBlockEditBtn.classList.add('active');
    blockEl.focus();
  }

  function detachBlockEdit(st) {
    clearTimeout(st.timer);
    st.blockEl.removeEventListener('input', st.handlers.input);
    st.blockEl.removeEventListener('compositionstart', st.handlers.compStart);
    st.blockEl.removeEventListener('compositionend', st.handlers.compEnd);
    st.blockEl.removeAttribute('contenteditable');
    st.blockEl.querySelectorAll('[contenteditable]').forEach(function (n) {
      if (n.classList && n.classList.contains('img-edit-toolbar')) return;
      n.removeAttribute('contenteditable');
    });
    st.blockEl.classList.remove('md-block-editing');
    selBlockEditBtn.classList.remove('active');
  }

  function scheduleAutosave(st) {
    clearTimeout(st.timer);
    st.timer = setTimeout(function () { autosaveBlock(st); }, 900);
  }

  // 边输入边写入原文件：只写文件，不重绘当前段落，避免光标跳动
  async function autosaveBlock(st) {
    if (editingState !== st || st.composing) return;
    if (st.busy) { st.dirty = true; return; }
    const path = state.currentPath;
    if (!path) return;
    const rawMd = state.currentMarkdown || await state.src.getText(path);
    const oldSeg = rawMd.slice(st.loc.start, st.loc.end);
    const seg = MDEditor.serializeBlockElementToMarkdown(st.blockEl, oldSeg);
    if (!seg || seg === oldSeg) return;
    const next = rawMd.slice(0, st.loc.start) + seg + rawMd.slice(st.loc.end);
    if (!st.undoPushed) { MDEditor.pushUndo(path, rawMd); st.undoPushed = true; updateUndoButtons(); }
    state.currentMarkdown = next;
    st.loc = { start: st.loc.start, end: st.loc.start + seg.length };
    st.busy = true;
    indStart();
    try {
      const res = await state.src.saveText(path, next);
      st.lastRes = res;
      indFinish(saveResultOk(res), saveResultNote(res));
    } catch (err) {
      indFinish(false, '写入失败：' + (err.message || err));
      showToast('写入失败：' + (err.message || err), true);
    }
    st.busy = false;
    if (st.dirty) { st.dirty = false; autosaveBlock(st); }
  }

  async function waitBlockIdle(st) {
    let guard = 0;
    while (st.busy && guard++ < 100) await new Promise(function (r) { setTimeout(r, 30); });
  }

  // Esc / 撤销按钮：撤回本次段落编辑（已实时写入的部分也一并还原到原文件）
  async function cancelBlockEdit() {
    const st = editingState;
    if (!st) return;
    clearTimeout(st.timer);
    await waitBlockIdle(st);
    editingState = null;
    detachBlockEdit(st);
    const path = state.currentPath;
    if (st.undoPushed && path) {
      const entry = MDEditor.popUndo(path, state.currentMarkdown || '');
      const prev = entry && typeof entry === 'object' ? entry.markdown : entry;
      if (prev != null) {
        state.currentMarkdown = prev;
        indStart();
        try {
          const res = await state.src.saveText(path, prev);
          await openDoc(path, true);
          indFinish(saveResultOk(res), saveResultNote(res));
        } catch (err) {
          indFinish(false, '撤回失败：' + (err.message || err));
          showToast('撤回失败：' + (err.message || err), true);
        }
      }
      return;
    }
    st.blockEl.innerHTML = st.originalHtml;
  }

  // ⌘Enter / 点击段落外：完成编辑，保存最后一次修改并按渲染态重绘
  async function finishBlockEdit(shouldSave) {
    const st = editingState;
    if (!st) return;
    clearTimeout(st.timer);
    await waitBlockIdle(st);
    const unchanged = !st.undoPushed && st.blockEl.innerHTML === st.originalHtml;
    editingState = null;
    detachBlockEdit(st);
    if (!shouldSave || unchanged) return;
    const path = state.currentPath;
    if (!path) return;

    const rawMd = state.currentMarkdown || await state.src.getText(path);
    const oldSeg = rawMd.slice(st.loc.start, st.loc.end);
    const seg = MDEditor.serializeBlockElementToMarkdown(st.blockEl, oldSeg);
    if (seg && seg !== oldSeg) {
      const updatedMd = rawMd.slice(0, st.loc.start) + seg + rawMd.slice(st.loc.end);
      await commitMarkdownEdit(updatedMd, '修改段落内容', { skipUndo: st.undoPushed });
    } else if (st.undoPushed) {
      // 内容已经实时写入，仅需按渲染态重绘该段
      await openDoc(path, true);
      indFinish(saveResultOk(st.lastRes), saveResultNote(st.lastRes));
    }
  }

  // 当点击正在编辑的段落外部时，自动保存该段落修改
  document.addEventListener('mousedown', function (e) {
    if (!editingState) return;
    if (editingState.blockEl.contains(e.target)) return;
    if (topEditorBar && topEditorBar.contains(e.target)) return;
    finishBlockEdit(true);
  });

  // 防止点击顶部工具栏按钮时丢失正文文字选区
  topEditorBar.addEventListener('mousedown', function (e) {
    if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
    }
  });

  $('selBoldBtn').addEventListener('click', function () {
    runSelectionTransform(function (md, loc) {
      return MDEditor.applyBoldToggle(md, loc);
    }, '切换加粗 (** **)');
  });

  $('selColors').addEventListener('click', function (e) {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    const color = dot.dataset.color;
    runSelectionTransform(function (md, loc) {
      return MDEditor.applyColorSpan(md, loc, color);
    }, '设置颜色 (' + color + ')');
  });

  $('selClearColorBtn').addEventListener('click', function () {
    runSelectionTransform(function (md, loc) {
      return MDEditor.removeColorSpan(md, loc);
    }, '取消文字颜色');
  });

  headerUndoBtn.addEventListener('click', triggerUndo);

  selBlockEditBtn.addEventListener('click', function () {
    startBlockEdit(null);
  });

  const selInsertImgBtn = $('selInsertImgBtn');
  if (selInsertImgBtn) {
    selInsertImgBtn.addEventListener('click', function () {
      if (!state.currentPath) {
        showToast('请先打开一篇笔记文档，再插入图片', true);
        return;
      }
      openImagePickerModal('insert', null);
    });
  }

  /* ---------- 图片编辑模块：1. 原地裁剪 (In-place Crop)  2. 替换图片 (Replace)  3. 插入图片 (Insert) ---------- */
  const cropModal = $('cropModal');
  const cropModalPath = $('cropModalPath');
  const cropDimBadge = $('cropDimBadge');
  const cropCanvasWrap = $('cropCanvasWrap');
  const cropSourceImg = $('cropSourceImg');
  const cropBox = $('cropBox');
  const cropResetBoxBtn = $('cropResetBoxBtn');
  const cropCancelBtn = $('cropCancelBtn');
  const cropConfirmBtn = $('cropConfirmBtn');

  let cropState = null; // { vaultPath, natW, natH, dispW, dispH, rect: {x, y, w, h}, drag: null }

  function closeCropModal() {
    if (!cropModal) return;
    cropModal.classList.add('hidden');
    cropSourceImg.src = '';
    cropState = null;
  }

  function syncCropBoxDom() {
    if (!cropState) return;
    const r = cropState.rect;
    cropBox.style.left = r.x + 'px';
    cropBox.style.top = r.y + 'px';
    cropBox.style.width = r.w + 'px';
    cropBox.style.height = r.h + 'px';

    const scaleX = cropState.natW / (cropState.dispW || 1);
    const scaleY = cropState.natH / (cropState.dispH || 1);
    const realW = Math.max(1, Math.round(r.w * scaleX));
    const realH = Math.max(1, Math.round(r.h * scaleY));
    cropDimBadge.textContent = '裁剪尺寸：' + realW + ' × ' + realH + ' px（原图 ' + cropState.natW + ' × ' + cropState.natH + ' px）';
  }

  function resetCropBoxToFull() {
    if (!cropState) return;
    const w = cropSourceImg.clientWidth || cropState.dispW;
    const h = cropSourceImg.clientHeight || cropState.dispH;
    cropState.dispW = w;
    cropState.dispH = h;
    // 默认给出内缩 8% 的易见裁剪框，方便用户直接拖动边缘，也可点击“全选整图”
    const padX = Math.round(w * 0.06);
    const padY = Math.round(h * 0.06);
    cropState.rect = {
      x: padX,
      y: padY,
      w: Math.max(24, w - padX * 2),
      h: Math.max(24, h - padY * 2)
    };
    syncCropBoxDom();
  }

  async function openCropModal(vaultRelPath) {
    if (!state.src || state.src.mode !== 'default') {
      showToast('只有默认知识库模式支持直接修改原图文件', true);
      return;
    }
    cropModalPath.textContent = vaultRelPath;
    cropDimBadge.textContent = '正在加载原图…';
    cropModal.classList.remove('hidden');

    const dataUrl = await apiReadImageDataUrl(vaultRelPath);
    if (!dataUrl) {
      closeCropModal();
      showToast('读取原图片失败，请确认 server.py 正在运行', true);
      return;
    }

    cropSourceImg.onload = function () {
      const natW = cropSourceImg.naturalWidth || 1;
      const natH = cropSourceImg.naturalHeight || 1;
      const dispW = cropSourceImg.clientWidth || natW;
      const dispH = cropSourceImg.clientHeight || natH;
      cropState = {
        vaultPath: vaultRelPath,
        natW: natW,
        natH: natH,
        dispW: dispW,
        dispH: dispH,
        rect: { x: 0, y: 0, w: dispW, h: dispH },
        drag: null
      };
      resetCropBoxToFull();
    };
    cropSourceImg.src = dataUrl;
  }

  if (cropResetBoxBtn) {
    cropResetBoxBtn.addEventListener('click', function () {
      if (!cropState) return;
      cropState.dispW = cropSourceImg.clientWidth || cropState.dispW;
      cropState.dispH = cropSourceImg.clientHeight || cropState.dispH;
      cropState.rect = { x: 0, y: 0, w: cropState.dispW, h: cropState.dispH };
      syncCropBoxDom();
    });
  }
  if (cropCancelBtn) cropCancelBtn.addEventListener('click', closeCropModal);

  if (cropCanvasWrap) {
    cropCanvasWrap.addEventListener('mousedown', function (e) {
      if (!cropState) return;
      e.preventDefault();
      cropState.dispW = cropSourceImg.clientWidth || cropState.dispW;
      cropState.dispH = cropSourceImg.clientHeight || cropState.dispH;
      const wrapRect = cropCanvasWrap.getBoundingClientRect();
      const mx = Math.max(0, Math.min(cropState.dispW, e.clientX - wrapRect.left));
      const my = Math.max(0, Math.min(cropState.dispH, e.clientY - wrapRect.top));

      const handleEl = e.target.closest('.crop-handle');
      if (handleEl) {
        cropState.drag = {
          mode: handleEl.getAttribute('data-handle'),
          startX: e.clientX,
          startY: e.clientY,
          orig: Object.assign({}, cropState.rect)
        };
      } else if (e.target === cropBox || cropBox.contains(e.target)) {
        cropState.drag = {
          mode: 'move',
          startX: e.clientX,
          startY: e.clientY,
          orig: Object.assign({}, cropState.rect)
        };
      } else {
        // 在图片空白处直接拖拽拉出新选框
        cropState.rect = { x: mx, y: my, w: 1, h: 1 };
        cropState.drag = {
          mode: 'new',
          anchorX: mx,
          anchorY: my
        };
        syncCropBoxDom();
      }
    });
  }

  window.addEventListener('mousemove', function (e) {
    if (!cropState || !cropState.drag) return;
    const d = cropState.drag;
    const maxW = cropState.dispW;
    const maxH = cropState.dispH;
    const minSize = 16;

    if (d.mode === 'new') {
      const wrapRect = cropCanvasWrap.getBoundingClientRect();
      const curX = Math.max(0, Math.min(maxW, e.clientX - wrapRect.left));
      const curY = Math.max(0, Math.min(maxH, e.clientY - wrapRect.top));
      const x1 = Math.min(d.anchorX, curX);
      const y1 = Math.min(d.anchorY, curY);
      const x2 = Math.max(d.anchorX, curX);
      const y2 = Math.max(d.anchorY, curY);
      cropState.rect = {
        x: x1,
        y: y1,
        w: Math.max(minSize, x2 - x1),
        h: Math.max(minSize, y2 - y1)
      };
      syncCropBoxDom();
      return;
    }

    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const o = d.orig;

    if (d.mode === 'move') {
      const nx = Math.max(0, Math.min(maxW - o.w, o.x + dx));
      const ny = Math.max(0, Math.min(maxH - o.h, o.y + dy));
      cropState.rect = { x: nx, y: ny, w: o.w, h: o.h };
      syncCropBoxDom();
      return;
    }

    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    if (d.mode.indexOf('w') >= 0) x1 = Math.max(0, Math.min(x2 - minSize, o.x + dx));
    if (d.mode.indexOf('e') >= 0) x2 = Math.min(maxW, Math.max(x1 + minSize, o.x + o.w + dx));
    if (d.mode.indexOf('n') >= 0) y1 = Math.max(0, Math.min(y2 - minSize, o.y + dy));
    if (d.mode.indexOf('s') >= 0) y2 = Math.min(maxH, Math.max(y1 + minSize, o.y + o.h + dy));
    cropState.rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    syncCropBoxDom();
  });

  window.addEventListener('mouseup', function () {
    if (cropState && cropState.drag) {
      cropState.drag = null;
    }
  });

  async function confirmCropSave() {
    if (!cropState || !state.currentPath) return;
    const st = cropState;
    const scaleX = st.natW / (st.dispW || 1);
    const scaleY = st.natH / (st.dispH || 1);
    const sx = Math.max(0, Math.round(st.rect.x * scaleX));
    const sy = Math.max(0, Math.round(st.rect.y * scaleY));
    const sw = Math.min(st.natW - sx, Math.max(1, Math.round(st.rect.w * scaleX)));
    const sh = Math.min(st.natH - sy, Math.max(1, Math.round(st.rect.h * scaleY)));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cropSourceImg, sx, sy, sw, sh, 0, 0, sw, sh);

    const ext = (st.vaultPath.split('.').pop() || '').toLowerCase();
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : (ext === 'webp' ? 'image/webp' : 'image/png');
    const croppedDataUrl = canvas.toDataURL(mime, 0.95);

    cropConfirmBtn.disabled = true;
    indStart();
    try {
      const res = await apiOverwriteImage(st.vaultPath, croppedDataUrl);
      if (res && res.previousDataUrl) {
        MDEditor.pushUndo(state.currentPath, {
          type: 'img',
          imagePath: st.vaultPath,
          previousDataUrl: res.previousDataUrl
        });
        updateUndoButtons();
      }
      state.assetBuster.set(st.vaultPath, Date.now());
      closeCropModal();
      await openDoc(state.currentPath, true);
      indFinish(true, '已原地裁剪并写入原图：' + st.vaultPath);
      showToast('✂️ 已原地裁剪并覆盖原图 (' + sw + '×' + sh + ' px)，可按 ⌘Z 撤销');
    } catch (err) {
      indFinish(false, '裁剪保存失败：' + (err.message || err));
      showToast('裁剪保存失败：' + (err.message || err), true);
    } finally {
      cropConfirmBtn.disabled = false;
    }
  }

  if (cropConfirmBtn) cropConfirmBtn.addEventListener('click', confirmCropSave);

  /* ---------- 替换图片 / 插入图片 弹窗逻辑 ---------- */
  const imgPickerModal = $('imgPickerModal');
  const imgPickerTitle = $('imgPickerTitle');
  const imgPickerSub = $('imgPickerSub');
  const imgDropzone = $('imgDropzone');
  const imgDropzoneEmpty = $('imgDropzoneEmpty');
  const imgDropzonePreview = $('imgDropzonePreview');
  const imgPickerPreviewImg = $('imgPickerPreviewImg');
  const imgPickerPreviewMeta = $('imgPickerPreviewMeta');
  const imgReadClipboardBtn = $('imgReadClipboardBtn');
  const imgBrowseLocalBtn = $('imgBrowseLocalBtn');
  const imgClearPreviewBtn = $('imgClearPreviewBtn');
  const imgInsertOptions = $('imgInsertOptions');
  const imgAltInput = $('imgAltInput');
  const imgPositionSelect = $('imgPositionSelect');
  const imgPickerHint = $('imgPickerHint');
  const imgPickerCancelBtn = $('imgPickerCancelBtn');
  const imgPickerConfirmBtn = $('imgPickerConfirmBtn');
  const imgReplaceFileInput = $('imgReplaceFileInput');
  const imgInsertFileInput = $('imgInsertFileInput');

  let pickerState = null; // { mode: 'replace'|'insert', targetVaultPath, anchorBlock, dataUrl, fileName, byteSize }

  function closeImagePickerModal() {
    if (!imgPickerModal) return;
    imgPickerModal.classList.add('hidden');
    imgPickerPreviewImg.src = '';
    pickerState = null;
  }

  function setPickerPreviewData(dataUrl, fileName, byteSize) {
    if (!pickerState) return;
    pickerState.dataUrl = dataUrl;
    pickerState.fileName = fileName || 'clipboard-image.png';
    pickerState.byteSize = byteSize || Math.round((dataUrl.length * 3) / 4);
    imgPickerPreviewImg.onload = function () {
      const dims = (imgPickerPreviewImg.naturalWidth || 0) + ' × ' + (imgPickerPreviewImg.naturalHeight || 0) + ' px';
      imgPickerPreviewMeta.textContent = pickerState.fileName + ' · ' + dims + ' · ' + fmtSize(pickerState.byteSize);
    };
    imgPickerPreviewImg.src = dataUrl;
    imgDropzoneEmpty.classList.add('hidden');
    imgDropzonePreview.classList.remove('hidden');
    imgPickerConfirmBtn.disabled = false;
  }

  function clearPickerPreview() {
    if (!pickerState) return;
    pickerState.dataUrl = null;
    pickerState.fileName = null;
    imgPickerPreviewImg.src = '';
    imgDropzoneEmpty.classList.remove('hidden');
    imgDropzonePreview.classList.add('hidden');
    imgPickerConfirmBtn.disabled = true;
  }

  function readBlobAsDataUrl(blob, fileName) {
    const reader = new FileReader();
    reader.onload = function (ev) {
      setPickerPreviewData(ev.target.result, fileName || blob.name || 'image.png', blob.size);
    };
    reader.readAsDataURL(blob);
  }

  function openImagePickerModal(mode, targetVaultPath, preloadedBlob) {
    if (!state.src || state.src.mode !== 'default') {
      showToast('只有默认知识库模式支持直接写入图片到原文件夹', true);
      return;
    }
    const container = el.article.querySelector('.markdown-rendered');
    const anchorBlock =
      (activeSelInfo && activeSelInfo.blockElement && container && container.contains(activeSelInfo.blockElement) ? activeSelInfo.blockElement : null) ||
      (lastClickedBlock && container && container.contains(lastClickedBlock) ? lastClickedBlock : null) ||
      (lastHoveredBlock && container && container.contains(lastHoveredBlock) ? lastHoveredBlock : null);

    pickerState = {
      mode: mode,
      targetVaultPath: targetVaultPath || null,
      anchorBlock: anchorBlock,
      dataUrl: null,
      fileName: null,
      byteSize: 0
    };

    clearPickerPreview();
    if (mode === 'replace') {
      imgPickerTitle.textContent = '🔄 替换原图片文件';
      imgPickerSub.textContent = targetVaultPath || '';
      imgInsertOptions.classList.add('hidden');
      imgPickerHint.textContent = '新图片将直接覆盖原文件夹中的同名文件，笔记中的引用自动生效';
      imgPickerConfirmBtn.textContent = '💾 覆盖原图片文件 (⌘↵)';
    } else {
      const noteStem = basename(state.currentPath || '').replace(/\.md$/i, '');
      imgPickerTitle.textContent = '🖼️ 插入新图片到笔记';
      imgPickerSub.textContent = '将保存至 assets/' + noteStem + '/';
      imgInsertOptions.classList.remove('hidden');
      imgAltInput.value = '';
      imgPositionSelect.value = anchorBlock ? 'after' : 'end';
      imgPickerHint.textContent = anchorBlock
        ? ('定位段落：「' + (anchorBlock.textContent || '').trim().slice(0, 26) + '…」')
        : '未选中特定段落，默认插入到文档末尾';
      imgPickerConfirmBtn.textContent = '💾 保存图片并插入原文档 (⌘↵)';
    }

    imgPickerModal.classList.remove('hidden');
    setTimeout(function () { imgDropzone.focus(); }, 20);

    if (preloadedBlob) {
      readBlobAsDataUrl(preloadedBlob, preloadedBlob.name || 'pasted-image.png');
    }
  }

  if (imgClearPreviewBtn) imgClearPreviewBtn.addEventListener('click', clearPickerPreview);
  if (imgPickerCancelBtn) imgPickerCancelBtn.addEventListener('click', closeImagePickerModal);

  if (imgBrowseLocalBtn) {
    imgBrowseLocalBtn.addEventListener('click', function () {
      if (!pickerState) return;
      if (pickerState.mode === 'replace') imgReplaceFileInput.click();
      else imgInsertFileInput.click();
    });
  }

  [imgReplaceFileInput, imgInsertFileInput].forEach(function (inp) {
    if (!inp) return;
    inp.addEventListener('change', function () {
      const f = inp.files && inp.files[0];
      inp.value = '';
      if (f && pickerState) readBlobAsDataUrl(f, f.name);
    });
  });

  if (imgReadClipboardBtn) {
    imgReadClipboardBtn.addEventListener('click', async function () {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        showToast('请直接按键盘 ⌘V 粘贴剪贴板中的图片', false);
        imgDropzone.focus();
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const imgType = item.types.find(function (t) { return t.indexOf('image/') === 0; });
          if (imgType) {
            const blob = await item.getType(imgType);
            const ext = imgType.split('/')[1] || 'png';
            readBlobAsDataUrl(blob, 'clipboard.' + ext);
            return;
          }
        }
        showToast('剪贴板中没有检测到图片，请先截图或复制图片后再试', true);
      } catch (e) {
        showToast('请直接按键盘 ⌘V 粘贴剪贴板中的图片', false);
        imgDropzone.focus();
      }
    });
  }

  if (imgDropzone) {
    ['dragenter', 'dragover'].forEach(function (ev) {
      imgDropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        imgDropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      imgDropzone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        imgDropzone.classList.remove('dragover');
      });
    });
    imgDropzone.addEventListener('drop', function (e) {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      const imgFile = files.find(function (f) { return /^image\//i.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name); });
      if (imgFile && pickerState) {
        readBlobAsDataUrl(imgFile, imgFile.name);
      }
    });
  }

  // 全局粘贴事件：1) 若替换/插入弹窗已打开，直接读入剪贴板图片；2) 若在阅读笔记时直接按 Cmd+V 且剪贴板中有图片，自动唤起插入图片弹窗并载入该图
  document.addEventListener('paste', function (e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let imgBlob = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) {
        imgBlob = items[i].getAsFile();
        break;
      }
    }
    if (!imgBlob) return;

    if (pickerState && !imgPickerModal.classList.contains('hidden')) {
      e.preventDefault();
      readBlobAsDataUrl(imgBlob, imgBlob.name || 'clipboard-image.png');
      return;
    }

    const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    if (!inInput && state.currentPath && state.src && state.src.mode === 'default') {
      e.preventDefault();
      openImagePickerModal('insert', null, imgBlob);
    }
  });

  async function confirmImagePicker() {
    if (!pickerState || !pickerState.dataUrl || !state.currentPath) return;
    const st = pickerState;
    imgPickerConfirmBtn.disabled = true;
    indStart();

    try {
      if (st.mode === 'replace') {
        const res = await apiOverwriteImage(st.targetVaultPath, st.dataUrl);
        if (res && res.previousDataUrl) {
          MDEditor.pushUndo(state.currentPath, {
            type: 'img',
            imagePath: st.targetVaultPath,
            previousDataUrl: res.previousDataUrl
          });
          updateUndoButtons();
        }
        state.assetBuster.set(st.targetVaultPath, Date.now());
        closeImagePickerModal();
        await openDoc(state.currentPath, true);
        indFinish(true, '已替换原图片文件：' + st.targetVaultPath);
        showToast('🔄 已直接替换文件夹中的原图片：' + basename(st.targetVaultPath) + '（可按 ⌘Z 撤销）');
      } else {
        const upRes = await apiUploadNewImage(state.currentPath, st.dataUrl, null);
        const vaultRel = upRes.vaultPath;
        const mdLink = upRes.markdownLink;
        if (state.src && state.src.assetIndex) {
          state.src.assetIndex[vaultRel] = vaultRel;
          state.src.assetIndex[basename(vaultRel)] = vaultRel;
        }
        state.assetBuster.set(vaultRel, Date.now());

        const rawMd = state.currentMarkdown || await state.src.getText(state.currentPath);
        const container = el.article.querySelector('.markdown-rendered');
        let loc = null;
        const pos = imgPositionSelect.value || 'after';
        if (pos !== 'end' && st.anchorBlock && container && container.contains(st.anchorBlock)) {
          const blkInfo = MDEditor.getBlockSelectionInfo(st.anchorBlock, container);
          if (blkInfo) loc = MDEditor.locateInMarkdown(rawMd, blkInfo);
        }
        const updatedMd = MDEditor.insertImageMarkdown(rawMd, loc, mdLink, imgAltInput.value, pos);
        closeImagePickerModal();
        await commitMarkdownEdit(updatedMd, '插入新图片 (' + upRes.fileName + ')');
        showToast('🖼️ 已存入 ' + vaultRel + ' 并写入原笔记');
      }
    } catch (err) {
      indFinish(false, '图片操作失败：' + (err.message || err));
      showToast('图片操作失败：' + (err.message || err), true);
    } finally {
      if (imgPickerConfirmBtn) imgPickerConfirmBtn.disabled = false;
    }
  }

  if (imgPickerConfirmBtn) imgPickerConfirmBtn.addEventListener('click', confirmImagePicker);

  function openCommentBox() { if (window.READER_READONLY) return;
    const info = MDEditor.extractSelectionInfo(el.article) || activeSelInfo;
    if (!info || !info.text) {
      showToast('请先在正文中选中需要评论的文字，再点击「➕ 评论」或按 ⌘M', true);
      return;
    }
    activeSelInfo = info;
    const previewText = info.rawText || info.text;
    commentQuotePreview.textContent = '针对：「' + (previewText.length > 48 ? previewText.slice(0, 48) + '…' : previewText) + '」';
    commentPanel.classList.remove('hidden');
    setTimeout(function () { commentInput.focus(); }, 20);
  }

  $('selCommentBtn').addEventListener('click', openCommentBox);

  $('commentCancelBtn').addEventListener('click', closeCommentPanel);

  async function submitComment() { if (window.READER_READONLY) return;
    const val = commentInput.value.trim();
    if (!val) {
      showToast('请输入评论内容', true);
      commentInput.focus();
      return;
    }
    await runSelectionTransform(function (md, loc) {
      return MDEditor.applyCommentSchemeC(md, loc, val);
    }, '添加批注评论', false);
  }

  $('commentSubmitBtn').addEventListener('click', submitComment);
  commentInput.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitComment();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommentPanel();
    }
  });

  /* ---------- 全套键盘快捷键绑定 ---------- */
  document.addEventListener('keydown', function (e) {
    const inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

    // 如果正在进行图片裁剪或替换/插入图片弹窗：支持 Cmd+Enter 确认，Esc 关闭
    if (cropState && cropModal && !cropModal.classList.contains('hidden')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCropModal();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        confirmCropSave();
        return;
      }
      return;
    }
    if (pickerState && imgPickerModal && !imgPickerModal.classList.contains('hidden')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeImagePickerModal();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !imgPickerConfirmBtn.disabled) {
        e.preventDefault();
        confirmImagePicker();
        return;
      }
      return;
    }

    // 如果正在进行段落原位编辑：支持 Cmd+Enter 或纯 Enter 保存，Esc 取消
    if (editingState) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelBlockEdit();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        finishBlockEdit(true);
        return;
      }
      return;
    }

    // 1. Cmd + K：搜索
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setSidebarCollapsed(false);
      el.search.focus();
      el.search.select();
      return;
    }

    if (inInput) return;

    // 2. Cmd + B：加粗 (** **)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      if (state.currentPath) {
        e.preventDefault();
        runSelectionTransform(function (md, loc) {
          return MDEditor.applyBoldToggle(md, loc);
        }, '切换加粗 (** **)');
        return;
      }
    }

    // 3. Option + 1~6（或 Cmd + Shift + 1~6）：6 种预设颜色快速上色
    if ((e.altKey && !e.metaKey && !e.ctrlKey) || ((e.metaKey || e.ctrlKey) && e.shiftKey)) {
      const codeMatch = (e.code || '').match(/^Digit([0-6])$/);
      if (codeMatch && state.currentPath) {
        const num = parseInt(codeMatch[1], 10);
        e.preventDefault();
        if (num === 0) {
          runSelectionTransform(function (md, loc) {
            return MDEditor.removeColorSpan(md, loc);
          }, '取消文字颜色');
        } else {
          const preset = MDEditor.PRESET_COLORS[num - 1];
          if (preset) {
            runSelectionTransform(function (md, loc) {
              return MDEditor.applyColorSpan(md, loc, preset.value);
            }, '设置' + preset.name + ' (' + preset.value + ')');
          }
        }
        return;
      }
    }

    // 4. Cmd + Shift + X：取消颜色
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
      if (state.currentPath) {
        e.preventDefault();
        runSelectionTransform(function (md, loc) {
          return MDEditor.removeColorSpan(md, loc);
        }, '取消文字颜色');
        return;
      }
    }

    // 5. Cmd + M（或 Cmd + Shift + M）：打开批注评论框
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'm') {
      if (state.currentPath) {
        e.preventDefault();
        openCommentBox();
        return;
      }
    }

    // 6. Cmd + E：原位编辑鼠标所在段落（只加 border 边界框，保持渲染态）
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'e') {
      if (state.currentPath) {
        e.preventDefault();
        startBlockEdit(null);
        return;
      }
    }

    // 6.5 Cmd + I：在当前段落位置插入新图片
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'i') {
      if (state.currentPath) {
        e.preventDefault();
        openImagePickerModal('insert', null);
        return;
      }
    }

    // 7. Cmd + Z：撤销上一步对原文档的修改
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (state.currentPath && window.MDEditor && MDEditor.canUndo(state.currentPath)) {
        e.preventDefault();
        triggerUndo();
        return;
      }
    }

    if (e.key === 'Escape') {
      el.lightbox.classList.remove('open');
      closeCommentPanel();
    }
  });

  /* ---------- 拖拽文件夹 / 文件 ---------- */
  ['dragover', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); }); });
  document.addEventListener('drop', function (e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const mds = files.filter(function (f) { return /\.(md|markdown)$/i.test(f.name); });
    if (mds.length) loadLocal(mds, false);
  });

  /* ---------- 启动 ---------- */
  loadUserLists();
  let theme = 'light';
  try { theme = localStorage.getItem('md-reader-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) { /* ignore */ }
  applyTheme(theme);
  defaultSource = createDefaultSource();
  if (defaultSource) {
    setSource(defaultSource); route();
    refreshVaultIndex(true);
  }
  else el.article.innerHTML = '<div class="empty-hint">未找到默认知识库索引，请点击左上角“读入本地文件夹”选择 md 目录。</div>';
})();
