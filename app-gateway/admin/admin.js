// The gateway's admin page. Talks to the JSON API that start.ps1 serves under
// ./api/, relative to this document so the page works under any prefix.
//
// One poll (the "pulse") feeds everything that shows app or machine state: the
// health pill in the top bar, the overview, the resource list and the selected application.
// The page's CSP allows no inline style, so charts are SVG and nothing here
// writes a style attribute into markup.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function reconcile(parent, items, keyOf, create, update) {
  const existing = new Map([...parent.children].map(el => [el.dataset.key, el]));
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const key = String(keyOf(item));
    const el = existing.get(key) ?? create(item);
    el.dataset.key = key;
    if (el !== cursor) parent.insertBefore(el, cursor);
    cursor = el.nextElementSibling;
    existing.delete(key);
    update?.(el, item);
  }
  for (const el of [...parent.children]) {
    if (!el.dataset.key || existing.has(el.dataset.key)) el.remove();
  }
}

function setMarkup(element, html) {
  if (element._markup !== html) {
    element._markup = html;
    element.innerHTML = html;
  }
}

function setText(element, text) {
  if (element.textContent !== String(text)) element.textContent = text;
}

function appIcon(a) {
  const glyph = esc(a.icon || '◇');
  return `<span class="ico" aria-hidden="true">${a.iconUrl ? `<img src="${esc(a.iconUrl)}" alt="" width="23" height="23"><span hidden>${glyph}</span>` : glyph}</span>`;
}

document.addEventListener('error', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.parentElement?.classList.contains('ico')) {
    const attempt = Number(image.dataset.retry || 0);
    if (attempt < 2) {
      image.dataset.retry = String(attempt + 1);
      const base = image.dataset.baseSrc || image.getAttribute('src') || '';
      image.dataset.baseSrc = base;
      if (base) {
        setTimeout(() => {
          if (!image.isConnected) return;
          const sep = base.includes('?') ? '&' : '?';
          image.src = `${base}${sep}retry=${attempt + 1}`;
        }, 800 * (attempt + 1));
        return;
      }
    }
    image.hidden = true;
    if (image.nextElementSibling) image.nextElementSibling.hidden = false;
    image.parentElement.title = 'Registered icon unavailable';
  }
}, true);

document.addEventListener('load', event => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.parentElement?.classList.contains('ico')) {
    image.hidden = false;
    if (image.nextElementSibling) image.nextElementSibling.hidden = true;
    image.parentElement.title = '';
  }
}, true);

let csrf = '';
let current = '';
const mounted = new Map();
const sectionLinks = new Map();
let timers = [];
let pinnedSection = '';
let layoutObserver;
let pulse = null;        // latest /overview
let metrics = null;      // latest /metrics
let online = true;
let globalTimers = [];
let lastStates = null;   // app id -> state, to announce changes
let lastInteraction = Date.now();
let lastTouched = Date.now();

for (const evType of ['pointerdown', 'keydown']) {
  $('#shell').addEventListener(evType, () => { lastInteraction = Date.now(); }, { passive: true, capture: true });
}

// ------------------------------------------------------------------ helpers

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function bytes(n) {
  if (n == null || isNaN(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  if (seconds == null || seconds < 0) return '–';
  seconds = Math.floor(seconds);
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const since = iso => iso ? duration((Date.now() - new Date(iso)) / 1000) : '–';
const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '';
const stamp = iso => iso ? new Date(iso).toLocaleString([], { hour12: false }) : '–';
// eslint-disable-next-line no-control-regex
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const pct = v => v == null || v < 0 ? '–' : v > 0 && v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`;

/** A sparkline over `values` (null = no sample). `max` fixes the scale. */
function spark(values, { max, cls = '' } = {}) {
  const real = values.filter(v => v != null);
  if (real.length < 2) return `<svg class="spark ${cls}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  const top = max ?? Math.max(...real, 1e-9) * 1.2;
  const n = values.length;
  const x = i => (i / (n - 1) * 100).toFixed(2);
  const y = v => (29 - Math.min(1, v / top) * 27).toFixed(2);
  let line = '', area = '', start = -1;
  values.forEach((v, i) => {
    if (v == null) {
      if (start >= 0) { area += `L${x(i - 1)} 30L${x(start)} 30Z`; start = -1; }
      return;
    }
    if (start < 0) { start = i; line += `M${x(i)} ${y(v)}`; area += `M${x(i)} ${y(v)}`; }
    else { line += `L${x(i)} ${y(v)}`; area += `L${x(i)} ${y(v)}`; }
  });
  if (start >= 0) area += `L${x(n - 1)} 30L${x(start)} 30Z`;
  return `<svg class="spark ${cls}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/></svg>`;
}

/** A horizontal bar filled to `fraction`; it turns amber and red as it fills. */
function bar(fraction, { warn = .75, bad = .9 } = {}) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const cls = f >= bad ? 'bad' : f >= warn ? 'warn' : '';
  return `<svg class="bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="${cls}" width="${(f * 100).toFixed(1)}" height="4"/></svg>`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500);
}

async function copyText(text, label = 'Copied to clipboard.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok');
  } catch {
    toast('Clipboard access is unavailable.', 'warn');
  }
}

