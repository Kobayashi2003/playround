using System.Drawing.Drawing2D;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>A clickable area of the widget, in logical pixels. <c>Click</c> receives the area's bounds.</summary>
internal sealed record Hit(RectangleF Bounds, string Id, Action<RectangleF> Click, string? Tip, bool Clickable = true);

/// <summary>What the widget's clickable areas do; the window supplies these.</summary>
internal sealed class DeckActions
{
    internal required Action<RectangleF> Power { get; init; }
    internal required Action<RectangleF> More { get; init; }
    internal required Action ToggleCompact { get; init; }
    internal required Action TogglePin { get; init; }
    internal required Action<int> ToggleDisk { get; init; }
    internal required Action<DiskInfo> DiskPower { get; init; }
    internal required Action<int> DiskInfo { get; init; }
    internal required Action<int> DiskActivity { get; init; }
    internal required Action<RectangleF> Timer { get; init; }
    internal required Action<RectangleF> Clients { get; init; }
    internal required Action WakeNas { get; init; }
    internal required Action InstallAgent { get; init; }
    internal required Action<string> OpenVolume { get; init; }
}

/// <summary>
/// Lays the widget out and draws it in one pass. Geometry is in logical pixels (96 dpi); text goes
/// through GDI, which ignores the graphics transform, so its rectangles are scaled by hand.
/// Called without a <see cref="Graphics"/> it only measures.
/// </summary>
internal sealed class DeckPainter(DeckActions actions)
{
    internal const float Width = 332;
    private const float Pad = 14;
    private const float Right = Width - Pad;
    private const float ChartHeight = 18;
    private const TextFormatFlags TextBase = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
        | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;

    private Graphics? g;
    private DeckModel model = null!;
    private float scale = 1;
    private PointF? mouse;
    private string? pressed;
    private float y;

    internal List<Hit> Hits { get; } = [];

    /// <summary>Returns the height the content needs, in logical pixels.</summary>
    internal float Render(Graphics? graphics, DeckModel deckModel, float dpiScale, PointF? mouseAt, string? pressedId)
    {
        (g, model, scale, mouse, pressed, y) = (graphics, deckModel, dpiScale, mouseAt, pressedId, 0);
        Hits.Clear();
        GraphicsState? saved = null;
        if (g is not null)
        {
            g.Clear(DeckTheme.Background);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            saved = g.Save();
            g.ScaleTransform(scale, scale);
        }

        Header();
        if (model.Live)
        {
            if (model.Compact)
            {
                CompactStrip();
            }
            else
            {
                SystemRows();
                Rule();
                DisksHeader();
                foreach (var disk in model.Disks) DiskRow(disk);
                y += 4;
            }
            Rule();
            Footer();
        }
        else if (model.Online) WithoutAgent();
        else Offline();

        if (g is not null && saved is not null) g.Restore(saved);
        return y;
    }

    private void Header()
    {
        var tone = model.Tone;
        var color = DeckTheme.ToneColor(tone);
        if (g is not null)
        {
            if (tone == NasTone.Ready) FillEllipse(new RectangleF(Pad - 2, 13, 16, 16), DeckTheme.Mix(DeckTheme.Background, color, 0.22f));
            if (tone is NasTone.Offline or NasTone.Unknown) DrawEllipse(new RectangleF(Pad + 1.5f, 16.5f, 9, 9), DeckTheme.Muted, 1.5f);
            else FillEllipse(new RectangleF(Pad + 1, 16, 10, 10), color);
        }
        var buttons = model.Live ? 4 : 3;
        var titleWidth = Right - (Pad + 22) - buttons * 30;
        var title = model.Snapshot?.System.HostName is { Length: > 0 } host ? host : model.Settings.Host;
        Text(title, DeckTheme.Heading, DeckTheme.Text, Pad + 22, 9, titleWidth, 22);
        Text(model.StatusText, DeckTheme.Small, tone is NasTone.Partial ? color : DeckTheme.Muted, Pad + 22, 30, titleWidth, 16);

        var x = Right - 28;
        IconButton("power", new RectangleF(x, 13, 28, 28), DeckGlyph.Power, model.Online ? "Power" : "Wake NAS", actions.Power,
            tone is NasTone.Ready or NasTone.Partial or NasTone.Busy ? color : null);
        x -= 30;
        IconButton("more", new RectangleF(x, 13, 28, 28), DeckGlyph.More, "Menu", actions.More);
        if (model.Live)
        {
            x -= 30;
            IconButton("compact", new RectangleF(x, 13, 28, 28), model.Compact ? DeckGlyph.ChevronDown : DeckGlyph.ChevronUp,
                model.Compact ? "Expand" : "Collapse", _ => actions.ToggleCompact());
        }
        x -= 30;
        IconButton("pin", new RectangleF(x, 13, 28, 28), DeckGlyph.Pin, model.Pinned ? "Unpin: allow dragging" : "Pin in place",
            _ => actions.TogglePin(), model.Pinned ? DeckTheme.Accent : null);
        y = 54;
    }

