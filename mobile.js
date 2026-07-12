/* Archive Studio Mobile — reads markdown libraries from GitHub repos,
 * chat with [n] citations via OpenRouter, offline cache in IndexedDB.
 * Companion to the desktop Archive Studio app; mirrors its document model
 * (frontmatter > filename convention > fallbacks) and chat prompt. */

'use strict';

/* ---------- settings (localStorage) ---------- */

const SETTINGS_KEY = 'as-mobile-settings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    return {
      libraries: s.libraries || [],
      key: s.key || '',
      model: s.model || 'anthropic/claude-sonnet-4.6',
      style: s.style || 'cited',
    };
  } catch (e) {
    return { libraries: [], key: '', model: 'anthropic/claude-sonnet-4.6', style: 'cited' };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  settings = s;
}

let settings = loadSettings();

function libKey(lib) {
  return `${lib.repo}@${lib.branch || 'main'}/${lib.dir || ''}`;
}

/* ---------- IndexedDB doc cache ---------- */

let _db = null;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('archive-mobile', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));   // an IDBRequest, or undefined for writes
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

function dbDocsForLib(lk) {
  const range = IDBKeyRange.bound(lk + '|', lk + '|￿');
  return tx('docs', 'readonly', s => s.getAll(range)).then(r => r || []);
}

function dbPutDocs(records) {
  return tx('docs', 'readwrite', s => { records.forEach(r => s.put(r)); });
}

function dbDeleteDocs(keys) {
  return tx('docs', 'readwrite', s => { keys.forEach(k => s.delete(k)); });
}

function dbGetMeta(lk) {
  return tx('meta', 'readonly', s => s.get(lk)).then(r => (r && r.result !== undefined) ? r.result : r);
}

function dbPutMeta(rec) {
  return tx('meta', 'readwrite', s => s.put(rec));
}

/* ---------- saved chats (IndexedDB, mirrors desktop data/chats/) ---------- */

function dbPutChat(c) { return tx('chats', 'readwrite', s => s.put(c)); }
function dbGetChat(id) { return tx('chats', 'readonly', s => s.get(id)); }
function dbDeleteChat(id) { return tx('chats', 'readwrite', s => s.delete(id)); }
function dbChatsForLib(lk) {
  return tx('chats', 'readonly', s => s.getAll())
    .then(r => (r || []).filter(c => c.lib === lk)
      .sort((a, b) => (a.updated < b.updated ? 1 : -1)));
}

/* which saved chat is open, per library */
const CURRENT_CHAT_KEY = 'as-mobile-current-chat';

function currentChatId(lk) {
  try { return (JSON.parse(localStorage.getItem(CURRENT_CHAT_KEY)) || {})[lk] || ''; }
  catch (e) { return ''; }
}

function setCurrentChatId(lk, id) {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(CURRENT_CHAT_KEY)) || {}; } catch (e) {}
  if (id) m[lk] = id; else delete m[lk];
  localStorage.setItem(CURRENT_CHAT_KEY, JSON.stringify(m));
}

function newChatRec(lk) {
  const now = new Date().toISOString();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
    lib: lk,
    title: '',
    mode: 'docs',
    created: now,
    updated: now,
    messages: [],   // {role, content, sources?: [{n, path, title}]}
    registry: [],   // library mode: stable chat-wide source numbers
  };
}

function persistChat(rec) {
  rec.updated = new Date().toISOString();
  // system/thinking bubbles are transient — only real turns are saved
  const clean = Object.assign({}, rec, {
    messages: rec.messages.filter(m => m.role === 'user' || m.role === 'assistant'),
  });
  return dbPutChat(clean);
}

/* in-memory per-library doc list, invalidated on sync */
const docCache = {};

async function docsFor(lib) {
  const lk = libKey(lib);
  if (!docCache[lk]) {
    const docs = await dbDocsForLib(lk);
    docs.sort((a, b) => {
      const ka = (a.date || '0000') + '|' + a.path, kb = (b.date || '0000') + '|' + b.path;
      return ka < kb ? 1 : ka > kb ? -1 : 0;   // newest first, undated last
    });
    docCache[lk] = docs;
  }
  return docCache[lk];
}

/* ---------- document parsing (mirrors app/libraries.py) ---------- */

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})_([a-zA-Z0-9-]+)_(.+)$/;
const HEADING_RE = /^#\s+(.+)$/m;

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    return v[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return v;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      meta[kv[1]] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      meta[kv[1]] = unquote(v);
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
}

function parseDoc(lib, path, sha, content) {
  const { meta, body } = parseFrontmatter(content);
  let title = String(meta.title || '').trim();
  let date = String(meta.date || '').trim();
  let source = String(meta.source || '').trim();
  let url = String(meta.url || '').trim();
  let tags = normalizeTags(meta.tags);

  // A URL-looking source is really the url (fandom exports do this).
  if (source.startsWith('http')) {
    if (!url) url = source;
    source = '';
  }
  const name = path.split('/').pop();
  const stem = name.replace(/\.md$/i, '');
  const fm = FILENAME_RE.exec(stem);
  if (!date && fm) date = fm[1];
  if (!source && fm) source = fm[2];
  if (!title) {
    const h = HEADING_RE.exec(body);
    title = h ? h[1].trim() : stem;
  }
  if (!source) source = 'note';

  return {
    key: libKey(lib) + '|' + path,
    lib: libKey(lib),
    path, sha,
    title, date: date.slice(0, 10), source, url, tags,
    body,
  };
}

