# The launch protocol: gateway.json for the gateway, apps/*.json for the apps.
#
# The apps directory *is* the registry. One file is one app; dropping a file in
# registers it and deleting the file unregisters it, with nothing else to edit and
# no list to keep in step. Nothing in lib/ knows an app's name, port, prefix or
# icon — an app is whatever its own file says it is.
#
# JSON cannot hold comments, so the field documentation lives in schema/ next to
# the files it describes, and the prose in README.
#
# Every string in an app file is expanded against a small vocabulary before use:
#
#   ${paths.NAME}   a named directory from gateway.json's "paths" map
#   ${root}         this app's root, absolute
#   ${id}           this app's id — which is its file name
#   ${basePath}     this app's public path prefix
#   ${bind}         the public bind address
#   ${ports.NAME}   one of this app's declared ports
#
# The ports map is the whole reason the gateway can *place* an app rather than
# merely discover it: a number is written once, then reaches both the app (as an
# argument or an environment variable) and the route that proxies to it. Two apps
# claiming one port becomes a load-time error here instead of a bind failure
# several minutes into a launch, with the reason buried in a child's log.

$script:Placeholder = '\$\{([A-Za-z0-9_.-]+)\}'

function Expand-GatewayString {
    <# Substitute ${...} against $Vars. An unknown name is an error rather than an
       empty string: a typo would otherwise quietly become an upstream of
       "127.0.0.1:" that Caddy accepts and nothing ever answers.

       Written out rather than handed to [regex]::Replace with a MatchEvaluator so
       a throw from here surfaces as itself, not wrapped in a delegate-invocation
       exception. #>
    param(
        [AllowEmptyString()] [string] $Text,
        [hashtable] $Vars,
        [string]    $Where
    )

    if ([string]::IsNullOrEmpty($Text)) { return $Text }

    $out  = [Text.StringBuilder]::new()
    $last = 0
    foreach ($m in [regex]::Matches($Text, $script:Placeholder)) {
        [void]$out.Append($Text.Substring($last, $m.Index - $last))

        $key = $m.Groups[1].Value
        if (-not $Vars.ContainsKey($key)) {
            $known = ($Vars.Keys | Sort-Object) -join ', '
            throw ('{0}: unknown placeholder ${{{1}}} in "{2}". Available: {3}' -f $Where, $key, $Text, $known)
        }

        [void]$out.Append([string]$Vars[$key])
        $last = $m.Index + $m.Length
    }
    [void]$out.Append($Text.Substring($last))
    return $out.ToString()
}

function Get-JsonProperty {
    <# ConvertFrom-Json yields PSCustomObjects, where an absent property is $null
       rather than an error. This keeps every "what if the key is missing" decision
       at one call site per field. #>
    param($Object, [string]$Name, $Default = $null)

    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if (-not $prop -or $null -eq $prop.Value) { return $Default }
    return $prop.Value
}

function Read-JsonFile {
    param([string]$Path)

    $raw = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    try {
        return $raw | ConvertFrom-Json
    } catch {
        throw "$Path is not valid JSON: $($_.Exception.Message)"
    }
}

function Read-GatewaySettings {
    <# gateway.json: bind, site chrome, named paths, where the apps live. No app is
       described here — that is what apps/ is for. Absent entirely is fine; the
       defaults are the ones the schema documents. #>
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{}
    }
    return Read-JsonFile -Path $Path
}

function Get-AppPlugin {
    <# Every *.json in the apps directory, in load order.

       The file name is the id. That is what makes this a plugin directory rather
       than a list: a file carries its own identity, so registering an app is
       copying a file in and unregistering it is deleting the file — no index to
       update, and no way for an index to disagree with what is actually there.

       Ordering therefore cannot also come from the name, hence "order" inside. #>
    param([string]$Dir)

    if (-not (Test-Path -LiteralPath $Dir)) {
        throw "No apps directory at $Dir. One *.json file per app; schema/app.schema.json describes one."
    }

    $plugins = @()
    foreach ($file in Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File | Sort-Object Name) {
        $entry = Read-JsonFile -Path $file.FullName
        if ($entry -isnot [pscustomobject]) {
            throw "$($file.Name) must hold a JSON object describing one app."
        }

        $id = [IO.Path]::GetFileNameWithoutExtension($file.Name)
        if ($id -notmatch '^[a-z0-9][a-z0-9._-]*$') {
            throw "$($file.Name): the file name is the app id, so it must be lower-case alphanumeric, optionally with . _ or -."
        }

        # Declaring it is optional; declaring it wrongly is not. A file copied as
        # the start of a new app would otherwise keep answering to the old name.
        $declared = Get-JsonProperty $entry 'id'
        if ($declared -and $declared -ne $id) {
            throw "$($file.Name) declares id '$declared'; the file name says '$id'. Rename one."
        }

        $plugins += [pscustomobject]@{
            File  = $file.FullName
            Id    = $id
            Order = [int](Get-JsonProperty $entry 'order' 100)
            Entry = $entry
        }
    }

    if (-not $plugins.Count) {
        throw "No app plugins in $Dir. One *.json file per app; schema/app.schema.json describes one."
    }
    return @($plugins | Sort-Object Order, Id)
}

