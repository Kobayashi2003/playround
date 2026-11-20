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
#   .\start.ps1                                every enabled app
#   .\start.ps1 -App hearth,neovndb            just these, enabled or not
#   .\start.ps1 -List                          the registry, and what is on
#   .\start.ps1 -ConfigOnly                    generate and validate config, launch nothing
#   .\start.ps1 -NoBrowser                     do not open the landing page
#   .\start.ps1 -Bind :8080                    move the public port, this run
#   .\start.ps1 -Port hearth:backend=17019     move an app's port, this run
#   .\start.ps1 -Enable tmw-downloader         turn an app on, written back to its own file
#   .\start.ps1 -Disable tmw-downloader        turn it off again
#   .\start.ps1 -NoAdmin                       leave the admin page off, this run
#   .\start.ps1 -SetAdminPassword              set the admin page's password

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

    # Do not open the landing page in the browser.
    [Parameter(ParameterSetName = 'Run')]
    [switch]   $NoBrowser,

    # Serve no admin page this run, whatever gateway.json's admin.enabled says.
    [Parameter(ParameterSetName = 'Run')]
    [switch]   $NoAdmin,

    # Ask for a new admin password and store its hash in gateway.json.
    [Parameter(ParameterSetName = 'Password', Mandatory)]
    [switch]   $SetAdminPassword,

    [Parameter(ParameterSetName = 'List')]
    [switch]   $List,

    # Flip "enabled" in an app's own file and exit. The persistent form of -App.
    [Parameter(ParameterSetName = 'Enable',  Mandatory)] [string[]] $Enable,
    [Parameter(ParameterSetName = 'Disable', Mandatory)] [string[]] $Disable
)

$ErrorActionPreference = 'Stop'

# Keep PowerShell and .NET exception messages in English in gateway logs,
# regardless of the host Windows display language.
$enUs = [Globalization.CultureInfo]::GetCultureInfo('en-US')
[Globalization.CultureInfo]::DefaultThreadCurrentUICulture = $enUs
[Threading.Thread]::CurrentThread.CurrentUICulture = $enUs

