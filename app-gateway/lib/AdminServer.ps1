# The admin page: static files from admin/ and a JSON API under /admin/api/,
# served by the gateway's own process so it can see and steer every child.
#
# http.sys (HttpListener) answers on localhost:<admin.port>; Caddy proxies
# /admin/* to it. Requests are handled one at a time on the supervisor loop,
# which is plenty for one administrator and means no handler ever races the
# supervisor over the state table. A handler therefore never waits on anything
# slow — see Update-GatewayRoutes for the one that would deadlock.

$script:AdminCookie  = 'gw_admin'
$script:MaxBodyBytes = 2MB
$script:StaticTypes  = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.svg'  = 'image/svg+xml'
}

function Start-AdminListener {
    param([int] $Port)
    $listener = [Net.HttpListener]::new()
    $listener.Prefixes.Add("http://localhost:$Port/admin/")
    $listener.Start()
    return $listener
}

function Invoke-AdminPump {
    <# Serve whatever requests are waiting, blocking up to $WaitMs for the first.
       This is also the loop's sleep. #>
    param([int] $WaitMs = 250)

    if (-not $Gw.Listener) { Start-Sleep -Milliseconds $WaitMs; return }
    for ($i = 0; $i -lt 25; $i++) {
        if (-not $Gw.AdminTask) { $Gw.AdminTask = $Gw.Listener.GetContextAsync() }
        try {
            if (-not $Gw.AdminTask.Wait($(if ($i) { 0 } else { $WaitMs }))) { return }
            $ctx = $Gw.AdminTask.Result
        } catch {
            $Gw.AdminTask = $null
            return
        } finally {
            if ($Gw.AdminTask -and $Gw.AdminTask.IsCompleted) { $Gw.AdminTask = $null }
        }
        try {
            Invoke-AdminRequest -Ctx $ctx
        } catch {
            if (Test-ClientDisconnect $_.Exception) { continue }
            try {
                $status = if ($_.Exception.Data.Contains('status')) { [int]$_.Exception.Data['status'] } else { 500 }
                if ($status -ge 500) { Write-GatewayLog "[ADMIN] $($ctx.Request.HttpMethod) $($ctx.Request.Url.AbsolutePath): $($_.Exception.Message)" 'err' }
                Send-AdminJson -Res $ctx.Response -Status $status -Body @{ error = $_.Exception.Message }
            } catch { }
        } finally {
            try { $ctx.Response.Close() } catch { }
        }
    }
}

function Stop-AdminRequest {
    param([int] $Status, [string] $Message)
    $e = [InvalidOperationException]::new($Message)
    $e.Data['status'] = $Status
    throw $e
}

function Test-ClientDisconnect {
    <# True when the browser closed the HTTP connection mid-response (e.g. page
       reload or tab close). Normal HTTP churn — not a server error. #>
    param([Exception] $Exception)
    for ($e = $Exception; $null -ne $e; $e = $e.InnerException) {
        if ($e -is [Net.HttpListenerException] -and $e.ErrorCode -in 64, 995, 1229) { return $true }
        if ($e -is [ObjectDisposedException]) { return $true }
    }
    return $false
}

# ----------------------------------------------------------------- helpers

function Send-AdminBytes {
    param($Res, [byte[]] $Bytes, [string] $Type, [int] $Status = 200)
    $Res.StatusCode = $Status
    $Res.ContentType = $Type
    $Res.ContentLength64 = $Bytes.Length
    $Res.OutputStream.Write($Bytes, 0, $Bytes.Length)
}

