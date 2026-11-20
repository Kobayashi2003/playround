# The running gateway: which apps are up, what each was told to do, and Caddy.
#
# start.ps1 builds one state table ($Gw) and then turns Step-Gateway in a loop.
# Everything that changes the set of running processes — the launch at start-up,
# a button on the admin page, an app that exits — goes through the functions
# here, so the console, the admin page and .running.json never disagree.
#
# Nothing here blocks for long. Stopping an app that was started elsewhere runs
# its stop.ps1 as a tracked child and the loop waits for its ports to free; the
# admin page is served from the same loop and would otherwise stall with it.

$script:AutoRestartLimit  = 5
$script:AutoRestartWindow = [TimeSpan]::FromMinutes(10)
$script:StopTimeout       = [TimeSpan]::FromSeconds(30)
$script:SampleSeconds     = 10
$script:SampleKeep        = 360   # an hour of history

function Write-GatewayLog {
    param([string] $Message, [ValidateSet('out', 'err')] [string] $Stream = 'out')
    $Gw.Hub.Write('gateway', $Stream, $Message)
}

function Get-RunRecord {
    param([string] $Id)
    if (-not $Gw.Runs.ContainsKey($Id)) {
        $Gw.Runs[$Id] = @{
            App         = $null   # effective launch configuration of the child
            Child       = $null   # the app's start.ps1, when this gateway started it
            Stopper     = $null   # its stop.ps1, while one runs
            StartedAt   = $null
            ExitedAt    = $null
            ExitCode    = $null
            Starts      = 0
            Crashes     = [Collections.Generic.List[datetime]]::new()
            Pending     = $null   # 'start' once the ports are free
            NotBefore   = $null   # and not before this, after a crash
            Deadline    = $null
            Stopping    = $false  # an exit now is asked for, not a crash
            Note        = ''      # the last thing worth telling the admin page
            CpuSamples  = @{}     # channel ('Live' | 'History') -> @{ Pid; At; ProcCpu; LastCpu }
        }
    }
    return $Gw.Runs[$Id]
}

function Test-Alive {
    param($Process)
    return $null -ne $Process -and -not $Process.HasExited
}

# ------------------------------------------------------------------ ports

function Get-ListeningPorts {
    <# port -> owning pid, for every TCP listener on the machine. Cached briefly:
       Get-NetTCPConnection is a CIM call, and one admin poll asks for it per app. #>
    param([switch] $Fresh)

    $now = Get-Date
    if (-not $Fresh -and $Gw.PortCache -and ($now - $Gw.PortCache.At).TotalSeconds -lt 2) {
        return $Gw.PortCache.Map
    }
    $map = @{}
    $bindings = @{}
    foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $port = [int]$c.LocalPort
        $owner = [int]$c.OwningProcess
        if (-not $map.ContainsKey($port)) { $map[$port] = $owner }
        $bindings[$port] += @(@{ address = $c.LocalAddress; pid = $owner })
    }
    $Gw.PortCache = @{ At = $now; Map = $map; Bindings = $bindings }
    return $map
}

function Get-BusyPorts {
    <# The app's declared ports that something listens on, checked live. #>
    param([hashtable] $App)

    $listening = @{}
    foreach ($ep in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()) {
        $listening[$ep.Port] = $true
    }
    foreach ($p in $App.Ports.GetEnumerator() | Sort-Object Value) {
        if ($listening.ContainsKey($p.Value)) { [pscustomobject]@{ Name = $p.Key; Port = $p.Value } }
    }
}

# ---------------------------------------------------------------- run file

function Save-RunFile {
    <# stop.ps1 reads this to stop the gateway from another window. #>
    $procs = @($Gw.Caddy) + @($Gw.Runs.Values | ForEach-Object { $_.Child; $_.Stopper })
    $entries = @($procs | Where-Object { Test-Alive $_ } |
        ForEach-Object { @{ ProcessId = $_.Id; StartTicks = $_.StartTime.Ticks } })
    ConvertTo-Json -InputObject $entries | Set-Content -LiteralPath $Gw.RunFile
}

# ------------------------------------------------------------------ routes

function Get-ActiveApps {
    return @($Gw.All | Where-Object { $Gw.Active.Contains($_.Id) })
}

