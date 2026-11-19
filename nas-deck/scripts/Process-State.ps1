function Get-NasDeckProcess {
    param([string]$StatePath, [string]$ExecutablePath)

    if (Test-Path -LiteralPath $StatePath) {
        try {
            $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
            $process = Get-Process -Id $state.ProcessId -ErrorAction Stop
            if ($process.Path -eq $ExecutablePath -and $process.StartTime.ToUniversalTime().Ticks -eq $state.StartTimeTicks) {
                return $process
            }
        } catch {
            Write-Verbose 'The recorded NAS Deck process is no longer running.'
        }
    }

    # Also match an instance launched directly from the Start menu or Startup shortcut.
    foreach ($candidate in (Get-Process -Name 'NasDeck' -ErrorAction SilentlyContinue)) {
        try {
            if ($candidate.Path -eq $ExecutablePath) { return $candidate }
        } catch { }
    }
}
