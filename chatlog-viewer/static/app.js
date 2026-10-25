'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function pref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

const state = {
  sessions: [],
  results: null,      // search results (with snippets); null = not searching
  query: '',
  filter: '',         // sidebar filter on folder / title / note, applied locally
  source: pref('source', 'all'),
  group: pref('group', 'cwd'),
  sort: pref('sort', 'recent'),   // folder order: recent | count | name
  view: 'all',        // all | star | archived | missing
  hideEmpty: pref('hideEmpty', '1') === '1',
  current: null,      // path of the open session
  open: null,         // {meta, turns} of the open session, for re-rendering
  newestFirst: pref('newestFirst', '0') === '1',
  rawText: pref('rawText', '0') === '1',
};

// Below this width the sidebar is a drawer over the conversation instead of a column.
const NARROW = matchMedia('(max-width: 860px)');

/* ----------------------------------------------------------------- utils */

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  // en-GB formats a 24-hour clock.
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return 'Today ' + hm;
  const y = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/';
  return `${y}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function dateBucket(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 30) return 'This month';
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
  return (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + ' MB';
}

function shortDir(p) {
  if (!p) return '(unknown folder)';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

/* A folder as {name, parent}: the last segment, and the path above it shortened from
   the left so the segments nearest the folder stay readable. */
function splitDir(p, max = 44) {
  if (!p) return { name: '(unknown folder)', parent: '' };
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || p;
  let parent = parts.join(sep);
  if (parent.length > max) {
    const kept = [];
    let len = 1;
    for (let i = parts.length - 1; i > 0 && len + parts[i].length + 1 <= max; i--) {
      kept.unshift(parts[i]);
      len += parts[i].length + 1;
    }
    parent = [parts[0], '…', ...kept].join(sep);
  }
  return { name, parent };
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

/* Tiny markdown: fenced code, headings, pipe tables, nested lists, task lists,
   quotes, horizontal rules, and inline formatting. */
function md(src) {
  const blocks = [];
  const text = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  /* A line is a table header only when the next line is a delimiter row with an
     equal cell count. Other lines containing "|" are treated as text. */
  const DELIM = /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  const isTableHead = (head, delim) =>
    head != null && delim != null && head.includes('|') && DELIM.test(delim) &&
    cells(delim).length === cells(head).length;
  const alignOf = (c) => (/^:.*:$/.test(c) ? 'center' : /:$/.test(c) ? 'right' : /^:/.test(c) ? 'left' : '');
  const cellAttr = (a) => (a ? ` style="text-align:${a}"` : '');

  const lines = text.split('\n');
  const out = [];
  const stack = [];                       // currently open lists: { tag, indent }

  const closeAll = () => { while (stack.length) out.push(`</${stack.pop().tag}>`); };
  const openList = (indent, tag) => {
    while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</${stack.pop().tag}>`);
    const top = stack[stack.length - 1];
    if (!top || top.indent < indent) { out.push(`<${tag}>`); stack.push({ tag, indent }); }
    else if (top.tag !== tag) { out.push(`</${stack.pop().tag}>`); out.push(`<${tag}>`); stack.push({ tag, indent }); }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const ph = line.match(/^\u0000(\d+)\u0000$/);
    if (ph) { closeAll(); out.push(blocks[+ph[1]]); continue; }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeAll(); out.push('<hr>'); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAll();
      const lvl = Math.min(h[1].length + 2, 6);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    if (isTableHead(line, lines[i + 1])) {
      closeAll();
      const heads = cells(line);
      const aligns = cells(lines[i + 1]).map(alignOf);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(cells(lines[j++]));
      const head = heads.map((c, k) => `<th${cellAttr(aligns[k])}>${inline(c)}</th>`).join('');
      const body = rows.map((r) =>
        '<tr>' + heads.map((_, k) => `<td${cellAttr(aligns[k])}>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('');
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      i = j - 1;
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const m = ul || ol;
      openList(m[1].replace(/\t/g, '  ').length, ul ? 'ul' : 'ol');
      const task = m[2].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        out.push(`<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>${inline(task[2])}</li>`);
      } else {
        out.push(`<li>${inline(m[2])}</li>`);
      }
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { closeAll(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    if (!line.trim()) { closeAll(); continue; }

    closeAll();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeAll();
  return out.join('\n');
}

/* --------------------------------------------------------------- sidebar */

function matchesFilter(s) {
  if (!state.filter) return true;
  const f = state.filter.toLowerCase();
  return [s.cwd, s.title, s.note, s.branch].some((v) => v && v.toLowerCase().includes(f));
}

/* Filters other than `view`; the Show counts are taken over these. */
function baseSessions() {
  return (state.results || state.sessions).filter((s) =>
    (state.source === 'all' || s.source === state.source) &&
    (!state.hideEmpty || s.n_user) && matchesFilter(s));
}

function visibleSessions() {
  return baseSessions().filter((s) => {
    if (state.view === 'star' && !s.star) return false;
    if (state.view === 'archived' && !s.archived) return false;
    if (state.view === 'missing' && !s.cwd_missing) return false;
    if (state.view === 'all' && s.archived) return false;   // archived stays out of the way
    return true;
  });
}

/* Persist a management flag on the server, then re-render the sidebar. */
async function manage(path, patch) {
  const res = await fetch(MOUNT + '/api/manage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, patch }),
  });
  if (!res.ok) return null;
  const { session } = await res.json();
  for (const list of [state.sessions, state.results]) {
    if (!list) continue;
    const i = list.findIndex((s) => s.path === path);
    if (i >= 0) list[i] = { ...list[i], ...session };
  }
  renderSidebar();
  return session;
}

async function removeSession(path) {
  const res = await fetch(MOUNT + '/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) return false;
  state.sessions = state.sessions.filter((s) => s.path !== path);
  if (state.results) state.results = state.results.filter((s) => s.path !== path);
  if (state.current === path) {
    state.current = null;
    history.replaceState(null, '', '#');
    $('#viewer').textContent = '';
    $('#viewer').append(el('div', 'empty', 'Moved to trash.'));
  }
  renderSidebar();
  $('#status').textContent = `${state.sessions.length} sessions`;
  return true;
}

// Windows reports cwd with inconsistent case (Code/temp vs Code/Temp). Group on the
// lowercased path; label the group with the first spelling encountered.
const dirLabels = new Map();
function groupKey(s) {
  if (state.group === 'cwd') {
    const raw = s.cwd || '(unknown folder)';
    const k = raw.toLowerCase();
    if (!dirLabels.has(k)) dirLabels.set(k, raw);
    return k;
  }
  if (state.group === 'date') return dateBucket(s.started);
  return 'All sessions';
}

function renderSidebar() {
  const list = $('#session-list');
  // Live refresh re-renders the list; a group the reader collapsed must stay collapsed.
  const known = new Set([...list.querySelectorAll('.group')].map((d) => d.dataset.key));
  const wasOpen = new Set([...list.querySelectorAll('.group[open]')].map((d) => d.dataset.key));
  list.textContent = '';
  const items = visibleSessions();
  setSearchStatus('done', searchSummary());
  renderViewCounts();
  renderOptsSummary();

  const groups = new Map();
  for (const s of items) {
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const keys = [...groups.keys()];
  if (state.group === 'cwd') {
    const latest = (k) => groups.get(k).reduce((m, s) => (s.started > m ? s.started : m), '');
    const label = (k) => splitDir(dirLabels.get(k) || k).name.toLowerCase();
    const order = {
      recent: (a, b) => latest(b).localeCompare(latest(a)),
      count: (a, b) => groups.get(b).length - groups.get(a).length,
      name: (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
    }[state.sort] || (() => 0);
    keys.sort(order);
  }

  const openGroups = state.group !== 'cwd' || keys.length <= 6 || !!state.query || !!state.filter;

  for (const k of keys) {
    const rows = groups.get(k);
    const d = el('details', 'group');
    d.dataset.key = k;
    const holdsCurrent = rows.some((s) => s.path === state.current);
    d.open = known.has(k) ? (wasOpen.has(k) || holdsCurrent) : (openGroups || holdsCurrent);
    d.append(groupSummary(k, rows, d));
    for (const s of rows) d.append(sessionRow(s));
    list.append(d);
  }
  if (!items.length) {
    const p = el('div', 'empty side-empty');
    p.append(el('p', null, state.query || state.filter ? 'No matching sessions.' : 'No sessions.'));
    list.append(p);
  }
  syncGroupsToggle();
}

function groupSummary(k, rows, d) {
  const sum = el('summary');
  const text = el('span', 'group-text');
  const line = el('span', 'group-line');
  const bytes = rows.reduce((n, s) => n + (s.size || 0), 0);

  if (state.group === 'cwd') {
    const full = dirLabels.get(k) || k;
    // Roughly the characters of 10.5px monospace that fit beside the size column.
    const room = Math.max(14, Math.floor(($('#sidebar').clientWidth - 120) / 6.4));
    const { name, parent } = splitDir(full, room);
    line.append(el('span', 'group-name', name));
    sum.title = `${full}\n${rows.length} sessions · ${fmtSize(bytes)}`;
    if (rows[0].cwd_missing) {
      d.classList.add('missing');
      sum.title += '\nThis folder no longer exists. Open a session and use Move… to relocate it.';
      line.append(el('span', 'missing-tag', 'missing'));
    }
    text.append(line);
    const sub = el('span', 'group-sub');
    sub.append(el('span', 'group-path', parent || ' '), el('span', 'group-size', fmtSize(bytes)));
    text.append(sub);
  } else {
    line.append(el('span', 'group-name', k));
    line.append(el('span', 'group-size', fmtSize(bytes)));
    text.append(line);
  }
  sum.append(text, el('span', 'group-count', String(rows.length)));
  return sum;
}

function renderViewCounts() {
  const base = baseSessions();
  const n = {
    star: base.filter((s) => s.star).length,
    archived: base.filter((s) => s.archived).length,
    missing: base.filter((s) => s.cwd_missing).length,
  };
  for (const b of document.querySelectorAll('#view-chips .seg-btn')) {
    const slot = b.querySelector('.n');
    if (slot) slot.textContent = n[b.dataset.view] ? String(n[b.dataset.view]) : '';
  }
}

function renderOptsSummary() {
  const label = (sel) => document.querySelector(sel + ' .seg-btn.on')?.textContent.replace(/\d+$/, '').trim();
  const bits = [label('#source-chips'), label('#group-chips'), label('#view-chips')];
  $('#opts-summary').textContent = bits.filter(Boolean).join(' · ');
  $('#sort-wrap').classList.toggle('disabled', state.group !== 'cwd');
  $('#sort').disabled = state.group !== 'cwd';
}

function syncGroupsToggle() {
  const groups = [...document.querySelectorAll('#session-list .group')];
  const anyOpen = groups.some((g) => g.open);
  const b = $('#groups-toggle');
  b.textContent = anyOpen ? '⊟' : '⊞';
  b.title = anyOpen ? 'Collapse all groups' : 'Expand all groups';
  b.disabled = groups.length < 2;
}

function sessionRow(s) {
  const row = el('div', 'item' + (s.path === state.current ? ' on' : '') + (s.archived ? ' archived' : ''));
  row.dataset.path = s.path;

  const head = el('div', 'item-head');
  const title = el('div', 'item-title');
  title.innerHTML = highlight(s.title || '(untitled)', state.query);
  const star = el('button', 'star' + (s.star ? ' on' : ''), s.star ? '★' : '☆');
  star.title = s.star ? 'Unstar' : 'Star';
  star.onclick = (e) => { e.stopPropagation(); manage(s.path, { star: !s.star }); };
  head.append(title, star);
  row.append(head);

  const meta = el('div', 'item-meta');
  meta.append(el('span', 'dot ' + s.source));
  meta.append(el('span', null, fmtTime(s.started)));
  meta.append(el('span', null, `${s.n_user} from me`));
  meta.append(el('span', 'size', fmtSize(s.size)));
  if (s.hits) meta.append(el('span', null, `${s.hits} hits`));
  if (s.cwd_missing && state.group !== 'cwd') {
    const tag = el('span', 'missing-tag', 'folder missing');
    tag.title = s.cwd;
    meta.append(tag);
  }
  row.append(meta);

  if (s.note) row.append(el('div', 'item-note', s.note));

  if (s.snippets && s.snippets.length) {
    const sn = el('div', 'item-snip');
    sn.innerHTML = highlight(s.snippets[0], state.query);
    row.append(sn);
  }

  row.onclick = () => openSession(s.path);
  return row;
}

/* ---------------------------------------------------------- conversation */

const AI_ROLES = new Set(['assistant', 'thinking', 'tool_use', 'tool_result', 'meta', 'user_auto']);

async function openSession(path) {
  state.current = path;
  if (NARROW.matches) setSideOpen(false);
  document.querySelectorAll('.item').forEach((n) => n.classList.toggle('on', n.dataset.path === path));

  const viewer = $('#viewer');
  viewer.textContent = '';
  viewer.append(el('div', 'empty', 'Loading…'));

  const res = await fetch(MOUNT + '/api/session?path=' + encodeURIComponent(path));
  if (!res.ok) { viewer.textContent = ''; viewer.append(el('div', 'empty', 'Failed to open')); return; }
  const data = await res.json();
  state.open = data;                 // kept so the order toggle can re-render
  state.openStamp = stampOf(data.meta);
  renderConversation(data);
  history.replaceState(null, '', '#' + encodeURIComponent(path));
}

const stampOf = (m) => `${m.mtime}/${m.size}`;

/* Re-read the open session in place. Used by the Refresh button and by the poller,
   so a session that is still being written can be followed without reopening it. */
async function reloadSession() {
  if (!state.current) return false;
  const path = state.current;
  const res = await fetch(MOUNT + '/api/session?path=' + encodeURIComponent(path));
  if (!res.ok || state.current !== path) return false;
  const data = await res.json();
  state.open = data;
  state.openStamp = stampOf(data.meta);

  const i = state.sessions.findIndex((s) => s.path === path);
  if (i >= 0) {
    state.sessions[i] = { ...state.sessions[i], ...data.meta };
    renderSidebar();
  }
  renderConversation(data, { preserve: true });
  return true;
}

/* Poll the open session's mtime/size; re-read only when the file actually changed. */
async function pollOpenSession() {
  if (!state.current || document.visibilityState !== 'visible') return;
  try {
    const res = await fetch(MOUNT + '/api/peek?path=' + encodeURIComponent(state.current));
    if (!res.ok) return;
    const stamp = stampOf(await res.json());
    if (stamp !== state.openStamp) await reloadSession();
  } catch {}
}

setInterval(pollOpenSession, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') pollOpenSession();
});

function renderConversation({ meta, turns }, opts = {}) {
  const viewer = $('#viewer');
  // Reloading in place must not scroll the reader away or re-collapse what they opened.
  const prev = opts.preserve ? {
    top: viewer.scrollTop,
    atTop: viewer.scrollTop < 40,
    atBottom: viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 40,
    openKeys: new Set([...viewer.querySelectorAll('.ai-run[open]')].map((d) => d.dataset.key)),
    onlyMe: !!viewer.querySelector('.turns.only-me'),
  } : null;
  viewer.textContent = '';

  /* header */
  const head = el('div', 'conv-head');
  head.append(el('h1', null, meta.title || '(untitled)'));
  const sub = el('div', 'conv-sub');
  sub.append(el('span', 'badge ' + meta.source, meta.source === 'claude' ? 'Claude Code' : 'Codex'));
  const cwd = el('code', null, meta.cwd || '(unknown folder)');
  cwd.title = 'Click to copy';
  cwd.style.cursor = 'pointer';
  cwd.onclick = () => navigator.clipboard.writeText(meta.cwd || '');
  sub.append(cwd);
  if (meta.cwd_missing) {
    const tag = el('span', 'missing-tag', 'folder missing');
    tag.title = 'This folder no longer exists; Move… files the session under another one';
    sub.append(tag);
  }
  sub.append(el('span', null, `${fmtTime(meta.started)} → ${fmtTime(meta.ended)}`));
  sub.append(el('span', null, `${meta.n_user} from me · ${meta.n_assistant} AI replies · ${meta.n_tool} tool calls`));
  sub.append(el('span', null, fmtSize(meta.size)));
  if (meta.model) sub.append(el('span', null, meta.model));
  head.append(sub);

  const actions = el('div', 'conv-actions');
  const bExpand = el('button', 'ghost', 'Expand all AI');
  const bCollapse = el('button', 'ghost', 'Collapse all');
  const bOnlyMe = el('button', 'ghost', 'Only my messages');
  const bOrder = el('button', 'ghost' + (state.newestFirst ? ' active' : ''),
                    state.newestFirst ? '↑ Newest first' : '↓ Oldest first');
  bOrder.title = 'Flip the reading order of the conversation';
  bOrder.onclick = () => {
    state.newestFirst = !state.newestFirst;
    try { localStorage.setItem('newestFirst', state.newestFirst ? '1' : '0'); } catch {}
    renderConversation(state.open);
  };
  const bRaw = el('button', 'ghost' + (state.rawText ? ' active' : ''),
                  state.rawText ? 'Raw text' : 'Markdown');
  bRaw.title = 'Render the AI replies as markdown, or show the raw source';
  bRaw.onclick = () => {
    state.rawText = !state.rawText;
    try { localStorage.setItem('rawText', state.rawText ? '1' : '0'); } catch {}
    renderConversation(state.open);
  };
  const bReload = el('button', 'ghost', '⟳ Refresh');
  bReload.title = 'Re-read this log now (it is also polled every 4 s)';
  bReload.onclick = async () => {
    bReload.textContent = '⟳ Reading…';
    await reloadSession();
  };

  const bResume = el('button', 'ghost', 'Copy resume');
  bResume.title = 'Copy a shell command that reopens this session in its folder';
  bResume.onclick = () => flash(bResume, navigator.clipboard.writeText(resumeCommand(meta)), 'Copied ✓');
  const bExport = el('button', 'ghost', 'Export .md');
  bExport.title = 'Download my messages and the AI replies as Markdown (tool calls left out)';
  bExport.onclick = () => exportMarkdown(state.open);

  actions.append(bExpand, bCollapse, bOnlyMe, bOrder, bRaw, bReload, el('span', 'act-gap'));
  actions.append(bResume, bExport, el('span', 'act-gap'));
  actions.append(...manageActions(meta, head));
  head.append(actions);
  renderNote(head, meta.note);
  viewer.append(head);

  /* Body: one block per exchange — a user message plus the assistant activity that
     followed it. The block is the unit that reversing reorders, so a reply is never
     placed above the message it answers. */
  const body = el('div', 'turns');
  const blocks = [];
  let cur = null;
  let run = null;

  const flushRun = () => {
    if (run && run.length) {
      if (!cur) blocks.push((cur = []));
      cur.push(renderRun(run));
    }
    run = null;
  };

  for (const t of turns) {
    if (t.role === 'user' || t.role === 'command') {
      flushRun();
      blocks.push((cur = []));
      cur.push(t.role === 'user' ? renderUser(t) : renderCommand(t));
    } else if (AI_ROLES.has(t.role)) {
      (run || (run = [])).push(t);
    }
  }
  flushRun();

  const ordered = state.newestFirst ? blocks.slice().reverse() : blocks;
  for (const block of ordered) for (const node of block) body.append(node);
  const wrap = el('div', 'conv-body');
  wrap.append(body, renderOutline(meta, body));
  viewer.append(wrap);
  trackHead(head);
  requestAnimationFrame(syncOutline);   // after the scroll position below is restored

  bExpand.onclick = () => body.querySelectorAll('details.ai-run').forEach((d) => (d.open = true));
  bCollapse.onclick = () => body.querySelectorAll('details').forEach((d) => (d.open = false));
  bOnlyMe.onclick = () => {
    const on = body.classList.toggle('only-me');
    body.querySelectorAll('.ai-run').forEach((d) => d.classList.toggle('hidden', on));
    bOnlyMe.textContent = on ? 'Show AI' : 'Only my messages';
  };

  if (!prev) {
    viewer.scrollTop = 0;
    return;
  }
  body.querySelectorAll('.ai-run').forEach((d) => { if (prev.openKeys.has(d.dataset.key)) d.open = true; });
  if (prev.onlyMe) bOnlyMe.onclick();
  if (prev.atBottom) viewer.scrollTop = viewer.scrollHeight;
  else if (prev.atTop) viewer.scrollTop = 0;
  else viewer.scrollTop = prev.top;
}

function fmtDuration(a, b) {
  const ms = new Date(b) - new Date(a);
  if (!(ms >= 0)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} days`;
}

/* Side column for wide screens: session facts, and every message I sent as a jump list
   that follows the reading position. */
function renderOutline(meta, body) {
  const box = el('aside', 'outline');

  const info = el('dl', 'outline-info');
  const fact = (k, v, copy) => {
    if (!v) return;
    const dd = el('dd', copy ? 'copy' : null, v);
    dd.title = copy ? 'Click to copy' : v;
    if (copy) dd.onclick = () => flash(dd, navigator.clipboard.writeText(v), 'Copied ✓');
    info.append(el('dt', null, k), dd);
  };
  fact('Duration', fmtDuration(meta.started, meta.ended));
  fact('Branch', meta.branch);
  fact('Model', meta.model);
  fact('Version', meta.version);
  fact('ID', meta.id, true);
  box.append(info);

  const users = [...body.querySelectorAll('.turn-user')];
  const nav = el('nav', 'outline-nav');
  const title = el('div', 'outline-title', 'My messages');
  title.append(el('span', null, String(users.length)));
  const list = el('div', 'outline-list');
  users.forEach((node, i) => {
    const n = state.newestFirst ? users.length - i : i + 1;
    const item = el('button', 'outline-item' + (node.classList.contains('superseded') ? ' superseded' : ''));
    const cmd = node.querySelector('.cmd-tag')?.textContent;
    const text = (node.querySelector('.body')?.textContent || '').replace(/\s+/g, ' ').trim();
    item.append(el('span', 'outline-n', String(n)),
                el('span', 'outline-text', (cmd ? cmd + ' ' : '') + (text || '(empty)').slice(0, 160)),
                el('span', 'outline-time', node.querySelector('time')?.textContent || ''));
    item.onclick = () => node.scrollIntoView({ block: 'start' });
    list.append(item);
  });
  nav.append(title, list);
  if (users.length) box.append(nav);

  outline = { users, items: [...list.children], list, active: -1 };
  return box;
}

let outline = null;

/* Mark the message being read: the last one whose top has passed under the header. */
function syncOutline() {
  if (!outline || !outline.users.length) return;
  const viewer = $('#viewer');
  const line = viewer.getBoundingClientRect().top + headHeight() + 40;
  let active = 0;
  for (let i = 0; i < outline.users.length; i++) {
    if (outline.users[i].getBoundingClientRect().top <= line) active = i;
    else break;
  }
  if (active === outline.active) return;
  outline.items[outline.active]?.classList.remove('on');
  const item = outline.items[active];
  item.classList.add('on');
  outline.active = active;
  // Keep the marked item visible without scrolling the transcript itself.
  const l = outline.list;
  if (item.offsetTop < l.scrollTop) l.scrollTop = item.offsetTop - 8;
  else if (item.offsetTop + item.offsetHeight > l.scrollTop + l.clientHeight) {
    l.scrollTop = item.offsetTop + item.offsetHeight - l.clientHeight + 8;
  }
}

function headHeight() {
  const head = $('#viewer .conv-head');
  return head && getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0;
}

/* The header's height varies (note, editors, wrapping); the outline and jump targets
   sit below it, so it is published as --head-h. */
let headObserver = null;
function trackHead(head) {
  headObserver?.disconnect();
  headObserver = new ResizeObserver(() => {
    $('#viewer').style.setProperty('--head-h', headHeight() + 'px');
  });
  headObserver.observe(head);
}

let outlineFrame = 0;
$('#viewer').addEventListener('scroll', () => {
  if (outlineFrame) return;
  outlineFrame = requestAnimationFrame(() => { outlineFrame = 0; syncOutline(); });
}, { passive: true });

/* Star / archive / rename / note / delete for the open conversation. Delete requires
   a second click on the button; confirm() is not used because it blocks the page. */
function manageActions(meta, head) {
  const bStar = el('button', 'ghost' + (meta.star ? ' active' : ''), meta.star ? '★ Starred' : '☆ Star');
  bStar.onclick = async () => {
    const s = await manage(meta.path, { star: !meta.star });
    if (!s) return;
    meta.star = s.star;
    bStar.textContent = s.star ? '★ Starred' : '☆ Star';
    bStar.classList.toggle('active', s.star);
  };

  const bArchive = el('button', 'ghost', meta.archived ? 'Unarchive' : 'Archive');
  bArchive.onclick = async () => {
    const s = await manage(meta.path, { archived: !meta.archived });
    if (!s) return;
    meta.archived = s.archived;
    bArchive.textContent = s.archived ? 'Unarchive' : 'Archive';
  };

  const bRename = el('button', 'ghost', 'Rename');
  bRename.onclick = () => editField(head, meta, 'title', meta.title, 'Session title (leave empty to restore the automatic one)');

  const bNote = el('button', 'ghost', meta.note ? 'Edit note' : 'Note');
  bNote.onclick = () => editField(head, meta, 'note', meta.note, 'A note about this conversation');

  const bMove = el('button', 'ghost' + (meta.cwd_missing ? ' active' : ''), 'Move…');
  bMove.title = 'File this session under another working folder, so it resumes from there';
  bMove.onclick = () => moveEditor(head, meta);

  const bDelete = el('button', 'ghost danger', 'Delete');
  let armed = false;
  bDelete.onclick = async () => {
    if (!armed) {
      armed = true;
      bDelete.textContent = 'Confirm delete?';
      setTimeout(() => { armed = false; bDelete.textContent = 'Delete'; }, 4000);
      return;
    }
    bDelete.textContent = 'Deleting…';
    if (!await removeSession(meta.path)) bDelete.textContent = 'Delete failed';
  };
  bDelete.title = 'Moves the log into .trash/ — recoverable';

  return [bStar, bArchive, bRename, bNote, bMove, bDelete];
}

function flash(button, promise, text) {
  const was = button.textContent;
  Promise.resolve(promise).then(() => {
    button.textContent = text;
    setTimeout(() => { button.textContent = was; }, 1500);
  }, () => { button.textContent = 'Failed'; });
}

function resumeCommand(meta) {
  const cmd = meta.source === 'claude' ? `claude --resume ${meta.id}` : `codex resume ${meta.id}`;
  return meta.cwd ? `cd "${meta.cwd}"; ${cmd}` : cmd;
}

function exportMarkdown({ meta, turns }) {
  const lines = [`# ${meta.title || '(untitled)'}`, '',
    `- Source: ${meta.source === 'claude' ? 'Claude Code' : 'Codex'} \`${meta.id}\``,
    `- Folder: \`${meta.cwd || '(unknown)'}\``,
    `- Time: ${meta.started} → ${meta.ended}`, ''];
  for (const t of turns) {
    if (t.role === 'user') lines.push(`## Me${t.ts ? ' · ' + fmtTime(t.ts) : ''}`, '', t.text, '');
    else if (t.role === 'command') lines.push(`\`/${t.text}\``, '');
    else if (t.role === 'assistant') lines.push('## AI', '', t.text, '');
  }
  const name = (meta.title || meta.id).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) + '.md';
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Folders sessions were started in that still exist, most used first: move targets. */
function knownFolders() {
  const counts = new Map();
  for (const s of state.sessions) {
    if (!s.cwd || s.cwd_missing) continue;
    const k = s.cwd.toLowerCase();
    const c = counts.get(k) || { cwd: s.cwd, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.cwd);
}

function moveEditor(head, meta) {
  head.querySelector('.inline-edit')?.remove();
  const siblings = meta.cwd
    ? state.sessions.filter((s) => s.path !== meta.path && (s.cwd || '').toLowerCase() === meta.cwd.toLowerCase())
    : [];

  const box = el('div', 'inline-edit move-edit');
  const row = el('div', 'move-row');
  const input = el('input');
  input.placeholder = 'Target folder, e.g. D:\\Program\\Code\\new-place';
  input.setAttribute('list', 'move-folders');
  const list = el('datalist');
  list.id = 'move-folders';
  for (const f of knownFolders()) if (f.toLowerCase() !== (meta.cwd || '').toLowerCase()) list.append(Object.assign(el('option'), { value: f }));
  const ok = el('button', 'ghost', 'Move');
  const cancel = el('button', 'ghost', 'Cancel');
  row.append(input, list, ok, cancel);
  box.append(row);

  let all = null;
  if (siblings.length) {
    const label = el('label', 'tick');
    all = el('input');
    all.type = 'checkbox';
    // A folder that is gone was usually renamed or moved as a whole.
    all.checked = !!meta.cwd_missing;
    label.append(all, ` Also move the other ${siblings.length} sessions from this folder`);
    box.append(label);
  }
  const msg = el('div', 'move-msg',
    'Rewrites the folder recorded in the log (a backup is kept in .backup/). Close the session in Claude Code / Codex first.');
  box.append(msg);
  head.append(box);
  input.focus();

  let force = false;
  const close = () => box.remove();
  const submit = async () => {
    const to = input.value.trim();
    if (!to) { input.focus(); return; }
    const paths = [meta.path, ...(all && all.checked ? siblings.map((s) => s.path) : [])];
    ok.disabled = true;
    msg.textContent = `Moving ${paths.length} session${paths.length > 1 ? 's' : ''}…`;
    let data = {};
    let res = null;
    try {
      res = await fetch(MOUNT + '/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, to, force }),
      });
      data = await res.json();
    } catch {}
    ok.disabled = false;
    if (!res || !res.ok) {
      msg.className = 'move-msg err';
      const lines = [data.error, ...(data.failed || []).map((f) => `${shortDir(f.path)}: ${f.error}`)].filter(Boolean);
      msg.textContent = lines.join('\n') || 'Move failed';
      if (data.active) { force = true; ok.textContent = 'Move anyway'; }
      return;
    }
    const mine = data.moved.find((m) => m.from === meta.path);
    await loadSessions();
    $('#status').textContent = `Moved ${data.moved.length} session${data.moved.length > 1 ? 's' : ''}` +
      (data.failed.length ? `, ${data.failed.length} failed` : '');
    if (mine) {
      await openSession(mine.to);
    } else {
      msg.className = 'move-msg err';
      msg.textContent = data.failed.map((f) => `${shortDir(f.path)}: ${f.error}`).join('\n');
    }
    if (data.failed.length || data.warnings.length) {
      const head2 = $('#viewer .conv-head');
      if (head2) head2.append(el('div', 'move-msg err',
        [...data.failed.map((f) => `${shortDir(f.path)}: ${f.error}`), ...data.warnings].join('\n')));
    }
  };
  ok.onclick = submit;
  cancel.onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') close();
  };
}

/* Inline editor. prompt() is not used because it blocks the page. */
function editField(head, meta, field, value, placeholder) {
  head.querySelector('.inline-edit')?.remove();
  const box = el('div', 'inline-edit');
  const input = el('input');
  input.value = value || '';
  input.placeholder = placeholder;
  const ok = el('button', 'ghost', 'Save');
  const cancel = el('button', 'ghost', 'Cancel');
  box.append(input, ok, cancel);
  head.append(box);
  input.focus();
  input.select();

  const close = () => box.remove();
  const save = async () => {
    const next = input.value.trim();
    const s = await manage(meta.path, { [field]: next });
    close();
    if (s) {
      Object.assign(meta, s);
      if (field === 'title') head.querySelector('h1').textContent = s.title || '(untitled)';
      else renderNote(head, s.note);
    }
  };
  ok.onclick = save;
  cancel.onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') close();
  };
}