function handleCodeTab(ev) {
  if (ev.key !== 'Tab' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  ev.preventDefault();
  const el = ev.currentTarget;
  const start = el.selectionStart, end = el.selectionEnd;
  el.setRangeText('  ', start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function confirmAction(title, text, okLabel = 'Confirm') {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, poll = false } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method === 'GET' && poll) {
    if (lastInteraction <= lastTouched) headers['X-Gateway-Poll'] = '1';
    else lastTouched = lastInteraction;
  } else if (path !== '/session' && path !== '/login') {
    lastTouched = Date.now();
  }
  let res;
  try {
    res = await fetch(`api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'The gateway is not answering.');
  }
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new ApiError(401, 'Signed out.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data;
}

async function act(path, { body, confirm, quiet = false } = {}) {
  if (confirm && !(await confirmAction(confirm.title, confirm.text, confirm.ok))) return null;
  try {
    const data = await api(path, { method: 'POST', body: body ?? {} });
    if (!quiet && data.message) toast(data.message, 'ok');
    return data;
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'bad');
    return null;
  }
}

function every(ms, fn) {
  fn(false);
  timers.push(setInterval(() => { if (!document.hidden) fn(true); }, ms));
}

// ------------------------------------------------------------------ theme

const openTheme = () => $('.theme-trigger')?.click();

// ------------------------------------------------------------------ session

function showLogin() {
  timers.concat(globalTimers).forEach(clearInterval);
  timers = [];
  globalTimers = [];
  layoutObserver?.disconnect();
  for (const section of mounted.values()) section.dispose?.();
  mounted.clear();
  sectionLinks.clear();
  pinnedSection = current = '';
  $('#view').replaceChildren();
  hasDraft = false;
  csrf = '';
  pulse = metrics = null;
  lastStates = null;
  busyApps.clear();
  probes.clear();
  probeUsesGet.clear();
  $('#nav-apps-badge').hidden = true;
  $('#nav-config-dot').hidden = true;
  $('#shell').hidden = true;
  $('#login').hidden = false;
  document.title = 'Gateway Admin';
  $('#login-form [name=password]').value = '';
  $('#login-form [name=user]').focus();
}

function showShell(session) {
  csrf = session.csrf;
  lastInteraction = lastTouched = Date.now();
  $('#who').textContent = session.user;
  $('#login').hidden = true;
  $('#shell').hidden = false;
  mountWorkspace();
  beat(false);
  loadMetrics(false);
  globalTimers.push(setInterval(() => { if (!document.hidden) beat(true); }, 3000));
  globalTimers.push(setInterval(() => { if (!document.hidden) loadMetrics(true); }, 10000));
}

$('#login-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const button = $('button', form);
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    showShell(await api('/login', { method: 'POST', body: { user: form.user.value, password: form.password.value } }));
  } catch (e) {
    $('#login-error').textContent = e.message;
    form.password.select();
  } finally {
    button.disabled = false;
  }
});

async function signOut() {
  await act('/logout', { quiet: true });
  showLogin();
}
$('#logout').addEventListener('click', signOut);

// ------------------------------------------------------------------ pulse

const STATES = ['running', 'starting', 'stopping', 'external', 'exited', 'stopped', 'routed'];
const STATE_HELP = {
  running: 'started by this gateway and listening',
  starting: 'started, ports not up yet',
  stopping: 'being stopped',
  external: 'listening, but started outside this gateway',
  exited: 'stopped on its own',
  stopped: 'not running',
  routed: 'routed only, never launched',
};
const isLive = a => ['running', 'starting', 'external', 'stopping'].includes(a.state);
const apps = () => pulse?.apps.list ?? [];
const appById = id => apps().find(a => a.id === id);

function badge(state) {
  return `<span class="badge s-${esc(state)}" title="${esc(STATE_HELP[state] || '')}">${esc(state)}</span>`;
}

let sampleAt = 0;
let requestingPulse = false;

async function beat(poll = false) {
  if (requestingPulse) return;
  requestingPulse = true;
  try {
    pulse = await api('/overview', { poll });
    sampleAt = Date.now();
    if (!online) toast('The gateway is answering again.', 'ok');
    online = true;
  } catch (e) {
    if (e.status === 401) return;
    online = false;
  } finally {
    requestingPulse = false;
  }
  renderHealth();
  for (const section of mounted.values()) section.onConnection?.();
  if (!pulse) return;
  announce();
  for (const section of mounted.values()) section.onPulse?.();
}

async function loadMetrics(poll = false) {
  try { metrics = await api('/metrics', { poll }); } catch { return; }
  if (!pulse) return;
  for (const section of mounted.values()) section.onMetrics?.();
}

function updateNavBadges() {
  const badgeEl = $('#nav-apps-badge');
  if (!badgeEl) return;
  const count = pulse ? apps().filter(appAttention).length : 0;
  badgeEl.hidden = count === 0;
  if (count) {
    setText(badgeEl, count);
    badgeEl.title = `${count} ${count === 1 ? 'app needs' : 'apps need'} attention`;
  }
}

function renderHealth() {
  const el = $('#health');
  if (!online || !pulse) {
    el.href = '#overview';
    el.className = 'health bad';
    el.textContent = online ? '…' : 'offline';
    el.title = online ? '' : 'The gateway is not answering.';
    document.title = online ? 'Gateway Admin' : '⚠ Gateway Admin';
    updateNavBadges();
    return;
  }
  const s = pulse.apps.states;
  const exited = s.exited || 0, busy = (s.starting || 0) + (s.stopping || 0), running = s.running || 0;
  const caddyDown = !pulse.gateway.caddy.alive;
  el.className = `health ${caddyDown || exited ? 'bad' : busy ? 'warn' : 'ok'}`;
  el.textContent = caddyDown ? 'Caddy down' : exited ? `${exited} exited` : busy ? `${busy} in transition` : `${running} running`;
  el.href = caddyDown ? '#overview' : exited ? '#apps/attention' : busy ? '#apps' : '#apps/live';
  el.title = STATES.filter(k => s[k]).map(k => `${s[k]} ${k}`).join(' · ');
  document.title = `${exited || caddyDown ? '⚠ ' : ''}Gateway Admin`;
  updateNavBadges();
}

/** Say so when an app changes state on its own: nobody watches seven cards. */
function announce() {
  const now = Object.fromEntries(apps().map(a => [a.id, a.state]));
  if (lastStates) {
    for (const a of apps()) {
      const before = lastStates[a.id];
      if (!before || before === a.state) continue;
      if (a.state === 'exited') toast(`${a.name} exited (code ${a.exitCode}).`, 'bad');
      else if (a.state === 'running' && before === 'starting') toast(`${a.name} is up.`, 'ok');
    }
  }
  lastStates = now;
}

// ------------------------------------------------------------------ routing

const views = {};

const workspace = $('#view');
const sectionOrder = ['overview', 'apps', 'ports', 'logs', 'config', 'security'];

function rememberSection(name, hash) {
  sectionLinks.set(name, hash);
  if (current === name && location.hash !== hash) history.replaceState(null, '', hash);
}

function highlight(name) {
  current = name;
  for (const link of $$('#nav [data-view]')) {
    const active = link.dataset.view === name;
    link.classList.toggle('on', active);
    if (active) {
      link.setAttribute('aria-current', 'location');
      const nav = link.parentElement;
      if (nav.scrollWidth > nav.clientWidth) {
        const item = link.getBoundingClientRect(), rail = nav.getBoundingClientRect();
        if (item.left < rail.left) nav.scrollLeft += item.left - rail.left;
        else if (item.right > rail.right) nav.scrollLeft += item.right - rail.right;
      }
    } else link.removeAttribute('aria-current');
  }
}

function alignSection() {
  const target = document.getElementById(pinnedSection);
  if (!target) return;
  const inset = parseFloat(getComputedStyle(workspace).paddingTop);
  workspace.scrollTop += target.getBoundingClientRect().top - workspace.getBoundingClientRect().top - inset;
}

function navigate(hash, applyDetail = true) {
  if (!mounted.size) return;
  const [requested, encoded, tab] = hash.slice(1).split('/');
  const name = mounted.has(requested) ? requested : 'overview';
  pinnedSection = name;
  highlight(name);
  alignSection();
  if (applyDetail && (encoded || tab)) {
    let arg;
    try { arg = decodeURIComponent(encoded || ''); } catch { return; }
    mounted.get(name).selectDetail?.(arg, tab);
  }
}

function mountWorkspace() {
  const hash = location.hash;
  const [entry, encoded, tab] = hash.slice(1).split('/');
  if (sectionOrder.includes(entry)) sectionLinks.set(entry, hash);
  let arg = '';
  try { arg = decodeURIComponent(encoded || ''); } catch { arg = ''; }
  for (const name of sectionOrder) {
    const el = document.createElement('section');
    el.className = 'workspace-section';
    el.id = name;
    el.dataset.section = name;
    workspace.append(el);
    const controller = views[name](el, name === entry ? arg : '', name === entry ? tab : '') || {};
    const heading = $('.head :is(h1,h2)', el);
    heading.id = 'heading-' + name;
    heading.tabIndex = -1;
    el.setAttribute('aria-labelledby', heading.id);
    mounted.set(name, controller);
  }
  navigate(hash, false);
  layoutObserver = new ResizeObserver(() => { if (pinnedSection) alignSection(); });
  for (const el of workspace.children) layoutObserver.observe(el);
}

for (const type of ['wheel','touchstart','pointerdown','keydown']) {
  workspace.addEventListener(type, () => { pinnedSection = ''; }, {passive:true});
}
// Chain mouse-wheel scrolling cleanly from inner scrollable panels (Storage,
// Apps list/properties/output, Logs, Config editors/inspector/code, Security
// tables) up to the nearest outer scroller with room (including #view) as soon
// as an inner panel hits its top/bottom edge or has no vertical overflow.
// Avoids Chromium's ~500ms wheel-latching stall and Windows DPI subpixel traps.
workspace.addEventListener('wheel', ev => {
  if (ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey || ev.defaultPrevented || !ev.deltaY ||
      Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return;
  const startEl = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
  if (!startEl || startEl.closest('select, dialog')) return;
  const deltaY = ev.deltaY * (ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? workspace.clientHeight : 1);

  const hasRoom = el => {
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 2) return false;
    return deltaY < 0 ? el.scrollTop > 1 : el.scrollTop < max - 2;
  };

  let el = startEl;
  let firstInner = null;
  let target = null;
  while (el) {
    const isWs = el === workspace;
    const oy = isWs ? 'auto' : getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      if (!isWs && !firstInner) firstInner = el;
      if (hasRoom(el)) { target = el; break; }
    }
    if (isWs) break;
    el = el.parentElement;
  }

  // No inner scrollable box under the cursor, or the innermost box still has room: let native scroll run.
  if (!firstInner || target === firstInner) return;
  if (!target) return;
  ev.preventDefault();
  pinnedSection = '';
  target.scrollTop += deltaY;
}, { passive: false });
document.addEventListener('keydown', e => {
  if (['PageDown','PageUp','Home','End','ArrowDown','ArrowUp',' '].includes(e.key)) pinnedSection = '';
});
workspace.addEventListener('scroll', () => {
  if (pinnedSection || !mounted.size) return;
  const top = workspace.getBoundingClientRect().top + 96;
  let name = sectionOrder[0];
  for (const el of workspace.children) {
    if (el.getBoundingClientRect().top > top) break;
    name = el.dataset.section;
  }
  if (workspace.scrollHeight - workspace.clientHeight - workspace.scrollTop < 2) name = sectionOrder.at(-1);
  if (name !== current) {
    highlight(name);
    history.replaceState(null, '', sectionLinks.get(name) || '#' + name);
  }
}, {passive:true});

document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest('a[href^="#"]');
  if (!link || !mounted.has(link.hash.slice(1).split('/')[0])) return;
  event.preventDefault();
  if (location.hash !== link.hash) history.pushState(null, '', link.hash);
  $('.account-menu').open = false;
  navigate(link.hash);
  $('#heading-' + current).focus({preventScroll:true});
});
window.addEventListener('hashchange', () => navigate(location.hash));
window.addEventListener('beforeunload', event => { if (hasDraft) event.preventDefault(); });
document.addEventListener('click', event => {
  for (const menu of $$('.action-menu[open]')) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const menu = document.activeElement?.closest('.action-menu[open]');
  if (menu) { menu.open = false; $('summary', menu).focus(); }
});

// ------------------------------------------------------------------ actions

const busyApps = new Map(); // app id -> verb while an action is in flight
const BUSY_LABEL = { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…' };

const CONFIRMS = {
  'restart-all': { title: 'Restart live apps?', text: 'Every managed app currently running will be stopped and started again.', ok: 'Restart live apps' },
  'stop-all': { title: 'Stop every app?', text: 'Every app this gateway started is stopped. Caddy and this page keep running.', ok: 'Stop all' },
  shutdown: { title: 'Shut down Gateway?', text: 'Every app, Caddy and this admin page stop. Start it again with start.ps1 on the machine.', ok: 'Shut down' },
};

async function gatewayAction(what) {
  const done = await act(`/gateway/${what}`, { confirm: CONFIRMS[what] });
  beat();
  return done;
}

async function appAction(id, verb) {
  if (busyApps.has(id)) return null;
  const app = appById(id);
  const name = app?.name ?? id;
  const confirm = verb === 'stop' ? { title: `Stop ${name}?`, text: 'Anyone using this application loses the connection.', ok: 'Stop' }
    : verb === 'restart' || (verb === 'start' && app?.state === 'external')
    ? { title: `${app?.state === 'external' ? 'Take over' : 'Restart'} ${name}?`, text: 'The current process is stopped and relaunched by Gateway.', ok: 'Continue' }
    : undefined;
  if (confirm && !(await confirmAction(confirm.title, confirm.text, confirm.ok))) return null;
  busyApps.set(id, verb);
  for (const section of mounted.values()) section.onPulse?.();
  try {
    const done = await act(`/apps/${encodeURIComponent(id)}/${verb}`);
    probes.delete(id);
    return done;
  } finally {
    busyApps.delete(id);
    beat();
  }
}

function appButtons(a) {
  if (!a.launch) return '';
  const busyVerb = busyApps.get(a.id);
  const disabled = busyVerb ? ' disabled' : '';
  const cls = verb => busyVerb === verb ? ' is-busy' : '';
  const label = (verb, idle) => busyVerb === verb ? BUSY_LABEL[verb] : idle;
  return isLive(a)
    ? `<button class="btn small${cls('restart')}" data-app="${esc(a.id)}" data-verb="restart"${disabled}>${label('restart', 'Restart')}</button><button class="btn small danger${cls('stop')}" data-app="${esc(a.id)}" data-verb="stop"${disabled}>${label('stop', 'Stop')}</button>`
    : `<button class="btn small primary${cls('start')}" data-app="${esc(a.id)}" data-verb="start"${disabled}>${label('start', 'Start')}</button>`;
}

// Buttons anywhere on the page: data-gw runs a gateway action, data-app +
// data-verb an app action, data-copy copies text to clipboard.
document.addEventListener('click', async ev => {
  const copyBtn = ev.target.closest('[data-copy]');
  if (copyBtn) { copyText(copyBtn.dataset.copy, copyBtn.dataset.copyLabel || 'Copied to clipboard.'); return; }
  const recheckBtn = ev.target.closest('[data-recheck]');
  if (recheckBtn) {
    const target = appById(recheckBtn.dataset.recheck);
    if (target) { probes.delete(target.id); probe(target, true); }
    return;
  }
  const gw = ev.target.closest('[data-gw]');
  if (gw) { gw.disabled = true; await gatewayAction(gw.dataset.gw); gw.disabled = false; return; }
  const btn = ev.target.closest('[data-app][data-verb]');
  if (btn) { await appAction(btn.dataset.app, btn.dataset.verb); return; }
});

document.addEventListener('change', async ev => {
  if (!ev.target.matches('[data-enable]')) return;
  const input = ev.target;
  input.disabled = true;
  const data = await act(`/apps/${encodeURIComponent(input.dataset.enable)}/${input.checked ? 'enable' : 'disable'}`);
  if (!data) input.checked = !input.checked;
  input.disabled = false;
  beat();
});

// ------------------------------------------------------------------ probes

const probes = new Map();
const probeUsesGet = new Set();
const onGatewayMachine = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const hasRoute = app => Boolean(app.basePath && app.active && app.routes !== 'none');
const probePath = app => app.probe || app.basePath;
const shouldProbe = app => hasRoute(app) && (!app.launch || app.state === 'running' || app.state === 'external');

function currentProbe(app) {
  const result = probes.get(app.id);
  return result?.path === probePath(app) ? result : null;
}

async function probe(app, force = false) {
  if (!shouldProbe(app)) {
    probes.delete(app.id);
    return;
  }
  const path = probePath(app);
  const last = currentProbe(app);
  if (!force && last && (last.pending || Date.now() - last.at < 15000)) return;
  const pending = { ...last, path, pending: true };
  probes.set(app.id, pending);
  let text, tone;
  const started = performance.now();
  try {
    const url = new URL('../' + path.replace(/^\//, ''), location.href);
    const send = method => fetch(url, { method, mode: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(2500) });
    let response = await send(probeUsesGet.has(app.id) ? 'GET' : 'HEAD');
    if (!probeUsesGet.has(app.id) && (response.status === 405 || response.status === 501)) {
      probeUsesGet.add(app.id);
      response = await send('GET');
    }
    response.body?.cancel?.().catch(() => {});
    const ms = Math.round(performance.now() - started);
    if (response.status === 401 || response.status === 403) {
      text = 'Sign-in required';
      tone = 'neutral';
    } else if (response.ok) {
      text = `${response.redirected ? 'Responded' : 'Healthy'} · ${ms} ms`;
      tone = 'ready';
    } else {
      text = `HTTP ${response.status}`;
      tone = 'problem';
    }
  } catch {
    text = 'Unreachable';
    tone = 'problem';
  }

  if (probes.get(app.id) !== pending) return;
  probes.set(app.id, { at: Date.now(), path, text, tone });
  const active = appById(app.id);
  if (!active || !hasRoute(active) || probePath(active) !== path) return;
  $$('[data-probe="' + CSS.escape(app.id) + '"]').forEach(element => updateEntryStatus(element, active));
  updateNavBadges();
  for (const section of mounted.values()) section.onProbe?.();
}

function entryStatus(app) {
  if (app.localUrl) {
    const port = Number(new URL(app.localUrl).port || '80');
    const up = app.ports.some(item => item.port === port && item.listening);
    return {
      text: up ? 'Listening locally' : app.state === 'starting' ? 'Waiting for port…' : 'No listener',
      tone: up ? 'ready' : 'neutral',
      hint: 'Listener status on the Gateway host. HTTP health has not been verified.',
    };
  }
  if (!hasRoute(app)) return { text: 'Not published' };
  if (app.launch) {
    if (app.state === 'stopped') return { text: 'App stopped' };
    if (app.state === 'exited') return { text: 'Process exited', tone: 'problem' };
    if (app.state === 'starting') return { text: 'Waiting for ports…' };
    if (app.state === 'stopping') return { text: 'Stopping…' };
  }
  const result = currentProbe(app);
  return {
    text: result?.text || 'Checking…',
    tone: result?.tone,
    hint: result?.at ? 'Checked ' + stamp(result.at) : 'Waiting for a probe',
  };
}

function updateEntryStatus(element, app) {
  const status = entryStatus(app);
  setText(element, status.text);
  element.dataset.tone = status.tone || 'neutral';
  element.title = status.hint || '';
}

function appAttention(app) {
  if (app.state === 'exited') return 'Process exited';
  if (app.needsRestart) return 'Restart required';
  if (entryStatus(app).tone === 'problem') return 'Entry unreachable';
  return '';
}

function entryHref(app) {
  if (hasRoute(app)) return '..' + app.basePath;
  if (onGatewayMachine && app.localUrl) return app.localUrl;
  return null;
}

function routeLink(app) {
  const href = entryHref(app);
  const local = app.localUrl ? new URL(app.localUrl) : null;
  const label = app.basePath || (local ? `:${local.port || '80'}${local.pathname}` : '');
  if (!label) return '';
  if (!href) return `<span class="mono" title="${local ? 'Only accessible on the Gateway host' : 'Route is not published'}">${esc(label)}</span>`;
  return `<a class="route mono" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} <span aria-hidden="true">↗</span></a>`;
}

// ------------------------------------------------------------------ overview

function formatEventMarkup(raw) {
  const plain = stripAnsi(raw);
  const m = plain.match(/^\[([A-Z ]+)\]\s*(.*)$/);
  if (!m) return esc(plain);
  const tag = m[1];
  const cls = tag === 'START' ? 'ok' : tag === 'EXIT' || tag === 'GIVE UP' || tag === 'SKIP' ? 'bad' : tag === 'RESTART' || tag === 'STOP' ? 'warn' : 'info';
  return `<span class="event-tag t-${cls}">${esc(tag)}</span> ${esc(m[2])}`;
}

views.overview = root => {
  const loadingRows = count => '<li class="loading-row" aria-hidden="true"><span class="skeleton"></span></li>'.repeat(count);
  const tile = (id, title) => `<section class="card tile" id="${id}"><h3>${title}</h3>
    <div class="value"><span class="skeleton"></span></div><div class="sub"></div><div class="tile-extra"></div></section>`;
  root.innerHTML = `
    <div class="head overview-head"><div class="heading-group"><h1>Overview</h1><p class="muted" id="ov-summary">Connecting to Gateway…</p></div><span class="spacer"></span>
      <button class="btn" id="refresh-overview">Refresh</button>
      <details class="action-menu"><summary class="btn">More</summary><div class="menu-items">
        <button data-gw="reload">Apply routes</button>
        <button data-gw="start-all">Start enabled apps</button>
        <button data-gw="restart-all">Restart live apps</button>
        <a href="#config">Config</a>
        <button class="menu-divider danger" data-gw="stop-all">Stop all apps</button><button class="danger" data-gw="shutdown">Shut down Gateway</button>
      </div></details></div>
    <div class="snapshot" id="snapshot">
      <span class="state-point" aria-hidden="true"></span><span id="snapshot-state">Waiting for the first update</span><a id="ov-attention" href="#apps/attention" hidden></a><time id="snapshot-time"></time>
    </div>
    <div class="tiles overview-tiles">
      ${tile('t-gw', 'Gateway')}${tile('t-apps', 'Applications')}${tile('t-cpu', 'CPU')}${tile('t-mem', 'Memory')}
    </div>
    <div class="cols overview-panels">
      <section class="card"><div class="panel-heading"><h3>Recent activity</h3><span class="panel-count" id="ov-event-count"></span></div>
        <ul class="events" id="events">${loadingRows(4)}</ul>
        <footer class="panel-footer"><span class="muted" id="activity-caption"></span><a href="#logs/gateway">View activity</a></footer></section>
      <section class="card" id="disks-card"><div class="panel-heading"><h3>Storage</h3><span class="panel-count" id="disk-count"></span></div>
        <div class="disks" id="disks"><span class="skeleton"></span></div>
        <footer class="panel-footer"><span class="muted" id="disks-caption"></span><span class="muted num" id="disks-total"></span></footer></section></div>`;
  const refresh = $('#refresh-overview', root);
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    probes.clear();
    await Promise.all([beat(), loadMetrics()]);
    refresh.disabled = false;
  });

  function renderActivity() {
    if (!pulse) return;
    const events = $('#events', root);
    if (events.contains(document.activeElement)) return;
    const entries = pulse.recent.slice(-4).reverse();
    const count = pulse.recent.length;
    setMarkup($('#activity-caption', root), `<span class="wide-caption">${count > 4 ? 'Showing latest 4' : 'Gateway log'}</span><span class="narrow-caption">${count > 3 ? 'Showing latest 3' : 'Gateway log'}</span>`);
    reconcile(events, entries.length ? entries : [{ seq: ':empty' }], entry => entry.seq, entry => {
      const el = document.createElement('li');
      if (!entry.time) {
        el.className = 'panel-empty';
        el.innerHTML = '<strong>No activity yet</strong><span>Starts, stops and route updates appear here.</span>';
      } else {
        el.className = entry.stream === 'err' ? 'err' : '';
        el.innerHTML = `<time datetime="${esc(entry.time)}">${clock(entry.time)}</time><a href="#logs/gateway" title="${esc(stripAnsi(entry.text))}">${formatEventMarkup(entry.text)}</a>`;
      }
      return el;
    });
    setText($('#ov-event-count', root), count);
  }
  const events = $('#events', root);
  events.addEventListener('focusout', () => queueMicrotask(() => { if (events.isConnected) renderActivity(); }));

  function updateTile(id, value, caption, extra = '') {
    const el = $(id, root);
    setMarkup($('.value', el), value);
    setMarkup($('.sub', el), caption);
    setMarkup($('.tile-extra', el), extra);
  }

  function showAttention() {
    const count = apps().filter(appAttention).length;
    const link = $('#ov-attention', root);
    link.hidden = count === 0;
    setText(link, `${count} ${count === 1 ? 'app needs' : 'apps need'} attention`);
    updateNavBadges();
  }

  function onConnection() {
    const g = pulse?.gateway;
    const message = !online ? 'Could not refresh Gateway'
      : !g ? 'Waiting for the first update'
      : !g.caddy.alive ? 'Caddy is offline'
      : g.reloading ? 'Applying routes'
      : g.lastReload && !g.lastReload.ok ? 'Route update failed' : 'Gateway responding';
    const snapshot = $('#snapshot', root);
    snapshot.dataset.tone = !online || (g && (!g.caddy.alive || (g.lastReload && !g.lastReload.ok))) ? 'problem'
      : g && !g.reloading ? 'ready' : 'neutral';
    setText($('#snapshot-state', root), message);
    setText($('#snapshot-time', root), sampleAt ? (online ? 'Updated ' : 'Last update ') + clock(sampleAt) : '');
    if (sampleAt) $('#snapshot-time', root).dateTime = new Date(sampleAt).toISOString();
    setText(refresh, online ? 'Refresh' : 'Retry');
  }

  function onMetrics() {
    const sys = pulse.system;
    const memUsed = Math.max(0, sys.memTotal - sys.memFree);
    updateTile('#t-cpu', sys.cpu >= 0 ? `${sys.cpu.toFixed(0)}<small>%</small>` : '—', `${sys.cpus} cores · last hour`,
      metrics ? spark(metrics.cpu, { max: 100 }) : '');
    updateTile('#t-mem', sys.memTotal ? `${(memUsed / 2 ** 30).toFixed(1)}<small> / ${(sys.memTotal / 2 ** 30).toFixed(0)} GB</small>` : '—',
      sys.memTotal ? `${(memUsed / sys.memTotal * 100).toFixed(0)}% used · last hour` : 'Memory data unavailable',
      metrics ? spark(metrics.mem, { cls: 'mem', max: sys.memTotal }) : '');
  }

  function onPulse() {
    const g = pulse.gateway;
    const states = pulse.apps.states;
    const total = pulse.apps.total;
    const proxied = apps().filter(hasRoute).length;
    setText($('#ov-summary', root), `${total} registered · ${proxied} proxied`);
    const live = (states.running || 0) + (states.external || 0) + (states.starting || 0);
    const runDetails = [
      states.running && `${states.running} running`,
      states.starting && `${states.starting} starting`,
      states.stopping && `${states.stopping} stopping`,
      states.external && `${states.external} external`,
      states.routed && `${states.routed} route-only`,
    ].filter(Boolean).join(' · ');
    const offDetails = [
      `${states.stopped || 0} stopped`,
      `${states.exited || 0} exited`,
    ].join(' · ');
    updateTile('#t-apps', `${live}<small> / ${total} live</small>`, runDetails || 'No app processes running', `<span class="sub">${offDetails}</span>`);
    const bindPort = String(g.bind).match(/:(\d+)\/?$/)?.[1] || g.bind;
    updateTile('#t-gw', g.caddy.alive ? 'Online' : 'Offline', `Port <span class="mono" title="${esc(g.bind)}">${esc(bindPort)}</span> · ${g.caddy.alive ? 'up ' + since(g.startedAt) : 'Caddy unavailable'}`,
      `<span class="sub">${g.reloading ? 'Applying routes…' : g.lastReload ? `Routes ${g.lastReload.ok ? 'applied' : 'failed'} at ${esc(clock(g.lastReload.at))}` : 'Routes loaded at startup'}</span>`);
    onConnection();
    onMetrics();

    renderActivity();
    showAttention();
    const disks = pulse.system.disks;
    setText($('#disk-count', root), disks.length);
    const disksEl = $('#disks', root);
    setMarkup(disksEl, disks.length ? disks.map(d => `
      <div class="disk" title="${esc(d.label || d.name)}"><div class="row"><b>${esc(d.name)}</b>${d.label ? `<span class="disk-label">${esc(d.label)}</span>` : ''}<span class="muted num">${bytes(d.free)} free of ${bytes(d.total)}</span></div>${bar((d.total - d.free) / d.total, { warn: .85, bad: .95 })}</div>`).join('')
      : '<p class="muted">No ready storage volumes.</p>');
    const totalFree = disks.reduce((sum, d) => sum + (d.free || 0), 0);
    const totalSize = disks.reduce((sum, d) => sum + (d.total || 0), 0);
    setText($('#disks-caption', root), disks.length > 4 ? `${disks.length} volumes · scroll for more` : `${disks.length} ${disks.length === 1 ? 'volume' : 'volumes'}`);
    setText($('#disks-total', root), totalSize ? `${bytes(totalFree)} free` : '');

  }

  return { onPulse, onMetrics, onConnection, onProbe: showAttention };
};

// ------------------------------------------------------------------ apps

views.apps = (root, initial, initialId) => {
  root.innerHTML = `
    <div class="head"><div class="heading-group"><h2>Apps</h2><p id="apps-count" class="muted">Loading registrations…</p></div>
      <span class="spacer"></span><details class="action-menu"><summary class="btn">More</summary><div class="menu-items">
        <button data-gw="start-all">Start enabled apps</button>
        <button data-gw="restart-all">Restart live apps</button>
        <button class="menu-divider danger" data-gw="stop-all">Stop all apps</button></div></details></div>
    <div class="app-workbench">
      <div class="app-toolbar"><input id="app-search" type="search" placeholder="Search apps" aria-label="Search apps">
        <div class="pills" id="app-filter" aria-label="App status"></div></div>
      <div class="object-split">
        <div class="object-index">
          <div class="object-columns"><span>Application</span><span>Process</span></div>
          <div id="app-grid" role="group" aria-label="Applications" aria-busy="true">
            ${'<div class="object-placeholder"><span class="skeleton"></span></div>'.repeat(6)}</div>
          <a class="index-footer" href="#config">Manage registrations <span aria-hidden="true">→</span></a>
          <select id="app-picker" aria-label="Selected application" disabled><option>Loading applications…</option></select>
        </div>
        <section class="object-pane" id="app-inspector" aria-label="Selected application">
          <div class="object-empty" id="app-placeholder"><strong id="apps-empty-title">Loading application details…</strong>
            <p id="apps-empty-hint" class="muted"></p><button class="btn small" id="clear-apps" hidden>Clear filters</button>
            <a class="btn small" id="register-app" href="#config" hidden>Open registrations</a></div>
          <div class="object-summary" hidden>
            <header class="object-heading"><span id="object-icon"></span><div><h3 id="object-name"></h3>
              <p id="object-description"></p></div><span id="object-state"></span></header>
            <div class="object-actions"><span id="object-commands"></span>
              <a class="btn small" id="object-edit">Edit registration</a>
              <label class="check"><input id="object-enable" type="checkbox">At Gateway startup</label></div>
            <div class="object-scroll" tabindex="0" aria-label="Application properties">
              <div class="banner" id="object-warning" hidden></div>
              <div class="object-properties">
                <section><h4>Runtime</h4><dl class="kv runtime"></dl></section>
                <section><h4>Startup configuration</h4><dl class="kv startup"></dl></section>
                <section><h4>Resources</h4><div class="gauges"><div class="gauge"></div><div class="gauge"></div></div></section>
                <section><h4>Declared ports</h4><dl class="kv object-ports"></dl></section>
              </div>
            </div>
          </div>
        </section>
      </div>
      <section class="object-output" aria-labelledby="output-title"><header><h3 id="output-title">Recent output</h3>
        <span id="output-source" class="mono muted"></span><span class="spacer"></span>
        <button class="link-button small" id="output-latest" aria-label="Jump to latest" title="Jump to latest" hidden><span aria-hidden="true">↓</span><span class="latest-label"> Latest</span></button>
        <a class="small" id="output-link" href="#logs">Open in Logs →</a></header>
        <div id="object-log" tabindex="0" aria-label="Recent application output" class="logbox mini"><div class="empty">Waiting for an application…</div></div>
      </section>
    </div>`;

  const groups = {
    all: ['All', () => true],
    live: ['Live', a => ['running', 'external', 'starting'].includes(a.state)],
    attention: ['Needs attention', appAttention],
    off: ['Stopped', a => ['stopped', 'exited'].includes(a.state)],
  };
  const table = $('#app-grid', root), picker = $('#app-picker', root), search = $('#app-search', root);
  const filters = $('#app-filter', root), box = $('#object-log', root), latest = $('#output-latest', root);
  const summary = $('.object-summary', root);
  let filter = Object.hasOwn(groups, initial) ? initial : 'all';
  let requestedId = initial === 'app' ? initialId : null;
  let selected, revision = 0, after = 0, reading = false;
  filters.innerHTML = Object.entries(groups).map(([key, [name]]) =>
    `<button class="pill" data-filter="${key}">${name} <b></b></button>`).join('');

  function createRow() {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'object-row';
    row.setAttribute('aria-controls', 'app-inspector');
    row.innerHTML = '<span class="app-image"></span><span class="object-label"><b></b><small></small></span><span class="object-process"></span>';
    return row;
  }

  function appSublabel(a) {
    if (a.basePath) return a.basePath;
    if (a.localUrl) {
      try { const u = new URL(a.localUrl); return `Local · :${u.port || '80'}`; } catch { /* fallback */ }
    }
    return a.id;
  }

  function updateRow(row, a) {
    const issue = appAttention(a);
    const sub = issue || appSublabel(a);
    row.setAttribute('aria-pressed', String(a.id === selected));
    row.title = `${a.name} — ${sub}`;
    setMarkup($('.app-image', row), appIcon(a));
    setText($('b', row), a.name);
    const caption = $('small', row);
    setText(caption, sub);
    caption.classList.toggle('restart-note', !!issue);
    setMarkup($('.object-process', row), badge(a.state));
  }

  function facts(selector, pairs) {
    const list = $(selector, summary);
    if (!list.children.length) for (const [label] of pairs) {
      const key = document.createElement('dt');
      key.textContent = label;
      list.append(key, document.createElement('dd'));
    }
    pairs.forEach((pair, i) => {
      const dd = list.children[i * 2 + 1];
      if (typeof pair[1] === 'function') pair[1](dd);
      else setMarkup(dd, pair[1]);
    });
  }

  function updateRouteCell(dd, a) {
    if (!dd._routeSlot) {
      dd.innerHTML = '<span class="route-cell"><span class="route-link-slot"></span><span class="entry-status"></span><button type="button" class="link-button small recheck-btn" title="Check entry now" hidden>Re-check</button></span>';
      dd._routeSlot = $('.route-link-slot', dd);
      dd._probeSlot = $('.entry-status', dd);
      dd._recheckSlot = $('.recheck-btn', dd);
    }
    setMarkup(dd._routeSlot, routeLink(a));
    dd._probeSlot.dataset.probe = a.id;
    updateEntryStatus(dd._probeSlot, a);
    dd._recheckSlot.dataset.recheck = a.id;
    dd._recheckSlot.hidden = !shouldProbe(a);
  }

  function updateGauges() {
    const a = appById(selected);
    if (!a) return;
    const history = metrics?.apps?.[a.id], [cpu, mem] = $$('.gauge', summary);
    const cpuSamples = (history?.cpu ?? []).filter(v => v != null);
    const memSamples = (history?.mem ?? []).filter(v => v != null);
    const cpuPeak = cpuSamples.length ? Math.max(...cpuSamples) : null;
    const memPeak = memSamples.length ? Math.max(...memSamples) : null;
    cpu.title = cpuPeak != null ? `Peak ${pct(cpuPeak)} over last hour (all cores)` : 'CPU over all cores';
    mem.title = memPeak != null ? `Peak ${bytes(memPeak)} over last hour` : 'Working set across process tree';
    setMarkup(cpu, `CPU <b>${a.usage ? pct(a.usage.cpu) : '–'}</b>${spark(history?.cpu ?? [])}`);
    setMarkup(mem, `Memory <b>${a.usage ? bytes(a.usage.memory) : '–'}</b>${spark(history?.mem ?? [], {cls:'mem'})}`);
  }

  function updateSummary(a) {
    const href = entryHref(a), logHash = '#logs/' + encodeURIComponent(a.id);
    const issue = appAttention(a);
    const entryHealthy = Boolean(href) && ['running', 'external', 'routed'].includes(a.state) && entryStatus(a).tone !== 'problem';
    setMarkup($('#object-icon', root), appIcon(a));
    setText($('#object-name', root), a.name);
    $('#object-name', root).title = a.name;
    setText($('#object-description', root), a.description || a.id);
    $('#object-description', root).title = a.description || a.id;
    setMarkup($('#object-state', root), badge(a.state));
    const warn = $('#object-warning', root);
    warn.hidden = !a.note && !issue;
    setText(warn, a.note || issue || '');
    const commands = $('#object-commands', root);
    const focused = commands.contains(document.activeElement) ? document.activeElement : null;
    setMarkup(commands, `${issue ? `<a class="btn small" href="${logHash}">Diagnose</a>` : ''}
      ${href ? `<a class="btn small${entryHealthy ? ' primary' : ''}" href="${esc(href)}" target="_blank" rel="noopener">Open entry ↗</a>` : ''}${appButtons(a)}`);
    const edit = $('#object-edit', root);
    edit.href = '#config/' + encodeURIComponent(a.id);
    if (focused && !focused.isConnected) (commands.querySelector('button,a') || edit).focus({preventScroll:true});
    let enable = $('#object-enable', root);
    if (enable.dataset.enable !== a.id) {
      const next = enable.cloneNode();
      next.dataset.enable = a.id;
      next.disabled = false;
      enable.replaceWith(next);
      enable = next;
    }
    if (!enable.disabled) enable.checked = !!a.enabled;
    const launchCmd = a.launch ? ('start.ps1' + (a.args.length ? ' ' + a.args.join(' ') : '')) : '';
    const copyChip = (val, label) => `<button type="button" class="copy-btn" data-copy="${esc(val)}" data-copy-label="${esc(label)}" title="Copy" aria-label="${esc(label)}">Copy</button>`;
    facts('.runtime', [
      ['Route', dd => updateRouteCell(dd, a)],
      ['Routing', `${esc(a.routes)}${a.hidden ? ' · Hidden from landing page' : ''}`],
      ['Processes', a.usage ? `${esc(a.usage.pids.join(', '))} · ${a.usage.threads} threads` : '—'],
      ['Uptime', `${a.startedAt && a.managed ? since(a.startedAt) + ' · Since ' + esc(stamp(a.startedAt)) + ' · ' : ''}${a.starts} ${a.starts === 1 ? 'start' : 'starts'} this run${a.exitedAt ? ' · Last exit ' + esc(clock(a.exitedAt)) + ' (code ' + esc(a.exitCode) + ')' : ''}`]
    ]);
    facts('.startup', [
      ['Root', `<span class="copy-row"><span class="mono">${esc(a.root)}</span>${copyChip(a.root, 'Copied root path.')}</span>`],
      ['Launch', a.launch ? `<span class="copy-row"><span class="mono">${esc(launchCmd)}</span>${copyChip(launchCmd, 'Copied launch command.')}</span>` : 'Routed only'],
      ['Policy', `${a.restartIfRunning ? 'Take over existing process' : 'Keep existing process'} · ${a.autoRestart ? 'Restart after crash' : 'Manual restart'}`],
      ['Environment', (Array.isArray(a.env) ? a.env : Object.keys(a.env || {})).map(esc).join('<br>') || '—']
    ]);
    setMarkup($('.object-ports', summary), a.ports.map(p => `<dt>${esc(p.name)}</dt><dd><span class="chip ${p.listening ? 'on' : ''}">${esc(p.port)}</span> ${p.listening ? 'PID ' + esc(p.pid) : 'Not listening'}</dd>`).join('') || '<dt>Ports</dt><dd>None declared</dd>');
    updateGauges();
  }

  const atEnd = () => box.scrollHeight - box.scrollTop - box.clientHeight < 8;
  let following = true;
  box.addEventListener('scroll', () => {
    following = atEnd();
    latest.hidden = following;
  });
  const outputSize = new ResizeObserver(() => {
    if (following) box.scrollTop = box.scrollHeight;
    latest.hidden = atEnd();
  });
  outputSize.observe(box);
  latest.onclick = () => { box.scrollTop = box.scrollHeight; box.focus({preventScroll:true}); };

  async function readOutput(poll = false) {
    if (!selected || reading || document.hidden || !root.isConnected) return;
    const bounds = root.getBoundingClientRect(), view = workspace.getBoundingClientRect();
    if (bounds.bottom < view.top || bounds.top > view.bottom) return;
    const generation = revision;
    reading = true;
    try {
      const data = await api(`/logs/${encodeURIComponent(selected)}?after=${after}&max=60`, { poll });
      if (!root.isConnected || generation !== revision) return;
      if (!data.lines.length) {
        if (!after) setMarkup(box, '<div class="empty">No output captured in this run.</div>');
        return;
      }
      const follow = !after || following;
      $('.empty', box)?.remove();
      after = data.lines.at(-1).seq;
      box.insertAdjacentHTML('beforeend', data.lines.map(line => logLine(line)).join(''));
      while (box.childElementCount > 200) box.firstElementChild.remove();
      if (follow) box.scrollTop = box.scrollHeight;
      latest.hidden = atEnd();
    } catch {
      if (root.isConnected && generation === revision && !after) setMarkup(box, '<div class="empty">Output unavailable. Retrying…</div>');
    } finally {
      if (generation === revision) reading = false;
    }
  }

  function render() {
    if (!pulse) return;
    const list = apps(), needle = search.value.trim().toLowerCase();
    for (const button of $$('[data-filter]', filters)) {
      const active = filter === button.dataset.filter;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
      setText($('b', button), list.filter(groups[button.dataset.filter][1]).length);
    }
    const shown = list.filter(groups[filter][1]).filter(a =>
      !needle || [a.name, a.id, a.description, a.basePath, a.state].some(value => value?.toLowerCase().includes(needle)));
    const a = shown.find(item => item.id === (requestedId || selected)) || shown[0];
    requestedId = null;
    const changed = selected !== (a?.id ?? null);
    selected = a?.id ?? null;
    const focusedRow = document.activeElement?.closest('.object-row');
    reconcile(table, shown, item => item.id, createRow, updateRow);
    table.setAttribute('aria-busy', 'false');
    if (focusedRow && !focusedRow.isConnected) (table.querySelector('[aria-pressed=true]') || search).focus({preventScroll:true});
    setMarkup(picker, shown.map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.state)}</option>`).join('') || '<option>No applications</option>');
    picker.disabled = !a;
    if (a) picker.value = a.id;
    setText($('#apps-count', root), shown.length === list.length ? `${list.length} registered` : `${shown.length} of ${list.length} registered`);
    $('#app-placeholder', root).hidden = !!a;
    summary.hidden = !a;
    if (a) updateSummary(a);
    else {
      const healthy = list.length && !needle && filter === 'attention';
      setText($('#apps-empty-title', root), !list.length ? 'No apps registered' : healthy ? 'No apps need attention' : 'No matching apps');
      setText($('#apps-empty-hint', root), !list.length ? 'Add a registration to see its process, ports and output here.' : healthy ? 'Current process and entry checks found no issues.' : 'Try another name or show all apps.');
      $('#clear-apps', root).hidden = !list.length;
      $('#register-app', root).hidden = !!list.length;
    }
    if (changed) {
      const saved = sectionLinks.get('apps') || '';
      if (saved.startsWith('#apps/app/') && saved !== '#apps/app/' + encodeURIComponent(selected))
        rememberSection('apps', a ? '#apps/app/' + encodeURIComponent(a.id) : '#apps');
      ++revision;
      reading = false;
      after = 0;
      following = true;
      latest.hidden = true;
      box._markup = null;
      setMarkup(box, `<div class="empty">${a ? 'Reading output…' : 'No application selected.'}</div>`);
      box.scrollTop = $('.object-scroll', root).scrollTop = 0;
      $('#output-link', root).href = a ? '#logs/' + encodeURIComponent(a.id) : '#logs';
      setText($('#output-source', root), a?.id || '');
      readOutput();
    }
  }

  function selectApp(id) {
    requestedId = id;
    render();
    if (filter === 'all' && !search.value && selected) rememberSection('apps', '#apps/app/' + encodeURIComponent(selected));
  }
  table.onclick = ev => {
    const row = ev.target.closest('.object-row');
    if (row) selectApp(row.dataset.key);
  };
  table.onkeydown = ev => {
    const row = ev.target.closest('.object-row');
    if (!row || !['ArrowDown','ArrowUp','Home','End'].includes(ev.key)) return;
    ev.preventDefault();
    const target = ev.key === 'Home' ? table.firstElementChild : ev.key === 'End' ? table.lastElementChild :
      (ev.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) || row;
    target.focus();
    selectApp(target.dataset.key);
  };
  picker.onchange = () => selectApp(picker.value);
  function changeFilter(value, clearSearch = false) {
    filter = value;
    if (clearSearch) search.value = '';
    rememberSection('apps', filter === 'all' ? '#apps' : '#apps/' + filter);
    render();
  }
  search.oninput = render;
  filters.onclick = ev => {
    const button = ev.target.closest('[data-filter]');
    if (button) changeFilter(button.dataset.filter);
  };
  $('#clear-apps', root).onclick = () => { changeFilter('all', true); search.focus(); };
  every(2000, readOutput);
  return { onPulse() {
    render();
    apps().forEach(probe);
  }, onProbe: render, onMetrics: updateGauges, dispose: () => outputSize.disconnect(), selectDetail(arg, id) {
    if (arg === 'app') {
      filter = 'all';
      search.value = '';
      selectApp(id);
    } else if (Object.hasOwn(groups, arg)) changeFilter(arg, true);
  }, onConnection() {
    if (!pulse && !online) {
      setText($('#apps-count', root), 'Could not read registrations. Retrying…');
      setText($('#apps-empty-title', root), 'Waiting for Gateway to reconnect…');
      table.setAttribute('aria-busy', 'false');
    }
  } };
};