function Resolve-GatewayApps {
    <# Turn the plugin files into validated app records — hashtables with a fixed
       shape, so everything downstream reads the same thing whether the app brought
       its own Caddy snippet or the gateway generated its routes. #>
    param(
        [Parameter(Mandatory)] [object[]] $Plugins,
        # Where relative roots and named paths resolve from: the gateway directory,
        # not apps/. An app's root is stated relative to the gateway it plugs into.
        [Parameter(Mandatory)] [string]   $BaseDir,
        [Parameter(Mandatory)] [string]   $Bind,
        # ${paths.NAME} -> absolute directory, from gateway.json.
        [hashtable] $Paths = @{},
        # app-id -> @{ portName = number }, from -Port. This run only.
        [hashtable] $PortOverride = @{}
    )

    $apps = @()
    foreach ($plugin in $Plugins) {
        $id    = $plugin.Id
        $entry = $plugin.Entry
        $where = "App '$id' ($(Split-Path -Leaf $plugin.File))"

        $name = Get-JsonProperty $entry 'name'
        if (-not $name) { throw "$where has no name." }

        # ---- root -----------------------------------------------------------
        # Resolved before anything else, because ${root} is what the rest leans on.
        $rawRoot = Get-JsonProperty $entry 'root'
        if (-not $rawRoot) { throw "$where has no root." }

        $vars = $Paths.Clone()
        $vars['id']   = $id
        $vars['bind'] = $Bind

        # GetFullPath(path, basePath) rather than Join-Path: an absolute value has
        # to stay itself, and Join-Path would happily glue two roots together.
        $root = [IO.Path]::GetFullPath(
            (Expand-GatewayString $rawRoot $vars "$where root"), $BaseDir)
        $vars['root'] = $root

        $basePath = Expand-GatewayString ([string](Get-JsonProperty $entry 'basePath' '')) $vars "$where basePath"
        if ($basePath) {
            if ($basePath -notmatch '^/') { throw "$where basePath must start with '/': '$basePath'." }
            if ($basePath.EndsWith('/')) {
                throw "$where basePath must not end with '/': '$basePath'. The bare prefix is the canonical URL; the trailing-slash form is a redirect the app itself owns."
            }
            $vars['basePath'] = $basePath
        }

        # ---- ports ----------------------------------------------------------
        # Declared here, handed out below. -Port lands before expansion, so an
        # override reaches the launch arguments and the upstream alike.
        $ports = @{}
        $portsNode = Get-JsonProperty $entry 'ports'
        if ($portsNode) {
            foreach ($p in $portsNode.PSObject.Properties) {
                if ($p.Value -isnot [int] -and $p.Value -isnot [long]) {
                    throw "$where port '$($p.Name)' must be a number, got '$($p.Value)'."
                }
                $ports[$p.Name] = [int]$p.Value
            }
        }
        if ($PortOverride.ContainsKey($id)) {
            foreach ($o in $PortOverride[$id].GetEnumerator()) {
                if (-not $ports.ContainsKey($o.Key)) {
                    $known = if ($ports.Count) { ($ports.Keys | Sort-Object) -join ', ' } else { '(none)' }
                    throw "$where declares no port named '$($o.Key)'. Declared: $known."
                }
                $ports[$o.Key] = [int]$o.Value
            }
        }
        foreach ($p in $ports.GetEnumerator()) {
            if ($p.Value -lt 1 -or $p.Value -gt 65535) {
                throw "$where port '$($p.Key)' is out of range: $($p.Value)."
            }
            $vars["ports.$($p.Key)"] = $p.Value
        }

        # ---- everything else ------------------------------------------------
        $appEnv = @{}
        $envNode = Get-JsonProperty $entry 'env'
        if ($envNode) {
            foreach ($e in $envNode.PSObject.Properties) {
                $appEnv[$e.Name] = Expand-GatewayString ([string]$e.Value) $vars "$where env.$($e.Name)"
            }
        }

        $launch = $null
        $launchNode = Get-JsonProperty $entry 'launch'
        if ($launchNode) {
            $file = Expand-GatewayString ([string](Get-JsonProperty $launchNode 'file' '')) $vars "$where launch.file"
            if (-not $file) { throw "$where has a launch block with no file." }
            $launch = @{
                File = $file
                Args = @(@(Get-JsonProperty $launchNode 'args' @()) |
                            ForEach-Object { Expand-GatewayString ([string]$_) $vars "$where launch.args" })
                Cwd  = Expand-GatewayString ([string](Get-JsonProperty $launchNode 'cwd' $root)) $vars "$where launch.cwd"
            }
        }

        $apps += @{
            Id          = $id
            File        = $plugin.File
            Name        = $name
            Description = Expand-GatewayString ([string](Get-JsonProperty $entry 'description' '')) $vars "$where description"
            Icon        = [string](Get-JsonProperty $entry 'icon' '')
            Enabled     = [bool](Get-JsonProperty $entry 'enabled' $true)
            Hidden      = [bool](Get-JsonProperty $entry 'hidden' $false)
            Root        = $root
            BasePath    = $basePath
            Probe       = Expand-GatewayString ([string](Get-JsonProperty $entry 'probe' $basePath)) $vars "$where probe"
            Ports       = $ports
            Env         = $appEnv
            Routes      = Resolve-AppRoute -Entry $entry -Vars $vars -Where $where -BasePath $basePath
            Launch      = $launch
        }
    }

    return $apps
}

