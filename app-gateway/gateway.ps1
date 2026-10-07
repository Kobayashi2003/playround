# app-gateway — one public port, several apps.
#
# Only a single HTTPS port is reachable through the tunnel, but there is more than
# one app behind it and each would like to own the origin root. One Caddy holds
# that port and fans out by path prefix; every app runs beside it as a child of
# this script, which supervises the lot.
#
# This file knows nothing about any app. An app is a file in apps/ — one JSON
# document per app, naming where it lives, which prefix it answers on, which ports
# it binds and how it is started. Dropping a file in registers an app; deleting it
# unregisters one. See schema/app.schema.json for the fields, README.md for why.
#
#   .\gateway.ps1                              every enabled app
#   .\gateway.ps1 -App hearth,lnlib            just these, enabled or not
#   .\gateway.ps1 -List                        the registry, and what is on
#   .\gateway.ps1 -ConfigOnly                  generate and validate config, launch nothing
#   .\gateway.ps1 -Bind :8080                  move the public port, this run
#   .\gateway.ps1 -Port hearth:backend=17019   move an app's port, this run
#   .\gateway.ps1 -Enable lnlib                turn an app on, written back to its own file
#   .\gateway.ps1 -Disable lnlib               turn it off again

[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    # Run exactly these ids, whatever their "enabled" says. For trying one app on
    # its own without editing anything.
    [Parameter(ParameterSetName = 'Run')]
    [string[]] $App,

    # Public listen address. Overrides gateway.json's "bind" for this run only —
    # the tunnel points at the configured one, which is why it lives in the file.
    [string]   $Bind,

    # Move a declared port for this run: -Port hearth:backend=17019, repeatable.
    # The number reaches the app and its route together, so nothing drifts.
    [Parameter(ParameterSetName = 'Run')]
    [string[]] $Port,

    [Parameter(ParameterSetName = 'Run')]
    [switch]   $ConfigOnly,

    [Parameter(ParameterSetName = 'List')]
    [switch]   $List,

    # Flip "enabled" in an app's own file and exit. The persistent form of -App.
    [Parameter(ParameterSetName = 'Enable',  Mandatory)] [string[]] $Enable,
    [Parameter(ParameterSetName = 'Disable', Mandatory)] [string[]] $Disable,

    # Settings somewhere other than ./gateway.json — a second registry, or a test
    # one. Its "appsDir" is what decides which plugins load.
    [string]   $Config
)

$ErrorActionPreference = 'Stop'