function Build-GatewayConfig {
    param(
        [hashtable[]] $Apps, [switch] $Validate,
        $Settings = $Gw.Settings,
        [string] $Caddyfile = $Gw.Caddyfile,
        [string] $WebRoot = $Gw.WebRoot
    )
    Assert-GatewayApps -Apps $Apps -Bind $Gw.Bind -PortRanges $Gw.Convention.Ranges `
        -PortSlot $Gw.Convention.Slot -Reserved $Gw.Reserved

    $next = "$Caddyfile.next"
    try {
        New-GatewayCaddyfile -Apps $Apps -OutFile $next -WebRoot $WebRoot -Bind $Gw.Bind `
            -CaddyAdmin $Gw.CaddyAdmin -AdminPort $Gw.AdminPort | Out-Null
        $routeEnv = Get-MergedRouteEnv -Apps $Apps
        if ($Validate) {
            $saved = Push-ProcessEnvironment -Environment $routeEnv
            try {
                $check = & caddy validate --config $next --adapter caddyfile 2>&1
                if ($LASTEXITCODE -ne 0) {
                    throw "Caddy rejected the generated configuration:`n$(($check | Select-Object -Last 8) -join "`n")"
                }
            } finally {
                Pop-ProcessEnvironment -Saved $saved
            }
        }

        $site = Get-JsonProperty $Settings 'site'
        New-LandingPage -Apps $Apps -WebRoot $WebRoot `
            -Title ([string](Get-JsonProperty $site 'title' 'Gateway')) `
            -Tagline ([string](Get-JsonProperty $site 'tagline' '')) `
            -FallbackIcon ([string](Get-JsonProperty $site 'fallbackIcon' '*')) `
            -AdminPath $(if ($Gw.AdminPort) { '/admin/' } else { '' }) | Out-Null
        [IO.File]::Move($next, $Caddyfile, $true)
        return $routeEnv
    } finally {
        [IO.File]::Delete($next)
    }
}

function Get-RegistryVersions {
    param([object[]] $Plugins)
    $result = @{}
    foreach ($plugin in $Plugins) { $result[$plugin.Id] = (Get-FileHash -LiteralPath $plugin.File).Hash }
    return $result
}

function Get-GatewayRestartFields {
    param($Settings)
    foreach ($name in 'bind', 'caddyAdmin', 'runtime', 'logs', 'backups', 'ports') {
        if ((Get-JsonProperty $Gw.StartupSettings $name) -cne (Get-JsonProperty $Settings $name)) { $name }
    }
    $oldAdmin = Get-JsonProperty $Gw.StartupSettings 'admin'
    $newAdmin = Get-JsonProperty $Settings 'admin'
    foreach ($name in 'enabled', 'port', 'sessionHours') {
        if ((Get-JsonProperty $oldAdmin $name) -cne (Get-JsonProperty $newAdmin $name)) { "admin.$name" }
    }
}

function Clear-StaleRuntimeDirs {
    <# Remove orphaned revision folders from previous runs and old ConfigOnly previews
       so .runtime/ does not accumulate indefinitely. #>
    $revisions = Join-Path $Gw.RuntimeDir 'revisions'
    if (Test-Path -LiteralPath $revisions -PathType Container) {
        Get-ChildItem -LiteralPath $revisions -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -cmatch '^[0-9a-f]{32}$' -and -not $_.LinkType } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
    $previews = Join-Path $Gw.RuntimeDir 'previews'
    if (Test-Path -LiteralPath $previews -PathType Container) {
        $cutoff = (Get-Date).AddHours(-24)
        $dirs = @(Get-ChildItem -LiteralPath $previews -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -cmatch '^[0-9a-f]{32}$' -and -not $_.LinkType } |
            Sort-Object LastWriteTime -Descending)
        foreach ($d in ($dirs | Select-Object -Skip 3)) {
            if ($d.LastWriteTime -lt $cutoff -or $dirs.Count -gt 10) {
                Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Remove-GatewayRevision {
    param([string] $Revision)
    if (-not $Revision) { return }
    $parent = [IO.Path]::GetFullPath((Join-Path $Gw.RuntimeDir 'revisions'))
    $target = [IO.Path]::GetFullPath($Revision)
    if ([IO.Path]::GetDirectoryName($target) -eq $parent -and
        [IO.Path]::GetFileName($target) -cmatch '^[0-9a-f]{32}$' -and
        (Test-Path -LiteralPath $target -PathType Container) -and -not (Get-Item -LiteralPath $target).LinkType) {
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-GatewaySelection {
    param([hashtable[]] $All, [string[]] $Add)
    $active = [Collections.Generic.HashSet[string]]::new()
    foreach ($app in $All) {
        $id = $app.Id
        $run = $Gw.Runs[$id]
        $live = $run -and ((Test-Alive $run.Child) -or (Test-Alive $run.Stopper))
        if ($Gw.Active.Contains($id) -and ($app.Enabled -or $live -or ($Gw.ExplicitApps -contains $id))) {
            [void]$active.Add($id)
        }
        if ($app.Enabled -and -not $app.Launch -and $app.Routes.Kind -ne 'none' -and -not $Gw.ExplicitApps) {
            [void]$active.Add($id)
        }
    }
    foreach ($id in $Add) { [void]$active.Add($id) }
    return ,$active
}

function Start-CandidateReload {
    param([hashtable] $Candidate)
    $envMap = [Collections.Generic.Dictionary[string, string]]::new()
    foreach ($pair in $Candidate.RouteEnv.GetEnumerator()) { $envMap[$pair.Key] = [string]$pair.Value }
    # The admin request must return before Caddy can finish draining it.
    $Gw.Reload = $Gw.Hub.Start('caddy', 'caddy',
        [string[]]@('reload', '--config', $Candidate.Caddyfile, '--adapter', 'caddyfile', '--address', $Gw.CaddyAdmin),
        $Gw.Root, $envMap)
    $Gw.Candidate = $Candidate
}

function Update-GatewayRoutes {
    param([switch] $Rescan, [string[]] $Add, [string] $RestartApp)
    if ($Gw.Reload -or $Gw.RouteChange) { throw 'A route update is already in progress. Wait for its result.' }
    if (-not $Gw.CaddyAdmin -or -not (Test-Alive $Gw.Caddy)) { throw 'Caddy cannot receive a live configuration update.' }

    $settings = $Gw.Settings
    $paths = $Gw.Paths
    $all = $Gw.All
    $versions = $Gw.RegistryVersions
    if ($Rescan) {
        $settings = Read-GatewaySettings -Path $Gw.SettingsFile
        $paths = Get-GatewayPaths -Settings $settings -Root $Gw.Root
        $plugins = @(Get-AppPlugin -Dir $Gw.AppsDir)
        $all = @(Resolve-GatewayApps -Plugins $plugins -BaseDir $Gw.Root -Bind $Gw.Bind `
            -Paths $paths -PortOverride $Gw.PortOverride)
        $versions = Get-RegistryVersions $plugins
    }

    $active = Resolve-GatewaySelection -All $all -Add $Add
    $apps = @($all | Where-Object { $active.Contains($_.Id) })
    $restart = $null
    foreach ($app in $apps) {
        $before = $Gw.All | Where-Object { $_.Id -eq $app.Id } | Select-Object -First 1
        if (-not $before -or -not $before.Launch -or $before.Routes.Kind -eq 'none' -or
            -not $Gw.Active.Contains($app.Id)) { continue }
        $oldPorts = $before.Ports.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
        $newPorts = $app.Ports.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
        $run = $Gw.Runs[$app.Id]
        if (($oldPorts -join ',') -ne ($newPorts -join ',') -and
            ((Test-Alive $run.Child) -or (Test-Alive $run.Stopper) -or @(Get-BusyPorts -App $before).Count)) {
            if ($RestartApp -ne $app.Id -or -not $app.Launch -or -not $app.Ports.Count -or -not (Test-Alive $run.Child)) {
                throw "$($app.Id) is using its current routed ports. Use Apply and restart for a managed app, or stop it first."
            }
            $effective = if ($run.App) { $run.App } else { $before }
            $listeners = Get-ListeningPorts -Fresh
            foreach ($port in $app.Ports.Values) {
                if ($listeners[$port] -and $port -notin $effective.Ports.Values) {
                    throw "$($app.Id) cannot restart: candidate port $port is already in use."
                }
            }
            $restart = @{ Id = $app.Id; Before = $effective; After = $app }
        }
    }
    if ($RestartApp -and -not $restart) { throw 'There are no pending routed port changes for this managed app.' }

    $directory = Join-Path $Gw.RuntimeDir "revisions/$([guid]::NewGuid().ToString('N'))"
    $candidate = @{
        All = $all; Active = $active; Settings = $settings; Paths = $paths; RegistryVersions = $versions
        Directory = $directory; Caddyfile = Join-Path $directory 'Caddyfile'; WebRoot = Join-Path $directory 'web'
    }
    try {
        $candidate.RouteEnv = Build-GatewayConfig -Apps $apps -Validate -Settings $settings `
            -Caddyfile $candidate.Caddyfile -WebRoot $candidate.WebRoot
        if ($restart) {
            $Gw.Runs[$restart.Id].Pending = $null
            $null = Stop-GatewayApp -Id $restart.Id
            $restart.Candidate = $candidate
            $restart.Phase = 'starting'
            $restart.Deadline = (Get-Date).AddSeconds(45)
            $Gw.RouteChange = $restart
            Write-GatewayLog "Restarting $($restart.Id) to apply its routed ports."
        } else {
            Start-CandidateReload $candidate
        }
    } catch {
        Remove-GatewayRevision $directory
        throw
    }
}

function Begin-GatewayRestore {
    param([hashtable] $Change, [string] $Reason)
    $run = $Gw.Runs[$Change.Id]
    if (Test-Alive $run.Child) {
        $run.Stopping = $true
        Stop-ProcessTree $run.Child
    }
    Remove-GatewayRevision $Change.Candidate.Directory
    $Change.Phase = 'restoring'
    $Change.Deadline = (Get-Date).AddSeconds(45)
    Write-GatewayLog "$Reason Previous routes are still active. Restoring $($Change.Id)." 'err'
}

function Test-OwnedListeners {
    param([hashtable] $App, $Process)
    if (-not (Test-Alive $Process)) { return $false }
    $listeners = Get-ListeningPorts -Fresh
    $tree = [AppGateway.ProcTree]::Usage($Process.Id, [AppGateway.ProcTree]::Parents())
    foreach ($port in $App.Ports.Values) {
        if (-not $listeners[$port] -or $listeners[$port] -notin $tree.Pids) { return $false }
    }
    return $true
}

function Step-GatewayRouteChange {
    $change = $Gw.RouteChange
    if (-not $change -or $change.Phase -eq 'applying') { return }
    if ((Get-Date) -lt $change.CheckAt) { return }
    $change.CheckAt = (Get-Date).AddMilliseconds(600)
    $run = $Gw.Runs[$change.Id]
    $restoring = $change.Phase -in 'restoring', 'checking-restore'
    if ((Get-Date) -gt $change.Deadline) {
        if ($restoring) {
            $Gw.LastReload = @{ At = Get-Date; Ok = $false; Message = "Previous routes kept. $($change.Id) did not recover in time." }
            Write-GatewayLog $Gw.LastReload.Message 'err'
            $Gw.RouteChange = $null
        } else {
            Begin-GatewayRestore $change "Timed out waiting for $($change.Id) on the candidate ports."
        }
        return
    }

    switch ($change.Phase) {
        { $_ -in 'starting', 'restoring' } {
            $target = if ($restoring) { $change.Before } else { $change.After }
            if ((Test-Alive $run.Child) -or @(Get-BusyPorts -App $target).Count) { return }
            try {
                Invoke-AppLaunch -App $target
                $change.Phase = if ($restoring) { 'checking-restore' } else { 'checking' }
            } catch {
                if ($restoring) {
                    $Gw.LastReload = @{ At = Get-Date; Ok = $false; Message = 'Previous routes kept, but the prior app could not be relaunched.' }
                    $Gw.RouteChange = $null
                } else {
                    Begin-GatewayRestore $change 'The candidate launch failed.'
                }
            }
        }
        'checking' {
            if (-not (Test-Alive $run.Child)) { Begin-GatewayRestore $change 'The candidate app exited.'; return }
            if (-not (Test-OwnedListeners $change.After $run.Child)) { return }
            try {
                Start-CandidateReload $change.Candidate
                $change.Phase = 'applying'
            } catch {
                Begin-GatewayRestore $change 'Unable to submit the candidate routes.'
            }
        }
        'checking-restore' {
            if (-not (Test-OwnedListeners $change.Before $run.Child)) { return }
            $Gw.LastReload = @{ At = Get-Date; Ok = $false; Message = 'Previous routes and app launch restored.' }
            Write-GatewayLog $Gw.LastReload.Message 'err'
            $Gw.RouteChange = $null
        }
    }
}

# -------------------------------------------------------------------- apps

function Get-GatewayApp {
    param([string] $Id)
    $app = $Gw.All | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
    if (-not $app) { throw "Unknown app '$Id'." }
    return $app
}

function Start-GatewayApp {
    <# Launch an app, as start.ps1 does for each selected one. One that is already
       up elsewhere is stopped first when it allows that (or -Force), otherwise
       left alone. Returns what happened, in a sentence. #>
    param([string] $Id, [switch] $Force)

    $app = Get-GatewayApp $Id
    if (-not $app.Launch) { throw "'$Id' declares no launch; the gateway only routes it." }
    $run = Get-RunRecord $Id
    if (Test-Alive $run.Child)   { return "$Id is already running." }
    if (Test-Alive $run.Stopper) { $run.Pending = 'start'; return "$Id is stopping; it will start once its ports free." }

    if (-not $Gw.Active.Contains($Id) -and -not ($Gw.Candidate -and $Gw.Candidate.Active.Contains($Id))) {
        if ($Gw.Reload) { throw 'Wait for the current route update before starting this app.' }
        if ($app.Routes.Kind -ne 'none') {
            Update-GatewayRoutes -Add $Id
        } else {
            Assert-GatewayApps -Apps (@(Get-ActiveApps) + $app) -Bind $Gw.Bind -PortRanges $Gw.Convention.Ranges `
                -PortSlot $Gw.Convention.Slot -Reserved $Gw.Reserved
            [void]$Gw.Active.Add($Id)
        }
    }

    $busy = @(Get-BusyPorts -App $app)
    if ($busy.Count) {
        $held = ($busy | ForEach-Object { "$($_.Name)=$($_.Port)" }) -join ', '
        if (-not ($app.Launch.RestartIfRunning -or $Force)) {
            $run.Note = "already running outside the gateway ($held); left as it is"
            Write-GatewayLog "[SKIP] ${Id}: $($run.Note)." 'err'
            return "$Id is already running outside the gateway ($held). Use restart to take it over."
        }
        Write-GatewayLog "[RESTART] $Id is already running ($held); running its stop.ps1 first."
        Invoke-StopScript -App $app
        $run.Pending = 'start'
        return "$Id was running elsewhere; stopping it first, then starting."
    }

    Invoke-AppLaunch -App $app
    return "$Id started."
}