function Resolve-AppRoute {
    <# The routes block, normalised to @{ Kind = 'snippet' | 'proxy' | 'none'; … }. #>
    param($Entry, [hashtable]$Vars, [string]$Where, [string]$BasePath)

    $node = Get-JsonProperty $Entry 'routes'
    if (-not $node) { return @{ Kind = 'none' } }

    $snippet = Expand-GatewayString ([string](Get-JsonProperty $node 'snippet' '')) $Vars "$Where routes.snippet"
    $proxy   = Get-JsonProperty $node 'proxy'

    if ($snippet -and $proxy) {
        throw "$Where declares both routes.snippet and routes.proxy. A snippet owns the app's routing entirely; pick one."
    }

    if ($snippet) {
        return @{
            Kind      = 'snippet'
            Snippet   = $snippet
            EnvScript = Expand-GatewayString ([string](Get-JsonProperty $node 'env' '')) $Vars "$Where routes.env"
        }
    }

    if ($proxy) {
        $rules = foreach ($rule in @($proxy)) {
            $upstream = Expand-GatewayString ([string](Get-JsonProperty $rule 'upstream' '')) $Vars "$Where routes.proxy.upstream"
            if (-not $upstream) { throw "$Where has a proxy route with no upstream." }

            $paths = @(Get-JsonProperty $rule 'paths' @())
            if (-not $paths.Count) {
                # The bare prefix as well as everything under it: an app that
                # redirects /prefix to /prefix/ has to be reachable at both.
                if (-not $BasePath) {
                    throw "$Where has a proxy route with no paths and no basePath to derive them from."
                }
                $paths = @($BasePath, "$BasePath/*")
            }

            @{
                Paths    = @($paths | ForEach-Object { Expand-GatewayString ([string]$_) $Vars "$Where routes.proxy.paths" })
                Upstream = $upstream
                Strip    = [bool](Get-JsonProperty $rule 'strip' $false)
                Stream   = [bool](Get-JsonProperty $rule 'stream' $false)
            }
        }
        return @{ Kind = 'proxy'; Rules = @($rules) }
    }

    return @{ Kind = 'none' }
}

