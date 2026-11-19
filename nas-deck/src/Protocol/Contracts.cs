namespace NasDeck.Protocol;

/// <summary>What the agent serves and the widget reads. Both projects compile this file.</summary>
public static class AgentApi
{
    public const int DefaultPort = 16000;
    public const string TokenHeader = "X-NasDeck-Token";
}

public enum DiskPower { Unknown, Spinning, Standby }

public sealed record VolumeInfo(string Letter, string Label, long TotalBytes, long FreeBytes);

public sealed record SmartInfo(
    int? TemperatureC,
    long? PowerOnHours,
    long? StartStopCount,
    long? LoadCycleCount,
    long? Reallocated,
    long? Pending,
    long? Uncorrectable,
    DateTimeOffset ReadAt);

public enum HealthStatus { Unknown, Good, Caution, Bad }

/// <summary>One row of a disk's health table: a SMART attribute, or a named reading for SAS and NVMe.</summary>
/// <param name="Id">The SMART attribute number in hex; empty for a reading that has none.</param>
/// <param name="Raw">The raw value as the drive reports it: twelve hex digits for SMART, a number otherwise.</param>
public sealed record DiskAttribute(string Id, string Name, int? Current, int? Worst, int? Threshold, string Raw, HealthStatus Status);

/// <summary>Everything the agent knows about one disk, as of the last time it was read while spinning.</summary>
public sealed record DiskDetail(
    int Number,
    string Model,
    string Serial,
    string Firmware,
    string Interface,
    bool Rotational,
    int? Rpm,
    long SizeBytes,
    DiskPower Power,
    VolumeInfo[] Volumes,
    HealthStatus Health,
    SmartInfo? Smart,
    long? PowerCycles,
    DiskAttribute[] Attributes);

public sealed record WakeEvent(DateTimeOffset At, string Cause);

public sealed record DiskInfo(
    int Number,
    string Model,
    string Serial,
    string Bus,
    bool Rotational,
    long SizeBytes,
    DiskPower Power,
    DateTimeOffset PowerSince,
    double ReadBytesPerSec,
    double WriteBytesPerSec,
    int IdleSeconds,
    VolumeInfo[] Volumes,
    SmartInfo? Smart,
    int SpinUpsToday,
    WakeEvent[] RecentWakes,
    bool CanSleep,
    HealthStatus Health);

public sealed record SystemInfo(
    string HostName,
    string CpuName,
    double CpuPercent,
    double? CpuTempC,
    long MemTotalBytes,
    long MemUsedBytes,
    double NetRxBytesPerSec,
    double NetTxBytesPerSec,
    long UptimeSeconds);

public sealed record SmbSession(string Client, string User, int ConnectedSeconds, int IdleSeconds);

public sealed record SmbOpenFile(string Path, string User, bool Writing);

public sealed record ShareInfo(string Name, string Path);

/// <param name="DiskIdleSeconds">Windows' "turn off hard disk after"; 0 is never.</param>
/// <param name="AutoHibernateMinutes">Hibernate the NAS after this long with no disk or SMB activity; 0 is off.</param>
public sealed record PowerPolicy(int DiskIdleSeconds, int AutoHibernateMinutes);

public enum HostPowerAction { Hibernate, Shutdown }

/// <summary>Sent by the widget as the PC it runs on goes to sleep or shuts down.</summary>
/// <param name="GraceSeconds">How long the NAS waits for the PC to come back before following it.</param>
/// <param name="Addresses">The PC's own addresses, so that its SMB sessions do not count as someone else's.</param>
public sealed record HostLeaving(HostPowerAction Action, int GraceSeconds, string[] Addresses);

/// <param name="Pending">What the NAS will do when <paramref name="Due"/> comes, unless the PC returns first.</param>
/// <param name="Note">Why the NAS last stayed on instead of following, until the widget is back to read it.</param>
public sealed record FollowState(HostPowerAction? Pending, DateTimeOffset? Due, string? Note);

public sealed record Snapshot(
    DateTimeOffset At,
    string AgentVersion,
    SystemInfo System,
    DiskInfo[] Disks,
    SmbSession[] Sessions,
    SmbOpenFile[] OpenFiles,
    ShareInfo[] Shares,
    PowerPolicy Policy,
    FollowState? Follow = null);

/// <param name="Code">"ok", or why nothing was done: "busy", "cooldown", "asleep", "unsupported", "failed".</param>
public sealed record ActionReply(bool Ok, string Code, string Message);

/// <summary>Live disk I/O attributed to one process on the NAS.</summary>
/// <param name="Disks">Physical disk numbers this process read or wrote in the last window; empty when using process totals.</param>
public sealed record ProcessDiskIo(
    int Pid,
    string Name,
    double ReadBytesPerSec,
    double WriteBytesPerSec,
    int[] Disks);

/// <summary>Real-time NAS disk activity returned on demand by <c>/api/activity</c>.</summary>
/// <param name="PerDisk">True when rates come from kernel DiskIo events and include physical disk numbers.</param>
public sealed record NasActivity(
    DateTimeOffset At,
    bool PerDisk,
    ProcessDiskIo[] Processes,
    SmbOpenFile[] OpenFiles);