function renderNote(head, note) {
  head.querySelector('.conv-note')?.remove();
  if (note) head.append(el('div', 'conv-note', note));
}

function renderUser(t) {
  const box = el('div', 'turn-user' + (t.superseded ? ' superseded' : ''));
  const who = el('div', 'who');
  const left = el('span');
  left.append(el('span', null, 'ME'));
  if (t.cmd) left.append(el('span', 'cmd-tag', '/' + t.cmd));
  if (t.superseded) {
    const tag = el('span', 'sup-tag', 'cancelled');
    tag.title = 'Replaced by the next message before any reply was produced';
    left.append(tag);
  }
  who.append(left);
  who.append(Object.assign(document.createElement('time'), { textContent: fmtTime(t.ts) }));
  box.append(who);
  const b = el('div', 'body');
  b.innerHTML = highlight(t.text, state.query);
  box.append(b);
  return box;
}

function renderCommand(t) {
  return el('div', 'turn-command', '/' + t.text);
}

function renderRun(turns) {
  const d = el('details', 'ai-run');
  // Stable across reloads, so an expanded run stays expanded when content is appended.
  d.dataset.key = `${turns[0].ts || ''}#${(turns[0].text || '').length}`;
  const sum = el('summary');

  const texts = turns.filter((t) => t.role === 'assistant');
  const tools = turns.filter((t) => t.role === 'tool_use');
  const think = turns.filter((t) => t.role === 'thinking');

  sum.append(el('span', 'run-label', 'AI'));
  const peek = el('span', 'run-peek');
  const src = texts[0]?.text || think[0]?.text || (tools[0] ? tools[0].name + ' …' : '(no text)');
  peek.textContent = src.replace(/\s+/g, ' ').slice(0, 160);
  sum.append(peek);

  const bits = [];
  if (texts.length) bits.push(`${texts.length} replies`);
  if (think.length) bits.push(`${think.length} thinking`);
  if (tools.length) bits.push(`${tools.length} tools`);
  sum.append(el('span', 'run-stats', bits.join(' · ')));
  d.append(sum);

  const inner = el('div', 'run-body');
  for (const t of turns) inner.append(renderAiTurn(t));
  d.append(inner);
  return d;
}