// ------------------------------------------------------------------ logs

const sourceColor = new Map();
const colorOf = source => {
  if (!sourceColor.has(source)) sourceColor.set(source, `c${sourceColor.size % 8}`);
  return sourceColor.get(source);
};

/** 'lv-error', 'lv-warn', 'e' (unlabelled stderr) or ''. Caddy and many others
    log everything to stderr, so the stream alone does not make a line a problem. */
function toneOf(line, plain) {
  if (/"level":"(error|fatal|panic)"|\b(ERROR|FATAL|CRITICAL)\b|Traceback \(most recent|Unhandled exception/.test(plain)) return 'lv-error';
  if (/"level":"warn"|\b(WARN|WARNING)\b/.test(plain)) return 'lv-warn';
  if (line.stream === 'err' && !/"level":"(info|debug)"|\b(INFO|DEBUG)\b/.test(plain)) return 'e';
  return '';
}

/** Format structured Caddy JSON log lines into a concise, readable summary. */
function formatCaddyLine(plain) {
  if (!plain || plain[0] !== '{' || !plain.endsWith('}')) return null;
  let obj;
  try { obj = JSON.parse(plain); } catch { return null; }
  if (!obj || typeof obj !== 'object' || typeof obj.msg !== 'string' || typeof obj.level !== 'string') return null;
  const lvl = obj.level.toUpperCase();
  const logger = obj.logger ? `${obj.logger} ` : '';
  const req = obj.request;
  const parts = [`[${lvl}] ${logger}${obj.msg}`];
  if (req && typeof req === 'object') {
    const reqInfo = [obj.status, req.method, req.uri].filter(v => v != null && v !== '').join(' ');
    if (reqInfo) parts.push(`(${reqInfo})`);
  } else if (obj.status != null) {
    parts.push(`(HTTP ${obj.status})`);
  }
  if (obj.error && !obj.msg.includes(obj.error)) parts.push(`— ${obj.error}`);
  if (obj.name && !req) parts.push(`· ${obj.name}`);
  return parts.join(' ');
}

function logLine(l, { needle = '', withSource = false, pretty = true } = {}) {
  const rawPlain = l.plain ?? stripAnsi(l.text);
  const formatted = pretty && l.source === 'caddy' ? (l.pretty ?? formatCaddyLine(rawPlain)) : null;
  const display = formatted || rawPlain;
  let text = esc(display);
  if (needle) {
    const re = new RegExp(esc(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(re, m => `<mark>${m}</mark>`);
  }
  const src = withSource ? `<span class="src ${colorOf(l.source)}">${esc(l.source)}</span>` : '';
  const titleAttr = formatted ? ` title="${esc(rawPlain)}"` : '';
  return `<div class="l ${toneOf(l, rawPlain)}"${titleAttr}><span class="t">${clock(l.time)}</span>${src}${text}</div>`;
}

views.logs = (root, initial) => {
  root.innerHTML = `
    <div class="head"><h2>Logs</h2></div>
    <section class="logs-panel"><div class="log-toolbar">
      <div class="log-toolbar-group">
        <select id="sources" aria-label="Log source"><option>Reading sources…</option></select>
        <input id="log-filter" type="search" placeholder="Filter lines" size="18" aria-label="Filter lines">
      </div>
      <div class="log-toolbar-group log-toolbar-toggles">
        <label class="check small"><input type="checkbox" id="log-err"> Problems only</label>
        <label class="check small" title="Show unformatted JSON for Caddy logs"><input type="checkbox" id="log-raw"> Raw JSON</label>
        <label class="check small"><input type="checkbox" id="log-wrap" checked> Wrap lines</label>
        <label class="check small"><input type="checkbox" id="log-follow" checked> Follow</label>
        <button class="btn small" id="log-pause">Pause</button>
      </div></div>
    <div class="logbox wrap" id="logbox" tabindex="0" aria-label="Log output"><div class="empty">Loading…</div></div>
    <footer class="log-footer"><span class="muted small" id="log-shown">Reading lines…</span><button class="pill" id="log-unread" hidden></button><span class="spacer"></span>
      <button class="btn small" id="log-copy" title="Copy visible lines to clipboard">Copy</button>
      <button class="btn small" id="log-clear" title="Empty the in-memory buffer; log files on disk are kept">Clear</button>
      <a class="btn small" id="log-download">Download</a></footer></section>`;

  const box = $('#logbox', root);
  const ALL = '_all';
  let source = initial || ALL;
  let logRevision = 0;
  let after = 0, loaded = false, lines = [], paused = false, unread = 0;
  const MAX = 5000;

  const currentShown = () => {
    const needle = $('#log-filter', root).value;
    const lower = needle.toLowerCase();
    const problems = $('#log-err', root).checked;
    const raw = $('#log-raw', root).checked;
    const shown = lines.filter(l => (!problems || toneOf(l, l.plain)) && (!lower || l.plain.toLowerCase().includes(lower) || (l.pretty && l.pretty.toLowerCase().includes(lower))));
    return { needle, raw, shown };
  };

  const paint = () => {
    const { needle, raw, shown } = currentShown();
    const follow = $('#log-follow', root).checked;
    setText($('#log-shown', root), `${shown.length} of ${lines.length} lines`);
    $('#log-copy', root).disabled = shown.length === 0;
    reconcile(box, shown.length ? shown : [{ seq: 'empty' }], l => l.seq, () => document.createElement('div'), (el, l) => {
      setMarkup(el, l.seq === 'empty' ? '<div class="empty">No lines.</div>' : logLine(l, { needle, withSource: source === ALL, pretty: !raw }));
    });
    if (follow) { box.scrollTop = box.scrollHeight; unread = 0; }
    showUnread();
  };

  const showUnread = () => {
    const control = $('#log-unread', root);
    control.hidden = !unread;
    control.textContent = `${unread} new ${unread === 1 ? 'line' : 'lines'}`;
  };
  $('#log-unread', root).addEventListener('click', () => {
    if (paused) $('#log-pause', root).click();
    $('#log-follow', root).checked = true;
    paint();
  });

  const select = name => {
    ++logRevision;
    source = name;
    after = 0; loaded = false; lines = []; unread = 0;
    showUnread();
    rememberSection('logs', name === ALL ? '#logs' : `#logs/${encodeURIComponent(name)}`);
    $('#sources', root).value = name;
    const dl = $('#log-download', root);
    dl.href = `api/logs/${encodeURIComponent(name)}/file`;
    dl.setAttribute('download', name === ALL ? 'all-sources.log' : `${name}.log`);
    box.innerHTML = '<div class="empty">Loading…</div>';
    poll();
  };

  const poll = async (background = false) => {
    const want = source, revision = logRevision;
    const previous = after;
    let d;
    try { d = await api(`/logs/${encodeURIComponent(want)}?after=${after}&max=2000`, { poll: background }); } catch {
      if (box.isConnected && revision === logRevision) {
        setText($('#log-shown', root), 'Could not refresh · retrying');
        if (!loaded) setText(box, 'Waiting for log output…');
      }
      return;
    }
    if (revision !== logRevision || !box.isConnected || want !== source || previous !== after) return;
    if (d.lines.length || !loaded) {
      for (const l of d.lines) {
        l.plain = stripAnsi(l.text);
        if (l.source === 'caddy') l.pretty = formatCaddyLine(l.plain);
        lines.push(l);
      }
      if (lines.length > MAX) lines = lines.slice(-MAX);
      if (d.lines.length) after = d.lines[d.lines.length - 1].seq;
      if (loaded && (paused || !$('#log-follow', root).checked)) unread += d.lines.length;
      loaded = true;
      if (paused) showUnread();
      else paint();
    }
  };

  let sourcesLoaded = false;
  const refreshSources = async ({ selectTarget = null, poll: background = false } = {}) => {
    const d = await api('/logs', { poll: background });
    if (!box.isConnected) return false;
    d.sources.forEach(colorOf);
    const selectEl = $('#sources', root);
    const html = `<option value="${ALL}">All sources</option>` +
      d.sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    setMarkup(selectEl, html);
    sourcesLoaded = true;
    if (selectTarget !== null) {
      const chosen = selectTarget === ALL || d.sources.includes(selectTarget) ? selectTarget : ALL;
      select(chosen);
      return chosen === selectTarget;
    }
    selectEl.value = source === ALL || d.sources.includes(source) ? source : ALL;
    return true;
  };

  refreshSources({ selectTarget: source }).catch(error => { if (box.isConnected) setText(box, error.message); });

  $('#sources', root).addEventListener('change', ev => select(ev.target.value));
  $('#log-filter', root).addEventListener('input', paint);
  $('#log-err', root).addEventListener('change', paint);
  $('#log-raw', root).addEventListener('change', paint);
  $('#log-wrap', root).addEventListener('change', ev => box.classList.toggle('wrap', ev.target.checked));
  $('#log-pause', root).addEventListener('click', ev => {
    paused = !paused;
    ev.target.textContent = paused ? 'Resume' : 'Pause';
    ev.target.classList.toggle('on', paused);
    if (!paused) { paint(); poll(false); }
  });
  $('#log-copy', root).addEventListener('click', () => {
    const { raw, shown } = currentShown();
    if (!shown.length) return;
    const text = shown.map(l => `${clock(l.time)}${source === ALL ? ' [' + l.source + ']' : ''} ${(!raw && l.pretty) || l.plain}`).join('\n');
    copyText(text, `Copied ${shown.length} ${shown.length === 1 ? 'line' : 'lines'}.`);
  });
  $('#log-clear', root).addEventListener('click', async () => {
    const revision = logRevision;
    const confirm = source === ALL ? { title: 'Clear all log buffers?', text: 'Clears the in-memory view for every source. Log files on disk are kept.', ok: 'Clear all' } : undefined;
    if (await act(`/logs/${encodeURIComponent(source)}/clear`, { confirm }) && box.isConnected && revision === logRevision) {
      ++logRevision;
      lines = [];
      unread = 0;
      paint();
    }
  });
  box.addEventListener('scroll', () => {
    $('#log-follow', root).checked = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  });

  timers.push(setInterval(() => {
    if (document.hidden || !logRevision) return;
    const bounds = root.getBoundingClientRect(), viewport = workspace.getBoundingClientRect();
    if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) poll(true);
  }, 1000));
  return {
    async selectDetail(arg) {
      if (!arg || source === arg) return;
      if (!sourcesLoaded) { source = arg; return; }
      const selectEl = $('#sources', root);
      if ([...selectEl.options].some(o => o.value === arg)) {
        select(arg);
        return;
      }
      try {
        await refreshSources({ selectTarget: arg });
      } catch { /* Keep current source if refresh fails. */ }
    },
  };
};

// ------------------------------------------------------------------ config

function appTemplate(id, mode) {
  const app = { $schema: '../schema/app.schema.json', name: id, enabled: mode !== 'route', root: '../' + id };
  if (mode !== 'route') {
    app.ports = { http: 16000 };
    app.launch = { args: ['-Port', '${ports.http}'] };
  }
  if (mode !== 'local') {
    app.basePath = '/' + id;
    app.routes = { proxy: [{ upstream: mode === 'route' ? 'upstream.example.com:8080' : '127.0.0.1:${ports.http}' }] };
  }
  return JSON.stringify(app, null, 2) + '\n';
}

let hasDraft = false;

views.config = (root, initial, initialTab) => {
  root.innerHTML = `
    <div class="head"><h2>Config</h2></div><section class="config-workspace">
    <div class="tabs pills" id="tabs">
      <button class="pill" data-tab="registry">Registry</button>
      <button class="pill" data-tab="site">Landing page</button>
      <details class="action-menu"><summary class="pill">Gateway files</summary><div class="menu-items">
        <button data-tab="caddyfile">Caddyfile</button><button data-tab="gateway">gateway.json</button></div></details>
      <details class="action-menu"><summary class="pill">Reference</summary><div class="menu-items">
        <button data-tab="env">Route variables</button><button data-tab="schema">App schema</button><button data-tab="ports">PORTS.md</button></div></details>
    </div>
    <div id="tab-body"></div><footer class="config-global-foot"><span id="apply-status" class="muted" role="status"></span>
      <span class="spacer"></span><button class="btn" data-gw="reload">Apply routes</button></footer></section>`;
  const body = $('#tab-body', root);
  let registryFiles;
  const rememberFiles = files => { registryFiles = files; };

  const showText = async (pane, key) => {
    const f = await api('/config/files');
    const text = key === 'env'
      ? (Array.isArray(f.routeEnv) ? f.routeEnv : Object.keys(f.routeEnv || {})).join('\n') || '(no snippet app sets any)'
      : f[key];
    pane.innerHTML = `<div class="code-box"><div class="code-box-head"><span class="muted small">${esc(key === 'caddyfile' ? 'Generated Caddyfile' : key === 'env' ? 'Route environment variables' : key === 'schema' ? 'schema/app.schema.json' : 'PORTS.md')}</span><button type="button" class="btn small" id="copy-ref">Copy</button></div><pre class="code">${esc(text)}</pre></div>`;
    $('#copy-ref', pane).addEventListener('click', () => copyText(text, 'Copied to clipboard.'));
  };

  const tabs = {
    registry: pane => registry(pane, initial, rememberFiles),
    site: async pane => {
      const site = (await api('/config/files')).site || {};
      if (!pane.isConnected) return;
      pane.innerHTML = `
        <form class="form card" id="site-form">
          <label>Title <input name="title" value="${esc(site.title)}"></label>
          <label>Tagline <input name="tagline" value="${esc(site.tagline)}"></label>
          <label>Fallback icon <input name="fallbackIcon" value="${esc(site.fallbackIcon)}" maxlength="8"></label>
          <div class="row"><button class="btn primary" id="site-save" disabled>Save settings</button><span id="site-status" class="muted small" role="status"></span><span class="spacer"></span><a href="../" target="_blank" rel="noopener" class="small">Open the landing page ↗</a></div>
        </form>`;
      const form = $('#site-form', pane);
      const saveBtn = $('#site-save', pane);
      const statusEl = $('#site-status', pane);
      let saving = false;
      const snapshot = () => JSON.stringify(Object.fromEntries(new FormData(form)));
      let savedSnapshot = snapshot();
      const syncDirty = () => {
        const dirty = snapshot() !== savedSnapshot;
        hasDraft = dirty;
        saveBtn.disabled = saving || !dirty;
        if (dirty) setText(statusEl, 'Unsaved');
        else if (statusEl.textContent === 'Unsaved') setText(statusEl, '');
        body.dispatchEvent(new Event('registrationchange', { bubbles: true }));
      };
      form.addEventListener('input', syncDirty);
      form.addEventListener('submit', async ev => {
        ev.preventDefault();
        if (saving) return;
        const sent = snapshot();
        const payload = Object.fromEntries(new FormData(form));
        saving = true;
        saveBtn.disabled = true;
        setText(statusEl, 'Saving…');
        const done = await act('/config/site', { body: payload });
        saving = false;
        if (!pane.isConnected) return;
        if (done) {
          savedSnapshot = sent;
          if (snapshot() === sent) {
            hasDraft = false;
            setText(statusEl, 'Saved · pending apply');
          } else {
            syncDirty();
          }
          body.dispatchEvent(new Event('registrationchange', { bubbles: true }));
        } else {
          syncDirty();
        }
      });
    },
    caddyfile: pane => showText(pane, 'caddyfile'),
    gateway: pane => gatewayEditor(pane),
    env: pane => showText(pane, 'env'),
    schema: pane => showText(pane, 'schema'),
    ports: pane => showText(pane, 'ports'),
  };

  let activeTab;
  const open = name => {
    activeTab = name;
    $$('#tabs button', root).forEach(b => {
      b.classList.toggle('on', b.dataset.tab === name);
      b.setAttribute('aria-pressed', String(b.dataset.tab === name));
    });
    for (const group of $$('#tabs details', root)) {
      const chosen = $('[aria-pressed="true"]', group), summary = $('summary', group);
      summary.dataset.label ||= summary.textContent;
      setText(summary, chosen ? chosen.textContent : summary.dataset.label);
      summary.classList.toggle('on', Boolean(chosen));
      if (group.open) { group.open = false; summary.focus(); }
    }
    const pane = document.createElement('div');
    pane.innerHTML = name === 'registry' ? `<div class="editor-layout registry-layout registry-loading" role="status" aria-label="Reading applications" aria-busy="true">
      <aside class="registry-index"><h3>Applications</h3><span class="skeleton"></span></aside>
      <div class="registry-editor stack"><div class="skeleton"></div><div class="skeleton"></div><div class="card registry-fields">
      ${'<div><span class="skeleton"></span><span class="field-placeholder"></span></div>'.repeat(6)}</div><span class="skeleton"></span></div></div>` : `<div class="card config-loading" role="status"><span class="skeleton" aria-hidden="true"></span>
      <span class="muted">Reading ${esc($('[data-tab="' + name + '"]', root).textContent)}…</span></div>`;
    body.replaceChildren(pane);
    Promise.resolve(tabs[name](pane)).catch(e => {
      pane.innerHTML = `<div class="card config-loading" role="alert"><p class="error">${esc(e.message)}</p><button class="btn small">Retry</button></div>`;
      $('button', pane).addEventListener('click', () => open(name));
    });
  };
  $('#tabs', root).addEventListener('click', async ev => {
    const b = ev.target.closest('[data-tab]');
    if (!b || b.classList.contains('on')) return;
    if (hasDraft && !(await confirmAction('Discard changes?', 'This editor has an unsaved draft.', 'Discard'))) return;
    hasDraft = false;
    rememberSection('config', '#config//' + b.dataset.tab);
    open(b.dataset.tab);
  });
  open(Object.hasOwn(tabs, initialTab) ? initialTab : 'registry');
  function syncConfig() {
    if (!pulse || !body.isConnected) return;
    const g = pulse.gateway;
    $('#applied-info', root)?.refresh?.();
    setText($('#apply-status', root), g.reloading ? 'Applying…' : g.lastReload
      ? (g.lastReload.ok ? `Applied at ${clock(g.lastReload.at)}` : g.lastReload.message || 'Apply failed · previous version active') : '');
    const apply = $('.reg-footer [data-gw="reload"]', root);
    $('.config-global-foot button', root).disabled = g.reloading || hasDraft;
    const status = $('#saved-at', root);
    if (apply) {
      const disk = registryFiles && new Map(registryFiles.map(f => [f.id, f.version]));
      const pending = disk && registryFiles.every(f => f.version) && g.registryVersions
        ? [...new Set([...disk.keys(), ...Object.keys(g.registryVersions)])].filter(id => disk.get(id) !== g.registryVersions[id]).length
        : null;
      const required = pending === null ? status.textContent.includes('pending') : pending > 0;
      apply.disabled = g.reloading || hasDraft || pending === 0;
      apply.classList.toggle('primary', required && !apply.disabled);
      const note = $('#pending-note', root);
      setText(note, g.reloading ? 'Applying…' : g.lastReload?.ok === false ? g.lastReload.message || 'Apply failed' :
        pending ? `${pending} pending` : '');
      const dot = $('#nav-config-dot');
      if (dot) dot.hidden = !(required || hasDraft);
    } else {
      const dot = $('#nav-config-dot');
      if (dot) dot.hidden = !hasDraft;
    }
    if (!g.reloading && !hasDraft) {
      const status = $('#saved-at', root);
      if (status?.dataset.version && status.dataset.version === g.registryVersions?.[status.dataset.id]) {
        status.textContent = 'Applied';
        const restart = $('#apply-restart', root);
        if (restart) restart.hidden = true;
      }
    }
  }
  body.addEventListener('registrationchange', syncConfig);
  return { onPulse: syncConfig, async selectDetail(id, targetTab) {
    const tab = Object.hasOwn(tabs, targetTab) ? targetTab : 'registry';
    if (activeTab === tab && (!id || $('#saved-at',root)?.dataset.id === id)) return;
    if (hasDraft && !(await confirmAction('Discard changes?', 'The configuration editor has unsaved changes.', 'Discard'))) {
      rememberSection('config', sectionLinks.get('config') || '#config');
      return;
    }
    hasDraft = false;
    initial = id;
    open(tab);
  } };
};

async function gatewayEditor(body) {
  const config = await api('/config/gateway');
  if (!body.isConnected) return;
  let version = config.version;
  let savedText = config.text;
  let checkSeq = 0;
  body.innerHTML = `<div class="editor-layout gateway-editor">
    <section><div class="row"><b>Gateway settings</b><span class="spacer"></span>
      <button class="btn small" id="gateway-format">Format JSON</button>
      <button class="btn" id="gateway-check">Check</button><button class="btn primary" id="gateway-save" disabled>Save settings</button></div>
      <textarea class="code" id="gateway-text" aria-label="gateway.json" spellcheck="false"></textarea></section>
    <aside class="card config-preview preview-idle" id="gateway-preview" aria-live="polite"><h3>Resolved settings</h3>
      <p class="muted">Check the path aliases and see which applications are affected.</p></aside></div>`;
  const text = $('#gateway-text', body);
  const preview = $('#gateway-preview', body);
  const checkBtn = $('#gateway-check', body);
  const saveBtn = $('#gateway-save', body);
  text.value = config.text;
  text.addEventListener('keydown', ev => {
    handleCodeTab(ev);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); if (!saveBtn.disabled) saveBtn.click(); }
  });
  $('#gateway-format', body).addEventListener('click', () => {
    try { text.value = JSON.stringify(JSON.parse(text.value), null, 2) + '\n'; text.dispatchEvent(new Event('input')); }
    catch (e) { toast(`Not valid JSON: ${e.message}`, 'bad'); }
  });
  let busy = false;
  const syncButtons = () => {
    const dirty = text.value !== savedText;
    hasDraft = dirty;
    checkBtn.disabled = busy;
    saveBtn.disabled = busy || !dirty;
    body.dispatchEvent(new Event('registrationchange', { bubbles: true }));
  };
  text.addEventListener('input', () => {
    ++checkSeq;
    if (!preview.classList.contains('preview-idle') && !$('.stale', preview)) {
      const note = document.createElement('strong');
      note.className = 'stale';
      note.textContent = 'Out of date · check again';
      preview.prepend(note);
    }
    syncButtons();
  });
  const submit = async save => {
    const json = text.value;
    const seq = ++checkSeq;
    busy = true;
    syncButtons();
    try {
      if (!json.trim()) throw new Error('gateway.json cannot be empty.');
      JSON.parse(json);
      const data = await api(save ? '/config/gateway' : '/config/gateway/preview', { method: 'POST', body: { text: json, version } });
      if (!body.isConnected || seq !== checkSeq || text.value !== json) return;
      preview.classList.remove('preview-idle');
      preview.innerHTML = `<h3>${save ? 'Saved · ready to apply' : 'Preflight passed'}</h3>
        <dl class="kv">${Object.entries(data.paths).map(([k, v]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>
        <p class="muted">${data.affected.length ? `Affected apps · ${esc(data.affected.join(', '))}` : 'No startup settings changed for current apps.'}</p>
        ${data.needsRestart.length ? `<p class="restart-note">Gateway restart required for ${esc(data.needsRestart.join(', '))}.</p>` : ''}`;
      if (save) {
        version = data.version;
        savedText = json;
        toast(data.message, 'ok');
      }
    } catch (error) {
      if (!body.isConnected || seq !== checkSeq || text.value !== json) return;
      preview.classList.remove('preview-idle');
      preview.innerHTML = `<h3>Check failed</h3><p class="error">${esc(error.message)}</p>`;
      text.focus();
    } finally {
      if (body.isConnected) {
        busy = false;
        syncButtons();
      }
    }
  };
  checkBtn.addEventListener('click', () => submit(false));
  saveBtn.addEventListener('click', () => submit(true));
}