function Send-AdminJson {
    param($Res, $Body, [int] $Status = 200)
    $Res.Headers['Cache-Control'] = 'no-store'
    $json = ConvertTo-Json -InputObject $Body -Depth 12 -Compress
    Send-AdminBytes -Res $Res -Status $Status -Type 'application/json; charset=utf-8' `
        -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($json))
}

function Send-AdminText {
    param($Res, [string] $Text, [string] $FileName, [int] $Status = 200)
    $Res.Headers['Cache-Control'] = 'no-store'
    if ($FileName) { $Res.Headers['Content-Disposition'] = "attachment; filename=`"$FileName`"" }
    Send-AdminBytes -Res $Res -Status $Status -Type 'text/plain; charset=utf-8' `
        -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

function Read-AdminBody {
    param($Req)
    if ($Req.ContentLength64 -gt $script:MaxBodyBytes) { Stop-AdminRequest 413 'Request body too large.' }
    $reader = [IO.StreamReader]::new($Req.InputStream, [Text.Encoding]::UTF8)
    try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($text.Length -gt $script:MaxBodyBytes) { Stop-AdminRequest 413 'Request body too large.' }
    if (-not $text.Trim()) { return @{} }
    try { $body = $text | ConvertFrom-Json -AsHashtable } catch { Stop-AdminRequest 400 'Body is not valid JSON.' }
    if ($body -isnot [hashtable]) { Stop-AdminRequest 400 'Body must be a JSON object.' }
    return $body
}

function Get-AdminClient {
    <# Who is asking. Behind the tunnel every request comes from Caddy on loopback,
       so the edge's own header is preferred; Caddy replaces any X-Forwarded-For it
       does not trust, which makes its last entry the real peer otherwise. #>
    param($Req)
    $cf = $Req.Headers['Cf-Connecting-IP']
    if ($cf) { return $cf.Trim() }
    $xff = $Req.Headers['X-Forwarded-For']
    if ($xff) { return ($xff -split ',')[-1].Trim() }
    return $Req.RemoteEndPoint.Address.ToString()
}

function Test-SecureRequest {
    param($Req)
    return "$($Req.Headers['Cf-Visitor'])" -match 'https' -or $Req.Headers['X-Forwarded-Proto'] -eq 'https'
}

function Test-DirectLoopbackRequest {
    <# True only when the request arrived directly from loopback on this host,
       not through Cloudflare Tunnel or a remote/LAN reverse proxy. #>
    param($Req)
    if ($Req.Headers['Cf-Connecting-IP'] -or $Req.Headers['Cf-Ray'] -or $Req.Headers['Cf-Visitor']) { return $false }
    $clientIp = $null
    if (-not [Net.IPAddress]::TryParse((Get-AdminClient $Req), [ref]$clientIp) -or -not [Net.IPAddress]::IsLoopback($clientIp)) {
        return $false
    }
    $xfh = [string]$Req.Headers['X-Forwarded-Host']
    if ($xfh) {
        $hostOnly = ($xfh -split ',')[0].Trim()
        if ($hostOnly -match '^\[([^\]]+)\](:\d+)?$') { $hostOnly = "[$($Matches[1])]" }
        elseif ($hostOnly -match '^([^:]+)(:\d+)?$') { $hostOnly = $Matches[1] }
        if ($hostOnly -notin '127.0.0.1', 'localhost', '[::1]') { return $false }
    }
    return $true
}

function Set-AdminCookie {
    param($Req, $Res, [string] $Value, [int] $MaxAge)
    $secure = if (Test-SecureRequest $Req) { '; Secure' } else { '' }
    $Res.AppendHeader('Set-Cookie', "$($script:AdminCookie)=$Value; Path=/admin/; HttpOnly; SameSite=Strict; Max-Age=$MaxAge$secure")
}

function Get-AdminCookie {
    param($Req)
    $raw = $Req.Headers['Cookie']
    if (-not $raw) { return $null }
    foreach ($part in $raw -split ';') {
        $kv = $part.Trim() -split '=', 2
        if ($kv[0] -eq $script:AdminCookie -and $kv.Count -eq 2) { return $kv[1] }
    }
    return $null
}

function Assert-AppId {
    param([string] $Id)
    if ($Id -notmatch '^[a-z0-9][a-z0-9._-]*$') { Stop-AdminRequest 400 "Bad app id '$Id'." }
}

function Read-SharedText {
    <# A file another process may be appending to, last $MaxBytes of it. #>
    param([string] $Path, [long] $MaxBytes = 10MB)
    $fs = [IO.FileStream]::new($Path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
        if ($fs.Length -gt $MaxBytes) { $fs.Seek(-$MaxBytes, 'End') | Out-Null }
        $reader = [IO.StreamReader]::new($fs, [Text.Encoding]::UTF8)
        return $reader.ReadToEnd()
    } finally { $fs.Dispose() }
}

# ----------------------------------------------------------------- request

function Invoke-AdminRequest {
    param($Ctx)
    $req = $Ctx.Request
    $res = $Ctx.Response

    $res.Headers['X-Content-Type-Options'] = 'nosniff'
    $res.Headers['X-Frame-Options'] = 'DENY'
    $res.Headers['Referrer-Policy'] = 'no-referrer'
    $res.Headers['Content-Security-Policy'] =
        "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

    # http.sys listens on every address and only filters by Host; the page is
    # meant to be reached through Caddy, which connects over loopback.
    if (-not $req.IsLocal) { Stop-AdminRequest 403 'Forbidden.' }

    $path = $req.Url.AbsolutePath
    if (-not $path.StartsWith('/admin/')) { Stop-AdminRequest 404 'Not found.' }
    $rel = $path.Substring(6)

    if ($rel.StartsWith('/api/')) {
        Invoke-AdminApi -Req $req -Res $res -Route $rel.Substring(4)
        return
    }

    if ($req.HttpMethod -notin 'GET', 'HEAD') { Stop-AdminRequest 405 'Method not allowed.' }
    if ($rel -eq '/') { $rel = '/index.html' }
    if ($rel -notmatch '^/[a-z0-9-]+\.(html|js|css|svg)$') { Stop-AdminRequest 404 'Not found.' }
    $file = Join-Path $Gw.AdminWeb $rel.Substring(1)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-AdminRequest 404 'Not found.' }
    $res.Headers['Cache-Control'] = 'no-cache'
    Send-AdminBytes -Res $res -Type $script:StaticTypes[[IO.Path]::GetExtension($file)] `
        -Bytes ([IO.File]::ReadAllBytes($file))
}