function Invoke-AppLaunch {
    param([hashtable] $App)

    $run = Get-RunRecord $App.Id
    $appArgs = @('-NoProfile', '-File', $App.Launch.Script) + $App.Launch.Args
    # The gateway's landing page is the one page to open; an app's own would be its
    # internal port.
    if ((Get-Command $App.Launch.Script).Parameters.ContainsKey('NoBrowser')) { $appArgs += '-NoBrowser' }

    $envMap = [Collections.Generic.Dictionary[string, string]]::new()
    foreach ($e in $App.Env.GetEnumerator()) { $envMap[$e.Key] = [string]$e.Value }

    try {
        $proc = $Gw.Hub.Start($App.Id, 'pwsh', [string[]]$appArgs, $App.Root, $envMap)
    } catch {
        $run.Note = "could not start: $($_.Exception.Message)"
        Write-GatewayLog "[SKIP] $($App.Id): $($run.Note)" 'err'
        throw
    }
    $run.App       = $App
    $run.Child     = $proc
    $run.StartedAt = Get-Date
    $run.ExitedAt  = $null
    $run.ExitCode  = $null
    $run.Stopping  = $false
    $run.Pending    = $null
    $run.CpuSamples = @{}
    $run.Starts++
    $run.Note = ''
    Write-GatewayLog "[START] $($App.Id) (PID $($proc.Id))"
    Save-RunFile
}

