[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$configuration = @{
    Host = '192.168.0.168'; SshUser = '17312'; SshPort = 22; MacAddress = '2C-F0-5D-32-32-14'
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
$port = [int]$configuration.SshPort
$mac = [string]$configuration.MacAddress
if ([Uri]::CheckHostName($nasAddress) -eq [UriHostNameType]::Unknown -or
    $nasUser -notmatch '^[\w.@\\-]+$' -or $port -lt 1 -or $port -gt 65535 -or
    $mac -notmatch '^[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}$') {
    throw 'Review the NAS address, SSH username, port, and MAC address in Settings.'
}
$hostAlias = 'nas-switch-' + ($mac -replace '[:-]', '').ToLowerInvariant()
$sshDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh'
$identity = Join-Path $sshDir 'nas-switch-ed25519'
$ssh = (Get-Command ssh.exe -CommandType Application).Source
$keygen = (Get-Command ssh-keygen.exe -CommandType Application).Source
$keyadd = (Get-Command ssh-add.exe -CommandType Application).Source

Write-Host "Set up key login for $nasUser on $nasAddress."
$agent = Get-Service -Name ssh-agent
if ($agent.StartType -ne 'Automatic' -or $agent.Status -ne 'Running') {
    Write-Host 'Approve the Windows administrator prompt to enable the OpenSSH Authentication Agent.'
    $enableAgent = @'
$ErrorActionPreference = 'Stop'
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service -Name ssh-agent
'@
    $payload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($enableAgent))
    $windowsPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $agentSetup = Start-Process -FilePath $windowsPowerShell -WindowStyle Hidden `
        -Verb RunAs -ArgumentList '-NoProfile', '-EncodedCommand', $payload -PassThru -Wait
    if ($agentSetup.ExitCode -ne 0) { throw 'Windows could not enable the OpenSSH Authentication Agent.' }
}

if (-not (Test-Path -LiteralPath $identity)) {
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
    Write-Host 'Choose a passphrase for the dedicated SSH key.'
    & $keygen -t ed25519 -f $identity -C 'nas-switch'
    if ($LASTEXITCODE -ne 0) { throw 'SSH key generation failed.' }
}
& $keyadd $identity
if ($LASTEXITCODE -ne 0) { throw 'The SSH agent could not load the dedicated key.' }
$publicKey = (Get-Content -LiteralPath "$identity.pub" -Raw).Trim()

$knownHosts = Join-Path $sshDir 'known_hosts'
if (Test-Path -LiteralPath $knownHosts) {
    $trustedAlias = & $keygen -F $hostAlias -f $knownHosts
    if (-not $trustedAlias) {
        $lookup = if ($port -eq 22) { $nasAddress } else { "[$nasAddress]:$port" }
        $trustedAddress = & $keygen -F $lookup -f $knownHosts
        $aliasEntries = $trustedAddress | Where-Object { $_ -match '^\S+\s+(ssh-|ecdsa-)' } | ForEach-Object {
            $_ -replace '^\S+', $hostAlias
        }
        if ($aliasEntries) { [IO.File]::AppendAllText($knownHosts, "`r`n$($aliasEntries -join "`r`n")`r`n") }
    }
}

$connection = @('-p', $port, '-i', $identity, '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5',
    '-o', "HostKeyAlias=$hostAlias", '-l', $nasUser, '--', $nasAddress)
$verify = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes') + $connection
& $ssh @verify hostname
if ($LASTEXITCODE -eq 0) {
    Write-Host 'SSH key login is ready. You can close this window.'
    return
}

$remoteSetup = @'
$ErrorActionPreference = 'Stop'
$key = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__NAS_SWITCH_PUBLIC_KEY__'))
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $authorizedKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
    if (-not (Test-Path -LiteralPath $authorizedKeys)) {
        New-Item -ItemType File -Path $authorizedKeys | Out-Null
        icacls.exe $authorizedKeys /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on the NAS authorized keys file.' }
    }
} else {
    $sshDirectory = Join-Path $env:USERPROFILE '.ssh'
    New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
    $authorizedKeys = Join-Path $sshDirectory 'authorized_keys'
}
$blob = ($key -split '\s+')[1]
$installed = (Test-Path -LiteralPath $authorizedKeys) -and
    [bool](Get-Content -LiteralPath $authorizedKeys | Where-Object { ($_ -split '\s+') -ccontains $blob })
if (-not $installed) {
    [IO.File]::AppendAllText($authorizedKeys, "`r`n$key`r`n", [Text.UTF8Encoding]::new($false))
}
'@
$publicPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publicKey))
$remoteSetup = $remoteSetup.Replace('__NAS_SWITCH_PUBLIC_KEY__', $publicPayload)
$encodedSetup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteSetup))

Write-Host 'Enter the NAS account password when OpenSSH prompts for it.'
& $ssh -o StrictHostKeyChecking=ask @connection "powershell.exe -NoProfile -NonInteractive -EncodedCommand $encodedSetup"
if ($LASTEXITCODE -ne 0) { throw 'The NAS did not install the SSH public key.' }
& $ssh @verify hostname
if ($LASTEXITCODE -ne 0) { throw 'The NAS installed the public key but key login could not be verified.' }
Write-Host 'SSH key login is ready. You can close this window.'
