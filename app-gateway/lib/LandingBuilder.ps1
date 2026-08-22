# Renders the landing page served at the gateway root.
#
# A static file (Caddy file_server), so there is no extra process to supervise.
# Cards come straight from the resolved apps, and the heading, tagline and
# fallback glyph from the "site" block — nothing here names an app or picks an
# icon, so registering one is the whole job of adding it.
#
# Each card probes its own app and dims if the upstream is down. The gateway can
# legitimately run with only some apps launched, and a route to an app that is not
# running still exists and would answer 502.

function New-LandingPage {
    <# Render $WebRoot\index.html. Returns its path. #>
    param(
        [hashtable[]] $Apps,
        [string]      $WebRoot,
        [string]      $Title        = 'Gateway',
        [string]      $Tagline      = '',
        [string]      $FallbackIcon = '*'
    )

    $enc = { param($text) [Net.WebUtility]::HtmlEncode([string]$text) }

    # An app with no prefix has no page to link to, and a hidden one is reached by
    # a direct link rather than by browsing.
    $listed = @($Apps | Where-Object { $_.BasePath -and -not $_.Hidden })

    $cards = foreach ($app in $listed) {
        $icon = if ($app.Icon) { $app.Icon } else { $FallbackIcon }

        # No trailing slash: an app under a prefix serves the bare form as
        # canonical and 30x-es the slashed one to it. Linking at the canonical form
        # skips a redirect hop.
        @"
      <a class="card" href="$(& $enc $app.BasePath)" data-probe="$(& $enc $app.Probe)">
        <span class="icon">$(& $enc $icon)</span>
        <span class="body">
          <span class="name">$(& $enc $app.Name)</span>
          <span class="desc">$(& $enc $app.Description)</span>
        </span>
        <span class="status" aria-live="polite">checking…</span>
      </a>
"@
    }

    if (-not $listed.Count) {
        $cards = @'
      <p class="empty">Nothing is enabled. Register an app in gateway.json, or turn one back on with <code>gateway.ps1 -Enable &lt;id&gt;</code>.</p>
'@
    }

    $html = @"
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>$(& $enc $Title)</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;  --fg: #17191c;  --muted: #6b7280;
    --card: #ffffff; --line: #e3e6ea; --accent: #3b6fd4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --fg: #e8eaed; --muted: #9aa3ad;
      --card: #1c1f24; --line: #2b3037; --accent: #6f9cf0;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 2rem 1.25rem;
    background: var(--bg); color: var(--fg);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { width: 100%; max-width: 34rem; }
  h1 { margin: 0 0 .25rem; font-size: 1.4rem; letter-spacing: -.01em; }
  .sub { margin: 0 0 1.75rem; color: var(--muted); font-size: .875rem; }
  .grid { display: flex; flex-direction: column; gap: .75rem; }
  .card {
    display: flex; align-items: center; gap: 1rem;
    padding: 1rem 1.15rem;
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    text-decoration: none; color: inherit;
    transition: border-color .15s, transform .15s;
  }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card[data-down="1"] { opacity: .45; pointer-events: none; }
  .icon { font-size: 1.6rem; line-height: 1; }
  .body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .name { font-weight: 600; }
  .desc { color: var(--muted); font-size: .85rem; }
  .status { color: var(--muted); font-size: .75rem; white-space: nowrap; }
  .card[data-down="0"] .status { color: #2e9e5b; }
  .card[data-down="1"] .status { color: #c2493d; }
  .empty { color: var(--muted); font-size: .9rem; }
  code { font-size: .85em; }
</style>
</head>
<body>
  <main>
    <h1>$(& $enc $Title)</h1>
    <p class="sub">$(& $enc $Tagline)</p>
    <div class="grid">
$($cards -join "`n")
    </div>
  </main>
<script>
  for (const card of document.querySelectorAll('.card')) {
    const status = card.querySelector('.status');
    fetch(card.dataset.probe, { method: 'HEAD', cache: 'no-store' })
      .then(r => {
        const up = r.ok || r.status === 401 || r.status === 403;  // auth-walled still counts as up
        card.dataset.down = up ? '0' : '1';
        status.textContent = up ? 'online' : 'offline';
      })
      .catch(() => {
        card.dataset.down = '1';
        status.textContent = 'offline';
      });
  }
</script>
</body>
</html>
"@

    New-Item -ItemType Directory -Path $WebRoot -Force | Out-Null
    $out = Join-Path $WebRoot 'index.html'
    [IO.File]::WriteAllText($out, $html, [Text.UTF8Encoding]::new($false))
    return $out
}