function Invoke-StopScript {
    <# Run the app's own stop.ps1 as a tracked child: it knows which processes are
       its own. The loop clears Stopper once it exits. #>
    param([hashtable] $App)

    $run = Get-RunRecord $App.Id
    if (-not (Test-Path -LiteralPath $App.Launch.StopScript)) {
        throw "$($App.Id) has no stop.ps1 at $($App.Launch.StopScript)."
    }
    $envMap = [Collections.Generic.Dictionary[string, string]]::new()
    foreach ($e in $App.Env.GetEnumerator()) { $envMap[$e.Key] = [string]$e.Value }
    $run.Stopper  = $Gw.Hub.Start($App.Id, 'pwsh', [string[]]@('-NoProfile', '-File', $App.Launch.StopScript), $App.Root, $envMap)
    $run.Deadline = (Get-Date) + $script:StopTimeout
    Save-RunFile
}

function Stop-ProcessTree {
    param($Process)
    if (-not (Test-Alive $Process)) { return }
    # /T because the real workloads are grandchildren (uv -> python, pwsh -> node),
    # which killing the launcher alone would orphan.
    & taskkill /F /T /PID $Process.Id 2>&1 | Out-Null
}

function Stop-GatewayApp {
    <# Stop an app: the one this gateway started by killing its tree, one started
       elsewhere through its stop.ps1. -Restart starts it again once its ports free.
       Explicit stop also cancels any queued auto-restart backoff. #>
    param([string] $Id, [switch] $Restart)

    $app = Get-GatewayApp $Id
    $run = Get-RunRecord $Id

    if (-not $Restart) {
        $hadPending = $run.Pending -eq 'start'
        $run.Pending = $null
        $run.NotBefore = $null
    }

    if (Test-Alive $run.Child) {
        $run.Stopping = $true
        Write-GatewayLog "[STOP] $Id (PID $($run.Child.Id))"
        Stop-ProcessTree $run.Child
        $run.Deadline = (Get-Date) + $script:StopTimeout
        if ($Restart) { $run.Pending = 'start'; $run.NotBefore = $null }
        return $(if ($Restart) { "$Id is restarting." } else { "$Id stopped." })
    }

    if (Test-Alive $run.Stopper) {
        if ($Restart) { $run.Pending = 'start'; $run.NotBefore = $null }
        return "$Id is already stopping."
    }

    if ($app.Launch -and @(Get-BusyPorts -App $app).Count) {
        Write-GatewayLog "[STOP] $Id is running outside the gateway; running its stop.ps1."
        Invoke-StopScript -App $app
        if ($Restart) { $run.Pending = 'start'; $run.NotBefore = $null }
        return "$Id is stopping through its stop.ps1."
    }

    if ($Restart) {
        $run.Pending = $null
        $run.NotBefore = $null
        return Start-GatewayApp -Id $Id
    }
    if ($hadPending) {
        $run.Deadline = $null
        $run.Note = 'scheduled restart cancelled'
        Write-GatewayLog "[STOP] $Id cancelled scheduled restart."
        return "$Id scheduled restart cancelled."
    }
    return "$Id is not running."
}

