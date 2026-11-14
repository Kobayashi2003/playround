using System.Text.Json;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>What the agent remembers about one disk across restarts, keyed by serial number.</summary>
internal sealed class DiskRecord
{
    public string Day { get; set; } = "";
    public int SpinUps { get; set; }
    public DateTimeOffset? LastSleepCommand { get; set; }
    public List<WakeEvent> Wakes { get; set; } = [];

    internal const int WakesKept = 12;

    internal void RecordWake(DateTimeOffset at, string cause)
    {
        RollDay(at);
        SpinUps++;
        Wakes.Insert(0, new WakeEvent(at, cause));
        if (Wakes.Count > WakesKept) Wakes.RemoveRange(WakesKept, Wakes.Count - WakesKept);
    }

    /// <summary>The spin-up count is per calendar day of the NAS.</summary>
    internal void RollDay(DateTimeOffset now)
    {
        var today = now.ToString("yyyy-MM-dd");
        if (Day == today) return;
        Day = today;
        SpinUps = 0;
    }
}

/// <summary>The agent's <c>state.json</c>: the idle-hibernate setting and each disk's record.</summary>
internal sealed class AgentState
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public int AutoHibernateMinutes { get; set; }
    public Dictionary<string, DiskRecord> Disks { get; set; } = [];

    internal static AgentState Load(string path)
    {
        try
        {
            if (File.Exists(path))
                return JsonSerializer.Deserialize<AgentState>(File.ReadAllText(path), JsonOptions) ?? new AgentState();
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            // A damaged file costs only today's counts and the wake log.
        }
        return new AgentState();
    }

    internal void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var pending = path + ".tmp";
        File.WriteAllText(pending, JsonSerializer.Serialize(this, JsonOptions));
        File.Move(pending, path, overwrite: true);
    }
}