function Invoke-AdminApi {
    param($Req, $Res, [string] $Route)

    $method = $Req.HttpMethod
    $client = Get-AdminClient $Req
    $auth   = $Gw.Auth

    # ---- unauthenticated -------------------------------------------------
    if ($Route -eq '/session' -and $method -eq 'GET') {
        $s = Get-AdminSession -Auth $auth -Token (Get-AdminCookie $Req) -Passive
        if (-not $s) { Send-AdminJson -Res $Res -Body @{ authenticated = $false }; return }
        Send-AdminJson -Res $Res -Body @{ authenticated = $true; user = $s.User; csrf = $s.Csrf; id = $s.Id }
        return
    }

    if ($Route -eq '/local-apps' -and $method -eq 'GET') {
        if (-not (Test-DirectLoopbackRequest $Req)) { Stop-AdminRequest 403 'Local directory is only available on the gateway host.' }
        $s = Get-AdminSession -Auth $auth -Token (Get-AdminCookie $Req) -Passive
        $site = Get-JsonProperty $Gw.Settings 'site'
        $fallback = [string](Get-JsonProperty $site 'fallbackIcon' '*')
        $localApps = @(Get-ActiveApps | Where-Object { $_.LocalUrl -and -not $_.Hidden } | ForEach-Object {
            $uri = [uri]$_.LocalUrl
            [ordered]@{
                id          = $_.Id
                name        = $_.Name
                description = $_.Description
                url         = $_.LocalUrl
                address     = ":$($uri.Port)$($uri.PathAndQuery)"
                icon        = $(if ($_.Icon) { $_.Icon } else { $fallback })
                iconUrl     = $(if ($s -and $_.IconFile) { "/admin/api/icons/$($_.Id)?v=$($_.IconHash)" })
            }
        })
        Send-AdminJson -Res $Res -Body @{ apps = $localApps }
        return
    }

    if ($Route -eq '/login' -and $method -eq 'POST') {
        # JSON only: a cross-site form cannot send it without a preflight.
        if ("$($Req.ContentType)" -notlike 'application/json*') { Stop-AdminRequest 415 'Expected JSON.' }
        $block = Get-LoginBlock -Auth $auth -Client $client
        if ($block) {
            Write-AdminAudit -Auth $auth -Event 'login' -Ok $false -Client $client -Detail 'refused: locked out'
            Stop-AdminRequest 429 $block
        }
        $body = Read-AdminBody $Req
        $userOk = [string]$body.user -ceq $auth.User
        # Always hash, so a wrong user name takes as long as a wrong password.
        $passOk = Test-PasswordHash -Password ([string]$body.password) -Stored $auth.PasswordHash
        if (-not ($userOk -and $passOk)) {
            Register-LoginFailure -Auth $auth -Client $client
            Write-AdminAudit -Auth $auth -Event 'login' -Ok $false -Client $client -User ([string]$body.user) -Detail 'wrong user name or password'
            Stop-AdminRequest 401 'Wrong user name or password.'
        }
        $auth.Failures.Remove($client)
        $new = New-AdminSession -Auth $auth -Client $client -UserAgent ([string]$Req.UserAgent)
        Set-AdminCookie -Req $Req -Res $Res -Value $new.Token -MaxAge ([int]$script:SessionMaxAge.TotalSeconds)
        Write-AdminAudit -Auth $auth -Event 'login' -Client $client -User $auth.User
        Send-AdminJson -Res $Res -Body @{ authenticated = $true; user = $auth.User; csrf = $new.Session.Csrf; id = $new.Session.Id }
        return
    }

    # ---- everything else needs a session ---------------------------------
    $passivePoll = ($method -eq 'GET') -and ($Req.Headers['X-Gateway-Poll'] -eq '1')
    $session = Get-AdminSession -Auth $auth -Token (Get-AdminCookie $Req) -Passive:$passivePoll
    if (-not $session) { Stop-AdminRequest 401 'Not signed in.' }

    if ($method -ne 'GET') {
        $csrf = [string]$Req.Headers['X-CSRF-Token']
        if (-not $csrf -or -not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals(
                [Text.Encoding]::UTF8.GetBytes($csrf), [Text.Encoding]::UTF8.GetBytes($session.Csrf))) {
            Stop-AdminRequest 403 'Missing or stale CSRF token; reload the page.'
        }
    }

    $audit = {
        param([string] $Event, [string] $Detail = '', [bool] $Ok = $true)
        Write-AdminAudit -Auth $auth -Event $Event -Detail $Detail -Ok $Ok -Client $client -User $session.User
    }

    switch -Regex ("$method $Route") {
        '^POST /logout$' {
            $auth.Sessions.Remove($session.Hash)
            Set-AdminCookie -Req $Req -Res $Res -Value '' -MaxAge 0
            & $audit 'logout'
            Send-AdminJson -Res $Res -Body @{ ok = $true }
            return
        }

        '^GET /overview$' { Send-AdminJson -Res $Res -Body (Get-AdminOverview); return }

        '^GET /icons/([a-z0-9._-]+)$' {
            $id = $Matches[1]
            $app = $Gw.All | Where-Object { $_.Id -eq $id } | Select-Object -First 1
            if (-not $app.IconFile) { Stop-AdminRequest 404 'No file icon is registered.' }
            try { $icon = Read-AppIcon -Root $app.Root -File $app.IconFile }
            catch { Stop-AdminRequest 404 'The registered icon is unavailable.' }
            $Res.Headers['Cache-Control'] = 'private, no-store'
            Send-AdminBytes -Res $Res -Type $icon.Type -Bytes $icon.Bytes
            return
        }

        '^GET /apps$' {
            $parents   = [AppGateway.ProcTree]::Parents()
            $listening = Get-ListeningPorts
            $apps = @($Gw.All | ForEach-Object { Get-AppStatus -App $_ -Parents $parents -Listening $listening })
            Send-AdminJson -Res $Res -Body @{ apps = $apps; reloading = [bool]($Gw.Reload -or $Gw.RouteChange) }
            return
        }

        '^POST /apps/([a-z0-9._-]+)/(start|stop|restart|enable|disable)$' {
            $id = $Matches[1]; $verb = $Matches[2]
            if ($Gw.RouteChange.Id -eq $id) { Stop-AdminRequest 409 'Wait for the route change for this app to finish.' }
            $null = Get-GatewayApp $id
            try {
                $message = switch ($verb) {
                    'start'   { Start-GatewayApp -Id $id -Force }
                    'stop'    { Stop-GatewayApp -Id $id }
                    'restart' { Stop-GatewayApp -Id $id -Restart }
                    default {
                        $plugins = @(Get-AppPlugin -Dir $Gw.AppsDir)
                        Set-AppEnabled -Plugins $plugins -Id $id -Enabled ($verb -eq 'enable')
                        ($Gw.All | Where-Object { $_.Id -eq $id }).Enabled = ($verb -eq 'enable')
                        "$id ${verb}d. It is $(if ($verb -eq 'enable') { 'included in' } else { 'left out of' }) the next plain start.ps1."
                    }
                }
            } catch {
                & $audit "app.$verb" "${id}: $($_.Exception.Message)" $false
                Stop-AdminRequest 409 $_.Exception.Message
            }
            & $audit "app.$verb" $id
            $Gw.PortCache = $null
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = [string]$message }
            return
        }

        '^GET /logs$' {
            $sources = [Collections.Generic.SortedSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach ($s in $Gw.Hub.Sources()) { [void]$sources.Add($s) }
            foreach ($a in $Gw.All) { if ($a.Launch) { [void]$sources.Add($a.Id) } }
            foreach ($s in 'gateway', 'caddy') { [void]$sources.Add($s) }
            Send-AdminJson -Res $Res -Body @{ sources = @($sources); last = $Gw.Hub.LastSeq }
            return
        }

        '^GET /logs/([a-z0-9._-]+)$' {
            $source = $Matches[1]
            $after = 0L;  $null = [long]::TryParse([string]$Req.QueryString['after'], [ref]$after)
            $max   = 1000; $null = [int]::TryParse([string]$Req.QueryString['max'], [ref]$max)
            $max   = [Math]::Min(5000, [Math]::Max(1, $max))
            # "_all" cannot be an app id, which starts with a letter or digit.
            $read = if ($source -eq '_all') { $Gw.Hub.ReadAll($after, $max) } else { $Gw.Hub.Read($source, $after, $max) }
            $lines = @($read | ForEach-Object {
                [ordered]@{ seq = $_.Seq; time = $_.Time.ToString('o'); source = $_.Source; stream = $_.Stream; text = $_.Text }
            })
            Send-AdminJson -Res $Res -Body @{ source = $source; lines = $lines; last = $Gw.Hub.LastSeq }
            return
        }

        '^GET /logs/([a-z0-9._-]+)/file$' {
            $source = $Matches[1]
            $file = $Gw.Hub.FileFor($source)
            if (-not $file -or -not (Test-Path -LiteralPath $file)) { Stop-AdminRequest 404 "No log file for '$source' yet." }
            Send-AdminText -Res $Res -Text (Read-SharedText $file) -FileName "$source.log"
            return
        }

        '^POST /logs/([a-z0-9._-]+)/clear$' {
            $Gw.Hub.Clear($Matches[1])
            Send-AdminJson -Res $Res -Body @{ ok = $true }
            return
        }

        '^GET /config/apps$' {
            $files = @(Get-ChildItem -LiteralPath $Gw.AppsDir -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
                [ordered]@{ id = $_.BaseName; file = $_.Name; version = Get-GatewayFileVersion $_.FullName; size = $_.Length; modified = $_.LastWriteTime.ToString('o') }
            })
            Send-AdminJson -Res $Res -Body @{ files = $files; dir = $Gw.AppsDir }
            return
        }

        '^GET /config/apps/([a-z0-9._-]+)$' {
            $id = $Matches[1]
            $file = Join-Path $Gw.AppsDir "$id.json"
            if (-not (Test-Path -LiteralPath $file)) { Stop-AdminRequest 404 "apps/$id.json does not exist." }
            $version = Get-GatewayFileVersion $file
            Send-AdminJson -Res $Res -Body @{ id = $id; text = [IO.File]::ReadAllText($file); version = $version; applied = $Gw.RegistryVersions[$id] -eq $version }
            return
        }

        '^POST /config/apps/([a-z0-9._-]+)/preview$' {
            $id = $Matches[1]; Assert-AppId $id
            $body = Read-AdminBody $Req
            try { $preview = Resolve-AdminDraft -Id $id -Text ([string]$body.text) }
            catch { Stop-AdminRequest 422 $_.Exception.Message }
            Send-AdminJson -Res $Res -Body $preview
            return
        }

        '^GET /config/apps/([a-z0-9._-]+)/history$' {
            $id = $Matches[1]
            $versions = @(Get-ChildItem -LiteralPath $Gw.BackupDir -Filter "$id.*.json" -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match "^$([regex]::Escape($id))\.\d{8}-\d{6}(?:-\d{7})?(\.deleted)?\.json$" } |
                Sort-Object Name -Descending | Select-Object -First 50 | ForEach-Object {
                    [ordered]@{ file = $_.Name; saved = $_.LastWriteTime.ToString('o'); size = $_.Length; deleted = $_.Name -like '*.deleted.json' }
                })
            Send-AdminJson -Res $Res -Body @{ id = $id; versions = $versions }
            return
        }

        '^GET /config/backups/([a-z0-9._-]+\.json)$' {
            $file = Join-Path $Gw.BackupDir $Matches[1]
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-AdminRequest 404 'No such backup.' }
            Send-AdminJson -Res $Res -Body @{ file = $Matches[1]; text = [IO.File]::ReadAllText($file) }
            return
        }

        '^GET /metrics$' { Send-AdminJson -Res $Res -Body (Get-AdminMetrics); return }

        '^POST /config/apps/([a-z0-9._-]+)$' {
            $id = $Matches[1]; Assert-AppId $id
            $body = Read-AdminBody $Req
            $file = Join-Path $Gw.AppsDir "$id.json"
            $exists = Test-Path -LiteralPath $file
            if ($body.create -and $exists) { Stop-AdminRequest 409 "apps/$id.json already exists." }
            if (-not $body.create -and -not $exists) { Stop-AdminRequest 404 "apps/$id.json does not exist." }
            $text = [string]$body.text
            if ($exists -and $body.version -and $body.version -ne (Get-GatewayFileVersion $file)) {
                Stop-AdminRequest 409 'This file changed on disk. Reopen it before saving.'
            }
            try { $preview = Resolve-AdminDraft -Id $id -Text $text }
            catch { Stop-AdminRequest 422 $_.Exception.Message }
            if (-not $text.EndsWith("`n")) { $text += "`n" }
            if ($exists) { Copy-Item -LiteralPath $file -Destination (Join-Path $Gw.BackupDir "$id.$((Get-Date).ToString('yyyyMMdd-HHmmss-fffffff')).json") }
            Write-GatewayText -Path $file -Text $text
            & $audit $(if ($body.create) { 'config.create' } else { 'config.save' }) "apps/$id.json"
            Send-AdminJson -Res $Res -Body @{ ok = $true; version = Get-GatewayFileVersion $file
                preview = $preview; message = "Saved apps/$id.json. Apply routes when ready." }
            return
        }

        '^POST /config/apps/([a-z0-9._-]+)/delete$' {
            $id = $Matches[1]; Assert-AppId $id
            $file = Join-Path $Gw.AppsDir "$id.json"
            if (-not (Test-Path -LiteralPath $file)) { Stop-AdminRequest 404 "apps/$id.json does not exist." }
            $run = $Gw.Runs[$id]
            if ($run -and ((Test-Alive $run.Child) -or (Test-Alive $run.Stopper))) { Stop-AdminRequest 409 "$id is running; stop it first." }
            if (@(Get-ChildItem -LiteralPath $Gw.AppsDir -Filter '*.json' -File).Count -le 1) { Stop-AdminRequest 409 'This is the last app; the gateway needs at least one.' }
            Move-Item -LiteralPath $file -Destination (Join-Path $Gw.BackupDir "$id.$((Get-Date).ToString('yyyyMMdd-HHmmss-fffffff')).deleted.json")
            & $audit 'config.delete' "apps/$id.json"
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = "Removed apps/$id.json and kept a backup. Apply routes when ready." }
            return
        }

        '^GET /config/files$' {
            $settingsText = if (Test-Path -LiteralPath $Gw.SettingsFile) {
                $s = Read-JsonFile $Gw.SettingsFile
                $adminNode = Get-JsonProperty $s 'admin'
                if ($adminNode) {
                    $adminNode.PSObject.Properties.Remove('passwordHash')
                    $adminNode.PSObject.Properties.Remove('user')
                }
                $s | ConvertTo-Json -Depth 20
            } else { '' }
            Send-AdminJson -Res $Res -Body ([ordered]@{
                caddyfile   = $(if (Test-Path -LiteralPath $Gw.Caddyfile) { [IO.File]::ReadAllText($Gw.Caddyfile) } else { '' })
                gateway     = $settingsText
                schema      = [IO.File]::ReadAllText((Join-Path $Gw.Root 'schema\app.schema.json'))
                ports       = $(if (Test-Path -LiteralPath $Gw.PortsFile) { [IO.File]::ReadAllText($Gw.PortsFile) } else { '' })
                routeEnv    = @($Gw.RouteEnv.Keys | Sort-Object)
                site        = (Get-JsonProperty $s 'site' @{})
                lastReload  = $(if ($Gw.LastReload) { @{ at = $Gw.LastReload.At.ToString('o'); ok = $Gw.LastReload.Ok } })
            })
            return
        }

        '^GET /config/gateway$' {
            $settings = Read-GatewaySettings $Gw.SettingsFile
            $admin = Get-JsonProperty $settings 'admin'
            if ($admin) {
                $admin.PSObject.Properties.Remove('user')
                $admin.PSObject.Properties.Remove('passwordHash')
            }
            Send-AdminJson -Res $Res -Body @{
                text = $settings | ConvertTo-Json -Depth 20
                version = $(if (Test-Path -LiteralPath $Gw.SettingsFile) { Get-GatewayFileVersion $Gw.SettingsFile })
                needsRestart = @(Get-GatewayRestartFields $settings)
            }
            return
        }

        '^POST /config/gateway(/preview)?$' {
            $previewOnly = $Matches[1] -eq '/preview'
            $body = Read-AdminBody $Req
            if (-not $previewOnly -and (Test-Path -LiteralPath $Gw.SettingsFile) -and
                $body.version -ne (Get-GatewayFileVersion $Gw.SettingsFile)) {
                Stop-AdminRequest 409 'gateway.json changed on disk. Reopen it before saving.'
            }
            try {
                try { $settings = ([string]$body.text) | ConvertFrom-Json }
                catch { throw 'Invalid JSON. Check the editor for the line and column.' }
                if ($settings -isnot [pscustomobject]) { throw 'gateway.json must contain a JSON object.' }
                $admin = Get-JsonProperty $settings 'admin'
                if ($admin -and $admin -isnot [pscustomobject]) { throw 'gateway.json admin must be a JSON object.' }
                if (Test-LegacyAdminCredential $admin) {
                    throw 'Manage credentials from Security or -SetAdminPassword.'
                }
                $null = Get-JsonBool $admin 'enabled' $true 'gateway.json admin'
                $adminPortCheck = Get-JsonInt $admin 'port' 16050 'gateway.json admin'
                if ($adminPortCheck -lt 1 -or $adminPortCheck -gt 65535) {
                    throw "gateway.json admin.port must be between 1 and 65535, got '$adminPortCheck'."
                }
                $bindCheck = [string](Get-JsonProperty $settings 'bind' ':30709')
                if ($bindCheck -notmatch '^[^\s]*:(\d+)$' -or [int]$Matches[1] -lt 1 -or [int]$Matches[1] -gt 65535) {
                    throw "gateway.json bind must end in a valid port (1-65535), got '$bindCheck'."
                }
                $null = Assert-LoopbackEndpoint -Endpoint ([string](Get-JsonProperty $settings 'caddyAdmin' 'localhost:16051')) -FieldName 'gateway.json caddyAdmin'
                $paths = Get-GatewayPaths -Settings $settings -Root $Gw.Root
                $all = @(Resolve-GatewayApps -Plugins @(Get-AppPlugin -Dir $Gw.AppsDir) -BaseDir $Gw.Root -Bind $Gw.Bind `
                    -Paths $paths -PortOverride $Gw.PortOverride)
                $active = Resolve-GatewaySelection -All $all
                $apps = @($all | Where-Object { $active.Contains($_.Id) })
                Test-GatewayDraftCaddy -Apps $apps -Settings $settings
            } catch {
                Stop-AdminRequest 422 $_.Exception.Message
            }
            $affected = @(foreach ($app in $all) {
                $before = $Gw.All | Where-Object Id -eq $app.Id
                if ($before -and (Test-LaunchChange $before $app)) { $app.Id }
            })
            $result = @{ paths = $paths; affected = $affected; needsRestart = @(Get-GatewayRestartFields $settings) }
            if (-not $previewOnly) {
                Write-GatewayText -Path $Gw.SettingsFile -Text (([string]$body.text).TrimEnd() + "`n")
                $result.version = Get-GatewayFileVersion $Gw.SettingsFile
                $result.message = 'Saved gateway.json. Apply routes when ready.'
                & $audit 'config.gateway'
            }
            Send-AdminJson -Res $Res -Body $result
            return
        }

        '^POST /config/site$' {
            $body = Read-AdminBody $Req
            Update-GatewaySettingsFile {
                param($s)
                $site = [ordered]@{
                    title        = [string]$body.title
                    tagline      = [string]$body.tagline
                    fallbackIcon = [string]$body.fallbackIcon
                }
                if ($s.PSObject.Properties['site']) { $s.site = $site } else { $s | Add-Member -NotePropertyName site -NotePropertyValue $site }
            }
            & $audit 'config.site' "title=$($body.title)"
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = 'Landing settings saved. Apply routes when ready.' }
            return
        }

        '^GET /ports$' { Send-AdminJson -Res $Res -Body (Get-AdminPorts); return }

        '^POST /gateway/reload$' {
            $body = Read-AdminBody $Req
            $restart = [string]$body.restartApp
            if ($restart) { Assert-AppId $restart }
            try { Update-GatewayRoutes -Rescan -RestartApp $restart }
            catch {
                & $audit 'gateway.reload' $_.Exception.Message $false
                Stop-AdminRequest 422 $_.Exception.Message
            }
            & $audit 'gateway.reload'
            Send-AdminJson -Res $Res -Status 202 -Body @{ ok = $true; message = 'Applying routes. The previous version remains active until Caddy accepts the update.' }
            return
        }

        '^POST /gateway/(start|stop)-all$' {
            $verb = $Matches[1]
            if ($Gw.RouteChange) { Stop-AdminRequest 409 'Wait for the routed application to finish restarting first.' }
            $messages = @()
            if ($verb -eq 'start') {
                $targets = @($Gw.All | Where-Object { $_.Enabled -and $_.Launch })
                $newRoutes = @($targets | Where-Object { -not $Gw.Active.Contains($_.Id) -and $_.Routes.Kind -ne 'none' } | ForEach-Object Id)
                if ($newRoutes) {
                    try { Update-GatewayRoutes -Add $newRoutes } catch { Stop-AdminRequest 409 $_.Exception.Message }
                }
                foreach ($a in $targets) {
                    try { $messages += Start-GatewayApp -Id $a.Id } catch { $messages += "$($a.Id): $($_.Exception.Message)" }
                }
            } else {
                foreach ($a in $Gw.All | Where-Object { $_.Launch }) {
                    $run = $Gw.Runs[$a.Id]
                    if ($run -and ((Test-Alive $run.Child) -or (Test-Alive $run.Stopper) -or ($run.Pending -eq 'start'))) {
                        $messages += Stop-GatewayApp -Id $a.Id
                    }
                }
            }
            & $audit "gateway.$verb-all"
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = ($messages -join ' ') }
            return
        }

        '^POST /gateway/shutdown$' {
            & $audit 'gateway.shutdown'
            Write-GatewayLog '[ADMIN] shutdown requested from the admin page.'
            Add-DeferredAction { $Gw.ShutdownRequested = $true }
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = 'The gateway is shutting down. This page goes with it.' }
            return
        }

        '^GET /security$' {
            Remove-ExpiredSessions -Auth $auth
            $now = Get-Date
            $sessions = @($auth.Sessions.Values | Sort-Object LastSeen -Descending | ForEach-Object {
                [ordered]@{
                    id = $_.Id; client = $_.Client; userAgent = $_.UserAgent
                    created = $_.Created.ToString('o'); lastSeen = $_.LastSeen.ToString('o')
                    current = $_.Hash -eq $session.Hash
                }
            })
            $locks = @($auth.Locked.GetEnumerator() | Where-Object { $_.Value -gt $now } |
                ForEach-Object { [ordered]@{ client = $_.Key; until = $_.Value.ToString('o') } })
            $trail = @($auth.Audit | Select-Object -Last 300)
            [array]::Reverse($trail)
            Send-AdminJson -Res $Res -Body ([ordered]@{
                user        = $auth.User
                sessions    = $sessions
                locks       = $locks
                globalLock  = $(if ($auth.GlobalUntil -gt $now) { $auth.GlobalUntil.ToString('o') })
                audit       = $trail
                idleHours   = $auth.IdleTimeout.TotalHours
            })
            return
        }

        '^POST /security/password$' {
            $body = Read-AdminBody $Req
            if (-not (Test-PasswordHash -Password ([string]$body.current) -Stored $auth.PasswordHash)) {
                & $audit 'security.password' 'wrong current password' $false
                Stop-AdminRequest 403 'The current password is wrong.'
            }
            $next = [string]$body.next
            if ($next.Length -lt 8) { Stop-AdminRequest 422 'The new password needs at least 8 characters.' }
            $hash = New-PasswordHash $next
            Set-GatewayAdminCredential -PasswordHash $hash
            $auth.PasswordHash = $hash
            foreach ($key in @($auth.Sessions.Keys)) { if ($key -ne $session.Hash) { $auth.Sessions.Remove($key) } }
            & $audit 'security.password' 'changed; other sessions signed out'
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = 'Password changed. Every other session has been signed out.' }
            return
        }

        '^POST /security/sessions/([a-f0-9]+)/revoke$' {
            $id = $Matches[1]
            $target = $auth.Sessions.Values | Where-Object { $_.Id -eq $id } | Select-Object -First 1
            if (-not $target) { Stop-AdminRequest 404 'No such session.' }
            $auth.Sessions.Remove($target.Hash)
            & $audit 'security.revoke' "session $id ($($target.Client))"
            Send-AdminJson -Res $Res -Body @{ ok = $true }
            return
        }

        '^POST /security/sessions/revoke-others$' {
            $n = 0
            foreach ($key in @($auth.Sessions.Keys)) { if ($key -ne $session.Hash) { $auth.Sessions.Remove($key); $n++ } }
            & $audit 'security.revoke' "$n other session(s)"
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = "Signed out $n other session(s)." }
            return
        }

        '^POST /security/unlock$' {
            Clear-LoginLocks -Auth $auth
            & $audit 'security.unlock'
            Send-AdminJson -Res $Res -Body @{ ok = $true; message = 'Lockouts cleared.' }
            return
        }

        default { Stop-AdminRequest 404 "No API at $method $Route." }
    }
}

