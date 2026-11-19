# Sign-in for the admin page: one account, sessions held in memory, an audit trail.
#
# The page is reachable through the tunnel, so the password is the only thing
# between the internet and a button that stops every app. Hence: PBKDF2 rather
# than a fast hash, a lockout per client and a global one (behind the tunnel every
# client arrives from 127.0.0.1 unless the edge says otherwise), a CSRF token on
# every write, and a record of who did what.
#
# Sessions do not survive a gateway restart; signing in again is the price of not
# keeping bearer tokens on disk.

$script:PasswordIterations = 210000
$script:PerClientLimit     = 5     # failures per client in the window before it is locked out
$script:GlobalLimit        = 30    # failures from everyone in the window before sign-in closes
$script:FailureWindow      = [TimeSpan]::FromMinutes(15)
$script:SessionMaxAge      = [TimeSpan]::FromDays(7)

function New-PasswordHash {
    <# "pbkdf2-sha256$<iterations>$<salt>$<hash>", base64 parts. #>
    param([Parameter(Mandatory)] [string] $Password, [int] $Iterations = $script:PasswordIterations)

    $salt = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    $hash = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
        [Text.Encoding]::UTF8.GetBytes($Password), $salt, $Iterations,
        [Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    return 'pbkdf2-sha256${0}${1}${2}' -f $Iterations, [Convert]::ToBase64String($salt), [Convert]::ToBase64String($hash)
}

function Test-PasswordHash {
    param([string] $Password, [string] $Stored)

    $parts = "$Stored" -split '\$'
    if ($parts.Count -ne 4 -or $parts[0] -ne 'pbkdf2-sha256') { return $false }
    try {
        $salt     = [Convert]::FromBase64String($parts[2])
        $expected = [Convert]::FromBase64String($parts[3])
        $actual   = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2(
            [Text.Encoding]::UTF8.GetBytes("$Password"), $salt, [int]$parts[1],
            [Security.Cryptography.HashAlgorithmName]::SHA256, $expected.Length)
    } catch { return $false }
    return [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($actual, $expected)
}

function Get-TokenHash {
    param([string] $Token)
    $bytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Token))
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

function New-RandomToken {
    param([int] $Bytes = 32)
    return [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes($Bytes)).
        TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-AdminAuth {
    param(
        [string] $User,
        [string] $PasswordHash,
        [double] $SessionHours,
        [string] $AuditFile
    )

    $auth = @{
        User         = $User
        PasswordHash = $PasswordHash
        IdleTimeout  = [TimeSpan]::FromHours($SessionHours)
        Sessions     = @{}   # token hash -> session
        Failures     = @{}   # client -> [datetime[]]
        Locked       = @{}   # client -> until
        GlobalFails  = [Collections.Generic.List[datetime]]::new()
        GlobalUntil  = [datetime]::MinValue
        AuditFile    = $AuditFile
        Audit        = [Collections.Generic.List[object]]::new()
    }

    # The page shows recent history across restarts, so the tail of the file is read back.
    if ($AuditFile -and (Test-Path -LiteralPath $AuditFile)) {
        foreach ($line in Get-Content -LiteralPath $AuditFile -Tail 300 -Encoding utf8) {
            try { $auth.Audit.Add(($line | ConvertFrom-Json -AsHashtable)) } catch { }
        }
    }
    return $auth
}

function Write-AdminAudit {
    param([hashtable] $Auth, [string] $Event, [string] $Detail = '', [string] $Client = '', [string] $User = '', [bool] $Ok = $true)

    $entry = [ordered]@{
        time   = (Get-Date).ToString('o')
        event  = $Event
        ok     = $Ok
        user   = $User
        client = $Client
        detail = $Detail
    }
    $Auth.Audit.Add($entry)
    while ($Auth.Audit.Count -gt 500) { $Auth.Audit.RemoveAt(0) }
    if ($Auth.AuditFile) {
        try {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Auth.AuditFile) | Out-Null
            [IO.File]::AppendAllText($Auth.AuditFile, ($entry | ConvertTo-Json -Compress) + "`n", [Text.UTF8Encoding]::new($false))
        } catch { }
    }
}

function Get-LoginBlock {
    <# Why sign-in is refused for this client right now, or $null. #>
    param([hashtable] $Auth, [string] $Client)

    $now = Get-Date
    if ($Auth.GlobalUntil -gt $now) {
        return "Too many failed sign-ins from everywhere; try again after $($Auth.GlobalUntil.ToString('HH:mm'))."
    }
    if ($Auth.Locked.ContainsKey($Client) -and $Auth.Locked[$Client] -gt $now) {
        return "Too many failed sign-ins; try again after $($Auth.Locked[$Client].ToString('HH:mm'))."
    }
    return $null
}

function Register-LoginFailure {
    param([hashtable] $Auth, [string] $Client)

    $now   = Get-Date
    $since = $now - $script:FailureWindow

    $list = @($Auth.Failures[$Client] | Where-Object { $_ -gt $since }) + $now
    $Auth.Failures[$Client] = $list
    if ($list.Count -ge $script:PerClientLimit) {
        $Auth.Locked[$Client] = $now + $script:FailureWindow
        $Auth.Failures.Remove($Client)
    }

    $Auth.GlobalFails.Add($now)
    $Auth.GlobalFails.RemoveAll([Predicate[datetime]] { param($t) $t -le $since }) | Out-Null
    if ($Auth.GlobalFails.Count -ge $script:GlobalLimit) {
        $Auth.GlobalUntil = $now + $script:FailureWindow
        $Auth.GlobalFails.Clear()
    }
}

function Clear-LoginLocks {
    param([hashtable] $Auth)
    $Auth.Failures.Clear()
    $Auth.Locked.Clear()
    $Auth.GlobalFails.Clear()
    $Auth.GlobalUntil = [datetime]::MinValue
}

function New-AdminSession {
    <# Returns @{ Token; Session }. Only the token's hash is kept. #>
    param([hashtable] $Auth, [string] $Client, [string] $UserAgent)

    $token = New-RandomToken
    $hash  = Get-TokenHash $token
    $now   = Get-Date
    $session = @{
        Id        = $hash.Substring(0, 12)
        Hash      = $hash
        Csrf      = New-RandomToken 24
        User      = $Auth.User
        Client    = $Client
        UserAgent = $UserAgent
        Created   = $now
        LastSeen  = $now
    }
    $Auth.Sessions[$hash] = $session
    return @{ Token = $token; Session = $session }
}

function Get-AdminSession {
    <# The live session for a cookie value; $null if absent or expired.
       Pass -Passive for background polling so idle timeout actually expires. #>
    param([hashtable] $Auth, [string] $Token, [switch] $Passive)

    if (-not $Token) { return $null }
    $hash = Get-TokenHash $Token
    $session = $Auth.Sessions[$hash]
    if (-not $session) { return $null }

    $now = Get-Date
    if (($now - $session.LastSeen) -gt $Auth.IdleTimeout -or ($now - $session.Created) -gt $script:SessionMaxAge) {
        $Auth.Sessions.Remove($hash)
        return $null
    }
    if (-not $Passive) { $session.LastSeen = $now }
    return $session
}

function Remove-ExpiredSessions {
    param([hashtable] $Auth)
    $now = Get-Date
    foreach ($key in @($Auth.Sessions.Keys)) {
        $s = $Auth.Sessions[$key]
        if (($now - $s.LastSeen) -gt $Auth.IdleTimeout -or ($now - $s.Created) -gt $script:SessionMaxAge) {
            $Auth.Sessions.Remove($key)
        }
    }
}