function includePath(lib, path) {
  if (!/\.md$/i.test(path)) return false;
  const dir = (lib.dir || '').replace(/^\/+|\/+$/g, '');
  if (dir && !(path === dir || path.startsWith(dir + '/'))) return false;
  const segs = path.split('/');
  return segs.every((s, i) => {
    if (i === segs.length - 1) return true;  // filename itself may start with _
    return !s.startsWith('.') && !s.startsWith('_') && s !== 'venv' && s !== 'node_modules';
  });
}

/* ---------- GitHub API ---------- */

function ghHeaders(lib, raw) {
  const h = {
    'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (lib.token) h['Authorization'] = 'Bearer ' + lib.token.trim();
  return h;
}

async function ghFetch(lib, apiPath, raw) {
  let r;
  try {
    r = await fetch('https://api.github.com' + apiPath, { headers: ghHeaders(lib, raw) });
  } catch (e) {
    throw new Error('Network error — are you online? (' + e.message + ')');
  }
  if (r.status === 401) throw new Error('GitHub says the token is wrong or expired (401). Check this library’s token in Settings.');
  if (r.status === 403) throw new Error('GitHub refused (403) — the token may lack access to this repo, or you hit the rate limit. Try again in a few minutes.');
  if (r.status === 404) throw new Error(`GitHub can’t find "${lib.repo}" (404). Check the repo name — and for private repos, the token.`);
  if (!r.ok) throw new Error('GitHub error ' + r.status + ': ' + (await r.text()).slice(0, 300));
  return raw ? r.text() : r.json();
}

function encPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function fetchTree(lib) {
  const branch = encodeURIComponent(lib.branch || 'main');
  return ghFetch(lib, `/repos/${lib.repo}/git/trees/${branch}?recursive=1`);
}

function fetchFile(lib, path) {
  const branch = encodeURIComponent(lib.branch || 'main');
  return ghFetch(lib, `/repos/${lib.repo}/contents/${encPath(path)}?ref=${branch}`, true);
}

async function pool(items, size, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* Sync = fetch tree, download new/changed files, drop deleted ones. */
async function syncLibrary(lib, onProgress) {
  const lk = libKey(lib);
  onProgress('Fetching file list…');
  const tree = await fetchTree(lib);
  const wanted = (tree.tree || []).filter(e => e.type === 'blob' && includePath(lib, e.path));

  const cached = await dbDocsForLib(lk);
  const cachedByPath = Object.fromEntries(cached.map(d => [d.path, d]));
  const wantedPaths = new Set(wanted.map(e => e.path));

  const stale = wanted.filter(e => !cachedByPath[e.path] || cachedByPath[e.path].sha !== e.sha);
  const removed = cached.filter(d => !wantedPaths.has(d.path)).map(d => d.key);

  let done = 0, failed = 0;
  const records = [];
  await pool(stale, 5, async (e) => {
    try {
      const content = await fetchFile(lib, e.path);
      records.push(parseDoc(lib, e.path, e.sha, content));
    } catch (err) {
      failed++;
    }
    done++;
    onProgress(`Downloading ${done} / ${stale.length}…`);
  });

  if (records.length) await dbPutDocs(records);
  if (removed.length) await dbDeleteDocs(removed);
  await dbPutMeta({ key: lk, syncedAt: new Date().toISOString(), count: wanted.length });
  delete docCache[lk];

  let msg = `Up to date — ${wanted.length} documents`;
  if (stale.length) msg += ` (${records.length} updated)`;
  if (failed) msg += `, ${failed} failed (try Sync again)`;
  return msg;
}

/* ---------- tiny DOM helpers ---------- */

const $ = sel => document.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function md(text) {
  return marked.parse(text, { mangle: false, headerIds: false });
}

function setTopbar(title, showBack, actionsHtml) {
  $('#topbar-title').textContent = title;
  $('#back-btn').classList.toggle('hidden', !showBack);
  $('#topbar-actions').innerHTML = actionsHtml || '';
}

/* Monochrome Material-style icons (stroke = currentColor). */
const ICONS = {
  docs: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3.5l2.6-3.2A8.5 8.5 0 1 1 21 11.5z"/><path d="M8 10h8M8 14h5"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 20v-6l11-2L3 10V4l19 8-19 8z"/></svg>',
};

/* Card emoji: user-chosen in Settings, else picked from the library name. */
const LIB_EMOJIS = ['📚', '🗞️', '📖', '🗂️', '📜', '🏛️', '🧭', '🌒', '🗃️', '🪶'];
function libEmoji(lib) {
  if (lib.emoji) return lib.emoji;
  let h = 0;
  for (const c of String(lib.name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LIB_EMOJIS[h % LIB_EMOJIS.length];
}

/* Bottom tab bar (Docs | Chat) shown inside a library, like NotebookLM's
 * Sources | Chat | Studio bar. Pass i=null to hide it. */
function setBottomNav(i, active) {
  const nav = $('#bottomnav');
  if (i === null) {
    nav.classList.add('hidden');
    document.body.classList.remove('has-nav');
    nav.innerHTML = '';
    return;
  }
  nav.classList.remove('hidden');
  document.body.classList.add('has-nav');
  nav.innerHTML = `
    <a class="nav-item ${active === 'docs' ? 'active' : ''}" href="#/lib/${i}">
      <span class="nav-icon">${ICONS.docs}</span>Docs</a>
    <a class="nav-item ${active === 'chat' ? 'active' : ''}" href="#/chat/${i}">
      <span class="nav-icon">${ICONS.chat}</span>Chat</a>`;
}

/* ---------- clipboard + TTS ---------- */

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

function citation(doc, format) {
  const today = new Date().toISOString().slice(0, 10);
  const url = doc.url || '';
  if (format === 'wiki') {
    return `<ref>{{cite web |title=${doc.title} |url=${url} |website=${doc.source} |date=${doc.date} |access-date=${today}}}</ref>`;
  }
  if (format === 'markdown') {
    return `[${doc.title}](${url}) — ${doc.source}, ${doc.date}`;
  }
  return `${doc.title}. ${doc.source}. ${doc.date}. ${url}`;
}

function stripForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[(\d+)\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let speaking = false;
function toggleSpeech(text, btn) {
  if (speaking) {
    speechSynthesis.cancel();
    speaking = false;
    btn.textContent = '🔊 Listen';
    return;
  }
  const u = new SpeechSynthesisUtterance(stripForSpeech(text).slice(0, 20000));
  u.onend = u.onerror = () => { speaking = false; btn.textContent = '🔊 Listen'; };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  speaking = true;
  btn.textContent = '⏹ Stop';
}

/* ---------- slide-over reader ---------- */

function openSlideover(doc) {
  $('#slideover-body').innerHTML = readerHtml(doc);
  wireReader($('#slideover-body'), doc);
  $('#slideover').classList.remove('hidden');
}

function closeSlideover() {
  $('#slideover').classList.add('hidden');
  $('#slideover-body').innerHTML = '';
}

/* ---------- reader rendering (shared by page + slideover) ---------- */

function readerHtml(doc) {
  const tags = doc.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('');
  const link = doc.url ? `<a href="${esc(doc.url)}" target="_blank" rel="noopener">original ↗</a>` : '';
  return `
    <article class="reader">
      <header class="reader-header">
        <h2>${esc(doc.title)}</h2>
        <div class="reader-meta">
          <span class="doc-date">${esc(doc.date)}</span>
          <span class="badge">${esc(doc.source)}</span>
          ${tags} ${link}
        </div>
        <div class="reader-actions">
          <select class="cite-format">
            <option value="wiki">wiki</option>
            <option value="markdown">markdown</option>
            <option value="plain">plain</option>
          </select>
          <button class="btn btn-small copy-cite">Copy citation</button>
          <button class="btn btn-small listen">🔊 Listen</button>
        </div>
      </header>
      <div class="doc-body">${md(doc.body)}</div>
    </article>`;
}

function wireReader(root, doc) {
  root.querySelector('.copy-cite').onclick = (e) =>
    copyText(citation(doc, root.querySelector('.cite-format').value), e.target);
  root.querySelector('.listen').onclick = (e) => toggleSpeech(doc.body, e.target);
}

/* ---------- views ---------- */

async function viewHome() {
  setTopbar('Archive Studio', false,
    `<button class="btn btn-icon" title="Settings" onclick="location.hash='#/settings'">⚙</button>`);
  setBottomNav(null);
  const v = $('#view');
  if (!settings.libraries.length) {
    v.innerHTML = `
      <div class="empty">
        <p>No libraries yet.</p>
        <p><button class="btn btn-primary" onclick="location.hash='#/settings'">Set up your first library</button></p>
      </div>`;
    return;
  }
  v.innerHTML = '<div id="lib-cards"></div>';
  for (let i = 0; i < settings.libraries.length; i++) {
    const lib = settings.libraries[i];
    const meta = await dbGetMeta(libKey(lib)).catch(() => null);
    const status = meta
      ? `${meta.count} docs · synced ${new Date(meta.syncedAt).toLocaleDateString()}`
      : 'not downloaded yet';
    const card = el(`
      <div class="card tint-${i % 5}">
        <span class="card-emoji">${esc(libEmoji(lib))}</span>
        <div class="card-main">
          <h3>${esc(lib.name)}</h3>
          <p>${esc(status)}</p>
        </div>
        <button class="card-chat" title="Chat">${ICONS.chat}</button>
      </div>`);
    card.onclick = () => { location.hash = `#/lib/${i}`; };
    card.querySelector('.card-chat').onclick = (e) => {
      e.stopPropagation();
      location.hash = `#/chat/${i}`;
    };
    $('#lib-cards').appendChild(card);
  }
}

/* --- library doc list --- */

const listState = {};  // libKey -> {q, source, shown}

async function viewLibrary(i) {
  const lib = settings.libraries[i];
  if (!lib) { location.hash = ''; return; }
  const lk = libKey(lib);
  const st = listState[lk] = listState[lk] || { q: '', source: '', shown: 100 };
  setTopbar(lib.name, true, '');
  setBottomNav(i, 'docs');

  const v = $('#view');
  const docs = await docsFor(lib);
  const meta = await dbGetMeta(lk).catch(() => null);

  if (!docs.length) {
    v.innerHTML = `
      <div class="empty">
        <p>This library hasn’t been downloaded to this device yet.</p>
        <p><button id="sync-btn" class="btn btn-primary">⬇ Download library</button></p>
        <p id="sync-status" class="muted"></p>
      </div>`;
    $('#sync-btn').onclick = () => runSync(lib, i);
    return;
  }

  const sources = [...new Set(docs.map(d => d.source))].sort();
  v.innerHTML = `
    <div class="sync-bar">
      <button id="sync-btn" class="btn btn-small">↻ Sync</button>
      <span id="sync-status" class="muted" style="font-size:13px">
        ${meta ? 'synced ' + new Date(meta.syncedAt).toLocaleString() : ''}</span>
    </div>
    <div class="filters">
      <input type="search" id="q" placeholder="Search" value="${esc(st.q)}">
      <div class="filter-row">
        <select id="source-filter">
          <option value="">source: all</option>
          ${sources.map(s => `<option value="${esc(s)}" ${s === st.source ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
      </div>
    </div>
    <p class="list-meta" id="list-meta"></p>
    <ul class="doc-rows" id="doc-rows"></ul>
    <button class="btn load-more hidden" id="load-more">Show more</button>`;

  $('#sync-btn').onclick = () => runSync(lib, i);
  let debounce;
  $('#q').oninput = () => { clearTimeout(debounce); debounce = setTimeout(() => { st.q = $('#q').value; st.shown = 100; renderRows(); }, 250); };
  $('#source-filter').onchange = () => { st.source = $('#source-filter').value; st.shown = 100; renderRows(); };
  $('#load-more').onclick = () => { st.shown += 100; renderRows(); };

  function renderRows() {
    const q = st.q.trim().toLowerCase();
    let hits = docs;
    if (st.source) hits = hits.filter(d => d.source === st.source);
    if (q) {
      hits = hits.filter(d =>
        d.title.toLowerCase().includes(q) ||
        d.tags.some(t => t.toLowerCase().includes(q)) ||
        d.body.toLowerCase().includes(q));
    }
    $('#list-meta').textContent = `${hits.length} document${hits.length === 1 ? '' : 's'}`;
    const rows = $('#doc-rows');
    rows.innerHTML = '';
    for (const d of hits.slice(0, st.shown)) {
      let snippet = '';
      if (q) {
        const idx = d.body.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 60);
          const frag = d.body.slice(start, idx + q.length + 60);
          snippet = `<div class="snippet">…${esc(frag).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`)}…</div>`;
        }
      }
      const row = el(`
        <li class="doc-row">
          <span class="doc-title">${esc(d.title)}</span>
          <span class="doc-meta">
            <span class="doc-date">${esc(d.date)}</span>
            <span class="badge">${esc(d.source)}</span>
            ${d.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          </span>
          ${snippet}
        </li>`);
      row.onclick = () => { location.hash = `#/doc/${i}/${encodeURIComponent(d.path)}`; };
      rows.appendChild(row);
    }
    $('#load-more').classList.toggle('hidden', hits.length <= st.shown);
  }
  renderRows();
}

async function runSync(lib, i) {
  const btn = $('#sync-btn'), status = $('#sync-status');
  btn.disabled = true;
  try {
    const msg = await syncLibrary(lib, t => { status.textContent = t; });
    status.textContent = msg;
    setTimeout(() => route(), 600);   // re-render with fresh docs
  } catch (e) {
    status.textContent = '';
    status.insertAdjacentHTML('beforeend', `<span class="error">${esc(e.message)}</span>`);
    btn.disabled = false;
  }
}

/* --- single document --- */

async function viewDoc(i, path) {
  const lib = settings.libraries[i];
  if (!lib) { location.hash = ''; return; }
  const docs = await docsFor(lib);
  let doc = docs.find(d => d.path === path);
  setTopbar(lib.name, true, '');
  setBottomNav(i, 'docs');
  const v = $('#view');
  if (!doc) {
    v.innerHTML = '<p class="muted">Fetching document…</p>';
    try {
      const content = await fetchFile(lib, path);
      doc = parseDoc(lib, path, '', content);
    } catch (e) {
      v.innerHTML = `<p class="error">${esc(e.message)}</p>`;
      return;
    }
  }
  v.innerHTML = readerHtml(doc);
  wireReader(v, doc);
  window.scrollTo(0, 0);
}

/* --- chat --- */

const SYSTEM_PROMPT =
  'You are a research assistant answering questions using ONLY the numbered sources ' +
  'provided. Every factual claim MUST carry an inline citation like [3] or [1][4] ' +
  'referring to the source numbers. If the sources do not contain the answer, say so ' +
  'plainly. Quote short passages verbatim when useful, in quotation marks with a citation.\n' +
  'Style: {STYLE}.';

const STYLES = {
  cited: 'dense, citation-heavy, structured with headings',
  natural: 'natural conversational prose, but still keep the inline [n] citations',
};

let chat = null;   // runtime: { libIdx, rec, selected:Set<path> }

async function loadOrNewChat(lk) {
  const id = currentChatId(lk);
  if (id) {
    const rec = await dbGetChat(id).catch(() => null);
    if (rec) return rec;
  }
  const rec = newChatRec(lk);
  setCurrentChatId(lk, rec.id);
  return rec;
}

async function viewChat(i) {
  const lib = settings.libraries[i];
  if (!lib) { location.hash = ''; return; }
  const lk = libKey(lib);
  const docs = await docsFor(lib);
  setTopbar(lib.name, true,
    `<button class="btn btn-small" id="new-chat">New chat</button>`);
  setBottomNav(i, 'chat');

  if (!chat || chat.libIdx !== i || !chat.rec || chat.rec.id !== currentChatId(lk)) {
    chat = { libIdx: i, rec: await loadOrNewChat(lk), selected: new Set() };
  }
  const rec = chat.rec;

  const v = $('#view');
  if (!docs.length) {
    v.innerHTML = `<div class="empty"><p>Download this library first, then come back to chat.</p>
      <p><button class="btn btn-primary" onclick="location.hash='#/lib/${i}'">Open library</button></p></div>`;
    $('#new-chat').onclick = () => {};
    return;
  }
  if (!settings.key) {
    v.innerHTML = `<div class="empty"><p>No OpenRouter API key yet — add one in Settings to chat.</p>
      <p><button class="btn btn-primary" onclick="location.hash='#/settings'">Open Settings</button></p></div>`;
    return;
  }

  const totalChars = docs.reduce((n, d) => n + d.body.length, 0);
  v.innerHTML = `
    <details class="chat-saved">
      <summary id="saved-summary">Saved chats</summary>
      <div class="chat-saved-body" id="saved-list"></div>
    </details>
    <div class="chat-mode" id="chat-mode">
      <label><input type="radio" name="cmode" value="docs"> Pick documents</label>
      <label><input type="radio" name="cmode" value="library"> Whole library 🔎</label>
    </div>
    <details class="chat-context" id="ctx-details" ${chat.selected.size ? '' : 'open'}>
      <summary id="ctx-summary"></summary>
      <div class="chat-context-body">
        <label class="whole-lib"><input type="checkbox" id="whole-lib">
          whole library (${totalChars.toLocaleString()} chars${totalChars > 300000 ? ' — probably too big for one chat' : ''})</label>
        <input type="search" id="ctx-q" placeholder="Filter documents">
        <div class="checkbox-list" id="ctx-list"></div>
        <p class="char-count" id="char-count"></p>
      </div>
    </details>
    <div class="chat-messages" id="chat-messages"></div>
    <form id="chat-form">
      <div class="chat-inputbox">
        <textarea id="chat-input" rows="2" placeholder="Ask…"></textarea>
        <button class="send-btn" title="Send">${ICONS.send}</button>
      </div>
      <p class="chat-disclaimer">Answers can be wrong — tap the [n] chips to check the sources.</p>
    </form>`;

  const chatTa = $('#chat-input');
  const growTa = () => {
    chatTa.style.height = 'auto';
    chatTa.style.height = chatTa.scrollHeight + 'px';
  };
  chatTa.oninput = growTa;

  const ctxList = $('#ctx-list');
  function renderCtxList(filter) {
    const f = (filter || '').toLowerCase();
    ctxList.innerHTML = '';
    for (const d of docs) {
      if (f && !d.title.toLowerCase().includes(f)) continue;
      const lab = el(`<label><input type="checkbox" data-path="${esc(d.path)}"
        ${chat.selected.has(d.path) ? 'checked' : ''}>
        <span>${esc(d.title)} <span class="doc-date">${esc(d.date)}</span></span></label>`);
      lab.querySelector('input').onchange = (e) => {
        if (e.target.checked) chat.selected.add(d.path); else chat.selected.delete(d.path);
        updateCounts();
      };
      ctxList.appendChild(lab);
    }
  }
  function updateCounts() {
    const chars = docs.filter(d => chat.selected.has(d.path)).reduce((n, d) => n + d.body.length, 0);
    $('#char-count').textContent = `${chat.selected.size} selected · ${chars.toLocaleString()} characters`;
    $('#ctx-summary').textContent = `Context: ${chat.selected.size} document${chat.selected.size === 1 ? '' : 's'} selected`;
    $('#whole-lib').checked = chat.selected.size === docs.length;
    chatTa.placeholder = rec.mode === 'library'
      ? 'Ask the whole library…'
      : chat.selected.size
        ? `Ask ${chat.selected.size} document${chat.selected.size === 1 ? '' : 's'}…`
        : 'Select documents above, then ask…';
  }
  $('#whole-lib').onchange = (e) => {
    chat.selected = e.target.checked ? new Set(docs.map(d => d.path)) : new Set();
    renderCtxList($('#ctx-q').value); updateCounts();
  };
  $('#ctx-q').oninput = () => renderCtxList($('#ctx-q').value);

  /* mode toggle — locked once the chat has an answer, like desktop */
  function syncModeUI() {
    const locked = rec.messages.some(m => m.role === 'assistant');
    document.querySelectorAll('#chat-mode input').forEach(r => {
      r.checked = r.value === rec.mode;
      r.disabled = locked;
      r.onchange = () => { rec.mode = r.value; syncModeUI(); };
    });
    $('#ctx-details').classList.toggle('hidden', rec.mode === 'library');
    updateCounts();
    if (!rec.messages.length) renderMessages();   // mode-specific empty-state hint
  }

  async function renderSaved() {
    const list = await dbChatsForLib(lk).catch(() => []);
    $('#saved-summary').textContent = `Saved chats (${list.length})`;
    const box = $('#saved-list');
    box.innerHTML = list.length ? ''
      : '<p class="muted">No saved chats yet — they save automatically as you chat.</p>';
    for (const c of list) {
      const row = el(`<div class="chat-saved-item ${c.id === rec.id ? 'active' : ''}">
        <a class="chat-saved-title">${esc(c.title || '(untitled)')}</a>
        <span class="muted">${esc((c.updated || '').slice(0, 10))}${c.mode === 'library' ? ' · 🔎' : ''}</span>
        <button class="btn btn-small btn-danger del" title="Delete chat">✕</button>
      </div>`);
      row.querySelector('.chat-saved-title').onclick = () => {
        setCurrentChatId(lk, c.id); chat = null; viewChat(i);
      };
      row.querySelector('.del').onclick = async () => {
        await dbDeleteChat(c.id);
        if (c.id === rec.id) { setCurrentChatId(lk, ''); chat = null; viewChat(i); }
        else renderSaved();
      };
      box.appendChild(row);
    }
  }

  renderCtxList('');
  syncModeUI();
  renderSaved();
  renderMessages();

  $('#new-chat').onclick = () => {
    setCurrentChatId(lk, ''); chat = null; viewChat(i);
  };

  $('#chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = chatTa.value.trim();
    if (!q) return;
    const isLib = rec.mode === 'library';
    if (!isLib && !chat.selected.size) {
      rec.messages.push({ role: 'system', content: 'Select at least one document in the context picker above.' });
      renderMessages();
      rec.messages.pop();
      return;
    }
    chatTa.value = '';
    growTa();
    const history = rec.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
    rec.messages.push({ role: 'user', content: q });
    rec.messages.push({ role: 'thinking', content: isLib ? 'Searching the library…' : 'Thinking…' });
    renderMessages();
    let answer, sources, error;
    if (isLib) {
      ({ answer, error } = await askLibrary(docs, history, q, rec.registry));
      sources = rec.registry.map(s => Object.assign({}, s));
    } else {
      const selectedDocs = docs.filter(d => chat.selected.has(d.path));
      ({ answer, sources, error } = await askOpenRouter(selectedDocs, history, q));
    }
    if (!error && !(answer || '').trim()) {
      error = 'The model returned an empty answer — please ask again.';
    }
    rec.messages.pop();  // remove thinking bubble
    if (error) {
      rec.messages.push({ role: 'system', content: error });
    } else {
      rec.messages.push({ role: 'assistant', content: answer, sources });
      if (!rec.title) rec.title = q.slice(0, 60) + (q.length > 60 ? '…' : '');
      await persistChat(rec).catch(() => {});
      renderSaved();
      syncModeUI();
    }
    renderMessages();
  };

  function renderMessages() {
    const box = $('#chat-messages');
    box.innerHTML = '';
    if (!rec.messages.length) {
      box.innerHTML = `<p class="empty">${rec.mode === 'library'
        ? 'Ask anything — the assistant searches the whole library and cites [n] chips you can tap.'
        : 'Pick documents above, then ask a question.<br>Answers cite sources as [1] chips you can tap.'}</p>`;
      return;
    }
    rec.messages.forEach((m) => {
      if (m.role === 'user') {
        box.appendChild(el(`<div class="bubble bubble-user">${esc(m.content)}</div>`));
      } else if (m.role === 'system') {
        box.appendChild(el(`<div class="bubble bubble-system"><pre>${esc(m.content)}</pre></div>`));
      } else if (m.role === 'thinking') {
        box.appendChild(el(`<div class="bubble thinking">${esc(m.content)}</div>`));
      } else {
        let html = md(m.content);
        html = html.replace(/\[(\d+)\]/g, (whole, n) =>
          `<a class="cite-chip" data-n="${n}">${n}</a>`);
        const b = el(`<div class="bubble"><div class="bubble-body">${html}</div>
          <div class="bubble-actions"><button class="btn btn-small listen">🔊 Listen</button></div></div>`);
        b.querySelectorAll('.cite-chip').forEach(chip => {
          chip.onclick = () => {
            const src = (m.sources || []).find(s => s.n === Number(chip.dataset.n));
            const d = src && docs.find(x => x.path === src.path);
            if (d) openSlideover(d);
          };
        });
        b.querySelector('.listen').onclick = (ev) => toggleSpeech(m.content, ev.target);
        box.appendChild(b);
      }
    });
    window.scrollTo(0, document.body.scrollHeight);
  }
}

/* one OpenRouter round; returns { msg } or { error } */
async function orCall(messages, tools, toolChoice) {
  const payload = { model: settings.model, messages, stream: false };
  if (tools) {
    payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
  }
  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + settings.key.trim(),
        'Content-Type': 'application/json',
        'X-Title': 'Archive Studio Mobile',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { error: 'Request failed: ' + e.message };
  }
  const text = await r.text();
  if (!r.ok) return { error: `OpenRouter error ${r.status}: ${text.slice(0, 2000)}` };
  try {
    return { msg: JSON.parse(text).choices[0].message };
  } catch (e) {
    return { error: 'Unexpected API response: ' + text.slice(0, 2000) };
  }
}

/* mirrors app/chat.py: build numbered source blocks, call OpenRouter */
async function askOpenRouter(selectedDocs, history, question) {
  const blocks = [], sources = [];
  selectedDocs.forEach((d, idx) => {
    const n = idx + 1;
    blocks.push(`[Source ${n}: "${d.title}" — ${d.source}, ${d.date}, doc_id=${d.path}]\n${d.body}`);
    sources.push({ n, path: d.path, title: d.title });
  });
  const style = STYLES[settings.style] || STYLES.cited;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT.replace('{STYLE}', style) },
    { role: 'user', content: 'SOURCES:\n\n' + blocks.join('\n\n') },
    ...history,
    { role: 'user', content: question },
  ];
  const { msg, error } = await orCall(messages);
  if (error) return { error };
  return { answer: msg.content || '', sources };
}

