/* lnlib front end.
   Hash routing, no framework, no build. Every view is a function that fills
   #content; navigation is just a hash change. Deliberately plain: the fewer
   moving parts, the fewer ways for the shelf to go wrong.

   The reader is the one exception to "a view is just HTML": it takes over the
   whole window, owns the keyboard, and writes reading progress back to the
   server, so it keeps a small amount of state of its own in `book`. */
"use strict";

const $ = (s) => document.querySelector(s);
const el = { nav: $("#nav"), content: $("#content"), title: $("#title"),
             subtitle: $("#subtitle"), q: $("#q"), reader: $("#reader") };

const state = { overview: null, q: "", offset: 0, limit: 120, loading: false };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const encPath = (p) => String(p).split("/").map(encodeURIComponent).join("/");

async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || r.statusText);
  return body;
}
const post = (path, data) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data || {}),
});

/* ------------------------------------------------------------------ theme */
function initTheme() {
  const saved = localStorage.getItem("lnlib.theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  $("#btn-theme").onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = cur ? (cur === "dark" ? "light" : "dark") : (dark ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("lnlib.theme", next);
  };
}

/* -------------------------------------------------------------- sidebar */
function renderNav() {
  const ov = state.overview;
  if (!ov) return;
  const t = ov.totals || {};
  const byRoot = {};
  for (const s of ov.shelves) (byRoot[s.root_label] ||= []).push(s);

  let h = `<div class="grp">全体</div>`;
  h += navLink("#/reading", "読書中", state.readingCount ?? "");
  h += navLink("#/all", "すべて", t.n_items || 0);
  h += navLink("#/missing", "欠落巻", t.n_missing || 0);
  h += navLink("#/undated", "日付なし", t.n_undated || 0);

  for (const [root, shelves] of Object.entries(byRoot)) {
    h += `<div class="grp">${esc(root)}</div>`;
    for (const s of shelves) {
      const label = s.shelf || "（直下）";
      h += navLink(`#/shelf/${encodeURIComponent(root)}/${encodeURIComponent(s.shelf)}`,
                   label, s.n_series);
    }
  }
  el.nav.innerHTML = h;
  markActive();
}
function navLink(href, label, n) {
  return `<a href="${href}" data-href="${href}">${esc(label)}` +
         (n !== "" && n != null ? `<span class="n">${n}</span>` : "") + `</a>`;
}
function markActive() {
  const h = location.hash || "#/all";
  el.nav.querySelectorAll("a").forEach((a) =>
    a.classList.toggle("on", a.dataset.href === h));
}

/* --------------------------------------------------------------- shelves */
/* The shelf is a virtual grid.

   1062 series is not a lot of DOM, but every tile owns a cover, and the covers
   are full-size images pulled out of the books. Rendering them all meant
   hundreds of megabytes of decoded bitmap and a scroll that stopped dead every
   few rows. So only the rows crossing the viewport exist as elements; the rest
   is empty space of exactly the right height, and the card elements are
   recycled as they scroll out of view.

   Cell geometry is computed rather than left to `auto-fill`, because virtual
   scrolling needs to know where row N is before row N is rendered. The CSS
   still describes the look; this only decides positions. */
const CELL = { min: 132, gapX: 14, gapY: 16, cap: 52, overscan: 2 };

const grid = {
  params: null, total: 0, rows: [], pages: new Set(), inflight: new Set(),
  cols: 1, cellW: 0, cellH: 0, first: -1, last: -1,
  nodes: new Map(), pool: [], box: null, ticking: false, page: 120,
};

function gridMetrics() {
  // clientWidth includes .content's padding, which the cards must not sit in.
  const cs = getComputedStyle(el.content);
  const width = el.content.clientWidth
              - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const cols = Math.max(1, Math.floor((width + CELL.gapX) / (CELL.min + CELL.gapX)));
  const cellW = Math.floor((width - CELL.gapX * (cols - 1)) / cols);
  const coverH = Math.round(cellW * 7 / 5);      // .thumb keeps a 5:7 aspect
  return { cols, cellW, cellH: coverH + 6 + CELL.cap };
}

function makeCard() {
  const n = document.createElement("div");
  n.className = "card vcard";
  n.innerHTML = `<div class="thumb"><img alt="" decoding="async">
      <div class="none">表紙なし</div><span class="badge"></span></div>
    <div class="cap"><div class="t"></div><div class="a"></div></div>`;
  n.__img = n.querySelector("img");
  n.__none = n.querySelector(".none");
  n.__badge = n.querySelector(".badge");
  n.__t = n.querySelector(".t");
  n.__a = n.querySelector(".a");
  n.__img.addEventListener("error", () => showCover(n, false));
  n.__img.addEventListener("load", () => showCover(n, true));
  return n;
}

