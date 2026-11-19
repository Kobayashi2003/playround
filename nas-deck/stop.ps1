[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Process-State.ps1')

$statePath = Join-Path $PSScriptRoot '.running.json'
$process = Get-NasDeckProcess $statePath (Join-Path $PSScriptRoot 'build\NasDeck.App\NasDeck.exe')
if (-not $process) {
    Write-Output 'NAS Deck is not running.'
    return
}

# The app closes its SSH tunnel on the way out.
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$eventName = "Local\NasDeck.$userSid.Stop.$($process.Id)"
$stopSignal = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, $eventName)
try { [void]$stopSignal.Set() }
finally { $stopSignal.Dispose() }
if (-not $process.WaitForExit(5000)) { throw 'NAS Deck did not exit within five seconds.' }
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Write-Output 'NAS Deck stopped.'