    private void SystemRows()
    {
        var system = model.Snapshot!.System;
        const float rowHeight = 26;
        const float labelX = Pad, valueX = Pad + 30, valueWidth = 44, graphX = Pad + 86;
        const float sideWidth = 80, graphWidth = Right - sideWidth - 8 - graphX;

        Text("CPU", DeckTheme.Label, DeckTheme.Muted, labelX, y, 30, rowHeight);
        Text($"{system.CpuPercent:0}%", DeckTheme.Strong, DeckTheme.Text, valueX, y, valueWidth, rowHeight, TextFormatFlags.Right);
        Sparkline(new RectangleF(graphX, y + 4, graphWidth, rowHeight - 8), model.Cpu.Values, 100, DeckTheme.Accent);
        var temperature = system.CpuTempC;
        Text(temperature is { } degrees ? $"{degrees:0} °C" : "— °C", DeckTheme.Caption,
            temperature >= 85 ? DeckTheme.Danger : temperature >= 75 ? DeckTheme.Warning : temperature is null ? DeckTheme.Muted : DeckTheme.Text,
            Right - sideWidth, y, sideWidth, rowHeight, TextFormatFlags.Right);
        if (temperature is null) Tip("cpu-temp", new RectangleF(Right - sideWidth, y, sideWidth, rowHeight), "CPU temperature needs the PawnIO driver: run Install-Agent.ps1 -InstallPawnIO.");
        y += rowHeight;

        var used = system.MemTotalBytes > 0 ? (double)system.MemUsedBytes / system.MemTotalBytes : 0;
        Text("RAM", DeckTheme.Label, DeckTheme.Muted, labelX, y, 30, rowHeight);
        Text($"{used * 100:0}%", DeckTheme.Strong, DeckTheme.Text, valueX, y, valueWidth, rowHeight, TextFormatFlags.Right);
        Bar(new RectangleF(graphX, y + rowHeight / 2 - 3, graphWidth, 6), used, used >= 0.9 ? DeckTheme.Warning : DeckTheme.Accent);
        const double gigabyte = 1024d * 1024 * 1024;
        Text($"{system.MemUsedBytes / gigabyte:0.0} / {system.MemTotalBytes / gigabyte:0.#} GB", DeckTheme.Small, DeckTheme.Muted,
            Right - sideWidth, y, sideWidth, rowHeight, TextFormatFlags.Right);
        y += rowHeight;

        Text("NET", DeckTheme.Label, DeckTheme.Muted, labelX, y, 30, rowHeight);
        Text("↓ " + Format.Rate(system.NetRxBytesPerSec), DeckTheme.Caption, DeckTheme.Text, valueX + 8, y, 92, rowHeight);
        Text("↑ " + Format.Rate(system.NetTxBytesPerSec), DeckTheme.Caption, DeckTheme.Text, valueX + 102, y, 92, rowHeight);
        var netX = valueX + 198;
        Sparkline(new RectangleF(netX, y + 4, Right - netX, rowHeight - 8), model.Rx.Values, 0, DeckTheme.Ready);
        y += rowHeight + 6;
    }