function Assert-GatewayApps {
    <# Checks that only matter for apps about to run *together*. Kept out of
       Resolve-GatewayApps so -List still prints a registry that has a collision in
       it — which is exactly the moment you want to look at the registry. #>
    param([hashtable[]] $Apps, [string] $Bind)

    $bindPort = [int]($Bind -split ':')[-1]
    $seenPort = @{}
    $prefixes = @{}

    foreach ($app in $Apps) {
        if (-not (Test-Path -LiteralPath $app.Root)) {
            throw "App '$($app.Id)': root does not exist: $($app.Root)"
        }

        if ($app.Routes.Kind -eq 'snippet') {
            if (-not (Test-Path -LiteralPath $app.Routes.Snippet)) {
                throw "App '$($app.Id)': routes.snippet not found: $($app.Routes.Snippet)"
            }
            if ($app.Routes.EnvScript -and -not (Test-Path -LiteralPath $app.Routes.EnvScript)) {
                throw "App '$($app.Id)': routes.env not found: $($app.Routes.EnvScript)"
            }
        }

        # One Caddy holds the public port. An app that also wanted it would leave
        # the edge unable to bind, with the reason in a JSON log nobody reads.
        foreach ($p in $app.Ports.GetEnumerator()) {
            if ($p.Value -eq $bindPort) {
                throw "App '$($app.Id)' port '$($p.Key)' is $bindPort, the gateway's own bind. Give the app another port, or move the gateway with -Bind."
            }
            if ($seenPort.ContainsKey($p.Value)) {
                throw "Port $($p.Value) is claimed by both '$($seenPort[$p.Value])' and '$($app.Id)/$($p.Key)'. Standalone these never met; together they cannot both have it."
            }
            $seenPort[$p.Value] = "$($app.Id)/$($p.Key)"
        }

        # The prefixes share one origin, so one that contains another swallows it —
        # and which wins depends on load order rather than on anyone's intent.
        if ($app.BasePath) {
            foreach ($other in $prefixes.GetEnumerator()) {
                if ($app.BasePath -eq $other.Key -or
                    $app.BasePath.StartsWith("$($other.Key)/") -or
                    $other.Key.StartsWith("$($app.BasePath)/")) {
                    throw "basePath '$($app.BasePath)' ($($app.Id)) overlaps '$($other.Key)' ($($other.Value)). One origin is shared here, so the prefixes have to be disjoint."
                }
            }
            $prefixes[$app.BasePath] = $app.Id
        }
    }
}

function Get-MergedRouteEnv {
    <# Union of the snippet apps' route environments, for the single Caddy that
       serves them all. Each app's own env is applied while its script runs, because
       that script is what turns a port declared in the app's file into an upstream.

       A key collision means two apps disagree about an upstream — worth failing on
       rather than letting whichever loaded last win. #>
    param([hashtable[]] $Apps)

    $merged = @{}
    $owner  = @{}

    foreach ($app in $Apps) {
        if ($app.Routes.Kind -ne 'snippet' -or -not $app.Routes.EnvScript) { continue }

        $saved = Push-ProcessEnvironment -Environment $app.Env
        try {
            $appEnv = & $app.Routes.EnvScript
        } finally {
            Pop-ProcessEnvironment -Saved $saved
        }

        if ($appEnv -isnot [hashtable]) {
            $got = if ($null -eq $appEnv) { 'nothing' } else { $appEnv.GetType().Name }
            throw "App '$($app.Id)': routes.env must return a hashtable, got $got."
        }

        foreach ($e in $appEnv.GetEnumerator()) {
            if ($merged.ContainsKey($e.Key) -and $merged[$e.Key] -ne $e.Value) {
                throw "Caddy variable '$($e.Key)' collides: '$($owner[$e.Key])' wants '$($merged[$e.Key])', '$($app.Id)' wants '$($e.Value)'."
            }
            $merged[$e.Key] = $e.Value
            $owner[$e.Key]  = $app.Id
        }
    }
    return $merged
}

function Set-AppEnabled {
    <# Flip "enabled" and rewrite that app's file, and only that one. Its own file
       is the only thing that has to change, which is the point of one file per app:
       nothing else is touched, and nothing else could disagree.

       The file is data, so this is a parse-and-reserialise — hand formatting is not
       preserved, and comments could not live there anyway; schema/ holds those. #>
    param([object[]] $Plugins, [string[]] $Id, [bool] $Enabled)

    $unknown = @($Id | Where-Object { $_ -notin $Plugins.Id })
    if ($unknown) { throw "Unknown app id(s): $($unknown -join ', '). Known: $($Plugins.Id -join ', ')" }

    foreach ($plugin in $Plugins | Where-Object { $_.Id -in $Id }) {
        $entry = $plugin.Entry
        if ($entry.PSObject.Properties['enabled']) { $entry.enabled = $Enabled }
        else { $entry | Add-Member -NotePropertyName 'enabled' -NotePropertyValue $Enabled }

        # No BOM, and a trailing newline: these files are read by editors and diffed.
        $json = $entry | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($plugin.File, $json + "`n", [Text.UTF8Encoding]::new($false))
    }
}
