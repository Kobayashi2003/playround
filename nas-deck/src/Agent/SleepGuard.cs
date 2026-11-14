using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>Decides whether a disk may be spun down now. Spin-ups are what wear a disk, so they are rationed.</summary>
internal static class SleepGuard
{
    internal static readonly TimeSpan Cooldown = TimeSpan.FromMinutes(10);
    internal static readonly TimeSpan BusyWindow = TimeSpan.FromSeconds(30);

    /// <summary>Null when the disk may be put to sleep; otherwise the reply that says why not.</summary>
    internal static ActionReply? Refuse(DiskIdentity disk, DiskPower power, DateTimeOffset now, DateTimeOffset lastIo,
        DateTimeOffset? lastSleepCommand, bool force)
    {
        if (!disk.CanSleep)
            return new ActionReply(false, "unsupported", "Only hard disks on a SATA port or a SAS adapter can be put to sleep.");
        if (power == DiskPower.Standby)
            return new ActionReply(true, "asleep", "The disk is already asleep.");
        if (force) return null;
        if (now - lastIo < BusyWindow)
            return new ActionReply(false, "busy", "The disk was read or written in the last 30 seconds.");
        if (lastSleepCommand is { } last && now - last < Cooldown)
        {
            var minutes = Math.Max(1, (int)Math.Ceiling((Cooldown - (now - last)).TotalMinutes));
            return new ActionReply(false, "cooldown",
                $"The disk was put to sleep less than 10 minutes ago and woke again. Wait {minutes} min: frequent spin-ups wear it.");
        }
        return null;
    }

    /// <summary>
    /// Whether a disk has been idle for the power plan's "turn off hard disk after" time. The agent enforces it
    /// itself because Windows was seen leaving idle SATA disks spinning on the NAS.
    /// </summary>
    internal static bool IdleExpired(DiskIdentity disk, DiskPower power, DateTimeOffset now, DateTimeOffset lastIo, int idleSeconds) =>
        disk.CanSleep && power == DiskPower.Spinning && idleSeconds > 0 &&
        now - lastIo >= TimeSpan.FromSeconds(idleSeconds);
}