async function registry(body, initial, rememberFiles) {
  const { files } = await api('/config/apps');
  if (!body.isConnected) return;
  rememberFiles(files);
  let selected = files.some(f => f.id === initial) ? initial : files[0]?.id;
  let creating = false;
  let dirty = false;
  let version;

  body.innerHTML = `
    <div class="editor-layout registry-layout">
      <aside class="registry-index"><div class="row"><h3>Applications</h3><span class="spacer"></span>
        <button class="btn small icon" id="new-toggle" aria-expanded="false" aria-controls="new-row" aria-label="New application">＋</button></div>
        <select id="file-picker" aria-label="Select registration"></select>
        <div class="filelist" id="filelist"></div>
        <div class="new-app-fields" id="new-row" hidden><label>Application ID<input id="new-id" placeholder="new-app-id"></label>
          <label>Template<select id="new-mode"><option value="local">Local launch</option><option value="managed">Launch and proxy</option><option value="route">Proxy only</option></select></label>
          <button class="btn small" id="new-app">Create draft</button></div>
      </aside>
      <div class="stack registry-editor">
        <div class="row"><div><h2 id="editing-name">Registration</h2><small id="editing" class="mono muted"></small></div></div>
        <div class="row"><div class="pills" aria-label="Editing mode"><button class="pill on" id="fields-mode">Fields</button><button class="pill" id="json-mode">Raw JSON</button></div>
          <span id="json-status" class="json-state" hidden></span>
          <button class="btn small" id="format-app" hidden title="Pretty-print JSON">Format JSON</button>
          <span class="spacer"></span>
          <select id="history" aria-label="Earlier versions"></select>
          <details class="action-menu"><summary class="btn small">More</summary><div class="menu-items">
          <button class="danger" id="delete-app">Delete registration</button></div></details></div>
        <div id="app-fields" class="card registry-fields">
          <label>Display name<input data-field="name"></label>
          <label>Public prefix<input data-field="basePath" placeholder="/example"></label>
          <label class="field-wide">Application root<input data-field="root"></label>
          <label class="field-wide">Description<input data-field="description"></label>
          <label>Icon<select id="icon-mode"><option value="">Fallback glyph</option><option value="glyph">Character</option><option value="file">Application file</option></select></label>
          <label id="icon-field" hidden><span id="icon-label">Icon value</span><input id="icon-value"></label>
          <label>Sort order<input type="number" data-int="order" placeholder="100"></label>
          <div class="field-flags field-wide">
            <label class="check"><input type="checkbox" data-bool="enabled"> Enabled at startup</label>
            <label class="check"><input type="checkbox" data-bool="hidden"> Hide from landing page</label>
            <label class="check" id="flag-auto-restart" hidden><input type="checkbox" data-launch-bool="autoRestart"> Auto-restart on crash</label>
            <label class="check" id="flag-restart-running" hidden><input type="checkbox" data-launch-bool="restartIfRunning"> Take over if already running</label>
          </div>
          <p class="muted small">Use Raw JSON for named ports, launch arguments, environment variables or routes.</p>
        </div>
        <textarea class="code" id="app-text" spellcheck="false" aria-label="App file" hidden></textarea>
      </div>
      <aside class="reg-inspector">
        <div class="config-preview preview-idle" id="app-preview" aria-live="polite" tabindex="-1"></div>
        <div id="applied-info"></div>
      </aside>
    </div><footer class="reg-footer"><span class="reg-state"><b id="saved-at"></b><small id="pending-note" class="muted"></small></span>
      <span class="spacer"></span><button class="btn small" id="apply-restart" hidden>Apply and restart</button>
      <button class="btn" id="check-app">Check</button><button class="btn" id="save-app" disabled>Save registration</button>
      <button class="btn" data-gw="reload">Apply routes</button></footer>`;
  const text = $('#app-text', body);
  const fields = $('#app-fields', body);
  const preview = $('#app-preview', body);
  let jsonMode = false;
  const historySelect = $('#history', body);
  const editor = $('.registry-editor', body);
  let fileRequest = 0;
  let writingFile = false;
  const restart = $('#apply-restart', body);
  let needsRoutedRestart = false;
  const picker = $('#file-picker', body);
  const nameOf = f => f.name || appById(f.id)?.name || f.id;
  function renderIndex() {
    reconcile($('#filelist', body), files, f => f.id, () => document.createElement('button'), (b, f) => {
      b.dataset.id = f.id; b.title = f.file;
      setText(b, nameOf(f));
      b.classList.toggle('on', f.id === selected);
      b.setAttribute('aria-pressed', String(f.id === selected));
    });
    setMarkup(picker, files.map(f => `<option value="${esc(f.id)}">${esc(nameOf(f))}</option>`).join(''));
    picker.value = selected || '';
  }
  function newForm(open) {
    $('#new-row', body).hidden = !open;
    $('#filelist', body).hidden = picker.hidden = open;
    const toggle = $('#new-toggle', body);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close new application form' : 'New application');
    setText(toggle, open ? '×' : '＋');
    if (open && current === 'config') $('#new-id', body).focus({preventScroll:true});
  }
  $('#new-toggle', body).onclick = () => newForm($('#new-row', body).hidden);
  picker.onchange = async () => { await load(picker.value); picker.value = selected || ''; };
  const appliedInfo = $('#applied-info', body);
  function showApplied() {
    const app = appById(selected);
    setMarkup(appliedInfo, `<h3>Applied registration</h3>` + (app
      ? `<dl class="kv"><dt>Entry</dt><dd>${routeLink(app) || 'Local only'}</dd>
        <dt>Ports</dt><dd>${app.ports.map(p => `${esc(p.name)} · ${esc(p.port)}`).join('<br>') || 'None'}</dd>
        <dt>Root</dt><dd class="mono">${esc(app.root)}</dd><dt>Icon</dt><dd>${appIcon(app)}</dd></dl>`
      : `<p class="muted">${pulse ? 'No applied registration.' : 'Reading applied settings…'}</p>`));
  }
  appliedInfo.refresh = showApplied;
  function resetPreview() {
    showApplied();
    preview.className = 'config-preview preview-idle';
    preview.textContent = 'Check to preview entry, ports and icon.';
  }
  function reportError(error, title) {
    preview.className = 'config-preview card';
    preview.innerHTML = `<h3>${title}</h3><p class="error">${esc(error.message)}</p>`;
    const field = /icon/i.test(error.message) ? '#icon-value' : /root|directory/i.test(error.message) ? '[data-field="root"]' : /prefix|basePath/i.test(error.message) ? '[data-field="basePath"]' : null;
    const input = jsonMode ? text : field && $(field, body);
    (input?.offsetWidth ? input : preview).focus();
  }
  const mark = (state, label = '') => {
    if (state && !preview.classList.contains('preview-idle') && !$('.stale', preview)) {
      const note = document.createElement('strong'); note.className = 'stale'; note.textContent = 'Out of date · check again'; preview.prepend(note);
    }
    dirty = state;
    hasDraft = state;
    const save = $('#save-app', body);
    save.disabled = writingFile || !state;
    save.classList.toggle('primary', state);
    $('.reg-footer [data-gw="reload"]', body).disabled = state || Boolean(pulse?.gateway.reloading);
    const status = $('#saved-at', body);
    status.textContent = state ? 'Unsaved' : label;
    restart.hidden = state || label !== 'Saved · pending apply' || !needsRoutedRestart;
    body.dispatchEvent(new Event('registrationchange', { bubbles: true }));
  };
  const discardOk = async () => !dirty || confirmAction('Discard changes?', 'The file has unsaved edits.', 'Discard');

  function iconField(mode) {
    $('#icon-field', body).hidden = !mode;
    $('#icon-label', body).textContent = mode === 'file' ? 'Path relative to the app' : 'Character or emoji';
    $('#icon-value', body).placeholder = mode === 'file' ? 'app/static/icon.svg' : '◇';
  }

  function updateJsonStatus() {
    const status = $('#json-status', body);
    if (!jsonMode || !text.value.trim()) { status.hidden = true; return; }
    status.hidden = false;
    try {
      JSON.parse(text.value);
      status.className = 'json-state ok';
      setText(status, 'Valid JSON');
      status.title = '';
    } catch (e) {
      status.className = 'json-state bad';
      setText(status, 'Invalid JSON');
      status.title = e.message;
    }
  }

  function syncFields() {
    let app;
    try { app = JSON.parse(text.value); }
    catch { return false; }
    $$('[data-field]', fields).forEach(input => { input.value = app[input.dataset.field] || ''; });
    $$('[data-int]', fields).forEach(input => { input.value = app[input.dataset.int] ?? ''; });
    $$('[data-bool]', fields).forEach(input => {
      const k = input.dataset.bool;
      input.checked = k === 'enabled' ? app.enabled !== false : Boolean(app[k]);
    });
    const hasLaunch = Boolean(app.launch && typeof app.launch === 'object');
    $('#flag-auto-restart', body).hidden = !hasLaunch;
    $('#flag-restart-running', body).hidden = !hasLaunch;
    if (hasLaunch) {
      $$('[data-launch-bool]', fields).forEach(input => { input.checked = Boolean(app.launch[input.dataset.launchBool]); });
    }
    const mode = typeof app.icon === 'string' && app.icon ? 'glyph' : app.icon?.file ? 'file' : '';
    $('#icon-mode', body).value = mode;
    $('#icon-value', body).value = mode === 'file' ? app.icon.file : typeof app.icon === 'string' ? app.icon : '';
    iconField(mode);
    return true;
  }
  function setMode(raw) {
    if (!raw && !syncFields()) {
      if (text.value) toast('Fix the JSON before opening Fields.', 'warn');
      return;
    }
    $('#format-app', body).hidden = !raw;
    $('#json-mode', body).setAttribute('aria-pressed', String(raw));
    $('#fields-mode', body).setAttribute('aria-pressed', String(!raw));
    jsonMode = raw;
    text.hidden = !raw;
    fields.hidden = raw;
    $('#fields-mode', body).classList.toggle('on', !raw);
    $('#json-mode', body).classList.toggle('on', raw);
    updateJsonStatus();
  }
  $('#fields-mode', body).addEventListener('click', () => setMode(false));
  $('#json-mode', body).addEventListener('click', () => setMode(true));
  fields.addEventListener('input', ev => {
    if (!text.value) return;
    let app;
    try { app = JSON.parse(text.value); } catch { return; }
    const el = ev.target;
    if (el.dataset.field) {
      const field = el.dataset.field;
      if (el.value || field === 'name' || field === 'root') app[field] = el.value;
      else delete app[field];
    } else if (el.dataset.int) {
      const key = el.dataset.int;
      if (el.value === '') delete app[key];
      else {
        const num = Number.parseInt(el.value, 10);
        if (!Number.isNaN(num)) app[key] = num;
      }
    } else if (el.dataset.bool) {
      const key = el.dataset.bool;
      if (key === 'enabled') app.enabled = el.checked;
      else if (el.checked) app[key] = true;
      else delete app[key];
    } else if (el.dataset.launchBool) {
      if (app.launch && typeof app.launch === 'object') {
        const key = el.dataset.launchBool;
        if (el.checked) app.launch[key] = true;
        else delete app.launch[key];
      }
    } else {
      const mode = $('#icon-mode', body).value;
      iconField(mode);
      const value = $('#icon-value', body).value;
      if (mode === 'file') app.icon = { file: value };
      else if (mode === 'glyph') app.icon = value;
      else delete app.icon;
    }
    text.value = JSON.stringify(app, null, 2) + '\n';
    mark(true);
  });
  function showPreview(data) {
    preview.className = 'config-preview card';
    needsRoutedRestart = data.applyRestart;
    if (!dirty && $('#saved-at', body).textContent === 'Saved · pending apply') restart.hidden = !needsRoutedRestart;
    const icon = data.iconData
      ? `<img src="${esc(data.iconData)}" alt="" width="24" height="24">` : esc(data.iconGlyph || '◇');
    preview.innerHTML = `<div class="row"><span class="ico" aria-hidden="true">${icon}</span><h3>Resolved registration</h3></div><small class="muted">Checked at ${esc(clock(Date.now()))}</small>
      <dl class="kv">
        <dt>Root</dt><dd class="mono">${esc(data.root)}</dd>
        <dt>Entry</dt><dd class="mono">${esc(data.entry || '—')}</dd>
        <dt>Ports</dt><dd>${Object.entries(data.ports).map(([k, v]) => `${esc(k)} ${v}`).join('<br>') || '—'}</dd>
        <dt>Launch</dt><dd class="mono">${esc(data.launch ? ['start.ps1', ...(data.args || [])].join(' ') : 'External')}</dd>
      </dl>${[...data.warnings, ...(data.needsRestart ? ['Application restart required for startup changes.'] : [])].map(w => `<p class="restart-note">${esc(w)}</p>`).join('')}`;
  }
  async function check(quiet = false) {
    if (!selected) return null;
    const id = selected, draft = text.value;
    try {
      if (!draft.trim()) throw new Error('Registration JSON cannot be empty.');
      JSON.parse(draft);
      const data = await api(`/config/apps/${encodeURIComponent(id)}/preview`, { method: 'POST', body: { text: draft } });
      if (selected !== id || text.value !== draft || !body.isConnected) return null;
      showPreview(data);
      return data;
    } catch (error) {
      if (selected !== id || text.value !== draft || !body.isConnected) return null;
      reportError(error, 'Check failed');
      if (!quiet) toast(error.message, 'bad');
      return null;
    }
  }
  $('#check-app', body).addEventListener('click', () => check(true));
  restart.addEventListener('click', async () => {
    restart.disabled = true;
    await act('/gateway/reload', {
      body: { restartApp: selected },
      confirm: { title: `Apply and restart ${selected}?`, text: 'This entry goes offline while the app opens its new ports. Gateway restores the previous launch and routes if the change fails.', ok: 'Apply and restart' },
    });
    restart.disabled = false;
    beat();
  });

  const loadHistory = async id => {
    historySelect.innerHTML = '<option value="">No backups yet</option>';
    historySelect.disabled = true;
    historySelect.title = 'Previous versions are saved automatically when you edit or delete this registration.';
    try {
      const { versions } = await api(`/config/apps/${encodeURIComponent(id)}/history`);
      if (selected !== id || creating) return;
      if (versions.length) {
        historySelect.innerHTML = `<option value="">History (${versions.length})…</option>` +
          versions.map(v => `<option value="${esc(v.file)}">${esc(stamp(v.saved))}${v.deleted ? ' (deleted)' : ''}</option>`).join('');
        historySelect.disabled = false;
        historySelect.title = 'Load an earlier backup into the editor';
      }
    } catch { /* The current file remains editable. */ }
  };

  const load = async id => {
    if (writingFile || !(await discardOk())) return;
    const request = ++fileRequest;
    editor.inert = true;
    $('.reg-footer', body).inert = true;
    editor.setAttribute('aria-busy', 'true');
    try {
      const file = await api(`/config/apps/${encodeURIComponent(id)}`);
      if (request !== fileRequest || !body.isConnected) return;
      creating = false;
      editor.hidden = false;
      selected = id;
      needsRoutedRestart = false;
      $$('#filelist button', body).forEach(b => b.classList.toggle('on', b.dataset.id === id));
      setText($('#editing', body), `apps/${id}.json`);
      $('#delete-app', body).hidden = false;
      newForm(false);
      text.value = file.text;
      version = file.version;
      showFileState(file.applied);
      setMode(jsonMode || !syncFields());
      resetPreview();
      const entry = files.find(f => f.id === id);
      if (entry) { try { entry.name = JSON.parse(file.text).name; } catch { entry.name = id; } }
      setText($('#editing-name', body), entry?.name || id);
      renderIndex();
      loadHistory(id);
      rememberSection('config', `#config/${encodeURIComponent(id)}`);
    } catch (e) {
      if (request === fileRequest && body.isConnected) {
        toast(e.message, 'bad');
        if (version === undefined && !creating) {
          editor.hidden = true;
          preview.className = 'config-preview card';
          preview.innerHTML = `<p class="error">${esc(e.message)}</p><button class="btn small">Retry</button>`;
          $('button', preview).onclick = () => load(id);
        }
      }
    } finally {
      if (request === fileRequest) {
        editor.inert = false;
        $('.reg-footer', body).inert = false;
        editor.removeAttribute('aria-busy');
      }
    }
  };
  function showFileState(applied) {
    const status = $('#saved-at', body);
    status.dataset.id = selected;
    status.dataset.version = version ?? '';
    mark(false, applied ? 'Applied' : 'Saved · pending apply');
  }

  text.addEventListener('input', () => { updateJsonStatus(); mark(true); });
  text.addEventListener('keydown', handleCodeTab);
  editor.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); $('#save-app', body).click(); }
  });

  historySelect.addEventListener('change', async () => {
    const file = historySelect.value;
    historySelect.value = '';
    if (!file) return;
    try {
      const before = text.value, id = selected, request = fileRequest;
      const backup = await api(`/config/backups/${encodeURIComponent(file)}`);
      if (selected !== id || fileRequest !== request || before !== text.value || !body.isConnected) return;
      text.value = backup.text;
      setMode(jsonMode || !syncFields());
      mark(true);
      toast('Earlier version loaded into the editor. Save to restore it.');
    } catch (e) { toast(e.message, 'bad'); }
  });

  $('#format-app', body).addEventListener('click', () => {
    try {
      text.value = JSON.stringify(JSON.parse(text.value), null, 2) + '\n';
      updateJsonStatus();
      mark(true);
    }
    catch (e) { toast(`Not valid JSON: ${e.message}`, 'bad'); }
  });

  $('#filelist', body).addEventListener('click', ev => {
    const b = ev.target.closest('[data-id]');
    if (b) load(b.dataset.id);
  });

  $('#new-app', body).addEventListener('click', async () => {
    const id = $('#new-id', body).value.trim();
    if (files.some(f => f.id === id)) { toast('This application ID already exists.', 'warn'); $('#new-id', body).focus(); return; }
    if (!id) { toast('Type an id for the new app first: it becomes its file name.', 'warn'); $('#new-id', body).focus(); return; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) { toast('An id is lower-case letters, digits, . _ or -.', 'bad'); return; }
    if (writingFile || !(await discardOk())) return;
    ++fileRequest;
    editor.inert = false;
    $('.reg-footer', body).inert = false;
    editor.removeAttribute('aria-busy');
    editor.hidden = preview.hidden = false;
    creating = true;
    selected = id;
    $('#saved-at', body).dataset.id = id;
    $('#saved-at', body).dataset.version = '';
    setText($('#editing-name', body), id);
    newForm(false);
    resetPreview();
    picker.selectedIndex = -1;
    $$('#filelist button', body).forEach(b => b.classList.remove('on'));
    $('#editing', body).textContent = `apps/${id}.json (new)`;
    $('#delete-app', body).hidden = true;
    historySelect.disabled = true;
    text.value = appTemplate(id, $('#new-mode', body).value);
    version = null;
    setMode(jsonMode);
    mark(true);
    (jsonMode ? text : $('[data-field="name"]', fields)).focus();
  });

  $('#save-app', body).addEventListener('click', async () => {
    if (writingFile || !selected) return;
    const id = selected, draft = text.value, create = creating;
    const save = $('#save-app', body);
    save.disabled = writingFile = true;
    try {
      if (!draft.trim()) throw new Error('Registration JSON cannot be empty.');
      JSON.parse(draft);
      const data = await api(`/config/apps/${encodeURIComponent(id)}`, { method: 'POST', body: { text: draft, create, version } });
      if (selected !== id || !body.isConnected) return;
      version = data.version;
      if (create) {
        creating = false;
        $('#delete-app', body).hidden = false;
        files.push({id, file:id + '.json'});
        setText($('#editing', body), 'apps/' + id + '.json');
        rememberSection('config', '#config/' + encodeURIComponent(id));
      }
      const entry = files.find(f => f.id === id);
      if (entry) { entry.name = JSON.parse(draft).name; entry.version = data.version; }
      renderIndex();
      setText($('#editing-name', body), entry?.name || id);
      if (text.value === draft) {
        if (data.preview) showPreview(data.preview);
        showFileState(version === pulse?.gateway.registryVersions?.[id]);
      }
      toast(data.message, 'ok');
      loadHistory(id);
    } catch (error) {
      if (selected === id && body.isConnected) {
        if (text.value === draft) reportError(error, 'Could not save registration');
      }
    } finally {
      writingFile = false;
      save.disabled = !dirty;
    }
  });

  $('#delete-app', body).addEventListener('click', async () => {
    const data = await act(`/config/apps/${encodeURIComponent(selected)}/delete`, {
      confirm: { title: `Delete apps/${selected}.json?`, text: 'A backup is kept. Its route is removed when the registry is applied.', ok: 'Delete' },
    });
    if (data) { mark(false); registry(body, '', rememberFiles); beat(); }
  });

  renderIndex();
  resetPreview();
  if (selected) await load(selected);
  else { editor.hidden = preview.hidden = true; newForm(true); }
}