function Step-Gateway {
    <# One turn of the supervisor: notice exits, finish pending starts, restart
       what asked to be. Returns $false once the gateway should come down. #>

    $changed = $false
    foreach ($id in @($Gw.Runs.Keys)) {
        $run = $Gw.Runs[$id]
        $app = $Gw.All | Where-Object { $_.Id -eq $id } | Select-Object -First 1

        if ($run.Child -and $run.Child.HasExited -and -not $run.ExitedAt) {
            $run.Child.WaitForExit()   # drains the redirected output before the code is read
            $run.ExitedAt = Get-Date
            $run.ExitCode = $run.Child.ExitCode
            $changed = $true
            if ($run.Stopping) {
                Write-GatewayLog "[EXIT] $id stopped."
            } else {
                Write-GatewayLog "[EXIT] $id exited with $($run.ExitCode); the rest keep running." 'err'
                $run.Note = "exited with $($run.ExitCode)"
                if ($app -and $app.Launch.AutoRestart -and $Gw.RouteChange.Id -ne $id) {
                    $now = Get-Date
                    $run.Crashes.Add($now)
                    $run.Crashes.RemoveAll([Predicate[datetime]] { param($t) $t -lt $now - $script:AutoRestartWindow }) | Out-Null
                    if ($run.Crashes.Count -le $script:AutoRestartLimit) {
                        # Backs off: 2 s, 4 s, 8 s ... so a crash loop does not spin.
                        $run.Pending  = 'start'
                        $run.NotBefore = $now.AddSeconds([Math]::Pow(2, $run.Crashes.Count))
                        $run.Deadline = $now + $script:StopTimeout + [TimeSpan]::FromSeconds(60)
                        Write-GatewayLog "[RESTART] ${id}: automatic restart $($run.Crashes.Count)/$($script:AutoRestartLimit)."
                    } else {
                        $run.Note = "exited with $($run.ExitCode); gave up after $($script:AutoRestartLimit) restarts in $($script:AutoRestartWindow.TotalMinutes) min"
                        Write-GatewayLog "[GIVE UP] ${id}: $($run.Note)." 'err'
                    }
                }
            }
        }

        if ($run.Stopper -and $run.Stopper.HasExited) {
            $run.Stopper.WaitForExit()
            $run.Stopper = $null
            $changed = $true
        }

        if ($run.Pending -eq 'start' -and $app -and -not (Test-Alive $run.Child) -and -not (Test-Alive $run.Stopper)) {
            if ($run.NotBefore -and (Get-Date) -lt $run.NotBefore) { continue }
            if (-not @(Get-BusyPorts -App $app).Count) {
                $run.NotBefore = $null
                try { Invoke-AppLaunch -App $app } catch { $run.Pending = $null }
                $changed = $true
            } elseif ($run.Deadline -and (Get-Date) -gt $run.Deadline) {
                $still = (@(Get-BusyPorts -App $app) | ForEach-Object Port) -join ', '
                $run.Pending = $null
                $run.Note = "port(s) $still still in use after stopping; something it does not own holds them"
                Write-GatewayLog "[SKIP] ${id}: $($run.Note)." 'err'
            }
        }
    }
    if ($changed) { Save-RunFile }

    try { Add-GatewaySample } catch { }
    Step-GatewayRouteChange

    if ($Gw.Reload -and $Gw.Reload.HasExited) {
        $Gw.Reload.WaitForExit()
        $ok = $Gw.Reload.ExitCode -eq 0
        $Gw.LastReload = @{ At = Get-Date; Ok = $ok }
        $candidate = $Gw.Candidate
        if ($ok) {
            Remove-GatewayRevision $Gw.PreviousRevision
            $Gw.PreviousRevision = $Gw.Revision
            $Gw.Revision = $candidate.Directory
            foreach ($key in @('All', 'Active', 'Settings', 'Paths', 'Caddyfile', 'WebRoot', 'RouteEnv', 'RegistryVersions')) {
                $Gw[$key] = $candidate[$key]
            }
            $Gw.PortCache = $null
            $Gw.IconCache = @{}
            $Gw.RouteChange = $null
            Write-GatewayLog 'Caddy applied the new routes and directory.'
        } else {
            if ($Gw.RouteChange) {
                Begin-GatewayRestore $Gw.RouteChange "Caddy refused the candidate (exit $($Gw.Reload.ExitCode))."
            } else {
                Remove-GatewayRevision $candidate.Directory
                Write-GatewayLog "Caddy refused the new routes (exit $($Gw.Reload.ExitCode)); the previous configuration is still active." 'err'
            }
        }
        $Gw.Candidate = $null
        $Gw.Reload = $null
    }

    foreach ($task in @($Gw.Deferred)) {
        if ((Get-Date) -ge $task.At) {
            [void]$Gw.Deferred.Remove($task)
            try { & $task.Action } catch { Write-GatewayLog "[ADMIN] $($_.Exception.Message)" 'err' }
        }
    }

    if ($Gw.Caddy.HasExited) {
        Write-GatewayLog "[EXIT] caddy exited with $($Gw.Caddy.ExitCode); stopping the rest." 'err'
        return $false
    }
    return -not $Gw.ShutdownRequested
}