function fillCard(n, i) {
  const s = grid.rows[i];
  n.style.transform = `translate(${(i % grid.cols) * (grid.cellW + CELL.gapX)}px,` +
                      `${Math.floor(i / grid.cols) * (grid.cellH + CELL.gapY)}px)`;
  n.style.width = grid.cellW + "px";
  if (n.__index === i && n.__filled) return;
  n.__index = i;

  if (!s) {                                   // page still loading
    n.__filled = false;
    n.dataset.id = "";
    n.classList.add("skel");
    n.__t.textContent = "";
    n.__a.textContent = "";
    n.__badge.style.display = "none";
    n.__img.removeAttribute("src");
    n.__img.style.visibility = "hidden";
    n.__none.style.display = "none";
    return;
  }
  n.__filled = true;
  n.classList.remove("skel");
  n.dataset.id = s.id;
  n.__t.textContent = s.title;
  n.__a.textContent = `${s.author || "作者不明"} · ${s.n_items}冊`;
  if (s.n_missing) {
    n.__badge.textContent = `欠 ${s.n_missing}`;
    n.__badge.style.display = "";
  } else {
    n.__badge.style.display = "none";
  }
  paintCover(n, s);
}

/** true = the image is showing, false = fall back to the 表紙なし placeholder. */
function showCover(n, ok) {
  n.__img.style.visibility = ok ? "" : "hidden";
  n.__none.style.display = ok ? "none" : "";
}

function paintCover(n, s) {
  const img = n.__img;
  const id = s.cover_item_id;
  img.removeAttribute("src");
  // cover_state already says whether a cover exists, so a tile without one
  // never spends a request (and a 404) finding that out.
  if (!id || s.cover_state !== "ok") {
    showCover(n, false);
    return;
  }
  if (!Thumbs.supported()) {
    showCover(n, true);
    img.src = MOUNT + "/cover/" + id;
    return;
  }
  const ready = Thumbs.peek(id);
  if (ready) {                                 // already built: no flicker
    showCover(n, true);
    img.src = ready;
    return;
  }
  showCover(n, false);
  n.__none.style.display = "none";             // building: show neither yet
  const mine = n.__index;
  Thumbs.get(id, () => n.__index === mine && grid.nodes.get(mine) === n)
    .then((url) => {
      if (n.__index !== mine || grid.nodes.get(mine) !== n) return;
      showCover(n, true);
      img.src = url;
    })
    .catch((e) => {
      if (n.__index !== mine || grid.nodes.get(mine) !== n) return;
      if (String(e.message) !== "dropped") showCover(n, false);
    });
}

function ensurePages(from, to) {
  for (let p = Math.floor(from / grid.page); p <= Math.floor(to / grid.page); p++) {
    if (grid.pages.has(p) || grid.inflight.has(p)) continue;
    grid.inflight.add(p);
    const qs = new URLSearchParams();
    const params = grid.params;
    if (params.root) qs.set("root", params.root);
    if (params.shelf != null) qs.set("shelf", params.shelf);
    if (params.only) qs.set("only", params.only);
    if (state.q) qs.set("q", state.q);
    qs.set("offset", p * grid.page);
    qs.set("limit", grid.page);
    const token = grid.token;
    api(MOUNT + "/api/series?" + qs).then((data) => {
      if (token !== grid.token) return;         // the view changed under us
      grid.inflight.delete(p);
      grid.pages.add(p);
      data.series.forEach((s, k) => { grid.rows[p * grid.page + k] = s; });
      // The visible range has not moved, so renderGrid would otherwise decide
      // there is nothing to do and leave these rows as skeletons.
      grid.clean = false;
      renderGrid();
    }).catch(() => { grid.inflight.delete(p); });
  }
}