/* Two display modes for assistant prose: rendered markdown, or unmodified source
   for inspecting the formatting itself. */
function renderProse(text, cls) {
  if (state.rawText) {
    const n = el('div', (cls ? cls + ' ' : '') + 'raw-text');
    n.textContent = text;
    return n;
  }
  const n = el('div', (cls ? cls + ' ' : '') + 'md');
  n.innerHTML = md(text);
  return n;
}

function renderAiTurn(t) {
  if (t.role === 'assistant') {
    return renderProse(t.text, 'turn-assistant');
  }
  if (t.role === 'thinking') {
    const n = el('div', 'turn-thinking');
    n.append(el('div', 'mini-label', 'THINKING'));
    n.append(renderProse(t.text));
    return n;
  }
  if (t.role === 'tool_use') {
    const d = el('details', 'tool');
    const s = el('summary');
    s.append(el('span', 'tool-name', '⚙ ' + (t.name || 'tool')));
    s.append(el('span', 'tool-arg', t.text));
    d.append(s, Object.assign(el('pre'), { textContent: t.text }));
    return d;
  }
  if (t.role === 'tool_result') {
    const d = el('details', 'tool' + (t.error ? ' err' : ''));
    const s = el('summary');
    s.append(el('span', 'tool-name', t.error ? '✕ error' : '↳ result'));
    s.append(el('span', 'tool-arg', (t.text || '').replace(/\s+/g, ' ').slice(0, 200)));
    d.append(s, Object.assign(el('pre'), { textContent: t.text }));
    return d;
  }
  if (t.role === 'user_auto' || t.role === 'meta') {
    const d = el('details', 'tool');
    const s = el('summary');
    s.append(el('span', 'tool-name', '· system'));
    s.append(el('span', 'tool-arg', (t.text || '').replace(/\s+/g, ' ').slice(0, 200)));
    d.append(s, Object.assign(el('pre'), { textContent: t.text }));
    return d;
  }
  return el('div');
}

