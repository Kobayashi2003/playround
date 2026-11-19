using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using NasDeck.Protocol;

namespace NasDeck;

internal static class DeckPaths
{
    /// <summary>The project root; the executable runs from <c>build\NasDeck.App</c> inside it.</summary>
    internal static string ProjectDirectory { get; } = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", ".."));

    internal static string DataDirectory
    {
        get
        {
            var directory = Environment.GetEnvironmentVariable("NAS_DECK_DATA_DIR");
            return Path.GetFullPath(string.IsNullOrWhiteSpace(directory) ? "data" : directory, ProjectDirectory);
        }
    }

    /// <summary>The key NAS Switch set up; NAS Deck keeps using it so nothing has to be authorised again.</summary>
    internal static string KeyPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".ssh", "nas-switch-ed25519");

    internal static string TokenPath => Path.Combine(DataDirectory, "agent-token");

    internal static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    internal static void WriteJson<T>(string name, T value)
    {
        Directory.CreateDirectory(DataDirectory);
        var path = Path.Combine(DataDirectory, name);
        var pending = path + ".tmp";
        File.WriteAllText(pending, JsonSerializer.Serialize(value, Json));
        File.Move(pending, path, overwrite: true);
    }
}

internal sealed record NasSettings
{
    public string Host { get; init; } = "192.168.0.168";
    public string SshUser { get; init; } = "17312";
    public int SshPort { get; init; } = 22;
    public string MacAddress { get; init; } = "2C-F0-5D-32-32-14";
    public string BroadcastAddress { get; init; } = "192.168.0.255";
    public int WakePort { get; init; } = 9;
    /// <summary>The agent's loopback port on the NAS, and the local end of the SSH tunnel to it.</summary>
    public int AgentPort { get; init; } = AgentApi.DefaultPort;
    public bool RecycleEnabled { get; init; }
    public string[] RecycleShares { get; init; } = [];
    public string? RecycleHostAlias { get; init; }

    internal string HostKeyAlias => "nas-switch-" + MacAddress.Replace("-", "").Replace(":", "").ToLowerInvariant();

    internal static NasSettings Load()
    {
        var path = Path.Combine(DeckPaths.DataDirectory, "settings.json");
        if (!File.Exists(path))
            return new NasSettings();

        var settings = JsonSerializer.Deserialize<NasSettings>(File.ReadAllText(path), DeckPaths.Json)
            ?? throw new InvalidDataException("The settings file is empty.");
        settings.Validate();
        return settings;
    }

    internal void Save()
    {
        Validate();
        DeckPaths.WriteJson("settings.json", this);
    }

    private void Validate()
    {
        if (RecycleShares is null || RecycleShares.Any(name => string.IsNullOrWhiteSpace(name)
            || name is "." or ".." || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            || (RecycleEnabled && RecycleShares.Length == 0))
            throw new InvalidDataException("Choose at least one valid share for the NAS Recycle Bin.");
        if (string.IsNullOrWhiteSpace(Host) || Uri.CheckHostName(Host) == UriHostNameType.Unknown)
            throw new InvalidDataException("Enter a valid NAS IP address or host name.");
        if (string.IsNullOrWhiteSpace(SshUser) || !Regex.IsMatch(SshUser, @"^[\w.@\\-]+$"))
            throw new InvalidDataException("Enter a valid SSH username.");
        if (SshPort is < 1 or > 65535 || WakePort is < 1 or > 65535 || AgentPort is < 1 or > 65535)
            throw new InvalidDataException("Ports must be between 1 and 65535.");
        if (string.IsNullOrEmpty(MacAddress) || !Regex.IsMatch(MacAddress, @"^[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}$", RegexOptions.IgnoreCase))
            throw new InvalidDataException("Enter a six-part MAC address such as 2C-F0-5D-32-32-14.");
        if (!IPAddress.TryParse(BroadcastAddress, out var broadcast) || broadcast.AddressFamily != AddressFamily.InterNetwork)
            throw new InvalidDataException("Enter an IPv4 broadcast address such as 192.168.0.255.");
    }
}

/// <summary>
/// <c>follow.log</c>: when this PC went down and whether the NAS was told, the one record that survives the
/// PC shutting down. Kept short by starting over past 64 KB.
/// </summary>
internal static class FollowLog
{
    internal static void Write(string text)
    {
        try
        {
            var path = Path.Combine(DeckPaths.DataDirectory, "follow.log");
            if (File.Exists(path) && new FileInfo(path).Length > 64 * 1024) File.Delete(path);
            File.AppendAllText(path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {text}{Environment.NewLine}");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}

/// <summary>Where the widget sits and how it looks; saved whenever it changes.</summary>
internal sealed record WidgetState
{
    public int? Left { get; init; }
    public int? Top { get; init; }
    /// <summary>The widget grows upwards when it was dropped in the lower half of the screen.</summary>
    public bool AnchorBottom { get; init; }
    public bool AlwaysOnTop { get; init; }
    public bool Compact { get; init; }
    /// <summary>Pinned in place: dragging does not move it.</summary>
    public bool Pinned { get; init; }
    /// <summary>A read and write chart under each disk.</summary>
    public bool DiskCharts { get; init; } = true;
    /// <summary>Wake the NAS when this PC starts or resumes.</summary>
    public bool FollowWake { get; init; }
    /// <summary>Have the NAS hibernate or shut down a while after this PC does.</summary>
    public bool FollowSleep { get; init; }
    /// <summary>How long the NAS waits for this PC to come back before following it down.</summary>
    public int FollowGraceMinutes { get; init; } = 2;
    public int OpacityPercent { get; init; } = 100;
    /// <summary>Whether the notification-area (system tray) icon is visible.</summary>
    public bool ShowTrayIcon { get; init; } = true;

    internal static WidgetState Load()
    {
        try
        {
            var path = Path.Combine(DeckPaths.DataDirectory, "widget.json");
            if (File.Exists(path) && JsonSerializer.Deserialize<WidgetState>(File.ReadAllText(path), DeckPaths.Json) is { } state)
                return state with { OpacityPercent = Math.Clamp(state.OpacityPercent, 40, 100), FollowGraceMinutes = Math.Clamp(state.FollowGraceMinutes, 1, 60) };
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
        return new WidgetState();
    }

    internal void Save()
    {
        try { DeckPaths.WriteJson("widget.json", this); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}
