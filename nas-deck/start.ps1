[CmdletBinding()]
param([switch]$Build, [switch]$InstallShortcut, [switch]$InstallStartup)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Process-State.ps1')

$executable = Join-Path $PSScriptRoot 'build\NasDeck.App\NasDeck.exe'
$statePath = Join-Path $PSScriptRoot '.running.json'
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$launchLock = [Threading.Mutex]::new($false, "Local\NasDeck.Launch.$userSid")
$locked = $false
try {
    try { $locked = $launchLock.WaitOne([TimeSpan]::FromSeconds(15)) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another NAS Deck launcher is still running.' }

    $running = Get-NasDeckProcess $statePath $executable
    $dotnet = Get-Command dotnet.exe -CommandType Application -ErrorAction SilentlyContinue
    if (-not $dotnet -or -not (& $dotnet.Source --list-runtimes | Where-Object { $_ -match '^Microsoft\.WindowsDesktop\.App 8\.' })) {
        throw 'Install the .NET 8 Desktop Runtime before running NAS Deck.'
    }
    if ($Build) {
        if ($running) { throw 'Exit NAS Deck before rebuilding it (.\stop.ps1).' }
        & $dotnet.Source build (Join-Path $PSScriptRoot 'src\App\NasDeck.App.csproj') --configuration Release --nologo --verbosity quiet
        if ($LASTEXITCODE -ne 0) { throw "NAS Deck build failed with exit code $LASTEXITCODE." }
    }

    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw 'NAS Deck is missing its build. Run .\start.ps1 -Build first.'
    }
    $systemPowerShell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $systemPowerShell -PathType Leaf)) { throw 'Windows PowerShell is required.' }
    if (-not (Get-Command ssh.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        throw 'Install the Windows OpenSSH Client optional feature to use NAS Deck.'
    }

    $shortcutFolders = @()
    if ($InstallShortcut) { $shortcutFolders += [Environment]::GetFolderPath('Programs') }
    if ($InstallStartup) { $shortcutFolders += [Environment]::GetFolderPath('Startup') }
    foreach ($folder in $shortcutFolders) {
        $shortcutPath = Join-Path $folder 'NAS Deck.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $systemPowerShell
        $shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "{0}"' -f $PSCommandPath
        $shortcut.WorkingDirectory = $PSScriptRoot
        $shortcut.IconLocation = "$executable,0"
        $shortcut.Description = 'Watch and manage your NAS from the desktop.'
        $shortcut.Save()
        Write-Output "Shortcut saved to $shortcutPath"
    }

    $showSignal = $null
    if ([Threading.EventWaitHandle]::TryOpenExisting("Local\NasDeck.$userSid.Show", [ref]$showSignal)) {
        try { [void]$showSignal.Set() }
        finally { $showSignal.Dispose() }
        return
    }

    if ($running) { return }
    $process = Start-Process -FilePath $executable -WorkingDirectory $PSScriptRoot -PassThru
    $state = @{ ProcessId = $process.Id; StartTimeTicks = $process.StartTime.ToUniversalTime().Ticks }
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
} finally {
    if ($locked) { $launchLock.ReleaseMutex() }
    $launchLock.Dispose()
}