// ------------------------------------------------------------------ ports

views.ports = root => {
  root.innerHTML = `
    <div class="head"><h2>Ports</h2><span class="spacer"></span><button class="btn" id="ports-refresh">Refresh</button></div>
    <div class="range-index" id="port-ranges" aria-label="Port ranges"><span class="skeleton"></span></div>
    <select class="range-select" aria-label="Port range"><option>Reading ranges…</option></select>
    <div class="port-summary row"><span id="scope-summary"></span><span class="muted small" id="ports-message" role="status">Reading listeners…</span>
      <span class="spacer"></span>
      <input type="search" id="port-search" placeholder="Filter ports, apps or processes…" aria-label="Filter ports">
      <label class="check"><input type="checkbox" id="only-issues"> Unclaimed only</label></div>
    <div class="ports-list"><table><colgroup><col class="col-port"><col class="col-range"><col class="col-app"><col class="col-state"><col class="col-listener"></colgroup><thead><tr><th>Port</th><th>Range / slot</th><th>Declared by</th><th>State</th><th>Listener</th></tr></thead>
      <tbody id="port-rows">${'<tr class="port-loading"><td colspan="5"><span class="skeleton"></span></td></tr>'.repeat(6)}</tbody></table></div>`;
  const index = $('#port-ranges', root), select = $('.range-select', root), table = $('#port-rows', root);
  const issues = $('#only-issues', root), portSearch = $('#port-search', root), message = $('#ports-message', root);
  let data, active = '', loading = false, updatedAt;
  const expanded = new Set();

  function render() {
    if (!data) return;
    const rangeCount = data.ranges.length;
    const choices = [{ key: '', name: 'All ranges', info: `${rangeCount} ${rangeCount === 1 ? 'range' : 'ranges'}` }];
    for (const range of data.ranges) {
      const ports = data.ports.filter(p => p.range === range.name);
      const slots = new Set(ports.map(p => p.slot)).size;
      choices.push({ key: range.name, name: range.name + '/', info: `${ports.filter(p => p.listening).length} listening · ${slots}/${Math.floor((range.to - range.from + 1) / data.slot)} slots` });
    }
    index.classList.toggle('many-ranges', choices.length > 7);
    if (!choices.some(c => c.key === active)) active = '';
    reconcile(index, choices, c => c.key || ':all', () => document.createElement('button'), (button, c) => {
      button.dataset.range = c.key;
      button.setAttribute('aria-pressed', String(active === c.key));
      setMarkup(button, `<b>${esc(c.name)}</b><small>${esc(c.info)}</small>`);
    });
    setMarkup(select, choices.map(c => `<option value="${esc(c.key)}">${esc(c.name)} · ${esc(c.info)}</option>`).join(''));
    select.value = active;
    const range = data.ranges.find(r => r.name === active);
    const scoped = data.ports.filter(p => !active || p.range === active);
    const unclaimed = p => p.listening && !p.app;
    setText($('#scope-summary', root), (range ? `${range.from}–${range.to} · ` : '') + `${scoped.filter(p => p.listening).length} listening · ${scoped.filter(unclaimed).length} unclaimed`);
    const q = portSearch.value.trim().toLowerCase();
    const rows = scoped.filter(p => (!issues.checked || unclaimed(p)) && (!q || [p.port, p.range, p.slot, p.app, p.name, p.process, p.pid].join(' ').toLowerCase().includes(q)));
    reconcile(table, rows.length ? rows : [{port: ':empty'}], p => p.port, () => document.createElement('tr'), (row, p) => {
      if (p.port === ':empty') {
        const filtered = issues.checked || active || q;
        setMarkup(row, `<td colspan="5" class="port-empty">${q ? 'No matching ports.' : issues.checked ? 'No unclaimed listeners match.' : 'No ports recorded in this range.'} ${filtered ? '<button class="link-button" data-clear>Clear filters</button>' : ''}</td>`);
        return;
      }
      const bindings = (p.bindings || []).map(b => esc(b.address) + (b.pid !== p.pid ? ' · PID ' + esc(b.pid) : '')).join('<br>');
      const listener = p.pid ? `${esc(p.process || 'Process')} · PID ${esc(p.pid)}<small>${bindings}</small>` : '—';
      const isOpen = expanded.has(p.port);
      if (!row.cells.length) {
        row.innerHTML = `<td><span class="port-number mono">${p.port}</span><button class="port-toggle link-button mono" data-port="${p.port}"></button></td>
          <td></td><td></td><td></td><td></td><td class="port-extra" hidden></td>`;
      }
      const button = $('button', row);
      setText(button, p.port + (isOpen ? ' ▴' : ' ▾'));
      button.setAttribute('aria-expanded', String(isOpen));
      const rangeCell = p.range ? `${esc(p.range)}<small>Slot ${esc(p.slot)}</small>` : `—<small>Unranged</small>`;
      const appCell = p.app && p.app !== '(gateway)'
        ? `<a href="#apps/app/${encodeURIComponent(p.app)}">${esc(p.app)}</a><small>${esc(p.name)}</small>`
        : `${esc(p.app || '—')}<small>${esc(p.name)}</small>`;
      setMarkup(row.cells[1], rangeCell);
      setMarkup(row.cells[2], appCell);
      setMarkup(row.cells[3], `<span class="badge s-${p.listening ? 'running' : 'stopped'}">${p.listening ? 'Listening' : 'Closed'}</span> ${unclaimed(p) ? '<span class="badge s-external plain">Unclaimed</span>' : ''}`);
      setMarkup(row.cells[4], listener);
      row.cells[5].hidden = !isOpen;
      if (isOpen) setMarkup(row.cells[5], `${p.range ? esc(p.range) + ' · Slot ' + esc(p.slot) : 'Unranged'}<br>${listener}`);
    });
  }
  index.onclick = e => { const b = e.target.closest('[data-range]'); if (b) { active = b.dataset.range; render(); } };
  select.onchange = () => { active = select.value; render(); };
  issues.onchange = render;
  portSearch.oninput = render;
  table.onclick = e => {
    if (e.target.closest('[data-clear]')) { active = ''; issues.checked = false; portSearch.value = ''; render(); portSearch.focus(); }
    const b = e.target.closest('[data-port]');
    if (b) { const n = Number(b.dataset.port); if (expanded.has(n)) expanded.delete(n); else expanded.add(n); render(); }
  };
  async function load(poll = false) {
    if (loading) return;
    loading = true;
    try {
      const next = await api('/ports', { poll });
      if (!table.isConnected) return;
      data = next;
      render();
      updatedAt = clock(Date.now());
      setText(message, 'Updated ' + updatedAt);
    } catch (error) {
      setText(message, data ? 'Refresh failed · last update ' + updatedAt : error.message);
    } finally { loading = false; }
  }
  $('#ports-refresh', root).onclick = () => load(false);
  every(10000, load);
};

