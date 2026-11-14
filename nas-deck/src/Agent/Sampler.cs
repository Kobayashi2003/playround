using System.Diagnostics;
using System.Reflection;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>
/// Reads the machine every two seconds, keeps the latest <see cref="Snapshot"/>, and carries out the disk
/// commands. One lock guards its state; the device calls that can take seconds run outside it.
/// </summary>
internal sealed class Sampler(string dataDirectory, ILogger<Sampler> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan SmartEvery = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan TemperatureEvery = TimeSpan.FromSeconds(30);
    private static readonly string Version =
        typeof(Sampler).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0";

    private sealed class DiskRuntime(DiskIdentity identity, DiskRecord record, DateTimeOffset now)
    {
        internal DiskIdentity Identity { get; set; } = identity;
        internal DiskRecord Record { get; } = record;
        internal DiskCounters? Counters;
        internal DateTimeOffset LastIo = now;
        internal DiskPower Power = DiskPower.Unknown;
        internal DateTimeOffset PowerSince = now;
        internal double ReadRate, WriteRate;
        internal VolumeInfo[] Volumes = [];
        internal DiskReport? Report;
        internal bool WakeRequested;
        internal DateTimeOffset NextIdleSleep;
        internal DateTimeOffset NextHealthRead;
        internal int Misses;
    }

    private readonly object gate = new();
    private readonly string statePath = Path.Combine(dataDirectory, "state.json");
    private readonly AgentState state = AgentState.Load(Path.Combine(dataDirectory, "state.json"));
    private readonly SortedDictionary<int, DiskRuntime> disks = [];
    private readonly SystemMetrics metrics = new();
    private readonly ProcessIo processIo = new();
    private CpuSensor? cpu;
    private SmbSession[] sessions = [];
    private SmbOpenFile[] openFiles = [];
    private ShareInfo[] shares = [];
    private int diskIdleSeconds;
    private DateTimeOffset lastSample;
    private DateTimeOffset quietSince = DateTimeOffset.Now;
    private DateTimeOffset hibernateHoldUntil;
    private long tick;
    private volatile Snapshot? snapshot;

    internal Snapshot? Current => snapshot;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Opening the sensors loads a driver and can take a few seconds; the first samples go out without it.
        _ = Task.Run(() => cpu = new CpuSensor(logger), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try { Sample(); }
            catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
            {
                logger.LogWarning(error, "A sample failed.");
            }
            try { await Task.Delay(Interval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
        cpu?.Dispose();
    }

    private void Sample()
    {
        var hibernate = false;
        var idle = new List<DiskIdentity>();
        lock (gate)
        {
            var now = DateTimeOffset.Now;
            // A long gap between samples means the machine slept; every disk spins up with it.
            var resumed = lastSample != default && now - lastSample > TimeSpan.FromSeconds(30);
            var seconds = lastSample == default ? 0 : (now - lastSample).TotalSeconds;
            lastSample = now;
            if (resumed)
            {
                quietSince = now;
                processIo.Reset();
            }

            if (tick % 30 == 0) ScanDisks(now);
            if (tick % 3 == 0)
            {
                sessions = SmbInfo.Sessions();
                openFiles = SmbInfo.OpenFiles();
            }
            if (tick % 150 == 0) shares = SmbInfo.Shares();
            if (tick % 15 == 0) diskIdleSeconds = PowerPlan.ReadDiskIdleSeconds() ?? diskIdleSeconds;
            var volumes = tick % 15 == 0 ? ReadVolumes() : null;

            var changed = false;
            var anyAsleep = false;
            string[]? busiest = null;
            foreach (var disk in disks.Values)
            {
                if (resumed) disk.LastIo = now;
                ReadCounters(disk, now, seconds);
                changed |= ReadPower(disk, now, resumed, ref busiest);
                anyAsleep |= disk.Power == DiskPower.Standby;
                disk.Record.RollDay(now);

                // What Windows reports for NVMe is cheap to read; SMART and SAS logs are asked for less often.
                var healthEvery = disk.Identity.Protocol == DiskProtocol.None ? TemperatureEvery : SmartEvery;
                if (disk.Power != DiskPower.Standby && now >= disk.NextHealthRead)
                {
                    disk.Report = DiskDevice.ReadReport(disk.Identity, now) ?? disk.Report;
                    // Windows names a SATA disk behind an adapter "ATA" plus a truncated product name; the drive's own is whole.
                    if (disk.Identity.Protocol == DiskProtocol.Sat && disk.Report?.Model is { } model) disk.Identity = disk.Identity with { Model = model };
                    disk.NextHealthRead = now + healthEvery;
                }
                // A sleeping disk keeps the sizes it reported while awake rather than being asked again.
                if (volumes is not null && (disk.Power != DiskPower.Standby || disk.Volumes.Length == 0))
                    disk.Volumes = volumes.GetValueOrDefault(disk.Identity.Number, []);

                if (now >= disk.NextIdleSleep && SleepGuard.IdleExpired(disk.Identity, disk.Power, now, disk.LastIo, diskIdleSeconds))
                {
                    // A disk that ignores the command is not asked again until another idle period has passed.
                    disk.NextIdleSleep = now + TimeSpan.FromSeconds(diskIdleSeconds);
                    idle.Add(disk.Identity);
                }
            }
            // Sampled only while a disk sleeps, so that the next wake can be put down to someone.
            if (anyAsleep && busiest is null && tick % 2 == 0) processIo.Sample();
            if (changed) SaveState();

            hibernate = ShouldHibernate(now);
            snapshot = Build(now);
            tick++;
        }
        foreach (var identity in idle)
        {
            if (DiskDevice.Standby(identity))
                logger.LogInformation("Disk {Number} was idle for {Seconds} s and was put to sleep.", identity.Number, diskIdleSeconds);
        }
        if (hibernate) Hibernate();
    }

    private void ScanDisks(DateTimeOffset now)
    {
        for (var number = 0; number < 24; number++)
        {
            if (disks.ContainsKey(number)) continue;
            if (DiskDevice.Identify(number) is not { } identity) continue;
            var key = identity.Serial.Length > 0 ? identity.Serial : $"{identity.Model}#{number}";
            if (!state.Disks.TryGetValue(key, out var record)) state.Disks[key] = record = new DiskRecord();
            disks[number] = new DiskRuntime(identity, record, now);
        }
        foreach (var gone in disks.Where(entry => entry.Value.Misses > 5).Select(entry => entry.Key).ToArray())
            disks.Remove(gone);
    }

    private static void ReadCounters(DiskRuntime disk, DateTimeOffset now, double seconds)
    {
        if (DiskDevice.ReadCounters(disk.Identity.Number) is not { } counters)
        {
            disk.Misses++;
            disk.ReadRate = disk.WriteRate = 0;
            return;
        }
        disk.Misses = 0;
        if (disk.Counters is { } before && seconds > 0)
        {
            disk.ReadRate = Math.Max(counters.BytesRead - before.BytesRead, 0) / seconds;
            disk.WriteRate = Math.Max(counters.BytesWritten - before.BytesWritten, 0) / seconds;
            if (counters.Operations != before.Operations) disk.LastIo = now;
        }
        disk.Counters = counters;
    }

    /// <summary>Returns whether a wake was recorded.</summary>
    private bool ReadPower(DiskRuntime disk, DateTimeOffset now, bool resumed, ref string[]? busiest)
    {
        var power = disk.Identity.CanSleep ? DiskDevice.ReadPower(disk.Identity) : DiskPower.Spinning;
        if (power == DiskPower.Unknown || power == disk.Power) return false;

        var woke = disk.Power == DiskPower.Standby && power == DiskPower.Spinning;
        if (woke)
        {
            string cause;
            if (disk.WakeRequested) cause = "Woken from NAS Deck";
            else if (resumed) cause = "System resume";
            else
            {
                openFiles = SmbInfo.OpenFiles();
                busiest ??= processIo.Sample();
                cause = WakeCause(disk.Volumes, openFiles, busiest);
            }
            disk.Record.RecordWake(now, cause);
            disk.LastIo = now;
        }
        if (power == DiskPower.Spinning) disk.WakeRequested = false;
        disk.Power = power;
        disk.PowerSince = now;
        return woke;
    }

    internal static string WakeCause(VolumeInfo[] volumes, SmbOpenFile[] openFiles, string[] busiest)
    {
        var onDisk = openFiles.FirstOrDefault(file => volumes.Any(volume =>
            file.Path.StartsWith(volume.Letter, StringComparison.OrdinalIgnoreCase)));
        if (onDisk is not null) return $"SMB · {onDisk.User} · {onDisk.Path}";
        return busiest.Length > 0 ? "Local · " + string.Join(", ", busiest) : "Unknown";
    }

    private static Dictionary<int, VolumeInfo[]> ReadVolumes()
    {
        var found = new Dictionary<int, List<VolumeInfo>>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed) continue;
            var letter = drive.Name[..1];
            if (DiskDevice.DiskNumberOfVolume(letter[0]) is not { } number) continue;
            try
            {
                if (!drive.IsReady) continue;
                if (!found.TryGetValue(number, out var list)) found[number] = list = [];
                list.Add(new VolumeInfo(letter + ":", drive.VolumeLabel, drive.TotalSize, drive.TotalFreeSpace));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return found.ToDictionary(entry => entry.Key, entry => entry.Value.ToArray());
    }

    /// <summary>Quiet means no hard disk was read or written and no client holds a file open for writing.</summary>
    private bool ShouldHibernate(DateTimeOffset now)
    {
        var minutes = state.AutoHibernateMinutes;
        if (minutes <= 0 || now < hibernateHoldUntil) return false;
        var spinning = disks.Values.Where(disk => disk.Identity.Rotational).ToArray();
        if (spinning.Length == 0 || openFiles.Any(file => file.Writing)) return false;
        var quiet = spinning.Max(disk => disk.LastIo);
        if (quietSince > quiet) quiet = quietSince;
        if (now - quiet < TimeSpan.FromMinutes(minutes)) return false;
        hibernateHoldUntil = now + TimeSpan.FromMinutes(5);
        quietSince = now;
        return true;
    }

    private void Hibernate()
    {
        logger.LogWarning("Hibernating: no disk or SMB activity for {Minutes} minutes.", state.AutoHibernateMinutes);
        try
        {
            using var process = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "shutdown.exe"), "/h")
            {
                UseShellExecute = false, CreateNoWindow = true
            });
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            logger.LogError(error, "Could not hibernate.");
        }
    }

    private Snapshot Build(DateTimeOffset now)
    {
        var system = metrics.Read(cpu?.Read());
        var list = disks.Values.Select(disk => new DiskInfo(
            disk.Identity.Number, disk.Identity.Model, disk.Identity.Serial, disk.Identity.Bus, disk.Identity.Rotational,
            disk.Identity.SizeBytes, disk.Power, disk.PowerSince, Math.Round(disk.ReadRate), Math.Round(disk.WriteRate),
            (int)Math.Max((now - disk.LastIo).TotalSeconds, 0), disk.Volumes, disk.Report?.Smart, disk.Record.SpinUps,
            disk.Record.Wakes.ToArray(), disk.Identity.CanSleep, disk.Report?.Health ?? HealthStatus.Unknown)).ToArray();
        return new Snapshot(now, Version, system, list, sessions, openFiles, shares,
            new PowerPolicy(diskIdleSeconds, state.AutoHibernateMinutes));
    }

    private void SaveState()
    {
        try { state.Save(statePath); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning(error, "Could not save the agent state.");
        }
    }

    /// <summary>The disk information panel's data: the identity plus the last report, which a sleeping disk keeps.</summary>
    internal DiskDetail? Detail(int number)
    {
        lock (gate)
        {
            if (!disks.TryGetValue(number, out var disk)) return null;
            var (identity, report) = (disk.Identity, disk.Report);
            var link = report?.Interface ?? identity.Bus;
            if (identity.Protocol == DiskProtocol.Sat) link += " on a SAS adapter";
            return new DiskDetail(identity.Number, identity.Model, identity.Serial, identity.Firmware, link, identity.Rotational,
                report?.Rpm, identity.SizeBytes, disk.Power, disk.Volumes, report?.Health ?? HealthStatus.Unknown, report?.Smart,
                report?.PowerCycles, report?.Attributes ?? []);
        }
    }

    internal ActionReply Sleep(int number, bool force)
    {
        DiskIdentity identity;
        lock (gate)
        {
            if (!disks.TryGetValue(number, out var disk)) return new ActionReply(false, "failed", $"Disk {number} was not found.");
            identity = disk.Identity;
            var refusal = SleepGuard.Refuse(disk.Identity, disk.Power, DateTimeOffset.Now, disk.LastIo, disk.Record.LastSleepCommand, force);
            if (refusal is not null) return refusal;
        }

        // No volume flush first: Windows has written its cache out within seconds of the last write, and a flush
        // makes NTFS write again a moment later, which on the NAS spun the disk straight back up.
        if (!DiskDevice.Standby(identity)) return new ActionReply(false, "failed", "The disk did not accept the standby command.");
        lock (gate)
        {
            if (disks.TryGetValue(number, out var disk))
            {
                disk.Record.LastSleepCommand = DateTimeOffset.Now;
                SaveState();
            }
        }
        return new ActionReply(true, "ok", "The disk is spinning down.");
    }

    internal ActionReply SleepAll()
    {
        int[] numbers;
        lock (gate) numbers = disks.Values.Where(disk => disk.Identity.CanSleep).Select(disk => disk.Identity.Number).ToArray();
        var replies = numbers.Select(number => Sleep(number, force: false)).ToArray();
        var slept = replies.Count(reply => reply.Code == "ok");
        var asleep = replies.Count(reply => reply.Code == "asleep");
        var skipped = replies.Length - slept - asleep;
        var parts = new List<string>();
        if (slept > 0) parts.Add($"{slept} spinning down");
        if (asleep > 0) parts.Add($"{asleep} already asleep");
        if (skipped > 0) parts.Add($"{skipped} left spinning (busy or recently woken)");
        return new ActionReply(skipped == 0, skipped == 0 ? "ok" : "busy", parts.Count == 0 ? "There are no hard disks to put to sleep." : string.Join(", ", parts) + ".");
    }

    internal ActionReply Wake(int number)
    {
        DiskIdentity identity;
        lock (gate)
        {
            if (!disks.TryGetValue(number, out var disk)) return new ActionReply(false, "failed", $"Disk {number} was not found.");
            if (disk.Power != DiskPower.Standby) return new ActionReply(true, "ok", "The disk is already spinning.");
            disk.WakeRequested = true;
            identity = disk.Identity;
        }
        // Spinning up takes several seconds; the widget sees the result in the next samples.
        _ = Task.Run(() => DiskDevice.SpinUp(identity));
        return new ActionReply(true, "ok", "The disk is spinning up.");
    }

    internal ActionReply SetPolicy(PowerPolicy policy)
    {
        if (policy.DiskIdleSeconds is not (0 or (>= 300 and <= 86400)))
            return new ActionReply(false, "failed", "The disk sleep timer must be off or between 5 minutes and 24 hours.");
        if (policy.AutoHibernateMinutes is not (0 or (>= 10 and <= 1440)))
            return new ActionReply(false, "failed", "Automatic hibernation must be off or between 10 minutes and 24 hours.");
        lock (gate)
        {
            if (policy.DiskIdleSeconds != diskIdleSeconds)
            {
                if (!PowerPlan.WriteDiskIdleSeconds(policy.DiskIdleSeconds))
                    return new ActionReply(false, "failed", "Windows did not accept the disk sleep timer.");
                diskIdleSeconds = policy.DiskIdleSeconds;
            }
            if (policy.AutoHibernateMinutes != state.AutoHibernateMinutes)
            {
                state.AutoHibernateMinutes = policy.AutoHibernateMinutes;
                quietSince = DateTimeOffset.Now;
                SaveState();
            }
        }
        return new ActionReply(true, "ok", "Saved.");
    }
}