# ------------------------------------------------------------ data builders

function Get-AdminOverview {
    $me = [Diagnostics.Process]::GetCurrentProcess()
    $mem = [AppGateway.SystemStats]::Memory()
    $caddyUsage = $null
    if (Test-Alive $Gw.Caddy) {
        try { $Gw.Caddy.Refresh(); $caddyUsage = $Gw.Caddy.WorkingSet64 } catch { }
    }

    $parents   = [AppGateway.ProcTree]::Parents()
    $listening = Get-ListeningPorts
    $states = @{}
    $list = @(foreach ($a in $Gw.All) {
        $status = Get-AppStatus -App $a -Parents $parents -Listening $listening
        $states[$status.state] = 1 + [int]$states[$status.state]
        $status
    })

    $disks = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -in 'Fixed', 'Removable', 'Network' } | ForEach-Object {
        [ordered]@{ name = $_.Name; label = $_.VolumeLabel; total = $_.TotalSize; free = $_.AvailableFreeSpace; type = "$($_.DriveType)" }
    })

    $recent = @($Gw.Hub.Read('gateway', 0, 40) | ForEach-Object {
        [ordered]@{ seq = $_.Seq; time = $_.Time.ToString('o'); stream = $_.Stream; text = $_.Text }
    })

    return [ordered]@{
        gateway = [ordered]@{
            pid        = $PID
            startedAt  = $Gw.StartedAt.ToString('o')
            bind       = $Gw.Bind
            adminPort  = $Gw.AdminPort
            caddyAdmin = $Gw.CaddyAdmin
            root       = $Gw.Root
            logs       = $Gw.LogDir
            memory     = $me.WorkingSet64
            pwsh       = $PSVersionTable.PSVersion.ToString()
            selection  = $Gw.Selection
            reloading  = [bool]($Gw.Reload -or $Gw.RouteChange)
            lastReload = $(if ($Gw.LastReload) { @{ at = $Gw.LastReload.At.ToString('o'); ok = $Gw.LastReload.Ok; message = $Gw.LastReload.Message } })
            registryVersions = $Gw.RegistryVersions
            caddy      = [ordered]@{
                pid       = $(if ($Gw.Caddy) { $Gw.Caddy.Id })
                alive     = Test-Alive $Gw.Caddy
                startedAt = $(if ($Gw.Caddy) { $Gw.Caddy.StartTime.ToString('o') })
                memory    = $caddyUsage
                version   = $Gw.CaddyVersion
            }
        }
        system = [ordered]@{
            host       = [Environment]::MachineName
            os         = [Runtime.InteropServices.RuntimeInformation]::OSDescription
            cpus       = [Environment]::ProcessorCount
            cpu        = [AppGateway.SystemStats]::Cpu()
            memTotal   = $mem[0]
            memFree    = $mem[1]
            uptime     = [Math]::Round([Environment]::TickCount64 / 1000)
            disks      = $disks
        }
        apps   = [ordered]@{ total = $Gw.All.Count; states = $states; list = $list }
        recent = $recent
    }
}

