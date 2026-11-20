# Renders the landing page served at the gateway root.
#
# A static file (Caddy file_server), so there is no extra process to supervise.
# Public cards come straight from the routed apps, while local-only apps are
# never baked into the public HTML — they are fetched on loopback hosts from
# /admin/api/local-apps after server-side host/client verification.
#
function New-LandingPage {
    <# Render $WebRoot\index.html. Returns its path. #>
    param(
        [hashtable[]] $Apps,
        [string]      $WebRoot,
        [string]      $Title        = 'Gateway',
        [string]      $Tagline      = '',
        [string]      $FallbackIcon = '*',
        # Link to the admin page in the header; empty when it is off.
        [string]      $AdminPath    = ''
    )

    $enc = { param($text) [Net.WebUtility]::HtmlEncode([string]$text) }

    # Routed apps, linked through the gateway. A hidden one is reached by a direct
    # link rather than by browsing.
    $listed = @($Apps | Where-Object { $_.BasePath -and $_.Routes.Kind -ne 'none' -and -not $_.Hidden })

    $cards = foreach ($app in $listed) {
        $icon = if ($app.Icon) { & $enc $app.Icon } else { & $enc $FallbackIcon }
        if ($app.IconFile) {
            try {
                $asset = Read-AppIcon -Root $app.Root -File $app.IconFile
                $name = "$($app.Id).$($asset.Hash)$($asset.Extension)"
                $assets = Join-Path $WebRoot '_gateway/icons'
                New-Item -ItemType Directory -Path $assets -Force | Out-Null
                [IO.File]::WriteAllBytes((Join-Path $assets $name), $asset.Bytes)
                $icon = '<img src="_gateway/icons/' + $name + '" width="24" height="24" alt="">'
            } catch { Write-Warning "App '$($app.Id)': icon unavailable. Using the fallback glyph." }
        }

        # No trailing slash: an app under a prefix serves the bare form as
        # canonical and 30x-es the slashed one to it. Linking at the canonical form
        # skips a redirect hop.
        @"
      <div class="card" data-app-id="$(& $enc $app.Id)">
        <span class="icon" aria-hidden="true">$icon</span>
        <span class="body">
          <span class="title-row"><span class="name">$(& $enc $app.Name)</span><span class="status-slot" hidden></span></span>
          <span class="desc">$(& $enc $app.Description)</span>
        </span>
        <code class="address">$(& $enc $app.BasePath)</code>
        <a class="open" href="$(& $enc $app.BasePath)" aria-label="Open $(& $enc $app.Name)">Open ↗</a>
      </div>
"@
    }

    # Local-only apps are never embedded in the public static HTML. On loopback
    # hosts, the page requests them from the admin API, which enforces loopback
    # access server-side and attaches file icons only for signed-in sessions.
    $localSection = if ($AdminPath) {
        @"
    <section id="local" data-admin="$(& $enc $AdminPath)" hidden>
      <h2>On this machine <span class="count" id="local-count"></span></h2>
      <div class="grid" id="local-grid"></div>
    </section>
"@
    } else { '' }

    $admin = if ($AdminPath) { '<a class="control" href="' + (& $enc $AdminPath) + '">Admin</a>' } else { '' }

    $html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$(& $enc $Title)</title>
<link rel="icon" href="favicon.svg?v=2" type="image/svg+xml">
<script src="theme.js?v=2"></script>
<link rel="stylesheet" href="theme.css?v=3">
<style>
  :root {
    color-scheme: light;
    --bg: #f1f4f9; --fg: #182638; --muted: #506478; --card: #ffffff;
    --raised: #f6f8fb; --hover: #edf2f8; --line: #d4dde8; --line-soft: #e5ebf3;
    --accent: #215da6; --selected: #dfebfb;
    --ok: #177048; --warn: #8f5407; --bad: #b4372f; --busy: #166c84;
    --scroll-thumb: rgb(24 38 56 / .20); --scroll-thumb-hover: rgb(24 38 56 / .36);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #101720; --fg: #e5ecf4; --muted: #a6b6c7; --card: #18222d;
      --raised: #141d27; --hover: #22303f; --line: #2d3c4c; --line-soft: #222f3d;
      --accent: #8ebeff; --selected: #203956;
      --ok: #4bcf8d; --warn: #edb04c; --bad: #f47a70; --busy: #5ab8ee;
      --scroll-thumb: rgb(176 191 206 / .22); --scroll-thumb-hover: rgb(176 191 206 / .38);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #101720; --fg: #e5ecf4; --muted: #a6b6c7; --card: #18222d;
    --raised: #141d27; --hover: #22303f; --line: #2d3c4c; --line-soft: #222f3d;
    --accent: #8ebeff; --selected: #203956;
    --ok: #4bcf8d; --warn: #edb04c; --bad: #f47a70; --busy: #5ab8ee;
    --scroll-thumb: rgb(176 191 206 / .22); --scroll-thumb-hover: rgb(176 191 206 / .38);
  }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background-color: var(--scroll-thumb);
    border: 2px solid transparent;
    background-clip: content-box;
    border-radius: 999px;
  }
  ::-webkit-scrollbar-thumb:hover { background-color: var(--scroll-thumb-hover); }
  @supports not selector(::-webkit-scrollbar) {
    * { scrollbar-width: thin; scrollbar-color: var(--scroll-thumb) transparent; }
  }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1120px; width: calc(100% - 64px); margin-inline: auto; }
  .top { background: var(--card); border-bottom: 1px solid var(--line); }
  .bar, .heading, .brand, .actions { display: flex; align-items: center; gap: 10px; }
  .bar, .heading { justify-content: space-between; }
  .bar { min-height: 56px; }
  .brand { font-weight: 650; font-size: 16px; letter-spacing: -.01em; }
  main { padding-block: 36px 64px; }
  .heading { margin-bottom: 24px; gap: 16px; }
  h1 { margin: 0; font-size: 24px; line-height: 1.25; letter-spacing: -.02em; font-weight: 650; }
  .sub { margin: 4px 0 0; color: var(--muted); }
  .sub:empty { display: none; }
  h2 {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 10px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  }
  .count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 18px; padding-inline: 5px; border-radius: 5px;
    background: var(--raised); border: 1px solid var(--line-soft);
    color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .count:empty { display: none; }
  section + section { margin-top: 26px; }
  .grid, .empty { border: 1px solid var(--line); border-radius: 8px; background: var(--card); overflow: clip; }
  .card {
    position: relative;
    cursor: pointer;
    display: grid; grid-template-columns: 36px minmax(130px, 1fr) minmax(108px, auto) 76px;
    align-items: center; gap: 16px; min-height: 62px; padding: 10px 16px;
    transition: background-color .12s ease;
  }
  .card:hover { background: var(--hover); }
  .card:hover .open { background: var(--selected); color: var(--accent); }
  .card[data-state="exited"] .name, .card[data-state="stopped"] .name { color: var(--muted); }
  .card + .card { border-top: 1px solid var(--line-soft); }
  .icon {
    display: grid; place-items: center; width: 36px; height: 36px; border-radius: 7px;
    background: var(--raised); border: 1px solid var(--line-soft); color: var(--accent); font-size: 17px;
  }
  .icon img { object-fit: contain; }
  .body { min-width: 0; display: grid; gap: 2px; overflow-wrap: anywhere; }
  .title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .name { font-weight: 620; }
  .status-slot {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; font-weight: 620; text-transform: capitalize;
    padding: 1px 7px; border-radius: 999px; white-space: nowrap;
    background: color-mix(in srgb, var(--st, var(--muted)) 14%, transparent);
    color: var(--st, var(--muted));
  }
  .status-slot::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .status-slot.s-running { --st: var(--ok); }
  .status-slot.s-starting, .status-slot.s-stopping { --st: var(--busy); }
  .status-slot.s-external { --st: var(--warn); }
  .status-slot.s-exited { --st: var(--bad); }
  .status-slot.s-stopped, .status-slot.s-routed { --st: var(--muted); }
  .desc, .address, .empty p { color: var(--muted); }
  .desc { font-size: 13px; }
  .desc:empty { display: none; }
  .address { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .open, .control {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 34px; border-radius: 7px; text-decoration: none;
    transition: background-color .12s ease, border-color .12s ease, color .12s ease;
  }
  .open { color: var(--accent); font-weight: 600; padding-inline: 10px; }
  .open::after { content: ""; position: absolute; inset: 0; }
  .open:hover, .control:hover { background: var(--selected); color: var(--accent); }
  .control, input {
    border: 1px solid var(--line); background: var(--card); color: var(--fg);
    min-height: 34px; border-radius: 7px; padding: 0 12px; font: inherit;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  input { width: min(290px, 100%); }
  button { cursor: pointer; }
  .empty { padding: 24px 20px; }
  .empty p { margin: 4px 0 12px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 600px) {
    .wrap { width: calc(100% - 32px); }
    main { padding-top: 24px; }
    .heading { align-items: flex-start; flex-direction: column; }
    input { width: 100%; }
    .card { grid-template-columns: 36px minmax(0, 1fr) 64px; gap: 2px 10px; padding: 10px 12px; }
    .card .icon { grid-row: span 2; }
    .card .open { grid-column: 3; grid-row: 1 / span 2; }
    .address { grid-column: 2; }
    .open, .control, input { min-height: 44px; }
  }
</style>
</head>
<body>
  <header class="top"><div class="bar wrap">
    <div class="brand"><img src="favicon.svg?v=2" width="28" height="28" alt="">$(& $enc $Title)</div>
    <div class="actions"><div class="theme-picker" data-theme-picker></div>$admin</div>
  </div></header>
  <main class="wrap">
    <div class="heading">
      <div><h1>Applications</h1><p class="sub">$(& $enc $Tagline)</p></div>
      <input id="search" type="search" placeholder="Search applications (/)" aria-label="Search applications">
    </div>
    <section id="public" data-admin="$(& $enc $AdminPath)"><h2>Via Gateway <span class="count" id="public-count"></span></h2><div class="grid">
$($cards -join "`n")
    </div></section>
$localSection
    <div class="empty" id="empty" hidden><strong id="empty-title">No applications to show</strong>
      <p id="empty-text">Entries appear here after their configuration is applied.</p>
      <button class="control" id="clear" type="button" hidden>Clear search</button></div>
  </main>
<script>
  const sections = [document.getElementById('public')];
  const local = document.getElementById('local');
  const search = document.getElementById('search');
  const clear = document.getElementById('clear');

  function applyStatus(card, state) {
    if (!card || !state) return;
    card.dataset.state = state;
    const slot = card.querySelector('.status-slot');
    if (!slot) return;
    slot.className = 'status-slot s-' + state;
    slot.textContent = state;
    slot.hidden = false;
  }

  function makeLocalCard(app) {
    const card = document.createElement('div');
    card.className = 'card';
    if (app.id) card.dataset.appId = app.id;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = app.icon || '*';
    if (app.iconUrl) {
      const loadIcon = (attempt = 0) => {
        const image = new Image(24, 24);
        image.alt = '';
        image.onload = () => icon.replaceChildren(image);
        image.onerror = () => {
          if (attempt < 2) setTimeout(() => loadIcon(attempt + 1), 800 * (attempt + 1));
        };
        const sep = app.iconUrl.includes('?') ? '&' : '?';
        image.src = attempt ? (app.iconUrl + sep + 'r=' + attempt) : app.iconUrl;
      };
      loadIcon();
    }

    const body = document.createElement('span');
    body.className = 'body';
    const titleRow = document.createElement('span');
    titleRow.className = 'title-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = app.name || app.id || '';
    const status = document.createElement('span');
    status.className = 'status-slot';
    status.hidden = true;
    titleRow.append(name, status);
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = app.description || '';
    body.append(titleRow, desc);

    const address = document.createElement('code');
    address.className = 'address';
    address.textContent = app.address || '';

    const open = document.createElement('a');
    open.className = 'open';
    open.href = app.url || '#';
    open.setAttribute('aria-label', 'Open ' + (app.name || app.id || 'application'));
    open.textContent = 'Open ↗';

    card.append(icon, body, address, open);
    if (app.state) applyStatus(card, app.state);
    return card;
  }

  function filter() {
    const term = search.value.trim().toLowerCase();
    let matches = 0;
    for (const section of sections) {
      let count = 0;
      for (const row of section.querySelectorAll('.card')) {
        row.hidden = !row.textContent.toLowerCase().includes(term);
        count += Number(!row.hidden);
      }
      section.hidden = count === 0;
      const badge = section.querySelector('.count');
      if (badge) badge.textContent = count || '';
      matches += count;
    }
    document.getElementById('empty').hidden = matches > 0;
    document.getElementById('empty-title').textContent = term ? 'No matching applications' : 'No applications to show';
    document.getElementById('empty-text').textContent = term ? 'Try another name or address.' : 'Entries appear here after their configuration is applied.';
    clear.hidden = !term;
  }

  async function loadLocalApps(attempt = 0) {
    if (!local || !local.dataset.admin) return;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) return;
    try {
      const response = await fetch(local.dataset.admin + 'api/local-apps', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) {
        if (response.status >= 500 && attempt < 3) setTimeout(() => loadLocalApps(attempt + 1), 700 * (attempt + 1));
        return;
      }
      const data = await response.json();
      const items = Array.isArray(data.apps) ? data.apps : [];
      if (!items.length) return;
      const grid = document.getElementById('local-grid');
      grid.replaceChildren(...items.map(makeLocalCard));
      sections.push(local);
      filter();
    } catch {
      if (attempt < 3) setTimeout(() => loadLocalApps(attempt + 1), 700 * (attempt + 1));
    }
  }

  async function loadStatuses() {
    const adminBase = document.getElementById('public')?.dataset.admin;
    if (!adminBase) return;
    try {
      const response = await fetch(adminBase + 'api/session?status=1', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.authenticated || !data.states) return;
      for (const [id, state] of Object.entries(data.states)) {
        const card = document.querySelector('.card[data-app-id="' + CSS.escape(id) + '"]');
        applyStatus(card, state);
      }
    } catch { /* Status badges are optional. */ }
  }

  search.addEventListener('input', filter);
  clear.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button || event.target.closest('a, button, input')) return;
    const card = event.target.closest('.card');
    if (card) card.querySelector('.open')?.click();
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      search.focus();
      search.select();
    } else if (event.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      filter();
    }
  });
  filter();
  loadLocalApps();
  loadStatuses();
</script>
</body>
</html>
"@

    New-Item -ItemType Directory -Path $WebRoot -Force | Out-Null
    # One icon for the gateway, kept beside the admin page that also uses it.
    $icon = Join-Path $PSScriptRoot '..\admin\favicon.svg'
    if (Test-Path -LiteralPath $icon) { Copy-Item -LiteralPath $icon -Destination (Join-Path $WebRoot 'favicon.svg') -Force }
    foreach ($asset in 'theme.js', 'theme.css') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot "..\admin\$asset") -Destination $WebRoot -Force
    }
    $out = Join-Path $WebRoot 'index.html'
    [IO.File]::WriteAllText($out, $html, [Text.UTF8Encoding]::new($false))
    return $out
}