# `pwsh -File gateway.ps1 -App a,b` hands the list over as the single string
# "a,b" — only an in-session call splits it. Both spellings are how this script is
# actually run, so accept either rather than failing on an id nobody typed.
function Split-List { param([string[]]$Value) @($Value | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }

$App     = Split-List $App
$Port    = Split-List $Port
$Enable  = Split-List $Enable
$Disable = Split-List $Disable

$root         = $PSScriptRoot
$settingsPath = if ($Config) { [IO.Path]::GetFullPath($Config) } else { Join-Path $root 'gateway.json' }
$baseDir      = Split-Path -Parent $settingsPath
$runtimeDir   = Join-Path $root '.runtime'
$webRoot      = Join-Path $runtimeDir 'web'
$caddyfile    = Join-Path $runtimeDir 'Caddyfile'

. (Join-Path $root 'lib\Config.ps1')
. (Join-Path $root 'lib\CaddyBuilder.ps1')
. (Join-Path $root 'lib\LandingBuilder.ps1')
. (Join-Path $root 'lib\ProcessHost.ps1')

# --------------------------------------------------------------------- load
# $settings, not $config: -Config above is a [string] path, and PowerShell would
# quietly stringify the parsed object back into it.
$settings = Read-GatewaySettings -Path $settingsPath
$appsDir  = [IO.Path]::GetFullPath([string](Get-JsonProperty $settings 'appsDir' 'apps'), $baseDir)
$plugins  = @(Get-AppPlugin -Dir $appsDir)

# ---------------------------------------------------------------- enable/disable
if ($Enable -or $Disable) {
    $ids     = if ($Enable) { $Enable } else { $Disable }
    $enabled = [bool]$Enable
    Set-AppEnabled -Plugins $plugins -Id $ids -Enabled $enabled
    $verb = if ($enabled) { 'enabled' } else { 'disabled' }
    Write-Host "[GATEWAY] ${verb}: $($ids -join ', ')" -ForegroundColor Cyan
    return
}

$bind = if ($Bind) { $Bind } else { [string](Get-JsonProperty $settings 'bind' ':30709') }
if ($bind -notmatch ':\d+$') { throw "Bind must end in a port, got '$bind'." }

$paths = @{}
$pathsNode = Get-JsonProperty $settings 'paths'
if ($pathsNode) {
    foreach ($p in $pathsNode.PSObject.Properties) {
        $paths["paths.$($p.Name)"] = [IO.Path]::GetFullPath([string]$p.Value, $baseDir)
    }
}

# portRanges: { "project": "17000-17999" } -> @{ project = @{ From; To } }, keyed
# by the same names as paths. The convention itself is in PORTS.md.
$portRanges = @{}
$rangesNode = Get-JsonProperty $settings 'portRanges'
if ($rangesNode) {
    foreach ($r in $rangesNode.PSObject.Properties) {
        if ([string]$r.Value -notmatch '^(\d+)-(\d+)$' -or [int]$Matches[1] -gt [int]$Matches[2]) {
            throw "gateway.json portRanges.$($r.Name) must be 'from-to', got '$($r.Value)'."
        }
        if (-not $paths.ContainsKey("paths.$($r.Name)")) {
            throw "gateway.json portRanges.$($r.Name) names no entry in paths."
        }
        $portRanges[$r.Name] = @{ From = [int]$Matches[1]; To = [int]$Matches[2] }
    }
}
$portSlot = [int](Get-JsonProperty $settings 'portSlot' 10)

# -Port hearth:backend=17019 -> @{ hearth = @{ backend = 17019 } }
$portOverride = @{}
foreach ($spec in $Port) {
    if ($spec -notmatch '^([^:=\s]+):([^:=\s]+)=(\d+)$') {
        throw "Bad -Port '$spec'. Expected <app>:<port-name>=<number>, e.g. hearth:backend=17019."
    }
    $appId = $Matches[1]
    if (-not $portOverride.ContainsKey($appId)) { $portOverride[$appId] = @{} }
    $portOverride[$appId][$Matches[2]] = [int]$Matches[3]
}

$unknownOverride = @($portOverride.Keys | Where-Object { $_ -notin $plugins.Id })
if ($unknownOverride) { throw "-Port names unknown app(s): $($unknownOverride -join ', '). Known: $($plugins.Id -join ', ')" }

$all = @(Resolve-GatewayApps -Plugins $plugins -BaseDir $baseDir -Bind $bind `
                             -Paths $paths -PortOverride $portOverride)

# --------------------------------------------------------------------- list
if ($List) {
    Write-Host ''
    # Ports last: the count varies per app, so any overflow runs off the end of the
    # line instead of shunting a column out of alignment for everyone else.
    $row = "  {0,-3} {1,-24} {2,-20} {3,-46} {4}"
    Write-Host ($row -f '', 'ID', 'PREFIX', 'ROOT', 'PORTS') -ForegroundColor DarkGray
    foreach ($a in $all) {
        $mark  = if ($a.Enabled) { ' on' } else { 'off' }
        $color = if ($a.Enabled) { 'Green' } else { 'DarkGray' }
        $ports = if ($a.Ports.Count) {
            (($a.Ports.GetEnumerator() | Sort-Object Key |
                ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
        } else { '-' }
        $prefix = if ($a.BasePath) { $a.BasePath } else { '(not routed)' }
        Write-Host ($row -f $mark, $a.Id, $prefix, $a.Root, $ports) -ForegroundColor $color
    }
    Write-Host ''
    Write-Host "  bind $bind   apps $appsDir" -ForegroundColor DarkGray
    Write-Host ''
    return
}

# ------------------------------------------------------------------ selection
if ($App) {
    $unknown = @($App | Where-Object { $_ -notin $all.Id })
    if ($unknown) { throw "Unknown app id(s): $($unknown -join ', '). Known: $($all.Id -join ', ')" }
    $selected = @($all | Where-Object { $_.Id -in $App })
} else {
    $selected = @($all | Where-Object { $_.Enabled })
}

if (-not $selected.Count) {
    throw "Nothing to run: every app in $appsDir is disabled. Turn one on with -Enable <id>, or name one with -App."
}

Assert-GatewayApps -Apps $selected -Bind $bind -Paths $paths -PortRanges $portRanges -PortSlot $portSlot

# --------------------------------------------------------------------- config
# Regenerated every launch — the plugin files are the source of truth, and a stale
# .runtime/ would serve the previous app set.
if (Test-Path $runtimeDir) { Remove-Item -Recurse -Force $runtimeDir }

$site = Get-JsonProperty $settings 'site'
New-LandingPage -Apps $selected -WebRoot $webRoot `
    -Title        ([string](Get-JsonProperty $site 'title' 'Gateway')) `
    -Tagline      ([string](Get-JsonProperty $site 'tagline' '')) `
    -FallbackIcon ([string](Get-JsonProperty $site 'fallbackIcon' '*')) | Out-Null

New-GatewayCaddyfile -Apps $selected -OutFile $caddyfile -WebRoot $webRoot -Bind $bind `
    -SourceDir (Split-Path -Leaf $appsDir) | Out-Null

$routeEnv = Get-MergedRouteEnv -Apps $selected

Write-Host ''
Write-Host "[GATEWAY] bind $bind" -ForegroundColor Cyan
foreach ($a in $selected) {
    $prefix = if ($a.BasePath) { $a.BasePath } else { '(not routed)' }
    $how    = switch ($a.Routes.Kind) { 'snippet' { 'snippet' } 'proxy' { 'proxy' } default { '-' } }
    Write-Host ("[GATEWAY]   {0,-24} {1,-20} {2}" -f $a.Id, $prefix, $how) -ForegroundColor Cyan
}
Write-Host ''

if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
    throw 'caddy is not on PATH (https://caddyserver.com/download).'
}

# ------------------------------------------------------------------- preflight
# Adapt the config before anything is spawned. A snippet with a typo in it, or a
# route variable no routes.env supplies, is otherwise found only after every app
# has been started — Caddy exits 1 and takes the whole launch down with it.
$saved = Push-ProcessEnvironment -Environment $routeEnv
try {
    $check = & caddy validate --config $caddyfile --adapter caddyfile 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The generated Caddyfile does not adapt:`n$($check -join "`n")"
    }
} finally {
    Pop-ProcessEnvironment -Saved $saved
}