    private void DisksHeader()
    {
        var snapshot = model.Snapshot!;
        var hardDisks = snapshot.Disks.Where(disk => disk.Rotational).ToArray();
        var asleep = hardDisks.Count(disk => disk.Power == DiskPower.Standby);
        Text("DISKS", DeckTheme.Label, DeckTheme.Muted, Pad, y, 40, 30);
        if (hardDisks.Length > 0)
            Text(asleep == 0 ? "all spinning" : asleep == hardDisks.Length ? "all asleep" : $"{hardDisks.Length - asleep} spinning · {asleep} asleep",
                DeckTheme.Small, DeckTheme.Muted, Pad + 42, y, 120, 30);

        var link = new RectangleF(Right - 124, y + 4, 124, 22);
        var hot = Over(link);
        var color = hot ? DeckTheme.Accent : DeckTheme.Muted;
        Text("Sleep after " + Format.Timeout(snapshot.Policy.DiskIdleSeconds), DeckTheme.Small, color, link.X, link.Y, link.Width - 14, link.Height, TextFormatFlags.Right);
        Glyph(DeckGlyph.ChevronDown, new RectangleF(link.Right - 12, link.Y + 5, 12, 12), color);
        Hits.Add(new Hit(link, "timer", actions.Timer, "When Windows spins an idle disk down"));
        y += 30;
    }

    private void DiskRow(DiskInfo disk)
    {
        var expanded = model.Expanded.Contains(disk.Number);
        var smart = disk.Smart;
        var details = expanded ? Details(disk) : null;
        var chart = model.DiskCharts ? ChartHeight : 0;
        var height = 46 + chart + (details?.Height ?? 0);
        var row = new RectangleF(5, y, Width - 10, height);
        var id = $"disk:{disk.Number}";
        var (level, reason) = DiskHealth.Of(disk);
        var letters = DiskHealth.Letters(disk);
        Hits.Add(new Hit(row, id, _ => actions.ToggleDisk(disk.Number), reason is null ? null : $"{letters} {reason}"));
        if (Over(row) || expanded) FillRound(row, expanded && !Over(row) ? DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.6f) : DeckTheme.Panel, 7);

        var asleep = disk.Power == DiskPower.Standby;
        var busy = disk.ReadBytesPerSec + disk.WriteBytesPerSec > 0;
        var health = level switch { HealthLevel.Bad => DeckTheme.Danger, HealthLevel.Warning => DeckTheme.Warning, _ => DeckTheme.Ready };
        if (g is not null)
        {
            var icon = new RectangleF(Pad, y + 7, 16, 16);
            if (asleep) Glyph(DeckGlyph.Moon, icon, level == HealthLevel.Good ? DeckTheme.Muted : health);
            else if (disk.Power == DiskPower.Unknown) DrawEllipse(RectangleF.Inflate(icon, -4, -4), DeckTheme.Muted, 1.5f);
            else
            {
                if (busy) FillEllipse(RectangleF.Inflate(icon, -0.5f, -0.5f), DeckTheme.Mix(DeckTheme.Background, health, 0.3f));
                FillEllipse(RectangleF.Inflate(icon, -4, -4), health);
            }
        }

        var lettersWidth = Math.Max(30, disk.Volumes.Length * 24 + 6);
        Text(letters, DeckTheme.Heading, asleep ? DeckTheme.Muted : DeckTheme.Text, Pad + 22, y + 4, lettersWidth, 22);
        Text(Format.ShortModel(disk.Model), DeckTheme.Caption, DeckTheme.Muted, Pad + 24 + lettersWidth, y + 4, 130 - lettersWidth, 22);
        if (!asleep && smart?.TemperatureC is { } temperature)
            Text($"{temperature}°", DeckTheme.Caption,
                temperature >= DiskHealth.HotC ? DeckTheme.Danger : temperature >= DiskHealth.WarmC ? DeckTheme.Warning : DeckTheme.Text,
                Pad + 154, y + 4, 32, 22, TextFormatFlags.Right);