// ------------------------------------------------------------------ security

views.security = root => {
  root.innerHTML = `
    <div class="head"><h2>Security</h2><span id="security-message" role="status" class="muted small">Reading security status…</span><button class="btn small" id="sec-retry" hidden>Retry</button></div>
    <div class="security-stack">
      <section class="card account-panel"><div class="row"><h3>Account</h3><strong id="account-name">—</strong>
        <span id="account-policy" class="muted small"></span><span class="spacer"></span>
        <button class="btn" id="pw-toggle" aria-controls="pw-form" aria-expanded="false" disabled>Change password</button></div>
        <form class="form" id="pw-form" hidden>
          <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
          <label>New password<input type="password" name="next" minlength="8" autocomplete="new-password" required></label>
          <label>Confirm new password<input type="password" name="again" autocomplete="new-password" required></label>
          <p class="error" role="alert" id="pw-error"></p><div class="row"><button class="btn primary">Save password</button><button type="button" class="btn" id="pw-cancel">Cancel</button></div></form></section>
      <section class="card security-section" id="sec-sessions"><div class="panel-heading"><h3>Sessions</h3>
        <span class="muted small" id="only-session"></span><button class="btn small danger" id="revoke-others" hidden>Sign out all others</button></div>
        <div class="table-wrap"><table><colgroup><col class="col-sess-client"><col class="col-sess-ua"><col class="col-sess-created"><col class="col-sess-seen"><col class="col-sess-status"></colgroup><thead><tr><th>Client</th><th>Browser / OS</th><th>Signed in</th><th>Last seen</th><th>Status</th></tr></thead>
        <tbody id="session-rows"><tr><td colspan="5"><span class="skeleton"></span></td></tr></tbody></table></div></section>
      <section class="card protection" id="sec-locks"><div class="row"><h3>Sign-in protection</h3><span id="lock-state" class="muted">Reading…</span>
        <span class="spacer"></span><button class="btn small" aria-expanded="false" aria-controls="lock-policy" id="policy-toggle">Policy</button></div>
        <p class="muted small" id="lock-policy" hidden>Five failures from one client within 15 minutes block it for 15 minutes. Thirty failures across clients suspend all sign-ins.</p>
        <div id="lock-list"></div><button class="btn small" id="unlock" hidden>Clear lockouts</button></section>
      <section class="card security-section" id="sec-audit"><div class="row"><h3>Audit log</h3><span class="spacer"></span>
        <input type="search" id="audit-filter" placeholder="Filter events…" aria-label="Filter audit events"></div>
        <div class="table-wrap"><table><colgroup><col class="col-audit-time"><col class="col-audit-event"><col class="col-audit-result"><col class="col-audit-client"><col class="col-audit-detail"></colgroup><thead><tr><th>Time</th><th>Event</th><th>Result</th><th>Client</th><th>Detail</th></tr></thead><tbody id="audit-rows"><tr><td colspan="5"><span class="skeleton"></span></td></tr></tbody></table></div></section></div>`;
  const form = $('#pw-form', root), toggle = $('#pw-toggle', root), issues = $('#sec-locks', root);
  const filter = $('#audit-filter', root), auditBody = $('#audit-rows', root);
  let audit = [], needsPriority = false, request = 0, lastUpdate;
  function passwordForm(open) {
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    form.reset();
    setText($('#pw-error', root), '');
    (open ? form.current : toggle).focus();
  }
  toggle.onclick = () => passwordForm(form.hidden);
  $('#pw-cancel', root).onclick = () => passwordForm(false);
  form.onsubmit = async e => {
    e.preventDefault();
    if (form.next.value !== form.again.value) {
      setText($('#pw-error', root), 'The new passwords differ.'); form.again.focus(); return;
    }
    const submit = $('button', form);
    submit.disabled = toggle.disabled = $('#pw-cancel', root).disabled = true;
    try {
      const result = await api('/security/password', {method:'POST', body:{current:form.current.value,next:form.next.value}});
      toggle.disabled = false;
      passwordForm(false); toast(result.message || 'Password changed.', 'ok'); load();
    } catch (error) { setText($('#pw-error', root), error.message); form.current.focus(); }
    finally { submit.disabled = toggle.disabled = $('#pw-cancel', root).disabled = false; }
  };
  $('#policy-toggle', root).onclick = e => {
    const panel = $('#lock-policy', root);
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
  };
  $('#unlock', root).onclick = async () => { if (await act('/security/unlock')) load(); };
  $('#revoke-others', root).onclick = async () => {
    if (await act('/security/sessions/revoke-others', {confirm:{title:'Sign out other sessions?', text:'This session will stay signed in.', ok:'Sign out others'}})) load();
  };
  $('#session-rows', root).onclick = async e => {
    const button = e.target.closest('[data-revoke]');
    if (button && await act('/security/sessions/' + encodeURIComponent(button.dataset.revoke) + '/revoke')) load();
  };
  function paintAudit() {
    const q = filter.value.trim().toLowerCase();
    const rows = audit.filter(a => !q || [a.time,stamp(a.time),a.event,a.ok ? 'ok' : 'failed',a.client,a.detail].join(' ').toLowerCase().includes(q));
    reconcile(auditBody, rows.length ? rows : [{key:':empty'}], a => a.key, () => document.createElement('tr'), (row,a) => setMarkup(row, a.key === ':empty'
      ? `<td colspan="5">${q ? 'No matching events. <button class="link-button" data-clear>Clear filter</button>' : 'No events recorded.'}</td>`
      : `<td>${esc(stamp(a.time))}</td><td class="mono">${esc(a.event)}</td><td><span class="badge s-${a.ok ? 'running' : 'exited'}">${a.ok ? 'Ok' : 'Failed'}</span></td><td class="mono">${esc(a.client)}</td><td>${esc(a.detail)}</td>`));
  }
  filter.oninput = paintAudit;
  auditBody.onclick = e => { if (e.target.closest('[data-clear]')) { filter.value = ''; paintAudit(); filter.focus(); } };
  function orderLocks() {
    if (!issues.isConnected || root.querySelector('input:focus, button:focus, summary:focus') || !form.hidden) return;
    const before = needsPriority ? $('#sec-sessions', root) : $('#sec-audit', root);
    if (issues.nextElementSibling !== before) before.before(issues);
  }
  issues.parentElement.addEventListener('focusout', () => setTimeout(orderLocks, 0));
  async function load(poll = false) {
    const seq = ++request;
    let d;
    try { d = await api('/security', { poll }); }
    catch (error) {
      if (issues.isConnected && seq === request) {
        setText($('#security-message', root), lastUpdate ? 'Refresh failed · last update ' + lastUpdate : error.message);
        $('#sec-retry', root).hidden = false;
      }
      return;
    }
    if (!issues.isConnected || seq !== request) return;
    lastUpdate = clock(Date.now());
    setText($('#security-message', root), '');
    $('#sec-retry', root).hidden = true;
    if (form.hidden) toggle.disabled = false;
    setText($('#account-name', root), d.user);
    setText($('#account-policy', root), `Idle timeout ${d.idleHours} h · Max session 7 days`);
    needsPriority = Boolean(d.globalLock || d.locks.length);
    orderLocks();
    setText($('#lock-state', root), d.globalLock ? 'All sign-ins suspended until ' + stamp(d.globalLock) : d.locks.length ? d.locks.length + ' locked out' : 'No active lockouts');
    setMarkup($('#lock-list', root), d.locks.map(l => `<p>${esc(l.client)} · Until ${esc(stamp(l.until))}</p>`).join(''));
    $('#unlock', root).hidden = !needsPriority;
    setText($('#only-session', root), d.sessions.length === 1 ? 'Only this session' : '');
    $('#revoke-others', root).hidden = d.sessions.length < 2;
    reconcile($('#session-rows',root), d.sessions.slice().sort((a,b) => Number(b.current)-Number(a.current)), a => a.id, a => {
      const row = document.createElement('tr'), ua = a.userAgent || '';
      const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
      const os = /Android|iPhone|iPad|Windows|Macintosh|Linux/.exec(ua)?.[0];
      row.innerHTML = `<td class="mono">${esc(a.client)}</td><td><details><summary>${esc([browser, os].filter(Boolean).join(' · ') || 'Browser details')}</summary><small>${esc(ua)}</small></details></td>
        <td>${esc(stamp(a.created))}</td><td class="age"></td><td>${a.current ? '<span class="badge s-running">This session</span>' : `<button class="btn small danger" data-revoke="${esc(a.id)}">Sign out</button>`}</td>`;
      return row;
    }, (row,a) => setText($('.age',row), since(a.lastSeen)+' ago'));
    const counts = new Map();
    audit = d.audit.slice().sort((a,b) => Date.parse(b.time)-Date.parse(a.time)).map(a => {
      const id = JSON.stringify([a.time,a.event,a.client,a.detail,a.ok]), n = counts.get(id) || 0;
      counts.set(id,n+1);
      return {...a,key:id+n};
    });
    paintAudit();
  }
  $('#sec-retry',root).onclick = () => load(false);
  every(15000, load);
};

