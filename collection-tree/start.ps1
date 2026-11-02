# Serves the built pages and opens them in the browser (-NoBrowser to skip); -Build rebuilds them
# from Everything first. .\stop.ps1 stops it from another window. Other arguments go to
# collection_tree.py.
param(
    [int]$Port = 16040,
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

# settings.json may move the output folder; relative paths are relative to this folder.
$output = 'HTML'
$settings = Join-Path $PSScriptRoot 'settings.json'
if (Test-Path -LiteralPath $settings) {
    $configured = (Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).output
    if ($configured) { $output = $configured }
}
if (-not $Build -and -not (Test-Path -LiteralPath (Join-Path ([IO.Path]::GetFullPath($output, $PSScriptRoot)) 'index.html'))) {
    throw "No built pages in $output. Run .\start.ps1 -Build to build them."
}

$scriptArgs = @('run', 'collection_tree.py', '--port', $Port) + $Rest
if (-not $Build) { $scriptArgs += '--serve' }
if ($NoBrowser) { $scriptArgs += '--no-browser' }
$server = Start-Process uv -NoNewWindow -PassThru -ArgumentList $scriptArgs
@{ ProcessId = $server.Id; StartTicks = $server.StartTime.Ticks } | ConvertTo-Json | Set-Content -LiteralPath $runFile
try {
    while (-not $server.HasExited) { Start-Sleep -Milliseconds 500 }
} finally {
    if (-not $server.HasExited) { taskkill /F /T /PID $server.Id 2>&1 | Out-Null }
    Remove-Item -LiteralPath $runFile -ErrorAction SilentlyContinue
}