        var pending = model.DiskActivity.TryGetValue(disk.Number, out var activity) ? activity.Label : null;
        var status = pending ?? (asleep ? "asleep " + Format.Duration((long)(model.Snapshot!.At - disk.PowerSince).TotalSeconds)
            : busy ? Activity(disk)
            : disk.Power == DiskPower.Unknown ? ""
            : "idle " + Format.Duration(disk.IdleSeconds));
        var statusRight = disk.CanSleep ? Right - 30 : Right;
        Text(status, DeckTheme.Small, pending is not null ? DeckTheme.Accent : busy && !asleep ? DeckTheme.Text : DeckTheme.Muted,
            Pad + 190, y + 4, statusRight - (Pad + 190), 22, TextFormatFlags.Right);
        if (disk.CanSleep && pending is null)
            IconButton($"{id}:power", new RectangleF(Right - 26, y + 2, 26, 26), asleep ? DeckGlyph.Sun : DeckGlyph.Moon,
                asleep ? $"Wake {letters}" : $"Put {letters} to sleep", _ => actions.DiskPower(disk), hoverFill: DeckTheme.Border);

        long total = disk.Volumes.Sum(volume => volume.TotalBytes), free = disk.Volumes.Sum(volume => volume.FreeBytes);
        if (total > 0)
        {
            var usedShare = 1 - (double)free / total;
            Bar(new RectangleF(Pad + 22, y + 33, 132, 4), usedShare,
                usedShare > 0.95 ? DeckTheme.Warning : asleep ? DeckTheme.Mix(DeckTheme.Border, DeckTheme.Accent, 0.45f) : DeckTheme.Accent);
            Text($"{Format.Bytes(free)} free / {Format.Bytes(total)}", DeckTheme.Small, DeckTheme.Muted, Pad + 160, y + 26, Right - (Pad + 160), 18, TextFormatFlags.Right);
        }
        else
        {
            Text(Format.Bytes(disk.SizeBytes), DeckTheme.Small, DeckTheme.Muted, Pad + 22, y + 26, 132, 18);
        }

        if (chart > 0 && model.DiskIo.TryGetValue(disk.Serial, out var io))
        {
            // Both lines share one scale, so a write burst is not drawn as tall as a larger read.
            var area = new RectangleF(Pad + 22, y + 44, Right - (Pad + 22), chart - 6);
            var ceiling = Math.Max(1024 * 1024, Math.Max(io.Read.Values.DefaultIfEmpty().Max(), io.Write.Values.DefaultIfEmpty().Max()));
            // A disk that did nothing gets the baseline alone, not a flat coloured line under its text.
            Sparkline(area, io.Read.Values.Any(value => value > 0) ? io.Read.Values : [], ceiling, DeckTheme.Accent);
            Sparkline(area, io.Write.Values.Any(value => value > 0) ? io.Write.Values : [], ceiling, DeckTheme.Warning);
            Tip($"{id}:chart", area, $"Read (blue) and write (amber) over three minutes; the top is {Format.Rate(ceiling)}");
        }