function Get-AdminMetrics {
    <# The sampled history as parallel arrays, null where an app was not running. #>
    $history = @($Gw.History)
    $apps = [ordered]@{}
    foreach ($a in $Gw.All) {
        if (-not @($history | Where-Object { $_.Apps.ContainsKey($a.Id) }).Count) { continue }
        $apps[$a.Id] = [ordered]@{
            cpu = @($history | ForEach-Object { if ($_.Apps.ContainsKey($a.Id)) { $_.Apps[$a.Id].Cpu } else { $null } })
            mem = @($history | ForEach-Object { if ($_.Apps.ContainsKey($a.Id)) { $_.Apps[$a.Id].Mem } else { $null } })
        }
    }
    return [ordered]@{
        step     = $script:SampleSeconds
        keep     = $script:SampleKeep
        memTotal = [AppGateway.SystemStats]::Memory()[0]
        t        = @($history | ForEach-Object { $_.T })
        cpu      = @($history | ForEach-Object { $_.Cpu })
        mem      = @($history | ForEach-Object { $_.Mem })
        apps     = $apps
    }
}

function Get-AdminPorts {
    $listening = Get-ListeningPorts -Fresh
    $declared = @{}
    foreach ($a in $Gw.All) {
        foreach ($p in $a.Ports.GetEnumerator()) { $declared[[int]$p.Value] = @{ app = $a.Id; name = $p.Key } }
    }
    $bindPort = [int]($Gw.Bind -split ':')[-1]
    $declared[$bindPort] = @{ app = '(gateway)'; name = 'public' }
    if ($Gw.AdminPort) { $declared[$Gw.AdminPort] = @{ app = '(gateway)'; name = 'admin' } }
    $caddyAdminPort = [int](($Gw.CaddyAdmin -split ':')[-1])
    if ($caddyAdminPort) { $declared[$caddyAdminPort] = @{ app = '(gateway)'; name = 'caddy admin' } }

    $rangeOf = {
        param([int] $Port)
        foreach ($r in $Gw.Convention.Ranges) { if ($Port -ge $r.From -and $Port -le $r.To) { return $r.Name } }
        return $null
    }

    $names = @{}
    $rows = foreach ($port in @($listening.Keys) + @($declared.Keys) | Sort-Object -Unique) {
        $range = & $rangeOf $port
        $decl  = $declared[$port]
        if (-not $range -and -not $decl) { continue }
        $owner = $listening[$port]
        if ($owner -and -not $names.ContainsKey($owner)) { $names[$owner] = [AppGateway.ProcTree]::NameOf($owner) }
        [ordered]@{
            port      = $port
            range     = $range
            slot      = $(if ($range) { $r = $Gw.Convention.Ranges | Where-Object Name -eq $range; $r.From + [Math]::Floor(($port - $r.From) / $Gw.Convention.Slot) * $Gw.Convention.Slot })
            app       = $(if ($decl) { $decl.app })
            name      = $(if ($decl) { $decl.name })
            listening = $null -ne $owner
            pid       = $owner
            process   = $(if ($owner) { $names[$owner] })
            bindings  = @($Gw.PortCache.Bindings[$port] | Where-Object { $_ })
        }
    }
    return [ordered]@{
        slot   = $Gw.Convention.Slot
        ranges = @($Gw.Convention.Ranges | ForEach-Object { [ordered]@{ name = $_.Name; from = $_.From; to = $_.To } })
        ports  = @($rows)
    }
}

