# Child-process lifecycle: one launcher per app, plus the shared Caddy.
#
# Ctrl+C is the graceful path — Windows fans CTRL_C_EVENT out to the whole console
# process group, so every launcher runs its own shutdown. Stop-Children is the
# backstop for an external kill. It uses taskkill /T because the real workloads are
# grandchildren (pixi -> python -> waitress/celery/redis; pwsh -> node), which
# Stop-Process would orphan.

function Push-ProcessEnvironment {
    <# Set variables on *this* process — children inherit it, and Start-Process has
       no -Environment parameter — returning what to restore afterwards.

       Restoring matters: the gateway launches several apps in sequence from one
       process, and one app's port must not leak into the next one's environment.
       The same pair brackets a routes.env script, so it computes upstreams from the
       ports gateway.json placed rather than from the project's own defaults. #>
    param([hashtable] $Environment = @{})

    $saved = @{}
    foreach ($key in $Environment.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
    }
    return $saved
}

function Pop-ProcessEnvironment {
    param([hashtable] $Saved = @{})

    foreach ($key in $Saved.Keys) {
        [Environment]::SetEnvironmentVariable($key, $Saved[$key], 'Process')
    }
}

function Start-Child {
    param(
        [string]    $Label,
        [string]    $File,
        [string[]]  $Arguments = @(),
        [string]    $Cwd,
        [hashtable] $Environment = @{}
    )

    $saved = Push-ProcessEnvironment -Environment $Environment
    try {
        $params = @{ FilePath = $File; NoNewWindow = $true; PassThru = $true }
        if ($Arguments) { $params.ArgumentList     = $Arguments }
        if ($Cwd)       { $params.WorkingDirectory = $Cwd }
        $proc = Start-Process @params
    } catch {
        throw "Could not start '$Label' ($File): $($_.Exception.Message)"
    } finally {
        Pop-ProcessEnvironment -Saved $saved
    }

    Write-Host "[START] $Label (PID $($proc.Id))" -ForegroundColor Green
    return [pscustomobject]@{ Label = $Label; Process = $proc }
}

function Wait-Children {
    <# Block until any child exits; the caller tears the rest down. If one app's
       stack dies the gateway is half-broken, and failing fast is more honest than
       serving an edge whose routes answer 502. #>
    param([object[]] $Children)

    while ($true) {
        foreach ($child in $Children) {
            if ($child.Process.HasExited) {
                Write-Host ''
                Write-Host "[EXIT] $($child.Label) exited with $($child.Process.ExitCode); stopping the rest." -ForegroundColor Yellow
                return
            }
        }
        Start-Sleep -Seconds 1
    }
}

function Stop-Children {
    param([AllowEmptyCollection()] [object[]] $Children)

    foreach ($child in $Children) {
        $proc = $child.Process
        if (-not $proc -or $proc.HasExited) { continue }
        Write-Host "[STOP] $($child.Label) (PID $($proc.Id))" -ForegroundColor Yellow
        Start-Process -FilePath 'taskkill' -ArgumentList @('/F', '/T', '/PID', $proc.Id) `
            -NoNewWindow -Wait -ErrorAction SilentlyContinue | Out-Null
    }
}