/* --- "whole library" mode: search-grounded chat, mirrors app/chat.py -------
 * Same agentic loop as desktop, but retrieval is client-side keyword scoring
 * over the docs already cached in IndexedDB (no FTS index in the browser). */

const LIBRARY_SYSTEM_PROMPT =
  'You are a research assistant answering questions about a markdown archive ' +
  'library. You cannot see the documents directly — use the tools:\n' +
  '- search_library(query): full-text search, returns matching documents with ' +
  'snippets. Use short keyword queries (2-4 words), not full sentences. Try ' +
  'multiple queries with different terms if the first misses.\n' +
  '- read_document(doc_id): read one document in full. Each document you read ' +
  'becomes a numbered source you can cite.\n\n' +
  'ALWAYS search before answering. Read the documents that look most relevant ' +
  '(usually 2-5) before writing your answer. Every factual claim MUST carry an ' +
  'inline citation like [3] or [1][4] referring to the numbered sources you ' +
  'have read (including ones listed as already read earlier in the ' +
  'conversation). Never cite a document you have not read. If the library ' +
  'does not contain the answer, say so plainly.\n' +
  'Style: {STYLE}.';

const LIBRARY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_library',
      description: 'Full-text keyword search over the library. Returns doc_id, title, date and a snippet for each hit.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for (2-4 words work best).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: 'Read a document in full by doc_id (from search results). It becomes a citable numbered source.',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: 'The doc_id exactly as returned by search_library.' },
        },
        required: ['doc_id'],
      },
    },
  },
];