/* ------------------------------------------------------------------ data */

async function loadSessions() {
  const r = await fetch(MOUNT + '/api/sessions');
  const d = await r.json();
  state.sessions = d.sessions;
  renderSidebar();
  return d.status;
}

async function pollStatus() {
  const r = await fetch(MOUNT + '/api/status');
  const s = await r.json();
  if (s.state === 'indexing') {
    $('#status').textContent = `Indexing ${s.done}/${s.total}`;
    setTimeout(pollStatus, 700);
  } else {
    await loadSessions();
    $('#status').textContent = `${state.sessions.length} sessions`;
  }
}

/* Matching takes a few milliseconds; the debounce delay dominates the perceived
   latency. The status is set on the first keystroke, before the request is sent. */
let searchTimer = null;
let searchSeq = 0;

function setSearchStatus(kind, text) {
  const box = $('.searchbox');
  const out = $('#search-count');
  box.classList.toggle('busy', kind === 'pending');
  box.classList.toggle('has-count', !!text);
  out.className = 'search-count' + (kind === 'pending' ? ' pending' : '');
  out.textContent = text || '';
}

/* Count the rows currently listed, so active filters are reflected. */
function searchSummary() {
  if (!state.query) return '';
  const n = visibleSessions().length;
  return n ? `${n} sessions` : 'No matches';
}