function renderGrid() {
  if (!grid.box) return;
  const main = $("#main");
  const top = main.scrollTop - grid.box.offsetTop;
  const rowH = grid.cellH + CELL.gapY;
  const firstRow = Math.max(0, Math.floor(top / rowH) - CELL.overscan);
  const lastRow = Math.floor((top + main.clientHeight) / rowH) + CELL.overscan;
  const first = Math.max(0, firstRow * grid.cols);
  const last = Math.min(grid.total - 1, (lastRow + 1) * grid.cols - 1);
  if (first === grid.first && last === grid.last && grid.clean) return;
  grid.first = first; grid.last = last; grid.clean = true;

  for (const [i, node] of grid.nodes) {
    if (i < first || i > last) {
      grid.nodes.delete(i);
      node.__index = -1;
      node.remove();
      grid.pool.push(node);
    }
  }
  const frag = document.createDocumentFragment();
  for (let i = first; i <= last; i++) {
    let node = grid.nodes.get(i);
    if (!node) {
      node = grid.pool.pop() || makeCard();
      node.__index = -1;
      grid.nodes.set(i, node);
      frag.appendChild(node);
    }
    fillCard(node, i);
  }
  if (frag.childNodes.length) grid.box.appendChild(frag);

  ensurePages(first, last);
  if (Thumbs.supported()) {
    const hot = new Set();
    for (let i = first; i <= last; i++) {
      const s = grid.rows[i];
      if (s && s.cover_item_id && s.cover_state === "ok") hot.add(s.cover_item_id);
    }
    Thumbs.prioritise(hot);
  }
}

function onGridScroll() {
  if (grid.ticking) return;
  grid.ticking = true;
  requestAnimationFrame(() => { grid.ticking = false; renderGrid(); });
}

function layoutGrid() {
  if (!grid.box) return;
  const m = gridMetrics();
  const changed = m.cols !== grid.cols || m.cellW !== grid.cellW;
  grid.cols = m.cols; grid.cellW = m.cellW; grid.cellH = m.cellH;
  const rows = Math.ceil(grid.total / grid.cols);
  grid.box.style.height = rows * grid.cellH + Math.max(0, rows - 1) * CELL.gapY + "px";
  if (changed) {
    for (const node of grid.nodes.values()) node.__index = -1;   // positions moved
    grid.clean = false;
  }
  renderGrid();
}

function teardownGrid() {
  $("#main").removeEventListener("scroll", onGridScroll);
  grid.box = null;
  grid.nodes.clear();
  grid.pool.length = 0;
}

async function viewSeries(params) {
  teardownGrid();
  grid.token = (grid.token || 0) + 1;
  grid.params = params;
  grid.rows = []; grid.pages.clear(); grid.inflight.clear();
  grid.first = grid.last = -1; grid.clean = false;

  const qs = new URLSearchParams();
  if (params.root) qs.set("root", params.root);
  if (params.shelf != null) qs.set("shelf", params.shelf);
  if (params.only) qs.set("only", params.only);
  if (state.q) qs.set("q", state.q);
  qs.set("offset", 0);
  qs.set("limit", grid.page);
  const token = grid.token;
  const data = await api(MOUNT + "/api/series?" + qs);
  if (token !== grid.token) return;

  grid.total = data.total;
  grid.pages.add(0);
  data.series.forEach((s, k) => { grid.rows[k] = s; });

  el.subtitle.textContent =
    `${data.total} シリーズ` + (state.q ? `（「${state.q}」で絞り込み）` : "");
  if (!data.total) {
    el.content.innerHTML = `<div class="empty">該当する作品がありません</div>`;
    return;
  }
  el.content.innerHTML = `<div class="vgrid" id="vgrid"></div>`;
  grid.box = $("#vgrid");
  $("#main").scrollTop = 0;
  $("#main").addEventListener("scroll", onGridScroll, { passive: true });
  layoutGrid();
}

/** A cover for the non-virtual views. The src is filled in by hydrateCovers so
    these tiles go through the same thumbnail cache the shelf uses. */
function thumb(s) {
  const badge = s.n_missing ? `<span class="badge">欠 ${s.n_missing}</span>` : "";
  const img = s.cover_item_id
    ? `<img decoding="async" alt="" data-cover="${s.cover_item_id}"
          onerror="this.style.visibility='hidden'">`
    : `<div class="none">表紙なし</div>`;
  return `<div class="thumb">${img}${badge}</div>`;
}

function hydrateCovers(root) {
  root.querySelectorAll("img[data-cover]").forEach((img) => {
    const id = +img.dataset.cover;
    if (!Thumbs.supported()) { img.src = MOUNT + "/cover/" + id; return; }
    const ready = Thumbs.peek(id);
    if (ready) { img.src = ready; return; }
    Thumbs.get(id, () => img.isConnected)
      .then((url) => { if (img.isConnected) img.src = url; })
      .catch(() => { img.style.visibility = "hidden"; });
  });
}