const MAX_TOOL_ROUNDS = 8;
const SEARCH_LIMIT = 8;
const DOC_CHAR_CAP = 20000;

function searchLocal(docs, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const d of docs) {
    const title = d.title.toLowerCase(), body = d.body.toLowerCase();
    let score = 0, firstIdx = -1;
    for (const t of terms) {
      if (title.includes(t)) score += 5;
      let idx = body.indexOf(t), c = 0;
      if (idx !== -1 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
      while (idx !== -1 && c < 50) { c++; idx = body.indexOf(t, idx + t.length); }
      score += c;
    }
    if (score > 0) scored.push({ d, score, firstIdx: Math.max(firstIdx, 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SEARCH_LIMIT).map(({ d, firstIdx }) => {
    const start = Math.max(0, firstIdx - 80);
    const snippet = d.body.slice(start, start + 220).replace(/\s+/g, ' ').trim();
    return { d, snippet };
  });
}

function runSearchTool(docs, query) {
  const hits = searchLocal(docs, query);
  if (!hits.length) return 'No matches. Try different or fewer keywords.';
  return hits.map(h => `doc_id=${h.d.path}\n  "${h.d.title}" (${h.d.date}) — ${h.snippet}`).join('\n');
}

function runReadTool(docs, path, registry) {
  const d = docs.find(x => x.path === path);
  if (!d) return 'Error: no such document. Use a doc_id from search_library results.';
  let s = registry.find(x => x.path === d.path);
  if (!s) {
    s = { n: registry.length + 1, path: d.path, title: d.title };
    registry.push(s);
  }
  let body = d.body;
  if (body.length > DOC_CHAR_CAP) body = body.slice(0, DOC_CHAR_CAP) + '\n\n[... truncated ...]';
  return `[Source ${s.n}: "${d.title}" — ${d.source}, ${d.date}]\n${body}`;
}

/* Mutates registry (stable chat-wide source numbers). Returns {answer} or {error}. */
async function askLibrary(docs, history, question, registry) {
  const style = STYLES[settings.style] || STYLES.cited;
  const messages = [{ role: 'system', content: LIBRARY_SYSTEM_PROMPT.replace('{STYLE}', style) }];
  if (registry.length) {
    messages.push({
      role: 'user',
      content: 'Sources already read earlier in this conversation:\n' +
        registry.map(s => `[${s.n}] "${s.title}"`).join('\n'),
    });
  }
  messages.push(...history, { role: 'user', content: question });

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // last round: keep tools in the payload but forbid calls to force an answer
    const { msg, error } = await orCall(messages, LIBRARY_TOOLS, round === MAX_TOOL_ROUNDS ? 'none' : '');
    if (error) return { error };
    const calls = msg.tool_calls || [];
    if (!calls.length) return { answer: msg.content || '' };
    messages.push(msg);
    for (const call of calls) {
      const fn = call.function || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (e) {}
      let out;
      if (fn.name === 'search_library') out = runSearchTool(docs, String(args.query || ''));
      else if (fn.name === 'read_document') out = runReadTool(docs, String(args.doc_id || ''), registry);
      else out = `Unknown tool ${fn.name}.`;
      messages.push({ role: 'tool', tool_call_id: call.id || '', content: out });
    }
  }
  return { error: 'Model kept calling tools past the round limit.' };
}

/* --- settings --- */

function viewSettings() {
  setTopbar('Settings', true, '');
  setBottomNav(null);
  const v = $('#view');
  const libRow = (lib, idx) => `
    <div class="lib-config" data-idx="${idx}">
      <label>Library name <input class="f-name" value="${esc(lib.name || '')}" placeholder="TLD News"></label>
      <label>Emoji for the card (optional) <input class="f-emoji" value="${esc(lib.emoji || '')}" placeholder="📚"></label>
      <label>GitHub repo <input class="f-repo" value="${esc(lib.repo || '')}" placeholder="username/my-archive"></label>
      <label>Branch <input class="f-branch" value="${esc(lib.branch || 'main')}"></label>
      <label>Subfolder (optional) <input class="f-dir" value="${esc(lib.dir || '')}" placeholder="leave empty for whole repo"></label>
      <label>GitHub token (needed for private repos)
        <input class="f-token" type="password" value="${esc(lib.token || '')}" placeholder="github_pat_…" autocomplete="off"></label>
      <button type="button" class="btn btn-small btn-danger remove-lib">Remove library</button>
    </div>`;

  v.innerHTML = `
    <div class="panel">
      <h3>Libraries</h3>
      <div id="lib-forms">${settings.libraries.map(libRow).join('')}</div>
      <button type="button" class="btn" id="add-lib">＋ Add library</button>
    </div>
    <div class="panel">
      <h3>Chat</h3>
      <label>OpenRouter API key
        <input id="f-key" type="password" value="${esc(settings.key)}" placeholder="sk-or-…" autocomplete="off"></label>
      <label>Model <input id="f-model" value="${esc(settings.model)}"></label>
      <label>Style
        <select id="f-style">
          <option value="cited" ${settings.style === 'cited' ? 'selected' : ''}>cited (dense, structured)</option>
          <option value="natural" ${settings.style === 'natural' ? 'selected' : ''}>natural (conversational)</option>
        </select></label>
    </div>
    <p class="settings-note">Keys and tokens are stored only in this browser, on this device.
      Everything here lives in your own GitHub account and your own OpenRouter account.</p>
    <button class="btn btn-primary" id="save-settings">Save</button>
    <p id="save-msg" class="flash"></p>`;

  $('#add-lib').onclick = () => {
    $('#lib-forms').insertAdjacentHTML('beforeend', libRow({ branch: 'main' }, settings.libraries.length));
    wireRemove();
  };
  function wireRemove() {
    v.querySelectorAll('.remove-lib').forEach(b => {
      b.onclick = () => b.closest('.lib-config').remove();
    });
  }
  wireRemove();

  $('#save-settings').onclick = () => {
    const libs = [...v.querySelectorAll('.lib-config')].map(f => ({
      name: f.querySelector('.f-name').value.trim(),
      emoji: f.querySelector('.f-emoji').value.trim(),
      repo: f.querySelector('.f-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''),
      branch: f.querySelector('.f-branch').value.trim() || 'main',
      dir: f.querySelector('.f-dir').value.trim(),
      token: f.querySelector('.f-token').value.trim(),
    })).filter(l => l.name && l.repo);
    saveSettings({
      libraries: libs,
      key: $('#f-key').value.trim(),
      model: $('#f-model').value.trim() || 'anthropic/claude-sonnet-4.6',
      style: $('#f-style').value,
    });
    $('#save-msg').textContent = 'Saved ✓';
    setTimeout(() => { $('#save-msg').textContent = ''; }, 1500);
  };
}

/* ---------- router ---------- */

function route() {
  closeSlideover();
  speechSynthesis.cancel(); speaking = false;
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  if (parts[0] === 'settings') return viewSettings();
  if (parts[0] === 'lib' && parts[1] !== undefined) return viewLibrary(Number(parts[1]));
  if (parts[0] === 'chat' && parts[1] !== undefined) return viewChat(Number(parts[1]));
  if (parts[0] === 'doc' && parts[1] !== undefined) {
    return viewDoc(Number(parts[1]), decodeURIComponent(parts.slice(2).join('/')));
  }
  return viewHome();
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
