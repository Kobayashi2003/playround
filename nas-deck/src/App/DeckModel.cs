using NasDeck.Protocol;

namespace NasDeck;

/// <summary>A fixed-length history of one reading, oldest first.</summary>
internal sealed class Series(int capacity)
{
    private readonly Queue<float> values = new(capacity);

    internal IReadOnlyCollection<float> Values => values;

    internal void Add(double value)
    {
        if (values.Count == capacity) values.Dequeue();
        values.Enqueue((float)value);
    }

    internal void Clear() => values.Clear();
}

/// <summary>Everything the widget draws from.</summary>
internal sealed class DeckModel(NasSettings settings)
{
    internal NasSettings Settings = settings;
    /// <summary>Whether SSH and file sharing answer; null before the first check.</summary>
    internal NasStatus? Ports;
    internal DateTime? CheckedAt;
    /// <summary>The agent's latest reading, or null while the agent is out of reach.</summary>
    internal Snapshot? Snapshot;
    internal DateTime SnapshotAt;
    internal bool HasAgentToken;
    internal string? AgentProblem;
    /// <summary>A power command in progress, such as "Waking…".</summary>
    internal string? Activity;
    internal DateTime ActivityStarted;
    internal string? Notice;
    internal DateTime NoticeAt;
    internal bool Compact;
    internal bool Pinned;
    internal bool DiskCharts = true;
    internal readonly HashSet<int> Expanded = [];
    /// <summary>Disks with a sleep or wake command on its way, by disk number.</summary>
    internal readonly Dictionary<int, (string Label, DiskPower Expected, DateTime Deadline)> DiskActivity = [];
    internal readonly Series Cpu = new(90);
    internal readonly Series Rx = new(90);
    /// <summary>Read and write rates per disk, by serial number: disk numbers move when disks are added.</summary>
    internal readonly Dictionary<string, (Series Read, Series Write)> DiskIo = [];

    internal bool Live => Snapshot is not null;
    internal bool Online => Live || Ports is { IsOnline: true };
    internal bool NoticeVisible => Notice is not null && DateTime.UtcNow - NoticeAt < TimeSpan.FromSeconds(10);

    internal NasTone Tone => Activity is not null ? NasTone.Busy
        : Live ? NasTone.Ready
        : Ports switch
        {
            { IsOnline: true } => NasTone.Partial,
            { IsOnline: false } => NasTone.Offline,
            _ => NasTone.Unknown
        };

    internal string StatusText => Activity is not null ? $"{Activity} {(int)(DateTime.UtcNow - ActivityStarted).TotalSeconds}s"
        : Live ? $"Online · up {Format.Duration(Snapshot!.System.UptimeSeconds)}"
        : Ports switch
        {
            { IsReady: true } => "Online",
            { IsOnline: true } => "Partially online",
            { IsOnline: false } => CheckedAt is { } time ? $"Offline · checked {time:HH:mm:ss}" : "Offline",
            _ => "Checking…"
        };

    /// <summary>Hard disks first in drive-letter order, then the rest.</summary>
    internal IEnumerable<DiskInfo> Disks => (Snapshot?.Disks ?? [])
        .OrderBy(disk => disk.Rotational ? 0 : 1)
        .ThenBy(disk => disk.Volumes.Length > 0 ? disk.Volumes[0].Letter : "~")
        .ThenBy(disk => disk.Number);
}

internal enum HealthLevel { Good, Warning, Bad }

internal static class DiskHealth
{
    internal const int WarmC = 50;
    internal const int HotC = 55;

    internal static string Letters(DiskInfo disk) =>
        disk.Volumes.Length > 0 ? string.Join(" ", disk.Volumes.Select(volume => volume.Letter)) : $"#{disk.Number}";

    internal static (HealthLevel Level, string? Reason) Of(DiskInfo disk)
    {
        var smart = disk.Smart;
        if (disk.Health == HealthStatus.Bad && smart is not ({ Pending: > 0 } or { Uncorrectable: > 0 }))
            return (HealthLevel.Bad, "the drive reports a failing health attribute: back this disk up");
        if (smart is { Pending: > 0 } or { Uncorrectable: > 0 })
            return (HealthLevel.Bad, $"{(smart.Pending ?? 0) + (smart.Uncorrectable ?? 0)} unreadable sectors: back this disk up");
        if (disk.Power != DiskPower.Standby && smart?.TemperatureC >= HotC) return (HealthLevel.Bad, $"running hot at {smart.TemperatureC} °C");
        if (smart is { Reallocated: > 0 }) return (HealthLevel.Warning, $"{smart.Reallocated} reallocated sectors");
        if (disk.Power != DiskPower.Standby && smart?.TemperatureC >= WarmC) return (HealthLevel.Warning, $"warm at {smart.TemperatureC} °C");
        var full = disk.Volumes.FirstOrDefault(volume => volume.TotalBytes > 0 && volume.FreeBytes < volume.TotalBytes * 0.05);
        if (full is not null) return (HealthLevel.Warning, $"{full.Letter} is almost full");
        return (HealthLevel.Good, null);
    }
}

/// <summary>Turns readings into one-off notifications: each condition is reported once until it clears.</summary>
internal sealed class Alerts
{
    private readonly HashSet<string> raised = [];

    internal List<string> Evaluate(Snapshot snapshot)
    {
        var messages = new List<string>();
        foreach (var disk in snapshot.Disks)
        {
            var name = DiskHealth.Letters(disk);
            var smart = disk.Smart;
            if (disk.Power != DiskPower.Standby && smart?.TemperatureC is { } temperature)
                Check($"temp:{disk.Serial}", temperature >= DiskHealth.HotC, temperature < DiskHealth.WarmC, $"Disk {name} is running hot at {temperature} °C.");
            // The counts are part of the key, so a count that grows is reported again.
            var bad = (smart?.Reallocated ?? 0, smart?.Pending ?? 0, smart?.Uncorrectable ?? 0);
            if (bad != (0, 0, 0) && raised.Add($"smart:{disk.Serial}:{bad}"))
                messages.Add($"Disk {name} reports {bad.Item1} reallocated, {bad.Item2} pending and {bad.Item3} uncorrectable sectors. Back it up.");
            Check($"spin:{disk.Serial}", disk.SpinUpsToday >= 12, disk.SpinUpsToday < 12,
                $"Disk {name} has spun up {disk.SpinUpsToday} times today. A longer sleep timer would wear it less.");
            foreach (var volume in disk.Volumes.Where(volume => volume.TotalBytes > 0))
            {
                var free = (double)volume.FreeBytes / volume.TotalBytes;
                Check($"space:{volume.Letter}", free < 0.05, free > 0.06, $"{volume.Letter} has only {Format.Bytes(volume.FreeBytes)} free.");
            }
        }
        if (snapshot.System.CpuTempC is { } cpu)
            Check("cpu", cpu >= 90, cpu < 80, $"The NAS CPU is at {cpu:0} °C.");
        return messages;

        void Check(string key, bool raise, bool clear, string message)
        {
            if (raise && raised.Add(key)) messages.Add(message);
            else if (clear) raised.Remove(key);
        }
    }
}