        if (details is not null)
        {
            const float left = Pad + 22, column = (Right - left) / 2, labelWidth = 88;
            var lineY = y + 46 + chart + 2;
            if (details.Reason is { } warning)
            {
                Text(warning, DeckTheme.Small, details.ReasonColor, left, lineY, Right - left, FactHeight);
                lineY += FactHeight;
            }
            for (var index = 0; index < details.Facts.Length; index++)
            {
                var x = left + index % 2 * column;
                Text(details.Facts[index].Label, DeckTheme.Small, DeckTheme.Muted, x, lineY, labelWidth, FactHeight);
                Text(details.Facts[index].Value, DeckTheme.Small, DeckTheme.Text, x + labelWidth, lineY, column - labelWidth - 6, FactHeight);
                if (index % 2 == 1 || index == details.Facts.Length - 1) lineY += FactHeight;
            }
            if (details.Wake is { } wake)
            {
                Text("Last wake", DeckTheme.Small, DeckTheme.Muted, left, lineY, labelWidth, FactHeight);
                Text(wake, DeckTheme.Small, DeckTheme.Text, left + labelWidth, lineY, Right - left - labelWidth, FactHeight);
                Tip($"{id}:wake", new RectangleF(left, lineY, Right - left, FactHeight), "Last wake " + wake);
                lineY += FactHeight;
            }
            var buttonX = left;
            var totalButtons = disk.Volumes.Length + 2;
            var buttonWidth = totalButtons <= 3 ? 76f : Math.Max(58f, (Right - left - (totalButtons - 1) * 5f) / totalButtons);
            var buttonGap = totalButtons <= 3 ? 6f : 5f;
            foreach (var volume in disk.Volumes)
            {
                Button($"{id}:open:{volume.Letter}", new RectangleF(buttonX, lineY + 6, buttonWidth, 24), "Open " + volume.Letter, false, () => actions.OpenVolume(volume.Letter));
                buttonX += buttonWidth + buttonGap;
            }
            Button($"{id}:info", new RectangleF(buttonX, lineY + 6, buttonWidth, 24), "Details…", false, () => actions.DiskInfo(disk.Number));
            buttonX += buttonWidth + buttonGap;
            Button($"{id}:activity", new RectangleF(buttonX, lineY + 6, buttonWidth, 24), "Activity…", false, () => actions.DiskActivity(disk.Number));
        }
        y += height;
    }

    private static string Activity(DiskInfo disk)
    {
        if (disk.ReadBytesPerSec > 0 && disk.WriteBytesPerSec > 0)
            return $"R {Short(disk.ReadBytesPerSec)}  W {Short(disk.WriteBytesPerSec)}";
        return disk.ReadBytesPerSec > 0 ? "R " + Format.Rate(disk.ReadBytesPerSec) : "W " + Format.Rate(disk.WriteBytesPerSec);

        static string Short(double rate)
        {
            var parts = Format.Bytes(rate).Split(' ');
            return parts[0] + parts[1][..1];
        }
    }

    private const float FactHeight = 18;

    /// <summary>What an opened disk row shows under its chart: a health warning, a grid of counters, the last wake.</summary>
    private sealed record RowDetails(string? Reason, Color ReasonColor, (string Label, string Value)[] Facts, string? Wake)
    {
        // Reason, the fact rows two to a line, the wake line, then the buttons.
        internal float Height => (Reason is null ? 0 : FactHeight) + (Facts.Length + 1) / 2 * FactHeight
            + (Wake is null ? 0 : FactHeight) + 38;
    }

    private static RowDetails Details(DiskInfo disk)
    {
        var (level, reason) = DiskHealth.Of(disk);
        var smart = disk.Smart;
        var facts = new List<(string, string)>();
        void Add(string label, long? value, string unit = "")
        {
            if (value is not null) facts.Add((label, value.Value.ToString("N0") + unit));
        }
        Add("Power-on", smart?.PowerOnHours, " h");
        Add("Starts", smart?.StartStopCount);
        Add("Load cycles", smart?.LoadCycleCount);
        Add("Reallocated", smart?.Reallocated);
        Add("Pending", smart?.Pending);
        Add("Uncorrectable", smart?.Uncorrectable);
        if (disk.CanSleep) Add("Spin-ups today", disk.SpinUpsToday);

        string? wake = null;
        if (disk.RecentWakes.Length > 0)
        {
            var at = disk.RecentWakes[0].At.LocalDateTime;
            // A fixed numeric date, so the row reads the same whatever the system's language.
            wake = (at.Date == DateTime.Today ? at.ToString("HH:mm") : at.ToString("MM-dd HH:mm", System.Globalization.CultureInfo.InvariantCulture))
                + " · " + disk.RecentWakes[0].Cause;
        }
        return new RowDetails(reason is null ? null : char.ToUpperInvariant(reason[0]) + reason[1..],
            level == HealthLevel.Bad ? DeckTheme.Danger : DeckTheme.Warning, facts.ToArray(), wake);
    }

    private void CompactStrip()
    {
        var snapshot = model.Snapshot!;
        var x = Pad;
        foreach (var disk in model.Disks.Where(disk => disk.Rotational).Take(5))
        {
            var pill = new RectangleF(x, y + 2, 34, 24);
            var asleep = disk.Power == DiskPower.Standby;
            var busy = disk.ReadBytesPerSec + disk.WriteBytesPerSec > 0;
            var (level, reason) = DiskHealth.Of(disk);
            var health = level switch { HealthLevel.Bad => DeckTheme.Danger, HealthLevel.Warning => DeckTheme.Warning, _ => DeckTheme.Ready };
            FillRound(pill, busy && !asleep ? DeckTheme.Mix(DeckTheme.Panel, health, 0.22f) : DeckTheme.Panel, 12);
            if (g is not null)
            {
                var dot = new RectangleF(pill.X + 8, pill.Y + 9, 6, 6);
                if (asleep) DrawEllipse(dot, level == HealthLevel.Good ? DeckTheme.Muted : health, 1.2f);
                else FillEllipse(dot, health);
            }
            var letter = DiskHealth.Letters(disk).Split(' ')[0].TrimEnd(':');
            Text(letter, DeckTheme.Strong, asleep ? DeckTheme.Muted : DeckTheme.Text, pill.X + 17, pill.Y, 14, pill.Height);
            var state = asleep ? "asleep " + Format.Duration((long)(snapshot.At - disk.PowerSince).TotalSeconds)
                : busy ? Activity(disk) : "idle " + Format.Duration(disk.IdleSeconds);
            Tip($"pill:{disk.Number}", pill, $"{DiskHealth.Letters(disk)} {Format.ShortModel(disk.Model)} · {state}" + (reason is null ? "" : $" · {reason}"));
            x += 39;
        }
        var system = snapshot.System;
        var summary = $"{system.CpuPercent:0}%" + (system.CpuTempC is { } degrees ? $" · {degrees:0} °C" : "");
        Text(summary, DeckTheme.Caption, DeckTheme.Muted, x + 4, y + 2, Right - x - 4, 24, TextFormatFlags.Right);
        y += 34;
    }

    private void Footer()
    {
        var snapshot = model.Snapshot!;
        const float height = 30;
        if (model.NoticeVisible)
        {
            Text(model.Notice!, DeckTheme.Small, DeckTheme.Text, Pad, y, Right - Pad, height);
            Tip("notice", new RectangleF(Pad, y, Right - Pad, height), model.Notice!);
            y += height;
            return;
        }
        var clients = snapshot.Sessions.Length;
        var files = snapshot.OpenFiles.Length;
        var text = clients == 0 ? "No clients connected"
            : $"{clients} client{(clients == 1 ? "" : "s")} · {files} open file{(files == 1 ? "" : "s")}";
        var link = new RectangleF(Pad - 4, y + 4, 190, 22);
        var hot = clients > 0 && Over(link);
        Text(text, DeckTheme.Small, hot ? DeckTheme.Accent : DeckTheme.Muted, Pad, y, 186, height);
        if (clients > 0) Hits.Add(new Hit(link, "clients", actions.Clients, "Who is connected"));

        var stale = DateTime.UtcNow - model.SnapshotAt > TimeSpan.FromSeconds(6);
        Text(stale ? "not responding" : snapshot.Policy.AutoHibernateMinutes > 0 ? "hibernates when idle" : "",
            DeckTheme.Small, stale ? DeckTheme.Warning : DeckTheme.Muted, Right - 120, y, 120, height, TextFormatFlags.Right);
        y += height;
    }

    private void WithoutAgent()
    {
        var ports = model.Ports ?? default;
        y += 2;
        var x = Pad;
        foreach (var (label, up) in new[] { ("SSH", ports.Ssh), ("File sharing", ports.Smb) })
        {
            var width = label.Length * 6.2f + 34;
            var chip = new RectangleF(x, y, width, 26);
            FillRound(chip, DeckTheme.Panel, 13);
            if (g is not null)
            {
                var dot = new RectangleF(x + 11, y + 9, 8, 8);
                if (up) FillEllipse(dot, DeckTheme.Ready);
                else DrawEllipse(RectangleF.Inflate(dot, -0.75f, -0.75f), DeckTheme.Muted, 1.5f);
            }
            Text(label, DeckTheme.Caption, up ? DeckTheme.Text : DeckTheme.Muted, x + 26, y, width - 30, 26);
            x += width + 8;
        }
        y += 36;

        var message = model.NoticeVisible ? model.Notice!
            : !model.HasAgentToken ? "Install the monitoring agent on the NAS to see its disks, load and temperatures."
            : model.AgentProblem is { } problem ? "The monitoring agent is out of reach: " + problem
            : ports.Ssh ? "Connecting to the monitoring agent…"
            : "SSH is unreachable, so the monitoring agent cannot be reached.";
        Wrapped(message, DeckTheme.Caption, DeckTheme.Muted, Pad, y, Right - Pad, 36);
        y += 42;
        if (!model.HasAgentToken)
        {
            Button("install", new RectangleF(Pad, y, 128, 32), "Install agent…", false, actions.InstallAgent);
            y += 42;
        }
        y += 4;
    }

    private void Offline()
    {
        y += 2;
        var waking = model.Activity is not null;
        Button("wake", new RectangleF(Pad, y, Right - Pad, 38), waking ? model.Activity! : "Wake NAS", true, actions.WakeNas, enabled: !waking && model.Ports is not null);
        y += 48;
        if (model.NoticeVisible)
        {
            Wrapped(model.Notice!, DeckTheme.Small, DeckTheme.Muted, Pad, y, Right - Pad, 32);
            y += 38;
        }
        y += 4;
    }

    private bool Over(RectangleF bounds) => mouse is { } point && bounds.Contains(point);

    private void Rule()
    {
        if (g is not null)
        {
            using var pen = new Pen(DeckTheme.Border, 1);
            g.DrawLine(pen, Pad, y + 0.5f, Right, y + 0.5f);
        }
        y += 1;
    }

    private void Tip(string id, RectangleF bounds, string tip) => Hits.Add(new Hit(bounds, id, _ => { }, tip, Clickable: false));

    private void IconButton(string id, RectangleF bounds, DeckGlyph glyph, string tip, Action<RectangleF> click, Color? color = null, Color? hoverFill = null)
    {
        Hits.Add(new Hit(bounds, id, click, tip));
        var hot = Over(bounds);
        if (hot) FillRound(bounds, pressed == id ? DeckTheme.Mix(DeckTheme.Border, DeckTheme.Text, 0.12f) : hoverFill ?? DeckTheme.Panel, 7);
        var inset = (bounds.Width - 16) / 2;
        Glyph(glyph, new RectangleF(bounds.X + inset, bounds.Y + (bounds.Height - 16) / 2, 16, 16), color ?? (hot ? DeckTheme.Text : DeckTheme.Muted));
    }

    private void Button(string id, RectangleF bounds, string text, bool primary, Action click, bool enabled = true)
    {
        if (enabled) Hits.Add(new Hit(bounds, id, _ => click(), null));
        var hot = enabled && Over(bounds);
        var fill = primary ? DeckTheme.Accent : DeckTheme.Panel;
        if (!enabled) fill = DeckTheme.Panel;
        else if (hot && pressed == id) fill = DeckTheme.Mix(fill, DeckTheme.Background, 0.25f);
        else if (hot) fill = primary ? DeckTheme.Mix(DeckTheme.Accent, DeckTheme.Text, 0.12f) : DeckTheme.Border;
        FillRound(bounds, fill, 7);
        if (g is not null && !primary && !hot)
        {
            using var outline = DeckTheme.RoundedRectangle(bounds, 7);
            using var pen = new Pen(DeckTheme.Border, 1);
            g.DrawPath(pen, outline);
        }
        Text(text, primary ? DeckTheme.Strong : DeckTheme.Caption, !enabled ? DeckTheme.Muted : primary ? DeckTheme.Background : DeckTheme.Text,
            bounds.X, bounds.Y, bounds.Width, bounds.Height, TextFormatFlags.HorizontalCenter);
    }

    private void Text(string text, Font font, Color color, float x, float top, float width, float height, TextFormatFlags align = TextFormatFlags.Left)
    {
        if (g is null || text.Length == 0 || width <= 0) return;
        TextRenderer.DrawText(g, text, font, Device(x, top, width, height), color, TextBase | align);
    }

    private void Wrapped(string text, Font font, Color color, float x, float top, float width, float height)
    {
        if (g is null) return;
        TextRenderer.DrawText(g, text, font, Device(x, top, width, height), color,
            TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
    }

    private Rectangle Device(float x, float top, float width, float height) =>
        Rectangle.Round(new RectangleF(x * scale, top * scale, width * scale, height * scale));

    private void Glyph(DeckGlyph glyph, RectangleF box, Color color)
    {
        if (g is null) return;
        var state = g.Save();
        g.TranslateTransform(box.X, box.Y);
        g.ScaleTransform(box.Width / 16f, box.Height / 16f);
        using (var pen = new Pen(color, 1.3f) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
            DeckIcons.Draw(g, pen, glyph);
        g.Restore(state);
    }

    private void FillRound(RectangleF bounds, Color color, float radius)
    {
        if (g is null) return;
        using var shape = DeckTheme.RoundedRectangle(bounds, radius);
        using var brush = new SolidBrush(color);
        g.FillPath(brush, shape);
    }

    private void FillEllipse(RectangleF bounds, Color color)
    {
        if (g is null) return;
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, bounds);
    }

    private void DrawEllipse(RectangleF bounds, Color color, float width)
    {
        if (g is null) return;
        using var pen = new Pen(color, width);
        g.DrawEllipse(pen, bounds);
    }

    private void Bar(RectangleF track, double share, Color color)
    {
        if (g is null) return;
        FillRound(track, DeckTheme.Border, track.Height / 2);
        var width = (float)(track.Width * Math.Clamp(share, 0, 1));
        if (width >= track.Height) FillRound(track with { Width = width }, color, track.Height / 2);
    }

    /// <summary>A filled line chart. A <paramref name="ceiling"/> of 0 scales to the largest value shown.</summary>
    private void Sparkline(RectangleF area, IReadOnlyCollection<float> values, float ceiling, Color color)
    {
        if (g is null) return;
        using (var baseline = new Pen(DeckTheme.Border, 1))
            g.DrawLine(baseline, area.Left, area.Bottom, area.Right, area.Bottom);
        if (values.Count < 2) return;
        // A quiet link is drawn flat rather than stretched to fill the chart.
        var top = ceiling > 0 ? ceiling : Math.Max(values.Max(), 256 * 1024);
        const int slots = 90;
        var step = area.Width / (slots - 1);
        var x = area.Right - (values.Count - 1) * step;
        var points = new List<PointF>(values.Count);
        foreach (var value in values)
        {
            points.Add(new PointF(x, area.Bottom - Math.Clamp(value / top, 0, 1) * (area.Height - 1)));
            x += step;
        }
        using var fillPath = new GraphicsPath();
        fillPath.AddLines(points.ToArray());
        fillPath.AddLine(points[^1].X, area.Bottom, points[0].X, area.Bottom);
        fillPath.CloseFigure();
        using var fill = new SolidBrush(Color.FromArgb(46, color));
        g.FillPath(fill, fillPath);
        using var pen = new Pen(color, 1.3f) { LineJoin = LineJoin.Round };
        g.DrawLines(pen, points.ToArray());
    }
}
