# Generates the gateway's Caddyfile from the resolved apps.
#
# There are two kinds of app here, and the difference is who owns the routing:
#
#   snippet — the project keeps a Caddyfile fragment and the gateway imports it,
#             the same file the project's standalone Caddyfile imports. Routes are
#             written once, and an app with auth gates, cache fast-paths or five
#             backends keeps that complexity in the project it belongs to.
#
#   proxy   — the app knows nothing about Caddy, so the gateway writes the route:
#             a matcher on its prefix and a reverse_proxy to the port its plugin
#             file gave it. This is what lets a plain HTTP server join without
#             being taught anything.
#
# Neither kind is named here. What an app is comes from its file in apps/.

function ConvertTo-CaddyPath {
    <# Caddy's parser treats a backslash as an escape, so Windows paths go in with
       forward slashes. #>
    param([string]$Path)
    return $Path.Replace('\', '/')
}

function ConvertTo-MatcherToken {
    <# A Caddy matcher name is a bare token, and app ids may hold - or . — so
       derive one. Prefixed with the app id because every app's routes are imported
       into a single site block, where matcher names are scoped. #>
    param([string]$Id, [int]$Index)
    return ('@{0}_{1}' -f ($Id -replace '[^A-Za-z0-9_]', '_'), $Index)
}

function New-ProxyRouteLines {
    <# The generated routes for one proxy app, indented one tab for the site block. #>
    param([hashtable]$App)

    $lines = @()
    $index = 0

    foreach ($rule in $App.Routes.Rules) {
        $body = @("`t`treverse_proxy $($rule.Upstream)")
        if ($rule.Stream) {
            # Pass bytes through instead of buffering, or a long-lived Range or SSE
            # connection is dropped under backpressure.
            $body = @(
                "`t`treverse_proxy $($rule.Upstream) {"
                "`t`t`tflush_interval -1"
                "`t`t}"
            )
        }

        if ($rule.Strip) {
            # handle_path takes one inline path matcher, so a rule with several
            # paths becomes several blocks rather than one named matcher.
            foreach ($path in $rule.Paths) {
                $lines += @("`thandle_path $path {") + $body + @("`t}")
            }
        } else {
            $token = ConvertTo-MatcherToken -Id $App.Id -Index $index
            $lines += @(
                "`t$token path $($rule.Paths -join ' ')"
                "`thandle $token {"
            ) + $body + @("`t}")
        }
        $index++
    }

    return $lines
}

function New-GatewayCaddyfile {
    <# Compose the runtime Caddyfile. Returns its path. #>
    param(
        [hashtable[]] $Apps,
        [string]      $OutFile,
        [string]      $WebRoot,
        [string]      $Bind,
        [string]      $SourceDir = 'apps'
    )

    $lines = @(
        "# GENERATED on every launch. Edit the source instead: $SourceDir/<app>.json for"
        '# which apps run and where, each project''s Caddyfile.snippet for its own routes.'
        '{'
        "`tauto_https off"
        ''
        "`t# Never used, and leaving it on binds 127.0.0.1:2019 — which collides with"
        "`t# any second Caddy on the box."
        "`tadmin off"
        '}'
        ''
        "$Bind {"
    )

    foreach ($app in $Apps) {
        switch ($app.Routes.Kind) {
            'snippet' {
                $lines += "`t# $($app.Id) — routes owned by the project"
                $lines += "`timport `"$(ConvertTo-CaddyPath $app.Routes.Snippet)`""
                $lines += ''
            }
            'proxy' {
                $lines += "`t# $($app.Id) — routes generated from $SourceDir/$($app.Id).json"
                $lines += New-ProxyRouteLines -App $app
                $lines += ''
            }
        }
    }

    # The landing page is the catch-all and must stay last: every route above
    # carries a path matcher, and a matcher-less handle before them would swallow
    # the lot.
    $lines += @(
        "`t# the landing page — catch-all, so it stays last"
        "`thandle {"
        "`t`troot * `"$(ConvertTo-CaddyPath $WebRoot)`""
        "`t`tfile_server"
        "`t}"
        '}'
    )

    New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null

    # LF and no BOM: Caddy warns about a CRLF config on every launch, and its
    # parser chokes on a leading BOM.
    [IO.File]::WriteAllText($OutFile, ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    return $OutFile
}