async function runSearch(q) {
  const seq = ++searchSeq;
  state.query = q.trim();
  if (!state.query) {
    state.results = null;
    setSearchStatus('idle', '');
    renderSidebar();
    return;
  }
  try {
    const r = await fetch(MOUNT + '/api/search?q=' + encodeURIComponent(state.query));
    const d = await r.json();
    if (seq !== searchSeq) return;      // a newer keystroke already superseded this
    state.results = d.results;
    renderSidebar();
  } catch {
    if (seq === searchSeq) setSearchStatus('idle', 'Search failed');
  }
}

/* -------------------------------------------------------------- bindings */

$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  if (!v.trim()) { runSearch(''); return; }
  setSearchStatus('pending', 'Searching…');
  searchTimer = setTimeout(() => runSearch(v), 120);
});

/* A segmented control bound to one state field; `save` also remembers the choice. */
function bindSeg(sel, field, save) {
  const box = $(sel);
  const mark = () => box.querySelectorAll('.seg-btn').forEach((c) =>
    c.classList.toggle('on', c.dataset[field] === state[field]));
  mark();
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    state[field] = b.dataset[field];
    if (save) setPref(field, state[field]);
    mark();
    renderSidebar();
  });
}
bindSeg('#source-chips', 'source', true);
bindSeg('#group-chips', 'group', true);
bindSeg('#view-chips', 'view', false);