function Get-GatewayFileVersion {
    param([string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Test-GatewayDraftCaddy {
    param([hashtable[]] $Apps, $Settings = $Gw.Settings)
    $directory = Join-Path $Gw.RuntimeDir "revisions/$([guid]::NewGuid().ToString('N'))"
    try {
        $null = Build-GatewayConfig -Apps $Apps -Validate -Settings $Settings `
            -Caddyfile (Join-Path $directory 'Caddyfile') -WebRoot (Join-Path $directory 'web')
    } finally {
        Remove-GatewayRevision $directory
    }
}

function Resolve-AdminDraft {
    param([string] $Id, [string] $Text)

    try { $entry = $Text | ConvertFrom-Json } catch { throw 'Invalid JSON. Check the editor for the line and column.' }
    if ($entry -isnot [pscustomobject]) { throw 'The file must hold one JSON object.' }
    $declared = Get-JsonProperty $entry 'id'
    if ($declared -and $declared -ne $Id) { throw "The id field must match the file name, '$Id'." }
    $plugin = [pscustomobject]@{ File = (Join-Path $Gw.AppsDir "$Id.json"); Id = $Id
        Order = Get-JsonInt $entry 'order' 100 "App '$Id'"; Entry = $entry }
    $settings = Read-GatewaySettings -Path $Gw.SettingsFile
    $paths = Get-GatewayPaths -Settings $settings -Root $Gw.Root
    $plugins = @(Get-AppPlugin -Dir $Gw.AppsDir -AllowEmpty -ExcludeId $Id) + $plugin
    $all = @(Resolve-GatewayApps -Plugins $plugins -BaseDir $Gw.Root -Bind $Gw.Bind -Paths $paths -PortOverride $Gw.PortOverride)
    $app = $all | Where-Object Id -eq $Id
    $active = Resolve-GatewaySelection -All $all -Add $Id
    $included = @($all | Where-Object { $active.Contains($_.Id) -and ($_.Id -ne $Id -or $app.Enabled -or $Gw.Active.Contains($Id)) })
    foreach ($set in @(@{ Apps = @($app) }, @{ Apps = $included })) {
        Assert-GatewayApps -Apps $set.Apps -Bind $Gw.Bind -PortRanges $Gw.Convention.Ranges -PortSlot $Gw.Convention.Slot -Reserved $Gw.Reserved
    }
    Test-GatewayDraftCaddy -Apps $included -Settings $settings
    if ($app -notin $included -and $app.Routes.Kind -ne 'none') {
        Test-GatewayDraftCaddy -Apps @($app) -Settings $settings
    }
    $icon = $null
    if ($app.IconFile) {
        $previous = $Gw.All | Where-Object Id -eq $Id
        try { $icon = Read-AppIcon -Root $app.Root -File $app.IconFile }
        catch {
            if ($previous.IconFile -ne $app.IconFile -or $previous.Root -ne $app.Root) { throw }
            $warning = 'The current icon is unavailable. The app will use the fallback glyph.'
        }
    }
    $applied = $Gw.All | Where-Object Id -eq $Id
    $managed = $applied -and (Test-Alive $Gw.Runs[$Id].Child)
    $oldPorts = if ($applied) { $applied.Ports.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" } }
    $newPorts = $app.Ports.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
    return @{
        root = $app.Root; ports = $app.Ports; entry = $(if ($app.BasePath) { $app.BasePath } else { $app.LocalUrl })
        launch = $(if ($app.Launch) { $app.Launch.Script })
        args = @($app.Launch.Args)
        warnings = @($warning | Where-Object { $_ })
        iconGlyph = $app.Icon; iconData = $(if ($icon) { "data:$($icon.Type);base64,$([Convert]::ToBase64String($icon.Bytes))" })
        needsRestart = [bool]($managed -and (Test-LaunchChange $applied $app))
        applyRestart = [bool]($managed -and $applied.Routes.Kind -ne 'none' -and $app.Launch -and
            $app.Ports.Count -and ($oldPorts -join ',') -ne ($newPorts -join ','))
    }
}

function Update-GatewaySettingsFile {
    <# Read gateway.json fresh, let $Change edit it, write it back. A parse and
       reserialise, as Set-AppEnabled does for app files. #>
    param([scriptblock] $Change)
    $s = if (Test-Path -LiteralPath $Gw.SettingsFile) { Read-JsonFile $Gw.SettingsFile } else { [pscustomobject]@{} }
    & $Change $s
    Write-GatewayText -Path $Gw.SettingsFile -Text (($s | ConvertTo-Json -Depth 20) + "`n")
}

function Get-GatewayAdminCredential {
    param([string] $Path, $Legacy)
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return Read-JsonFile $Path }
    return $Legacy
}

function Set-GatewayAdminCredential {
    param([string] $PasswordHash)
    $settings = Read-GatewaySettings $Gw.SettingsFile
    $legacy = Get-JsonProperty $settings 'admin'
    $current = Get-GatewayAdminCredential -Path $Gw.CredentialFile -Legacy $legacy
    $credential = @{ user = [string](Get-JsonProperty $current 'user' 'admin'); passwordHash = $PasswordHash }
    Write-GatewayText -Path $Gw.CredentialFile -Text (($credential | ConvertTo-Json) + "`n") -Private

    if (Test-LegacyAdminCredential $legacy) {
        Update-GatewaySettingsFile {
            param($s)
            $admin = Get-JsonProperty $s 'admin'
            if ($admin) {
                $admin.PSObject.Properties.Remove('passwordHash')
                $admin.PSObject.Properties.Remove('user')
            }
        }
    }
}
