# -Build prepares the web assets first; the page opens in the browser unless -NoBrowser.
param([ValidateSet('Cloud', 'Setup')][string]$Mode = 'Cloud', [switch]$Build, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$statePath = Join-Path $PSScriptRoot '.running.json'
if (Test-Path -LiteralPath $statePath) { throw 'Run .\stop.ps1 before starting another instance.' }
foreach ($tool in @('node', 'uv')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Install $tool and add it to PATH." }
}
if (-not (Test-Path 'node_modules/wrangler/bin/wrangler.js')) { throw 'Run pnpm install first.' }
if (-not (Test-Path '.venv/Scripts/python.exe')) { throw 'Run uv sync first.' }
$ports = if ($Mode -eq 'Setup') { @(16032) } else { @(16034, 16030) }
foreach ($port in $ports) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is occupied; stop its app first." }
}
if ($Mode -ne 'Setup') {
    if ($Build) {
        & node scripts/build.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Asset build failed; server was not started.' }
    }
    if (-not (Test-Path 'cloud/src/generated-assets.js')) { throw 'Web assets are not built. Run .\start.ps1 -Build.' }
}
New-Item -ItemType Directory -Path '.logs' -Force | Out-Null
$started = @()
function Start-Owned([string]$Tool, [string[]]$Arguments, [string]$Log, [string]$Directory = $PSScriptRoot) {
    $process = Start-Process -FilePath (Get-Command $Tool).Source -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput "$PSScriptRoot/.logs/$Log.out.log" -RedirectStandardError "$PSScriptRoot/.logs/$Log.err.log"
    $process.Refresh()
    if ($process.HasExited) { throw "Startup failed; inspect .logs/$Log.err.log." }
    return [pscustomobject]@{ id = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
}
try {
    if ($Mode -eq 'Setup') {
        $started += Start-Owned 'uv' @('run', 'configure.py') 'setup'
    } else {
        $started += Start-Owned 'node' @('node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'cloud/wrangler.jsonc', '--ip', '127.0.0.1', '--port', '16030', '--inspector-port', '16034') 'worker'
    }
    $started | ConvertTo-Json -AsArray | Set-Content -LiteralPath $statePath
    Write-Host "Running $Mode at http://127.0.0.1:$($ports[-1])/ . Logs: .logs/ . Stop with Ctrl+C or .\stop.ps1."
    if (-not $NoBrowser) {
        # Open the page once it answers; the job ends with this script.
        $null = Start-ThreadJob -ArgumentList "http://127.0.0.1:$($ports[-1])/" -ScriptBlock {
            param($url)
            for ($i = 0; $i -lt 240; $i++) {
                try { $null = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; Start-Process $url; return }
                catch { if ($_.Exception.Response) { Start-Process $url; return } }
                Start-Sleep -Milliseconds 500
            }
        }
    }
    while ($true) {
        foreach ($entry in $started) {
            $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
            if (-not $process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $entry.startedAt) {
                if ($Mode -eq 'Setup' -or -not (Test-Path -LiteralPath $statePath)) { return }
                throw 'A server exited; inspect .logs/. All app processes will stop.'
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    if (Test-Path -LiteralPath $statePath) { & "$PSScriptRoot/stop.ps1" }
}