function Add-GatewaySample {
    <# One point of the history the admin page charts: machine CPU and memory, and
       each live app's. Kept here rather than in the browser so the charts have an
       hour behind them the moment the page opens. #>
    $now = Get-Date
    if ($Gw.NextSample -and $now -lt $Gw.NextSample) { return }
    $Gw.NextSample = $now.AddSeconds($script:SampleSeconds)
    if (-not $Gw.History) { $Gw.History = [Collections.Generic.List[object]]::new() }

    $mem       = [AppGateway.SystemStats]::Memory()
    $parents   = [AppGateway.ProcTree]::Parents()
    $listening = Get-ListeningPorts
    $apps = @{}
    foreach ($a in $Gw.All) {
        $u = (Get-AppStatus -App $a -Parents $parents -Listening $listening -SampleChannel 'History').usage
        if ($u) { $apps[$a.Id] = @{ Cpu = $u.cpu; Mem = $u.memory } }
    }
    $sysCpu = [AppGateway.SystemStats]::Cpu()
    $Gw.History.Add(@{
        T    = [DateTimeOffset]::new($now).ToUnixTimeSeconds()
        Cpu  = $(if ($sysCpu -ge 0) { $sysCpu } else { $null })
        Mem  = [long]($mem[0] - $mem[1])
        Apps = $apps
    })
    while ($Gw.History.Count -gt $script:SampleKeep) { $Gw.History.RemoveAt(0) }
}

