using System.Diagnostics;

namespace NasDeck.Agent;

/// <summary>
/// Per-process I/O totals, compared between two samples to name what was busy when a disk woke. The totals
/// cover every device, the network included, so the names are a hint, not proof.
/// </summary>
internal sealed class ProcessIo
{
    private const ulong Noise = 64 * 1024;
    private Dictionary<int, (string Name, ulong Bytes)> previous = [];

    /// <summary>Takes a sample and returns the busiest processes since the one before, busiest first.</summary>
    internal string[] Sample(int top = 2)
    {
        var current = new Dictionary<int, (string Name, ulong Bytes)>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id is 0 or 4 || process.Id == Environment.ProcessId) continue;
                using var handle = Native.OpenProcess(Native.ProcessQueryLimitedInformation, false, process.Id);
                if (handle.IsInvalid || !Native.GetProcessIoCounters(handle, out var counters)) continue;
                current[process.Id] = (process.ProcessName, counters.ReadBytes + counters.WriteBytes);
            }
        }

        var busiest = current
            .Select(entry => (entry.Value.Name, Delta: previous.TryGetValue(entry.Key, out var before) && before.Name == entry.Value.Name
                ? entry.Value.Bytes - Math.Min(before.Bytes, entry.Value.Bytes)
                : 0))
            .Where(entry => entry.Delta > Noise)
            .OrderByDescending(entry => entry.Delta)
            .Select(entry => entry.Name)
            .Distinct()
            .Take(top)
            .ToArray();
        previous = current;
        return busiest;
    }

    internal void Reset() => previous = [];
}