$('#hide-empty').checked = state.hideEmpty;
$('#hide-empty').addEventListener('change', (e) => {
  state.hideEmpty = e.target.checked;
  setPref('hideEmpty', state.hideEmpty ? '1' : '0');
  renderSidebar();
});

$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  setPref('sort', state.sort);
  renderSidebar();
});

let filterTimer = null;
$('#side-filter').addEventListener('input', (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { state.filter = e.target.value.trim(); renderSidebar(); }, 80);
});

$('#side-opts').open = pref('optsOpen', '1') === '1';
$('#side-opts').addEventListener('toggle', (e) => setPref('optsOpen', e.target.open ? '1' : '0'));

$('#groups-toggle').addEventListener('click', () => {
  const groups = [...document.querySelectorAll('#session-list .group')];
  const open = !groups.some((g) => g.open);
  groups.forEach((g) => { g.open = open; });
  syncGroupsToggle();
});
// toggle does not bubble; listen in the capture phase for the groups inside the list.
$('#session-list').addEventListener('toggle', syncGroupsToggle, true);

$('#reindex').addEventListener('click', async () => {
  await fetch(MOUNT + '/api/reindex');
  pollStatus();
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault();
    toggleSide();
    return;
  }
  const typing = /input|textarea|select/i.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault(); $('#search').focus(); $('#search').select();
  }
  if (e.key === 'Escape') {
    if (typing) document.activeElement.blur();
    else if (document.body.classList.contains('side-open')) setSideOpen(false);
  }
  if ((e.key === 'j' || e.key === 'k') && !typing) {
    const rows = [...document.querySelectorAll('.item')];
    const i = rows.findIndex((n) => n.dataset.path === state.current);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'j' ? 1 : -1)))];
    if (next) { next.click(); next.scrollIntoView({ block: 'nearest' }); }
  }
});

