# Registers agent.py as a logon task for the current user, so it runs in the
# signed-in session (programs it launches appear on the desktop) and starts it
# now. -Uninstall stops and removes the task. Requires `uv sync` first.
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'USB Wake Agent'
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed '$taskName'."
    } else {
        Write-Host "'$taskName' is not installed."
    }
    return
}
$python = Join-Path $PSScriptRoot '.venv/Scripts/pythonw.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run uv sync first.' }
& (Join-Path $PSScriptRoot '.venv/Scripts/python.exe') (Join-Path $PSScriptRoot 'tools/agent.py') --check
if ($LASTEXITCODE -ne 0) { throw 'agent.toml is invalid; the task was not installed.' }
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $python -Argument "`"$(Join-Path $PSScriptRoot 'tools/agent.py')`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# No time limit, restart after crashes, and keep running on battery.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started '$taskName'. Log: .logs/agent.log"