// ------------------------------------------------------------------ palette

function jumpTo(hash) {
  if (location.hash === hash) navigate(hash);
  else location.hash = hash;
}

function commands() {
  const go = (label, hash) => ({ label, hint: 'Go to', run: () => { jumpTo(hash); } });
  const list = [
    go('Overview', '#overview'), go('Apps', '#apps'), go('Ports', '#ports'), go('Logs', '#logs'), go('Config', '#config'), go('Security', '#security'),
    { label: 'Apply routes', hint: 'Gateway', sep: true, run: () => gatewayAction('reload') },
    { label: 'Start enabled apps', hint: 'Gateway', run: () => gatewayAction('start-all') },
    { label: 'Restart live apps', hint: 'Gateway', run: () => gatewayAction('restart-all') },
    { label: 'Choose color theme', hint: 'Page', sep: true, run: openTheme },
    { label: 'Sign out', hint: 'Page', run: signOut },
    { label: 'Stop all apps', hint: 'Gateway', sep: true, danger: true, run: () => gatewayAction('stop-all') },
    { label: 'Shut down Gateway', hint: 'Gateway', danger: true, run: () => gatewayAction('shutdown') },
  ];
  for (const a of apps()) {
    const href = entryHref(a);
    list.push({ app: a, label: `${a.name} · Open details`, hint: a.state, run: () => jumpTo(`#apps/app/${encodeURIComponent(a.id)}`) });
    if (href) {
      list.push({ app: a, label: `${a.name}: open entry ↗`, hint: 'App', run: () => window.open(href, '_blank', 'noopener') });
    }
    if (a.launch) {
      if (isLive(a)) {
        list.push({ app: a, label: `${a.name}: restart`, hint: 'App', run: () => appAction(a.id, 'restart') });
        list.push({ app: a, label: `${a.name}: stop`, hint: 'App', danger: true, run: () => appAction(a.id, 'stop') });
      } else {
        list.push({ app: a, label: `${a.name}: start`, hint: 'App', run: () => appAction(a.id, 'start') });
      }
      list.push({ app: a, label: `${a.name}: logs`, hint: 'App', run: () => { jumpTo(`#logs/${encodeURIComponent(a.id)}`); } });
    }
    list.push({ app: a, label: `${a.name}: edit registration`, hint: 'App', run: () => { jumpTo(`#config/${encodeURIComponent(a.id)}`); } });
  }
  return list;
}