# `pwsh -File start.ps1 -App a,b` hands the list over as the single string
# "a,b" — only an in-session call splits it. Both spellings are how this script is
# actually run, so accept either rather than failing on an id nobody typed.
function Split-List { param([string[]]$Value) @($Value | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }

$App     = Split-List $App
$Port    = Split-List $Port
$Enable  = Split-List $Enable
$Disable = Split-List $Disable

$root         = $PSScriptRoot
$appsDir      = Join-Path $root 'apps'

. (Join-Path $root 'lib\Config.ps1')
. (Join-Path $root 'lib\Icons.ps1')
. (Join-Path $root 'lib\CaddyBuilder.ps1')
. (Join-Path $root 'lib\LandingBuilder.ps1')
. (Join-Path $root 'lib\ProcessHost.ps1')
. (Join-Path $root 'lib\Supervisor.ps1')
. (Join-Path $root 'lib\AdminAuth.ps1')
. (Join-Path $root 'lib\AdminServer.ps1')

# --------------------------------------------------------------------- load
$settingsFile = Join-Path $root 'gateway.json'
$credentialFile = Join-Path $root 'gateway.auth.json'
$settings = Read-GatewaySettings -Path $settingsFile

# ------------------------------------------------------------ admin password
if ($SetAdminPassword) {
    $first  = Read-Host 'New admin password' -AsSecureString
    $second = Read-Host 'Again' -AsSecureString
    $plain  = [Net.NetworkCredential]::new('', $first).Password
    if ($plain -ne [Net.NetworkCredential]::new('', $second).Password) { throw 'The two passwords differ; nothing changed.' }
    if ($plain.Length -lt 8) { throw 'The password needs at least 8 characters; nothing changed.' }
    $Gw = @{ SettingsFile = $settingsFile; CredentialFile = $credentialFile }
    Set-GatewayAdminCredential -PasswordHash (New-PasswordHash $plain)
    Write-Host '[GATEWAY] admin password set in gateway.auth.json. A running gateway picks it up on restart.' -ForegroundColor Cyan
    return
}
$runtimeDir = [IO.Path]::GetFullPath([string](Get-JsonProperty $settings 'runtime' '.runtime'), $root)
$webRoot    = Join-Path $runtimeDir 'web'
$caddyfile  = Join-Path $runtimeDir 'Caddyfile'
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

$paths = Get-GatewayPaths -Settings $settings -Root $root

# The port convention is not the gateway's: it reads the ranges from PORTS.md.
$portsFile  = [IO.Path]::GetFullPath([string](Get-JsonProperty $settings 'ports' '../../PORTS.md'), $root)
$convention = Read-PortConvention -Path $portsFile

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

$all = @(Resolve-GatewayApps -Plugins $plugins -BaseDir $root -Bind $bind `
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

# -------------------------------------------------------------------- admin
# The admin page and Caddy's reload endpoint sit in the gateway's own slot
# (playround/PORTS.md), so no app can be given them.
$adminNode    = Get-JsonProperty $settings 'admin'
if ($adminNode -and $adminNode -isnot [pscustomobject]) { throw 'gateway.json admin must be a JSON object.' }
$adminPort    = Get-JsonInt $adminNode 'port' 16050 'gateway.json admin'
if ($adminPort -lt 1 -or $adminPort -gt 65535) { throw "gateway.json admin.port must be between 1 and 65535, got '$adminPort'." }
$caddyAdmin   = Assert-LoopbackEndpoint -Endpoint ([string](Get-JsonProperty $settings 'caddyAdmin' 'localhost:16051')) -FieldName 'gateway.json caddyAdmin'
$credential   = Get-GatewayAdminCredential -Path $credentialFile -Legacy $adminNode
$adminUser    = [string](Get-JsonProperty $credential 'user' 'admin')
$adminHash    = [string](Get-JsonProperty $credential 'passwordHash' '')
$adminEnabled = (Get-JsonBool $adminNode 'enabled' $true 'gateway.json admin') -and -not $NoAdmin
if ($adminEnabled -and -not $adminHash) {
    Write-Host '[GATEWAY] admin page off: run start.ps1 -SetAdminPassword to enable it.' -ForegroundColor Yellow
    $adminEnabled = $false
}

$reserved = @{ Prefixes = @{}; Ports = @{} }
$reserved.Prefixes['/_gateway'] = '(gateway) static assets'
if ($caddyAdmin) { $reserved.Ports[[int]($caddyAdmin -split ':')[-1]] = '(gateway) caddy admin' }
if ($adminEnabled) {
    $reserved.Prefixes['/admin'] = '(gateway) admin page'
    $reserved.Ports[$adminPort]  = '(gateway) admin page'
}

Assert-GatewayApps -Apps $selected -Bind $bind -PortRanges $convention.Ranges -PortSlot $convention.Slot -Reserved $reserved

# The public port is the tunnel's, and only one process can hold it: an earlier
# gateway, or a project started standalone with -Bind onto it. Say so plainly:
# otherwise Caddy fails to bind, exits 1, and the reason is buried in its JSON log
# while the apps are already starting up. Checked before the runtime folder is
# rewritten, so a second start does not swap a running gateway's landing page.
$bindPort = [int]($bind -split ':')[-1]
if (-not $ConfigOnly) {
    $held = { param([int]$P) [bool](Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction SilentlyContinue) }
    if (& $held $bindPort) {
        throw "Port $bindPort is already in use — something else owns the public port. " +
              'Stop the other edge (a project started standalone, or an earlier gateway) first.'
    }
    if ($caddyAdmin -and (& $held ([int]($caddyAdmin -split ':')[-1]))) {
        throw "Port $(($caddyAdmin -split ':')[-1]) (caddyAdmin) is already in use; Caddy could not take reloads on it."
    }
    if ($adminEnabled -and (& $held $adminPort)) {
        Write-Host "[GATEWAY] admin page off: port $adminPort is already in use." -ForegroundColor Yellow
        $adminEnabled = $false
    }
}

if (-not (Get-Command caddy -ErrorAction SilentlyContinue)) {
    throw 'caddy is not on PATH (https://caddyserver.com/download).'
}

# ---------------------------------------------------------------- the state
# Everything the supervisor and the admin page share. See lib/Supervisor.ps1.
$Gw = @{
    Root          = $root
    AppsDir       = $appsDir
    SettingsFile  = $settingsFile
    CredentialFile = $credentialFile
    Settings      = $settings
    StartupSettings = $settings
    PortsFile     = $portsFile
    Convention    = $convention
    Bind          = $bind
    Paths         = $paths
    PortOverride  = $portOverride
    Reserved      = $reserved
    RuntimeDir    = $runtimeDir
    WebRoot       = $webRoot
    Caddyfile     = $caddyfile
    CaddyAdmin    = $caddyAdmin
    AdminPort     = $(if ($adminEnabled) { $adminPort } else { 0 })
    AdminWeb      = Join-Path $root 'admin'
    LogDir        = [IO.Path]::GetFullPath([string](Get-JsonProperty $settings 'logs' 'logs'), $root)
    RunFile       = Join-Path $root '.running.json'
    All           = $all
    RegistryVersions = Get-RegistryVersions $plugins
    Active        = [Collections.Generic.HashSet[string]]::new([string[]]@($selected.Id))
    ExplicitApps  = $App
    Selection     = $(if ($App) { "-App $($App -join ',')" } else { 'enabled apps' })
    Runs          = @{}
    Deferred      = [Collections.Generic.List[object]]::new()
    StartedAt     = Get-Date
    RouteEnv      = @{}
}
$Gw.BackupDir = [IO.Path]::GetFullPath([string](Get-JsonProperty $settings 'backups' 'backups'), $root)

# --------------------------------------------------------------------- config
# A preview has separate files so it can run next to an active gateway.
$nativePath = Join-Path $root 'lib\Native.cs'
$nativeHash = (Get-FileHash -LiteralPath $nativePath -Algorithm SHA256).Hash
if (-not $ConfigOnly -and ('AppGateway.LogHub' -as [type]) -and $global:AppGatewayNativeHash -ne $nativeHash) {
    # .NET cannot reload a modified type with the same name into the current
    # PowerShell session, so run in a fresh pwsh process when Native.cs changed.
    Write-Host '[GATEWAY] lib\Native.cs changed since the previous run in this shell; starting in a fresh pwsh process.' -ForegroundColor Yellow
    $reexec = @('-NoProfile', '-File', $PSCommandPath)
    if ($App)       { $reexec += @('-App', ($App -join ',')) }
    if ($Bind)      { $reexec += @('-Bind', $Bind) }
    if ($Port)      { $reexec += @('-Port', ($Port -join ',')) }
    if ($NoBrowser) { $reexec += '-NoBrowser' }
    if ($NoAdmin)   { $reexec += '-NoAdmin' }
    & pwsh @reexec
    return
}
if ($ConfigOnly) {
    $preview = Join-Path $runtimeDir "previews/$([guid]::NewGuid().ToString('N'))"
    $Gw.Caddyfile = $caddyfile = Join-Path $preview 'Caddyfile'
    $Gw.WebRoot = $webRoot = Join-Path $preview 'web'
} else {
    Clear-StaleRuntimeDirs
}
$Gw.RouteEnv = Build-GatewayConfig -Apps $selected -Validate

Write-Host ''
Write-Host "[GATEWAY] bind $bind" -ForegroundColor Cyan
foreach ($a in $selected) {
    $prefix = if ($a.BasePath) { $a.BasePath } else { '(not routed)' }
    $how    = switch ($a.Routes.Kind) { 'snippet' { 'snippet' } 'proxy' { 'proxy' } default { '-' } }
    Write-Host ("[GATEWAY]   {0,-24} {1,-20} {2}" -f $a.Id, $prefix, $how) -ForegroundColor Cyan
}
if ($Gw.AdminPort) { Write-Host ("[GATEWAY]   {0,-24} {1,-20} {2}" -f '(admin page)', '/admin', "localhost:$($Gw.AdminPort)") -ForegroundColor Cyan }
Write-Host ''

if ($ConfigOnly) {
    Write-Host "[GATEWAY] config is valid; wrote $caddyfile and $webRoot\index.html. Launched nothing." -ForegroundColor Yellow
    return
}

if ($Gw.AdminPort -and (Test-LegacyAdminCredential $adminNode)) {
    Set-GatewayAdminCredential -PasswordHash $adminHash
}

# --------------------------------------------------------------------- launch
if (-not ('AppGateway.LogHub' -as [type])) {
    Add-Type -Path $nativePath
    $global:AppGatewayNativeHash = $nativeHash
}
[AppGateway.SystemStats]::UseEnglishMessages()
New-Item -ItemType Directory -Force -Path $Gw.LogDir, $Gw.BackupDir | Out-Null
# Every child's output passes through here: to this console, prefixed with its
# app, to logs/<app>.log, and to the admin page.
$Gw.Hub = [AppGateway.LogHub]::new($Gw.LogDir, 3000, 5MB)
$Gw.CaddyVersion = ("$(& caddy version 2>$null)" -split ' ')[0]

try {
    foreach ($a in $selected) {
        if (-not $a.Launch) {
            Write-GatewayLog "[SKIP] $($a.Id) declares no launch; routing only."
            continue
        }
        # One app that cannot start is skipped; the others still come up.
        try { $null = Start-GatewayApp -Id $a.Id } catch { }
    }

    # Caddy last, so its upstreams are already coming up. It tolerates a cold one
    # anyway (502 until ready); this just keeps the log readable.
    $caddyEnv = [Collections.Generic.Dictionary[string, string]]::new()
    foreach ($e in $Gw.RouteEnv.GetEnumerator()) { $caddyEnv[$e.Key] = [string]$e.Value }
    $Gw.Caddy = $Gw.Hub.Start('caddy', 'caddy', [string[]]@('run', '--config', $caddyfile, '--adapter', 'caddyfile'), $root, $caddyEnv)
    Write-GatewayLog "[START] caddy (PID $($Gw.Caddy.Id))"
    Save-RunFile

    if ($Gw.AdminPort) {
        $Gw.Auth = New-AdminAuth -User $adminUser -PasswordHash $adminHash `
            -SessionHours ([double](Get-JsonProperty $adminNode 'sessionHours' 12)) `
            -AuditFile (Join-Path $Gw.LogDir 'admin-audit.log')
        try {
            $Gw.Listener = Start-AdminListener -Port $Gw.AdminPort
        } catch {
            Write-GatewayLog "admin page off: could not listen on localhost:$($Gw.AdminPort): $($_.Exception.Message)" 'err'
        }
    }

    $landing = "http://127.0.0.1:$bindPort/"
    Write-Host ''
    Write-Host "[GATEWAY] up on $landing — Ctrl+C to stop everything." -ForegroundColor Green
    if ($Gw.Listener) { Write-Host "[GATEWAY] admin page on ${landing}admin/" -ForegroundColor Green }
    Write-Host ''

    if (-not $NoBrowser) {
        # Open the landing page once Caddy answers; the job ends with this script.
        $null = Start-ThreadJob -ArgumentList $landing -ScriptBlock {
            param($url)
            for ($i = 0; $i -lt 240; $i++) {
                try { $null = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; Start-Process $url; return }
                catch { if ($_.Exception.Response) { Start-Process $url; return } }
                Start-Sleep -Milliseconds 500
            }
        }
    }

    # The supervisor loop. Only Caddy exiting, Ctrl+C or the admin page's
    # shutdown ends it; an app that exits is reported and the rest keep serving.
    while (Step-Gateway) { Invoke-AdminPump -WaitMs 250 }
} finally {
    if ($Gw.Listener) { try { $Gw.Listener.Close() } catch { } }
    Stop-Gateway
    if ($Gw.Hub) { $Gw.Hub.Dispose() }
    Remove-Item -LiteralPath $Gw.RunFile -ErrorAction SilentlyContinue
}
