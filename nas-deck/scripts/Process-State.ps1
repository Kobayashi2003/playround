function Get-NasDeckProcess {
    param([string]$StatePath, [string]$ExecutablePath)

    if (-not (Test-Path -LiteralPath $StatePath)) { return }
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
