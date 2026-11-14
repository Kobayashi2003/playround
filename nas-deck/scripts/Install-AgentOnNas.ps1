# Runs on the NAS, started over SSH by Install-Agent.ps1. Installs, updates or removes the agent service.
[CmdletBinding()]
param(
    [string]$Package,
    [string]$InstallDirectory = 'C:\NasDeck',
    [ValidateRange(1, 65535)]
    [int]$Port = 16000,
    [string]$PawnIOSetup,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$serviceName = 'NasDeckAgent'
$appDirectory = Join-Path $InstallDirectory 'app'
$dataDirectory = Join-Path $InstallDirectory 'data'
$executable = Join-Path $appDirectory 'NasDeck.Agent.exe'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The SSH account must be an administrator on the NAS to install a service.'
}

function Stop-Agent {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if (-not $service) { return $false }
    if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force }
    # The service reports Stopped a moment before its process lets go of its files.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Process -Name 'NasDeck.Agent' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 300
    }
    return $true
}

if ($Uninstall) {
    if (Stop-Agent) {
        sc.exe delete $serviceName | Out-Null
        Write-Output 'The agent service was removed.'
    }
    if (Test-Path -LiteralPath $InstallDirectory) { Remove-Item -LiteralPath $InstallDirectory -Recurse -Force }
    Write-Output "Removed $InstallDirectory."
    return
}

if (-not $Package -or -not (Test-Path -LiteralPath $Package)) { throw "The agent package was not found: $Package" }
$exists = Stop-Agent

$staging = Join-Path $InstallDirectory 'staging'
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Expand-Archive -LiteralPath $Package -DestinationPath $staging -Force
Remove-Item -LiteralPath $Package -Force

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
# Only administrators and the service may read the token or replace the service's files.
icacls.exe $InstallDirectory /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on the install directory.' }
Move-Item -LiteralPath (Join-Path $staging 'token') -Destination (Join-Path $dataDirectory 'token') -Force
if (Test-Path -LiteralPath $appDirectory) { Remove-Item -LiteralPath $appDirectory -Recurse -Force }
Move-Item -LiteralPath $staging -Destination $appDirectory

$binaryPath = '"{0}" --port {1} --data "{2}"' -f $executable, $Port, $dataDirectory
if ($exists) {
    sc.exe config $serviceName binPath= $binaryPath start= delayed-auto | Out-Null
} else {
    sc.exe create $serviceName binPath= $binaryPath start= delayed-auto DisplayName= 'NAS Deck Agent' | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "sc.exe could not register the service (exit code $LASTEXITCODE)." }
sc.exe description $serviceName 'Reports this machine''s load, temperatures and disks to NAS Deck, and puts its disks to sleep on request.' | Out-Null
sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/5000/restart/60000 | Out-Null

if ($PawnIOSetup) {
    $uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO'
    if (Test-Path -LiteralPath $uninstallKey) {
        Write-Output 'PawnIO is already installed.'
    } else {
        $PawnIOSetup = (Resolve-Path -LiteralPath $PawnIOSetup).Path
        $signature = Get-AuthenticodeSignature -LiteralPath $PawnIOSetup
        if ($signature.Status -ne 'Valid') { throw "The PawnIO installer's signature is $($signature.Status); it was not run." }
        $setup = Start-Process -FilePath $PawnIOSetup -ArgumentList '-install', '-silent' -PassThru
        if (-not $setup.WaitForExit(120000)) {
            $setup.Kill()
            Write-Warning 'The PawnIO installer did not finish on its own. Install PawnIO on the NAS by hand from https://pawnio.eu.'
        } elseif (Test-Path -LiteralPath $uninstallKey) {
            Write-Output 'PawnIO was installed.'
        } else {
            Write-Warning "The PawnIO installer exited with code $($setup.ExitCode) and PawnIO is not installed."
        }
    }
    Remove-Item -LiteralPath $PawnIOSetup -Force -ErrorAction SilentlyContinue
}

Start-Service -Name $serviceName
$token = (Get-Content -LiteralPath (Join-Path $dataDirectory 'token') -Raw).Trim()
$deadline = (Get-Date).AddSeconds(30)
$answer = $null
do {
    Start-Sleep -Milliseconds 700
    try {
        $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/snapshot" -Headers @{ 'X-NasDeck-Token' = $token } -TimeoutSec 3
    } catch {
        $answer = $null
    }
} while (-not $answer -and (Get-Date) -lt $deadline)
if (-not $answer) { throw "The agent service started but does not answer on port $Port. See the Application event log on the NAS." }

# The agent loads the temperature sensors a few seconds after it starts.
$hasPawnIO = Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO'
$deadline = (Get-Date).AddSeconds(20)
while ($hasPawnIO -and $null -eq $answer.system.cpuTempC -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try { $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/snapshot" -Headers @{ 'X-NasDeck-Token' = $token } -TimeoutSec 3 } catch { }
}
$temperature = if ($null -ne $answer.system.cpuTempC) { "$($answer.system.cpuTempC) C" }
    elseif ($hasPawnIO) { 'not read yet' }
    else { 'unavailable (PawnIO is not installed)' }
Write-Output "The agent $($answer.agentVersion) is running on $($answer.system.hostName): $($answer.disks.Count) disks, CPU temperature $temperature."