/* ------------------------------------------------- sidebar width & collapse */

const SIDE_MIN = 220;
const SIDE_MAX = 680;
const SIDE_DEFAULT = 330;

function setSideWidth(px, save = true) {
  const w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(px)));
  $('#sidebar').style.width = w + 'px';
  if (save) {
    setPref('sideWidth', w);
    renderSidebar();   // folder paths are shortened to the width
  }
}

/* Wide screens collapse the sidebar to a rail; narrow ones slide it in as a drawer.
   The two states are kept apart so a phone never inherits a desktop's collapse. */
function setSideCollapsed(on, save = true) {
  document.body.classList.toggle('side-collapsed', on);
  if (save) setPref('sideCollapsed', on ? '1' : '0');
  if (!on) renderSidebar();   // paths were shortened to the rail's width
}

function setSideOpen(on) {
  document.body.classList.toggle('side-open', on);
  // On touch screens focusing would pop the keyboard over the list.
  if (on && !matchMedia('(pointer: coarse)').matches) {
    setTimeout(() => $('#side-filter').focus({ preventScroll: true }), 200);
  }
}

function toggleSide() {
  if (NARROW.matches) setSideOpen(!document.body.classList.contains('side-open'));
  else setSideCollapsed(!document.body.classList.contains('side-collapsed'));
}

