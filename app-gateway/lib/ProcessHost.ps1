# Process environment for the steps that run inside the gateway's own process.
#
# Children get their environment through ProcessStartInfo (lib/Native.cs), so
# nothing here touches them. What still runs in-process is an app's routes.env
# script and `caddy validate`, and both read this process's environment.
#
# Child lifecycle lives in lib/Supervisor.ps1. Ctrl+C is the graceful path —
# Windows fans CTRL_C_EVENT out to the whole console process group, so every
# launcher runs its own shutdown; the supervisor's taskkill /T is the backstop.

function Push-ProcessEnvironment {
    <# Set variables on *this* process, returning what to restore afterwards.

       Restoring matters: one app's port must not leak into the next one's routes.env.
       The pair brackets a routes.env script, so it computes upstreams from the
       ports the app's file placed rather than from the project's own defaults. #>
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
