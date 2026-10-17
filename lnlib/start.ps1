# Starts the library server and opens it in the browser (-NoBrowser to skip); .\stop.ps1 stops it
# from another window. -Build rebuilds the interface first. Other arguments go to `main.py serve`.
param(
    [int]$Port = 16020,
    [switch]$Build,
    [switch]$NoBrowser,
    [Parameter(ValueFromRemainingArguments)][string[]]$Rest = @()
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$runFile = Join-Path $PSScriptRoot '.running.json'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is not on PATH (https://docs.astral.sh/uv/).' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. If this app holds it, run .\stop.ps1 first."
}
if ($Build) {
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is not on PATH.' }
    Push-Location web
    try {
        pnpm install --frozen-lockfile
        if ($LASTEXITCODE -eq 0) { pnpm build }
    } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "Building the interface failed (exit $LASTEXITCODE)." }
}
if (-not (Test-Path web\dist\index.html)) { throw 'The interface is not built. Run .\start.ps1 -Build.' }
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }

# `serve` opens the browser itself once it is listening.
$serverArgs = @('run', '--locked', 'python', 'main.py', 'serve', '--port', $Port) + $Rest
if ($NoBrowser) { $serverArgs += '--no-browser' }
$server = Start-Process uv -NoNewWindow -PassThru -ArgumentList $serverArgs
@{ ProcessId = $server.Id; StartTicks = $server.StartTime.Ticks } | ConvertTo-Json | Set-Content -LiteralPath $runFile
try {
    while (-not $server.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
    if (-not $server.HasExited) { taskkill /F /T /PID $server.Id 2>&1 | Out-Null }
    Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
}