$('#side-close').addEventListener('click', () => (NARROW.matches ? setSideOpen(false) : setSideCollapsed(true)));
$('#side-rail').addEventListener('click', () => setSideCollapsed(false));
$('#backdrop').addEventListener('click', () => setSideOpen(false));
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-side]')) setSideOpen(true);
});
NARROW.addEventListener('change', () => { setSideOpen(false); renderSidebar(); });

$('#resizer').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const bar = $('#sidebar');
  const left = bar.getBoundingClientRect().left;
  const rz = e.currentTarget;
  rz.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');

  const move = (ev) => setSideWidth(ev.clientX - left, false);
  const up = () => {
    rz.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    rz.removeEventListener('pointermove', move);
    rz.removeEventListener('pointerup', up);
    rz.removeEventListener('pointercancel', up);
    setSideWidth(bar.getBoundingClientRect().width);   // persist the final width
  };
  rz.addEventListener('pointermove', move);
  rz.addEventListener('pointerup', up);
  rz.addEventListener('pointercancel', up);
});

$('#resizer').addEventListener('dblclick', () => setSideWidth(SIDE_DEFAULT));
$('#side-toggle').addEventListener('click', toggleSide);

(function restoreSidebar() {
  let w = 0;
  let collapsed = false;
  try {
    w = Number(localStorage.getItem('sideWidth')) || 0;
    collapsed = localStorage.getItem('sideCollapsed') === '1';
  } catch {}
  if (w) setSideWidth(w, false);
  setSideCollapsed(collapsed, false);
})();

function openFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && hash !== state.current && state.sessions.some((s) => s.path === hash)) openSession(hash);
}
window.addEventListener('hashchange', openFromHash);

(async function init() {
  await pollStatus();
  openFromHash();
  if (NARROW.matches && !state.current) setSideOpen(true);
})();