function Add-DeferredAction {
    <# Run after the current response has gone out: an action that would cut the
       connection serving it (stopping the gateway) must not race its own reply. #>
    param([scriptblock] $Action, [int] $DelayMs = 400)
    [void]$Gw.Deferred.Add(@{ At = (Get-Date).AddMilliseconds($DelayMs); Action = $Action })
}

function Stop-Gateway {
    <# Everything this gateway started, apps first so Caddy keeps answering until
       the end. #>
    foreach ($run in $Gw.Runs.Values) {
        foreach ($p in $run.Child, $run.Stopper) {
            if (Test-Alive $p) {
                Write-Host "[STOP] PID $($p.Id)" -ForegroundColor Yellow
                Stop-ProcessTree $p
            }
        }
    }
    if (Test-Alive $Gw.Caddy) {
        Write-Host "[STOP] caddy (PID $($Gw.Caddy.Id))" -ForegroundColor Yellow
        Stop-ProcessTree $Gw.Caddy
    }
}

# ------------------------------------------------------------------ status

function Test-LaunchChange {
    param($Before, $After)
    if ($Before.Root -ne $After.Root -or [bool]$Before.Launch -ne [bool]$After.Launch) { return $true }
    if (($Before.Launch.Args | ConvertTo-Json -Compress -AsArray) -cne ($After.Launch.Args | ConvertTo-Json -Compress -AsArray)) {
        return $true
    }
    foreach ($name in 'Ports', 'Env') {
        if ($Before[$name].Count -ne $After[$name].Count) { return $true }
        foreach ($key in $Before[$name].Keys) {
            if (-not $After[$name].ContainsKey($key) -or $Before[$name][$key] -cne $After[$name][$key]) { return $true }
        }
    }
    return $false
}

function Measure-AppCpuPercent {
    <# Per-PID delta CPU over all cores (0–100%). Tracking each (pid, startTime)
       independently avoids false zeros when a short-lived child exits and avoids
       false spikes on first sample. Separate channels keep 10s history clean from
       3s /overview polling. #>
    param([hashtable] $Record, [int] $RootPid, $Usage, [string] $Channel = 'Live', [double] $MinSeconds = 1.5)

    if (-not $Record.CpuSamples) { $Record.CpuSamples = @{} }
    $now = Get-Date
    $prev = $Record.CpuSamples[$Channel]
    if (-not $prev -or $prev.Pid -ne $RootPid) {
        $Record.CpuSamples[$Channel] = @{ Pid = $RootPid; At = $now; ProcCpu = $Usage.ProcCpu; LastCpu = $null }
        return $null
    }
    $dt = ($now - $prev.At).TotalSeconds
    if ($dt -lt $MinSeconds) { return $prev.LastCpu }

    $delta = 0.0
    foreach ($kv in $Usage.ProcCpu.GetEnumerator()) {
        $prevCpu = 0.0
        if ($prev.ProcCpu -and $prev.ProcCpu.TryGetValue($kv.Key, [ref]$prevCpu)) {
            if ($kv.Value -gt $prevCpu) { $delta += ($kv.Value - $prevCpu) }
        } else {
            # Brand-new child process created after the previous sample: count its CPU so far.
            $startAt = [datetime]::MinValue
            if ($Usage.ProcStart -and $Usage.ProcStart.TryGetValue($kv.Key, [ref]$startAt) -and $startAt -ge $prev.At) {
                $delta += $kv.Value
            }
        }
    }
    $pct = [Math]::Round([Math]::Max(0.0, [Math]::Min(100.0, $delta / $dt / [Environment]::ProcessorCount * 100.0)), 2)
    $Record.CpuSamples[$Channel] = @{ Pid = $RootPid; At = $now; ProcCpu = $Usage.ProcCpu; LastCpu = $pct }
    return $pct
}

