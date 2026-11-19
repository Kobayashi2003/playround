using System.Net;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>A request to follow the widget's PC down, waiting for its grace period to run out.</summary>
internal sealed record FollowPlan(HostPowerAction Action, DateTimeOffset Due, string[] HostAddresses);

/// <summary>
/// Decides, once the PC's grace period is over, whether the NAS follows it down. Someone else connected over SMB
/// means it stays on; disks busy with the NAS's own work put it off for a while.
/// </summary>
internal static class HostFollow
{
    internal const double BusyBytesPerSecond = 1024 * 1024;
    internal static readonly TimeSpan RetryEvery = TimeSpan.FromMinutes(1);

    internal enum Verdict { Wait, Go, Postpone, Skip }

    internal static (Verdict Verdict, string? Reason) Decide(FollowPlan plan, DateTimeOffset now, IEnumerable<SmbSession> sessions,
        double busiestDiskBytesPerSecond)
    {
        if (now < plan.Due) return (Verdict.Wait, null);
        var hosts = plan.HostAddresses.Select(Normalize).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var other = sessions.FirstOrDefault(session => !hosts.Contains(Normalize(session.Client)));
        if (other is not null)
            return (Verdict.Skip, $"{other.Client}{(other.User.Length > 0 ? $" ({other.User})" : "")} was still connected");
        if (busiestDiskBytesPerSecond > BusyBytesPerSecond) return (Verdict.Postpone, "the disks are busy");
        return (Verdict.Go, null);
    }

    /// <summary>
    /// The same address however Windows spells it: SMB sessions may show an IPv4 address in IPv6 form, and a PC
    /// writes its own link-local address with a zone ("%19") that the NAS does not see.
    /// </summary>
    internal static string Normalize(string address)
    {
        var text = address.Trim().TrimStart('\\').Trim('[', ']');
        if (!IPAddress.TryParse(text, out var parsed)) return text;
        if (parsed.IsIPv4MappedToIPv6) return parsed.MapToIPv4().ToString();
        if (parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) parsed.ScopeId = 0;
        return parsed.ToString();
    }
}
