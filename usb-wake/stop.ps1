$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot '.running.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No recorded USB Wake processes.'; return }
$entries = @(Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json)
function Stop-OwnedTree([int]$ProcessId, [datetime]$StartedAt) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.StartTime.ToUniversalTime() -ne $StartedAt.ToUniversalTime()) { return }
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId")
    foreach ($child in $children) {
        $childProcess = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($childProcess -and $childProcess.StartTime -ge $process.StartTime -and [math]::Abs(($childProcess.StartTime - $child.CreationDate).TotalSeconds) -lt 1) {
            Stop-OwnedTree $childProcess.Id $childProcess.StartTime
        }
    }
    $current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($current -and $current.StartTime.ToUniversalTime() -eq $StartedAt.ToUniversalTime()) { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue }
}
foreach ($entry in $entries) { Stop-OwnedTree $entry.id ([datetime]$entry.startedAt) }
Remove-Item -LiteralPath $statePath -Force
Write-Host 'Stopped recorded USB Wake processes.'