function Get-AppStatus {
    <# One app as the admin page shows it. #>
    param([hashtable] $App, $Parents, [hashtable] $Listening, [string] $SampleChannel = 'Live')

    $run = $Gw.Runs[$App.Id]
    $alive   = $run -and (Test-Alive $run.Child)
    $stopper = $run -and (Test-Alive $run.Stopper)
    $effective = if ($alive -and $run.App) { $run.App } else { $App }

    $ports = @(foreach ($p in $effective.Ports.GetEnumerator() | Sort-Object Value) {
        $owner = $Listening[[int]$p.Value]
        [ordered]@{ name = $p.Key; port = $p.Value; listening = $null -ne $owner; pid = $owner }
    })
    $anyListening = @($ports | Where-Object { $_.listening }).Count -gt 0
    $allListening = $ports.Count -and @($ports | Where-Object { -not $_.listening }).Count -eq 0

    $state = if ($stopper -or ($run -and $run.Stopping -and $alive)) { 'stopping' }
             elseif ($run -and $run.Pending -eq 'start' -and -not $alive) { 'starting' }
             elseif ($alive -and ($allListening -or -not $ports.Count)) { 'running' }
             elseif ($alive) { 'starting' }
             elseif ($anyListening) { 'external' }
             elseif ($run -and $null -ne $run.ExitCode -and -not $run.Stopping) { 'exited' }
             elseif (-not $App.Launch) { 'routed' }
             else { 'stopped' }

    $usage = $null
    $rootPid = if ($alive) { $run.Child.Id } elseif ($anyListening) { ($ports | Where-Object { $_.listening } | Select-Object -First 1).pid } else { $null }
    if ($rootPid) {
        $u = [AppGateway.ProcTree]::Usage([int]$rootPid, $Parents)
        $record = Get-RunRecord $App.Id
        $minSec = if ($SampleChannel -eq 'History') { 5.0 } else { 1.5 }
        $cpu = Measure-AppCpuPercent -Record $record -RootPid ([int]$rootPid) -Usage $u -Channel $SampleChannel -MinSeconds $minSec
        # Fall back to the other channel's latest reading on the very first poll so UI isn't blank.
        if ($null -eq $cpu -and $SampleChannel -eq 'Live' -and $record.CpuSamples['History']) {
            $cpu = $record.CpuSamples['History'].LastCpu
        }
        $usage = [ordered]@{ pids = @($u.Pids); memory = $u.WorkingSet; cpu = $cpu; threads = $u.Threads }
    }

    return [ordered]@{
        id          = $App.Id
        name        = $App.Name
        description = $App.Description
        icon        = $App.Icon
        iconUrl     = $(if ($App.IconFile) { "api/icons/$($App.Id)?v=$($App.IconHash)" })
        enabled     = $App.Enabled
        hidden      = $App.Hidden
        active      = $Gw.Active.Contains($App.Id)
        basePath    = $App.BasePath
        probe       = $App.Probe
        root        = $App.Root
        routes      = $App.Routes.Kind
        launch      = [bool]$App.Launch
        autoRestart = [bool]($App.Launch -and $App.Launch.AutoRestart)
        restartIfRunning = [bool]($App.Launch -and $App.Launch.RestartIfRunning)
        args        = @(if ($App.Launch) { $App.Launch.Args })
        env         = @($effective.Env.Keys | Sort-Object)
        needsRestart = [bool]($alive -and (Test-LaunchChange $effective $App))
        state       = $state
        pid         = $(if ($alive) { $run.Child.Id } else { $rootPid })
        managed     = [bool]$alive
        startedAt   = $(if ($run -and $alive) { $run.StartedAt.ToString('o') })
        exitedAt    = $(if ($run -and $run.ExitedAt) { $run.ExitedAt.ToString('o') })
        exitCode    = $(if ($run) { $run.ExitCode })
        starts      = $(if ($run) { $run.Starts } else { 0 })
        pending     = $(if ($run) { $run.Pending })
        note        = $(if ($run) { $run.Note } else { '' })
        ports       = $ports
        usage       = $usage
        localUrl    = $effective.LocalUrl
    }
}