(() => {
  const dialog = $('#palette'), input = $('#palette-input'), listEl = $('#palette-list');
  let shown = [], index = 0;

  const paint = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const filtering = words.length > 0;
    shown = commands().filter(c => words.every(w => `${c.label} ${c.hint}`.toLowerCase().includes(w))).slice(0, 40);
    index = Math.min(index, Math.max(0, shown.length - 1));
    listEl.innerHTML = shown.map((c, i) => {
      const cls = [c.danger ? 'danger' : '', !filtering && c.sep && i > 0 ? 'sep' : ''].filter(Boolean).join(' ');
      return `<li role="option" id="cmd-${i}" aria-selected="false" data-i="${i}"${cls ? ` class="${cls}"` : ''}>${c.app ? appIcon(c.app) : ''}<span>${esc(c.label)}</span><small>${esc(c.hint)}</small></li>`;
    }).join('')
      || '<li class="none">No matching commands. Try a page or application name.</li>';
    select(index);
  };

  function select(next) {
    const previous = $('.on', listEl);
    if (previous) {
      previous.classList.remove('on');
      previous.setAttribute('aria-selected', 'false');
    }
    index = Math.max(0, Math.min(next, shown.length - 1));
    const row = listEl.children[index];
    if (!shown.length) { input.removeAttribute('aria-activedescendant'); return; }
    row.classList.add('on');
    row.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({block: 'nearest'});
  }

  const run = i => {
    const cmd = shown[i];
    if (!cmd) return;
    dialog.close();
    cmd.run();
  };

  const open = () => {
    if ($('#shell').hidden || dialog.open) return;
    input.value = '';
    index = 0;
    paint();
    dialog.showModal();
  };

  $('#open-palette').addEventListener('click', open);
  document.addEventListener('keydown', ev => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); open(); }
  });
  input.addEventListener('input', () => { index = 0; paint(); });
  input.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); select(index + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); select(index - 1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); run(index); }
  });
  listEl.addEventListener('click', ev => {
    const li = ev.target.closest('[data-i]');
    if (li) run(+li.dataset.i);
  });
  dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); });
})();

// ------------------------------------------------------------------ start


(async () => {
  try {
    const session = await api('/session');
    if (session.authenticated) showShell(session);
    else showLogin();
  } catch (e) {
    showLogin();
    $('#login-error').textContent = e.message;
  }
})();
