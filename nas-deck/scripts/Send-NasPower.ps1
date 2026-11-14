[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Hibernate', 'Restart', 'Shutdown')]
    [string]$Action = 'Hibernate',
    [string]$ComputerName = '192.168.0.168',
    [string]$UserName = '17312',
    [ValidateRange(1, 65535)]
    [int]$Port = 22,
    [Parameter(Mandatory)] [string]$IdentityFile,
    [Parameter(Mandatory)] [string]$HostKeyAlias
)

function Test-NasTcpPort {
    param([string]$HostName, [int]$TcpPort)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync($HostName, $TcpPort)
        return $connection.Wait(750) -and $client.Connected
    } catch [System.AggregateException] {
        return $false
    } finally {
        $client.Dispose()
    }
}

$target = "$UserName@$ComputerName"
$shutdownArguments = @{ Hibernate = '/h'; Restart = '/r /t 0'; Shutdown = '/s /t 0' }[$Action]
if ($PSCmdlet.ShouldProcess($target, "$Action the NAS")) {
    $ssh = Get-Command ssh.exe -CommandType Application -ErrorAction Stop
    $requestMarker = '__NAS_POWER_REQUESTED__'
    $remoteScript = @"
[Console]::WriteLine('$requestMarker')
Start-Sleep -Milliseconds 300
shutdown.exe $shutdownArguments
exit `$LASTEXITCODE
"@
    $payload = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteScript))
    $remoteCommand = "powershell.exe -NoProfile -NonInteractive -EncodedCommand $payload"
    $sshArguments = @('-p', $Port, '-i', $IdentityFile, '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', "HostKeyAlias=$HostKeyAlias",
        '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2',
        '-l', $UserName, '--', $ComputerName, $remoteCommand)
    $sshOutput = & {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        & $ssh.Source @sshArguments 2>&1
    }
    $sshExitCode = $LASTEXITCODE

    if ($sshExitCode -eq 0) {
        Write-Output "$Action command accepted by $ComputerName."
        return
    }

    # A NAS going down can lose its network connection before SSH returns the command status.
    if ($sshExitCode -eq 255 -and $sshOutput -ccontains $requestMarker) {
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        $offlineChecks = 0
        do {
            if ((Test-NasTcpPort $ComputerName $Port) -or (Test-NasTcpPort $ComputerName 445)) {
                $offlineChecks = 0
            } else {
                $offlineChecks++
                if ($offlineChecks -eq 2) {
                    $global:LASTEXITCODE = 0
                    Write-Output "$Action requested. $ComputerName went offline."
                    return
                }
            }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
    }

    $diagnostics = ($sshOutput | Where-Object { $_ -cne $requestMarker }) -join "`n"
    throw "SSH to $target (port $Port) returned exit code $sshExitCode.`n$diagnostics"
}