if ($ConfigOnly) {
    Write-Host "[GATEWAY] config is valid; wrote $caddyfile and $webRoot\index.html. Launched nothing." -ForegroundColor Yellow
    return
}

# The public port is the tunnel's, and only one process can hold it: an earlier
# gateway, or a project started standalone with -Bind onto it. Say so plainly:
# otherwise Caddy fails to bind, exits 1, and the reason is buried in its JSON log
# while the apps are already starting up.
$bindPort = [int]($bind -split ':')[-1]
if (Get-NetTCPConnection -LocalPort $bindPort -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $bindPort is already in use — something else owns the public port. " +
          'Stop the other edge (a project started standalone, or an earlier gateway) first.'
}

# --------------------------------------------------------------------- launch
$children = @()
try {
    foreach ($a in $selected) {
        if (-not $a.Launch) {
            Write-Host "[SKIP]  $($a.Id) declares no launch; routing only." -ForegroundColor DarkGray
            continue
        }
        $children += Start-Child -Label $a.Id -File $a.Launch.File -Arguments $a.Launch.Args `
            -Cwd $a.Launch.Cwd -Environment $a.Env
    }

    # Caddy last, so its upstreams are already coming up. It tolerates a cold one
    # anyway (502 until ready); this just keeps the log readable.
    $children += Start-Child -Label 'caddy' -File 'caddy' -Cwd $root -Environment $routeEnv `
        -Arguments @('run', '--config', $caddyfile, '--adapter', 'caddyfile')

    Write-Host ''
    Write-Host "[GATEWAY] up on http://localhost$bind — Ctrl+C to stop everything." -ForegroundColor Green
    Write-Host ''

    Wait-Children -Children $children
} finally {
    Stop-Children -Children $children
}