async function viewDetail(id) {
  const d = await api(MOUNT + "/api/series/" + id);
  const s = d.series;
  el.title.textContent = s.title;
  el.subtitle.textContent =
    `${s.author || "作者不明"} · ${s.root_label}${s.shelf ? " / " + s.shelf : ""}`;

  const cover = d.items.find((i) => !i.is_missing);
  const chips = [`<span class="chip">${s.n_items} 冊</span>`];
  if (s.n_missing) chips.push(`<span class="chip miss">欠落 ${s.n_missing}</span>`);
  if (s.n_undated) chips.push(`<span class="chip">日付なし ${s.n_undated}</span>`);
  if (s.first_date)
    chips.push(`<span class="chip">${s.first_date} 〜 ${s.last_date || ""}</span>`);

  const rows = d.items.map((i) => {
    const pct = Math.round((i.read_percent || 0) * 100);
    const read = i.read_finished ? `<span class="chip ok">読了</span>`
               : pct ? `<span class="chip">${pct}%</span>` : "";
    const action = i.is_missing
      ? `<span class="dim">未所持</span>`
      : `<button class="sm pri" data-read="${i.id}">${pct ? "続き" : "読む"}</button>`;
    return `<tr class="${i.is_missing ? "missing" : ""}">
      <td class="dt">${i.date || "—"}</td>
      <td class="vv">${i.volume ? "第" + i.volume + "巻" : ""}</td>
      <td><div class="name">${esc(i.title)}${
            i.is_extra ? ' <span class="chip">特典</span>' : ""} ${read}</div>
          <div class="fn">${esc(i.filename)}</div></td>
      <td class="act">${action}</td>
    </tr>`;
  }).join("");

  el.content.innerHTML = `
    <div class="detail-head">
      <div style="width:140px">${
        cover ? thumb({ cover_item_id: cover.id, n_missing: 0 }) : ""}</div>
      <div class="detail-meta">
        <h3 class="mincho">${esc(s.title)}</h3>
        <div style="color:var(--ink-2)">${esc(s.author || "作者不明")}</div>
        <div class="chips">${chips.join("")}</div>
        <div class="path">${esc(s.path)}</div>
        <div class="actions">
          <button class="sm" id="reveal">フォルダを開く</button>
        </div>
      </div>
    </div>
    <table class="vols"><thead><tr>
      <th>発売日</th><th>巻</th><th>タイトル</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;

  hydrateCovers(el.content);
  $("#reveal").onclick = () => post(MOUNT + "/api/reveal", { path: s.path }).catch(showErr);
  el.content.querySelectorAll("[data-read]").forEach((b) =>
    b.onclick = () => { location.hash = "#/read/" + b.dataset.read; });
}

async function viewMissing() {
  const d = await api(MOUNT + "/api/missing");
  el.subtitle.textContent = `${d.count} 巻 / ${d.groups.length} シリーズ`;
  if (!d.count) {
    el.content.innerHTML = `<div class="empty">欠落巻はありません</div>`;
    return;
  }
  const q = state.q.toLowerCase();
  const groups = q
    ? d.groups.filter((g) => (g.title + " " + (g.author || "")).toLowerCase().includes(q))
    : d.groups;
  el.content.innerHTML = groups.map((g) => `
    <div style="margin-bottom:18px">
      <div style="font-weight:600;cursor:pointer" data-goto="${g.series_id}">
        ${esc(g.title)}
        <span style="color:var(--ink-3);font-weight:400"> · ${esc(g.author || "作者不明")}
          · ${esc(g.shelf || g.root_label)}</span>
      </div>
      <table class="vols"><tbody>${g.items.map((i) => `
        <tr class="missing"><td class="dt">${i.date || "—"}</td>
        <td class="vv">${i.volume ? "第" + i.volume + "巻" : ""}</td>
        <td class="name">${esc(i.title)}</td></tr>`).join("")}</tbody></table>
    </div>`).join("");
  el.content.querySelectorAll("[data-goto]").forEach((n) =>
    n.onclick = () => { location.hash = "#/series/" + n.dataset.goto; });
}

async function viewReading() {
  const d = await api(MOUNT + "/api/reading");
  state.readingCount = d.items.length;
  renderNav();
  el.subtitle.textContent = `${d.items.length} 冊`;
  if (!d.items.length) {
    el.content.innerHTML =
      `<div class="empty">まだ読みかけの本はありません</div>`;
    return;
  }
  el.content.innerHTML = `<div class="grid">` + d.items.map((r) => {
    const pct = Math.round((r.percent || 0) * 100);
    return `<div class="card" data-read="${r.item_id}">
      <div class="thumb">
        <img decoding="async" alt="" data-cover="${r.item_id}"
             onerror="this.style.visibility='hidden'">
        <span class="badge">${r.finished ? "読了" : pct + "%"}</span>
      </div>
      <div class="cap">
        <div class="t">${esc(r.title)}</div>
        <div class="a">${esc(r.series_title)}</div>
        <div class="bar"><i style="width:${r.finished ? 100 : pct}%"></i></div>
      </div>
    </div>`;
  }).join("") + `</div>`;
  hydrateCovers(el.content);
  el.content.querySelectorAll("[data-read]").forEach((n) =>
    n.onclick = () => { location.hash = "#/read/" + n.dataset.read; });
}

/* ================================================================ reader */
const book = {
  id: null, data: null, kind: null, index: 0, dir: "ltr",
  scale: +(localStorage.getItem("lnlib.scale") || 100),
  mode: localStorage.getItem("lnlib.rmode") || "paper",
  dirty: false, timer: null, restore: 0, loading: false,
};

const READ_MODES = { paper: "紙", light: "白", sepia: "セピア", dark: "暗" };

function readerShell(d) {
  const it = d.item;
  const total = d.kind === "epub" ? d.sections.length
              : d.kind === "images" ? d.pages.length : 1;
  return `
    <div class="rbar">
      <button class="sm" id="r-back" title="棚に戻る">← 棚</button>
      <div class="rtitle">
        <b>${esc(it.title)}</b>
        <span>${esc(it.series_title)}${it.author ? " · " + esc(it.author) : ""}</span>
      </div>
      ${d.kind === "epub" ? `<button class="sm" id="r-toc">目次</button>` : ""}
      ${d.kind !== "pdf" ? `
        <button class="sm" id="r-mode" title="表示">${READ_MODES[book.mode]}</button>` : ""}
      ${d.kind === "epub" ? `
        <button class="sm" id="r-smaller" title="文字を小さく">A−</button>
        <button class="sm" id="r-bigger" title="文字を大きく">A＋</button>` : ""}
      <button class="sm" id="r-open" title="外部アプリで開く">外部</button>
    </div>
    <div class="rstage" id="r-stage"></div>
    <div class="rfoot">
      <button class="sm" id="r-prev">◀</button>
      <div class="rprog"><i id="r-bar"></i></div>
      <span class="rpos" id="r-pos">1 / ${total}</span>
      <button class="sm" id="r-next">▶</button>
    </div>
    <aside class="rtoc" id="r-tocpane" hidden></aside>`;
}

async function viewReader(id) {
  await saveProgress(true);
  const d = await api(MOUNT + "/api/book/" + id);
  book.id = id; book.data = d; book.kind = d.kind;
  book.dir = (d.meta && d.meta.direction) || "ltr";
  book.dirty = false;

  document.body.classList.add("reading");
  el.reader.innerHTML = readerShell(d);
  el.reader.dataset.mode = book.mode;
  el.reader.dataset.dir = book.dir;

  const stage = $("#r-stage");
  if (["missing", "gone", "external", "error"].includes(d.kind)) {
    stage.innerHTML = `<div class="empty">
      ${esc(d.detail || "この本は開けません")}<br><br>
      <span class="dim">${esc(d.item.filename)}</span></div>`;
  }

  $("#r-back").onclick = () => leaveReader(d.item.series_id);
  $("#r-open").onclick = () => post(MOUNT + "/api/open", { path: d.item.path }).catch(showErr);
  const prev = $("#r-prev"), next = $("#r-next");
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  if (book.dir === "rtl") {                 // ◀ moves forward in a rtl book
    prev.textContent = "▶"; next.textContent = "◀";
    $(".rfoot").classList.add("rtl");
  }

  const mode = $("#r-mode");
  if (mode) mode.onclick = () => {
    const keys = Object.keys(READ_MODES);
    book.mode = keys[(keys.indexOf(book.mode) + 1) % keys.length];
    localStorage.setItem("lnlib.rmode", book.mode);
    mode.textContent = READ_MODES[book.mode];
    el.reader.dataset.mode = book.mode;
    applyFrameStyle();
  };
  const bigger = $("#r-bigger"), smaller = $("#r-smaller");
  if (bigger) bigger.onclick = () => setScale(book.scale + 10);
  if (smaller) smaller.onclick = () => setScale(book.scale - 10);
  const toc = $("#r-toc");
  if (toc) toc.onclick = () => {
    const pane = $("#r-tocpane");
    pane.hidden = !pane.hidden;
  };

  const p = d.progress;
  if (d.kind === "epub") {
    buildToc(d);
    const at = p && p.locator
      ? d.sections.findIndex((s) => s.href === p.locator) : -1;
    book.restore = p ? p.position || 0 : 0;
    openSection(at >= 0 ? at : 0);
  } else if (d.kind === "images") {
    const at = p && p.locator ? parseInt(p.locator, 10) : 0;
    openPage(Number.isFinite(at) && at < d.pages.length ? at : 0);
  } else if (d.kind === "pdf") {
    stage.innerHTML = `<iframe id="r-frame" src="${MOUNT}/book/${id}/raw"></iframe>`;
    $("#r-pos").textContent = "PDF";
    saveProgress();
  }
}

function setScale(v) {
  book.scale = Math.max(60, Math.min(240, v));
  localStorage.setItem("lnlib.scale", book.scale);
  applyFrameStyle();
}

function buildToc(d) {
  const pane = $("#r-tocpane");
  if (!d.toc.length) {
    pane.innerHTML = `<div class="dim" style="padding:12px">目次がありません</div>`;
    return;
  }
  pane.innerHTML = d.toc.map((t) => {
    const i = d.sections.findIndex((s) => s.href === t.href);
    return `<a data-sec="${i}" style="padding-inline-start:${8 + t.depth * 14}px"
              class="${i < 0 ? "dim" : ""}">${esc(t.label)}</a>`;
  }).join("");
  pane.querySelectorAll("[data-sec]").forEach((a) => a.onclick = () => {
    const i = +a.dataset.sec;
    if (i >= 0) { book.restore = 0; openSection(i); pane.hidden = true; }
  });
}

/* ---- epub: one spine section per iframe, served as a virtual directory --- */
function openSection(i) {
  const d = book.data;
  i = Math.max(0, Math.min(d.sections.length - 1, i));
  book.index = i;
  book.loading = true;
  const href = d.sections[i].href;
  $("#r-stage").innerHTML =
    `<iframe id="r-frame" src="${MOUNT}/book/${book.id}/f/${encPath(href)}"></iframe>`;
  const f = $("#r-frame");
  f.onload = () => onFrameLoad(f);
  updateFoot(i, d.sections.length, d.sections[i].title);
}

function onFrameLoad(f) {
  let doc;
  try { doc = f.contentDocument; } catch { return; }
  if (!doc) return;

  // A malformed XHTML file renders as a parser error. Reload it through the
  // forgiving HTML parser instead of showing the user a stack of XML complaints.
  if (doc.querySelector("parsererror") && !f.src.includes("as=html")) {
    f.src += (f.src.includes("?") ? "&" : "?") + "as=html";
    return;
  }
  book.loading = false;
  applyFrameStyle();
  if (book.restore > 0) {
    scrollFraction(book.restore);
    book.restore = 0;
  }
  doc.addEventListener("keydown", onKey);
  doc.addEventListener("scroll", markDirty, { passive: true });
  doc.defaultView.addEventListener("scroll", markDirty, { passive: true });
  doc.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const raw = a.getAttribute("href") || "";
    if (/^[a-z]+:/i.test(raw) && !raw.startsWith("http")) return;
    if (raw.startsWith("http")) { e.preventDefault(); return; }   // stay offline
  });
  markDirty();
}

const FRAME_STYLE_ID = "lnlib-reader-style";
function applyFrameStyle() {
  const f = $("#r-frame");
  if (!f || book.kind !== "epub") return;
  let doc;
  try { doc = f.contentDocument; } catch { return; }
  if (!doc || !doc.documentElement) return;
  const paint = {
    paper: ["#f4efe6", "#241f1a"], light: ["#ffffff", "#16181d"],
    sepia: ["#efe2c8", "#3b2f21"], dark: ["#14161a", "#c9cdd4"],
  }[book.mode] || ["#f4efe6", "#241f1a"];
  const css = `html{font-size:${book.scale}% !important;` +
              `background:${paint[0]} !important;color:${paint[1]} !important;}` +
              `body{background:transparent !important;color:inherit !important;}` +
              `img,image,svg{max-width:100% !important;height:auto !important;}` +
              `a{color:inherit !important;}`;
  let tag = doc.getElementById(FRAME_STYLE_ID);
  if (!tag) {
    tag = doc.createElement("style");
    tag.id = FRAME_STYLE_ID;
    (doc.head || doc.documentElement).appendChild(tag);
  }
  tag.textContent = css;
}

/* ---- images: cbz and scanned folders, one page at a time ---------------- */
function openPage(i) {
  const d = book.data;
  i = Math.max(0, Math.min(d.pages.length - 1, i));
  book.index = i;
  const stage = $("#r-stage");
  stage.innerHTML =
    `<div class="rpage"><img id="r-img" alt=""
        src="${MOUNT}/book/${book.id}/f/${encPath(d.pages[i])}"></div>`;
  // Tapping the side of the page turns it, the way every manga reader does:
  // in a rtl book the left half is the next page.
  stage.onclick = (e) => {
    const left = e.clientX - stage.getBoundingClientRect().left
                 < stage.clientWidth / 2;
    step(left === (book.dir === "rtl") ? 1 : -1);
  };
  updateFoot(i, d.pages.length, d.pages[i].split("/").pop());
  markDirty();
}

/* ---- shared navigation -------------------------------------------------- */
function count() {
  const d = book.data;
  return d.kind === "epub" ? d.sections.length
       : d.kind === "images" ? d.pages.length : 1;
}

function step(delta) {
  const d = book.data;
  if (!d) return;
  // Page turns pressed while the next section is still arriving would otherwise
  // fall straight through it -- an empty frame has nothing left to scroll.
  if (book.loading) return;
  if (d.kind === "epub") {
    if (delta > 0 && scrollStep(1)) return;      // scroll on within the section
    if (delta < 0 && scrollStep(-1)) return;
    if (book.index + delta < 0 || book.index + delta >= d.sections.length) return;
    saveProgress(true);
    book.restore = delta < 0 ? 1 : 0;            // entering backwards: land at the end
    openSection(book.index + delta);
  } else if (d.kind === "images") {
    if (book.index + delta < 0 || book.index + delta >= d.pages.length) return;
    openPage(book.index + delta);
  }
}

/** The scrollable geometry of the current section.

   A Japanese novel is typeset `writing-mode: vertical-rl`, which the browser
   lays out as one very wide page scrolling towards *negative* x. Reading the
   writing mode is the only reliable way to know which way "forward" is:
   scrollLeft is 0 at the start of both conventions. */
function frameBox() {
  const f = $("#r-frame");
  if (!f) return null;
  let win;
  try { win = f.contentWindow; } catch { return null; }
  const doc = win && win.document;
  const se = doc && doc.scrollingElement;
  if (!se) return null;
  const cs = win.getComputedStyle(doc.documentElement);
  const back = String(cs.writingMode).startsWith("vertical-rl")
            || cs.writingMode === "tb-rl" || cs.direction === "rtl";
  return { se, sign: back ? -1 : 1,
           v: se.scrollHeight - se.clientHeight,
           h: se.scrollWidth - se.clientWidth };
}

/** Scroll the frame by one screen; returns false when there is no room left. */
function scrollStep(delta) {
  const b = frameBox();
  if (!b) return false;
  if (b.v > 4) {
    const before = b.se.scrollTop;
    b.se.scrollTop = before + delta * (b.se.clientHeight - 40);
    return Math.abs(b.se.scrollTop - before) > 1;
  }
  if (b.h <= 4) return false;
  const before = b.se.scrollLeft;
  b.se.scrollLeft = before + b.sign * delta * (b.se.clientWidth - 40);
  return Math.abs(b.se.scrollLeft - before) > 1;
}

function scrollFraction(frac) {
  const b = frameBox();
  if (!b) return;
  if (b.v > 4) b.se.scrollTop = b.v * frac;
  else if (b.h > 4) b.se.scrollLeft = b.sign * b.h * frac;
}

function readFraction() {
  if (book.kind !== "epub") return 0;
  const b = frameBox();
  if (!b) return 0;
  if (b.v > 4) return Math.min(1, Math.max(0, b.se.scrollTop / b.v));
  if (b.h > 4) return Math.min(1, Math.abs(b.se.scrollLeft) / b.h);
  return 0;
}

function updateFoot(i, total, label) {
  const pos = $("#r-pos"), bar = $("#r-bar");
  if (pos) pos.textContent = `${i + 1} / ${total}` + (label ? ` · ${label}` : "");
  if (bar) bar.style.width = (100 * (i + 1) / total) + "%";
}

function onKey(e) {
  if (!document.body.classList.contains("reading")) return;
  const k = e.key;
  if (k === "Escape") { leaveReader(); return; }
  const rtl = book.dir === "rtl";
  if (k === "ArrowRight") { e.preventDefault(); step(rtl ? -1 : 1); }
  else if (k === "ArrowLeft") { e.preventDefault(); step(rtl ? 1 : -1); }
  else if (k === "PageDown" || k === " " || k === "ArrowDown") { e.preventDefault(); step(1); }
  else if (k === "PageUp" || k === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (k === "+" || k === "=") setScale(book.scale + 10);
  else if (k === "-") setScale(book.scale - 10);
}

function markDirty() {
  book.dirty = true;
  clearTimeout(book.timer);
  book.timer = setTimeout(() => saveProgress(), 2500);
}

async function saveProgress(force) {
  if (!book.id || !book.data) return;
  if (!book.dirty && !force) return;
  const d = book.data;
  if (!["epub", "images", "pdf"].includes(d.kind)) return;
  book.dirty = false;
  const total = count();
  const frac = d.kind === "epub" ? readFraction() : 0;
  const percent = Math.min(1, (book.index + (d.kind === "epub" ? frac : 1)) / total);
  const locator = d.kind === "epub" ? d.sections[book.index].href
                : d.kind === "images" ? String(book.index) : "pdf";
  try {
    await post(MOUNT + "/api/progress", {
      item_id: book.id, locator, position: frac, percent,
      finished: percent >= 0.995,
    });
  } catch { /* reading must not stop because a write failed */ }
}

function leaveReader(seriesId) {
  saveProgress(true);
  const back = seriesId || (book.data && book.data.item.series_id);
  location.hash = back ? "#/series/" + back : "#/reading";
}

function closeReader() {
  if (!document.body.classList.contains("reading")) return;
  saveProgress(true);
  clearTimeout(book.timer);
  document.body.classList.remove("reading");
  el.reader.innerHTML = "";
  book.id = null; book.data = null;
}

/* ------------------------------------------------------------- routing */
function showErr(e) {
  const box = document.body.classList.contains("reading") ? el.reader : el.content;
  box.insertAdjacentHTML("afterbegin", `<div class="err">${esc(e.message || e)}</div>`);
}

async function refreshOverview() {
  state.overview = await api(MOUNT + "/api/overview");
  const scan = state.overview.last_scan;
  if (scan && scan.at) Thumbs.checkGeneration(scan.at);
  try {
    const d = await api(MOUNT + "/api/reading?limit=200");
    state.readingCount = d.items.filter((r) => !r.finished).length;
  } catch { /* the shelf still works without it */ }
  renderNav();
}

async function route() {
  if (state.loading) return;
  state.loading = true;
  const h = (location.hash || "#/all").slice(2);
  const parts = h.split("/").map(decodeURIComponent);

  if (parts[0] !== "read") closeReader();
  if (parts[0] !== "shelf" && parts[0] !== "all" && parts[0] !== "undated" && h !== "")
    teardownGrid();
  markActive();

  try {
    if (parts[0] === "read") {
      await viewReader(+parts[1]);
      return;
    }
    el.content.innerHTML = `<div class="empty">読み込み中…</div>`;
    el.q.style.display = "";
    if (parts[0] === "series") {
      el.q.style.display = "none";
      await viewDetail(+parts[1]);
    } else if (parts[0] === "reading") {
      el.title.textContent = "読書中";
      el.q.style.display = "none";
      await viewReading();
    } else if (parts[0] === "missing") {
      el.title.textContent = "欠落巻";
      await viewMissing();
    } else if (parts[0] === "shelf") {
      el.title.textContent = parts[2] || parts[1];
      state.offset = 0;
      await viewSeries({ root: parts[1], shelf: parts[2] });
    } else if (parts[0] === "undated") {
      el.title.textContent = "日付なし";
      state.offset = 0;
      await viewSeries({ only: "undated" });
    } else {
      el.title.textContent = "すべて";
      state.offset = 0;
      await viewSeries({});
    }
  } catch (e) {
    if (!document.body.classList.contains("reading")) el.content.innerHTML = "";
    showErr(e);
  } finally {
    state.loading = false;
  }
}

el.content.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card && card.dataset.id) location.hash = "#/series/" + card.dataset.id;
});

let qTimer;
el.q.addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = el.q.value.trim(); state.offset = 0; route(); }, 220);
});

$("#btn-scan").onclick = async () => {
  const b = $("#btn-scan");
  b.disabled = true; b.textContent = "スキャン中…";
  try {
    const r = await post(MOUNT + "/api/scan");
    await refreshOverview();
    await route();
    b.textContent = `${r.items} 件`;
  } catch (e) { showErr(e); }
  setTimeout(() => { b.disabled = false; b.textContent = "再スキャン"; }, 1500);
};
$("#btn-menu").onclick = () => $("#side").classList.toggle("open");
el.nav.addEventListener("click", () => $("#side").classList.remove("open"));

document.addEventListener("keydown", onKey);
window.addEventListener("beforeunload", () => saveProgress(true));
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutGrid, 120);
});
window.addEventListener("hashchange", route);
initTheme();
refreshOverview().then(route).catch((e) => { el.content.innerHTML = ""; showErr(e); });
