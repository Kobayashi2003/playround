<#
.SYNOPSIS
Installs, updates or removes the NAS Deck agent on the NAS, over SSH.

.PARAMETER Build
Publishes the agent first. Without it, the last published agent in build\agent is installed.

.PARAMETER InstallPawnIO
Also installs the PawnIO driver on the NAS, which the agent reads the CPU temperature through.

.PARAMETER Uninstall
Removes the agent service and its folder from the NAS.

.PARAMETER InstallDirectory
Where the agent lives on the NAS. Its token and state go in the data folder inside it.
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$InstallPawnIO,
    [switch]$Uninstall,
    [string]$InstallDirectory = 'C:\NasDeck'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($InstallDirectory -notmatch '^[A-Za-z]:\\[\w.\\-]+$') { throw 'Use an install directory without spaces, such as C:\NasDeck.' }

$configuration = @{
    Host = '192.168.0.168'; SshUser = '17312'; SshPort = 22; MacAddress = '2C-F0-5D-32-32-14'; AgentPort = 16000
}
$dataDirectory = $env:NAS_DECK_DATA_DIR
if ([string]::IsNullOrWhiteSpace($dataDirectory)) { $dataDirectory = 'data' }
if (-not [IO.Path]::IsPathRooted($dataDirectory)) { $dataDirectory = Join-Path $PSScriptRoot $dataDirectory }
$configPath = Join-Path $dataDirectory 'settings.json'
if (Test-Path -LiteralPath $configPath) {
    $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($name in @($configuration.Keys)) {
        if ($null -ne $saved.$name) { $configuration[$name] = $saved.$name }
    }
}
$nasAddress = [string]$configuration.Host
$nasUser = [string]$configuration.SshUser
$agentPort = [int]$configuration.AgentPort
$hostAlias = 'nas-switch-' + ([string]$configuration.MacAddress -replace '[:-]', '').ToLowerInvariant()
$identity = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\nas-switch-ed25519'

$ssh = Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue
$scp = Get-Command scp.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $ssh -or -not $scp) { throw 'Install the Windows OpenSSH Client optional feature first.' }
if (-not (Test-Path -LiteralPath $identity)) { throw 'Set up the SSH key first: run .\Setup-SshKey.ps1.' }
$common = @('-i', $identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', "HostKeyAlias=$hostAlias", '-o', 'ConnectTimeout=8')
$sshArguments = @('-p', $configuration.SshPort) + $common + @('-l', $nasUser, '--', $nasAddress)
$scpArguments = @('-P', $configuration.SshPort, '-q') + $common

function Invoke-Nas {
    param([string]$Command)
    & $ssh.Source @sshArguments $Command
    if ($LASTEXITCODE -ne 0) { throw "The command on the NAS failed with exit code $LASTEXITCODE." }
}

function Send-ToNas {
    param([string]$Path, [string]$Name)
    & $scp.Source @scpArguments $Path "${nasUser}@${nasAddress}:$Name"
    if ($LASTEXITCODE -ne 0) { throw "Could not copy $Name to the NAS (exit code $LASTEXITCODE)." }
}

& $ssh.Source @sshArguments hostname | Out-Null
if ($LASTEXITCODE -ne 0) { throw "SSH to $nasUser@$nasAddress failed. Is the NAS awake, and is the key set up (.\Setup-SshKey.ps1)?" }

$remoteScript = 'nasdeck-install.ps1'
$runRemote = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $remoteScript -InstallDirectory $InstallDirectory -Port $agentPort"
Send-ToNas (Join-Path $PSScriptRoot 'scripts\Install-AgentOnNas.ps1') $remoteScript

$tokenPath = Join-Path $dataDirectory 'agent-token'
if ($Uninstall) {
    Invoke-Nas "$runRemote -Uninstall"
    Invoke-Nas "cmd.exe /c del $remoteScript"
    if (Test-Path -LiteralPath $tokenPath) { Remove-Item -LiteralPath $tokenPath -Force }
    return
}

$publishDirectory = Join-Path $PSScriptRoot 'build\agent'
if ($Build) {
    $dotnet = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $dotnet) { throw 'Install the .NET 8 SDK to build the agent.' }
    if (Test-Path -LiteralPath $publishDirectory) { Remove-Item -LiteralPath $publishDirectory -Recurse -Force }
    # Self-contained, so the NAS needs no .NET runtime of its own.
    & $dotnet.Source publish (Join-Path $PSScriptRoot 'src\Agent\NasDeck.Agent.csproj') --configuration Release `
        --runtime win-x64 --self-contained true --output $publishDirectory --nologo --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw "The agent build failed with exit code $LASTEXITCODE." }
}
if (-not (Test-Path -LiteralPath (Join-Path $publishDirectory 'NasDeck.Agent.exe'))) {
    throw 'The agent is missing its build. Run .\Install-Agent.ps1 -Build first.'
}

# The token is shared by the agent and the widget; a reinstall keeps the one already in use.
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    [IO.File]::WriteAllText($tokenPath, (($bytes | ForEach-Object { $_.ToString('X2') }) -join ''))
}

$package = Join-Path $PSScriptRoot 'build\nasdeck-agent.zip'
if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Force }
Copy-Item -LiteralPath $tokenPath -Destination (Join-Path $publishDirectory 'token') -Force
try {
    Compress-Archive -Path (Join-Path $publishDirectory '*') -DestinationPath $package
} finally {
    Remove-Item -LiteralPath (Join-Path $publishDirectory 'token') -Force
}

Write-Output "Copying the agent to $nasAddress..."
Send-ToNas $package 'nasdeck-agent.zip'
Remove-Item -LiteralPath $package -Force

if ($InstallPawnIO) {
    $pawnIO = Join-Path $PSScriptRoot 'build\PawnIO_setup.exe'
    if (-not (Test-Path -LiteralPath $pawnIO)) {
        Write-Output 'Downloading the PawnIO installer...'
        Invoke-WebRequest -Uri 'https://github.com/namazso/PawnIO.Setup/releases/latest/download/PawnIO_setup.exe' -OutFile $pawnIO -UseBasicParsing
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $pawnIO
    if ($signature.Status -ne 'Valid') {
        Remove-Item -LiteralPath $pawnIO -Force
        throw "The downloaded PawnIO installer's signature is $($signature.Status); it was deleted."
    }
    Send-ToNas $pawnIO 'PawnIO_setup.exe'
    $runRemote += ' -PawnIOSetup PawnIO_setup.exe'
}

Invoke-Nas "$runRemote -Package nasdeck-agent.zip"
Invoke-Nas "cmd.exe /c del $remoteScript"
Write-Output 'Done. NAS Deck connects to the agent within a few seconds.'
