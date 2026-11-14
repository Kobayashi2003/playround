using System.Drawing.Drawing2D;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>
/// The disk information panel: one disk at a time, with its identity, health and the whole attribute table.
/// It is drawn by hand in logical pixels, like the widget. Every disk's details are fetched up front and every half
/// minute, so switching disks shows them at once; the window keeps one size and a longer table scrolls.
/// </summary>
internal sealed class DiskInfoWindow : Form
{
    private const float PanelWidth = 780, Pad = 20, Edge = PanelWidth - Pad, RowHeight = 22, ChipHeight = 42;
    private const int VisibleRows = 20;
    private const TextFormatFlags TextBase = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
        | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;
    private static readonly TimeSpan RefreshEvery = TimeSpan.FromSeconds(30);

    private readonly AgentLink link;
    private readonly Func<IReadOnlyList<DiskInfo>> disks;
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer clock = new() { Interval = 2000 };
    private readonly List<(RectangleF Bounds, string Serial)> chips = [];
    private readonly Dictionary<string, DiskDetail> details = [];
    private string? selected;
    private DateTime fetchedAt;
    private bool fetching;
    private float scroll;
    private float tableTop;
    private PointF? mouse;
    private Graphics? g;

    internal DiskInfoWindow(AgentLink link, Func<IReadOnlyList<DiskInfo>> disks, int? number)
    {
        this.link = link;
        this.disks = disks;
        Text = "Disk information";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.None;
        DoubleBuffered = true;
        KeyPreview = true;
        BackColor = DeckTheme.Background;
        DeckTheme.Attach(this);
        DeckTheme.Changed += OnThemeChanged;
        Select(number);
        clock.Tick += (_, _) =>
        {
            if (DateTime.UtcNow - fetchedAt > RefreshEvery) _ = LoadAsync();
            Invalidate();
        };
        clock.Start();
    }

    private float DpiScale => DeviceDpi / 96f;

    private void OnThemeChanged()
    {
        BackColor = DeckTheme.Background;
        Invalidate();
    }

    /// <summary>Shows the disk with this number, or keeps the current one, or falls back to the first.</summary>
    internal void Select(int? number)
    {
        var list = disks();
        var disk = list.FirstOrDefault(candidate => candidate.Number == number)
            ?? list.FirstOrDefault(candidate => candidate.Serial == selected)
            ?? list.FirstOrDefault();
        if (disk is null) return;
        if (disk.Serial != selected) scroll = 0;
        selected = disk.Serial;
        Invalidate();
        if (!details.ContainsKey(disk.Serial)) _ = LoadAsync();
    }

    private DiskInfo? Selected => disks().FirstOrDefault(disk => disk.Serial == selected);

    /// <summary>Fetches the selected disk first, then the others.</summary>
    private async Task LoadAsync()
    {
        if (fetching) return;
        fetching = true;
        try
        {
            var list = disks();
            foreach (var disk in list.OrderBy(disk => disk.Serial == selected ? 0 : 1))
            {
                if (await link.GetDiskDetailAsync(disk.Number, lifetime.Token) is not { } loaded || IsDisposed) continue;
                details[loaded.Serial] = loaded;
                if (loaded.Serial == selected) Invalidate();
            }
            fetchedAt = DateTime.UtcNow;
        }
        catch (OperationCanceledException) { }
        finally { fetching = false; }
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        Relayout();
        CenterToScreen();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        BeginInvoke(Relayout);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        lifetime.Cancel();
        clock.Dispose();
        DeckTheme.Changed -= OnThemeChanged;
        base.OnFormClosed(e);
    }

    /// <summary>
    /// One size for every disk: room for <see cref="VisibleRows"/> table rows, or less on a short screen. It changes
    /// only with the DPI, so switching disks never moves the window's edges.
    /// </summary>
    private void Relayout()
    {
        if (IsDisposed || !IsHandleCreated) return;
        Render(null);
        var limit = Screen.FromControl(this).WorkingArea.Height * 0.88f / DpiScale;
        var height = Math.Min(tableTop + VisibleRows * RowHeight + 12, limit);
        var size = new Size((int)Math.Round(PanelWidth * DpiScale), (int)Math.Round(height * DpiScale));
        if (ClientSize != size) ClientSize = size;
        scroll = Math.Clamp(scroll, 0, MaxScroll(Render(null)));
        Invalidate();
    }

    private float MaxScroll(float content) => Math.Max(0, content - ClientSize.Height / DpiScale);

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e) => Render(e.Graphics);

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        mouse = new PointF(e.X / DpiScale, e.Y / DpiScale);
        Cursor = chips.Any(chip => chip.Bounds.Contains(mouse.Value)) ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        mouse = null;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        var chip = chips.FirstOrDefault(candidate => candidate.Bounds.Contains(point));
        if (e.Button == MouseButtons.Left && chip.Serial is not null) SelectSerial(chip.Serial);
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        scroll = Math.Clamp(scroll - e.Delta / 120f * RowHeight * 3, 0, MaxScroll(Render(null)));
        Invalidate();
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.Escape:
                Close();
                return true;
            case Keys.F5:
                _ = LoadAsync();
                return true;
            case Keys.Left or Keys.Right:
                var list = disks();
                var index = list.ToList().FindIndex(disk => disk.Serial == selected);
                if (index >= 0) SelectSerial(list[(index + (keyData == Keys.Left ? list.Count - 1 : 1)) % list.Count].Serial);
                return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private void SelectSerial(string serial)
    {
        if (disks().FirstOrDefault(disk => disk.Serial == serial) is { } disk) Select(disk.Number);
    }

    // ---- drawing ----

    /// <summary>Draws the panel, or only measures it without a <see cref="Graphics"/>. Returns the content height.</summary>
    private float Render(Graphics? graphics)
    {
        g = graphics;
        GraphicsState? saved = null;
        if (g is not null)
        {
            g.Clear(DeckTheme.Background);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            saved = g.Save();
            g.ScaleTransform(DpiScale, DpiScale);
        }

        var y = Chips(16);
        var disk = Selected;
        // While another disk's details are on their way, the summary still comes from the snapshot.
        var shown = selected is not null ? details.GetValueOrDefault(selected) : null;
        if (disk is not null)
        {
            y = Summary(y, disk, shown);
            y = Table(y, shown);
        }
        else
        {
            Draw("The agent reports no disks.", DeckTheme.Body, DeckTheme.Muted, Pad, y, Edge - Pad, 30);
            y += 40;
        }

        if (g is not null && saved is not null) g.Restore(saved);
        g = null;
        return y + 12;
    }

    private float Chips(float top)
    {
        chips.Clear();
        var list = disks();
        const float gap = 5;
        var perRow = Math.Min(Math.Max(list.Count, 1), 9);
        var width = (Edge - Pad - gap * (perRow - 1)) / perRow;
        for (var index = 0; index < list.Count; index++)
        {
            var disk = list[index];
            var bounds = new RectangleF(Pad + index % perRow * (width + gap), top + index / perRow * (ChipHeight + gap), width, ChipHeight);
            chips.Add((bounds, disk.Serial));
            var active = disk.Serial == selected;
            var hot = mouse is { } point && bounds.Contains(point);
            FillRound(bounds, active ? DeckTheme.Border : hot ? DeckTheme.Panel : DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.5f), 7);
            var (level, _) = DiskHealth.Of(disk);
            var color = level switch { HealthLevel.Bad => DeckTheme.Danger, HealthLevel.Warning => DeckTheme.Warning, _ => DeckTheme.Ready };
            FillEllipse(new RectangleF(bounds.X + 9, bounds.Y + 10, 8, 8), color);
            Draw(DiskHealth.Letters(disk), DeckTheme.Strong, DeckTheme.Text, bounds.X + 22, bounds.Y + 3, bounds.Width - 26, 22);
            var asleep = disk.Power == DiskPower.Standby;
            Draw(asleep ? "asleep" : disk.Smart?.TemperatureC is { } degrees ? $"{degrees} °C" : "—", DeckTheme.Small, DeckTheme.Muted,
                bounds.X + 22, bounds.Y + 21, bounds.Width - 26, 16);
        }
        var rows = (list.Count + perRow - 1) / perRow;
        return top + Math.Max(rows, 1) * (ChipHeight + gap) + 9;
    }

    private float Summary(float y, DiskInfo disk, DiskDetail? shown)
    {
        Draw($"{shown?.Model ?? disk.Model}   {Format.Bytes(disk.SizeBytes)}", DeckTheme.Title, DeckTheme.Text, Pad, y, Edge - Pad, 36);
        y += 46;

        var health = shown?.Health ?? disk.Health;
        var (healthText, healthColor) = health switch
        {
            HealthStatus.Good => ("Good", DeckTheme.Ready),
            HealthStatus.Caution => ("Caution", DeckTheme.Warning),
            HealthStatus.Bad => ("Bad", DeckTheme.Danger),
            _ => ("Unknown", DeckTheme.Muted)
        };
        var smart = shown?.Smart ?? disk.Smart;
        var asleep = disk.Power == DiskPower.Standby;
        var degrees = smart?.TemperatureC;
        var temperatureColor = degrees is null || asleep ? DeckTheme.Muted
            : degrees >= DiskHealth.HotC ? DeckTheme.Danger : degrees >= DiskHealth.WarmC ? DeckTheme.Warning : DeckTheme.Accent;
        Card(new RectangleF(Pad, y, 150, 56), "HEALTH", healthText, healthColor);
        Card(new RectangleF(Pad, y + 64, 150, 56), asleep ? "TEMPERATURE · ASLEEP" : "TEMPERATURE", degrees is null ? "—" : $"{degrees} °C", temperatureColor);

        string Count(long? value, string unit = "") => value is null ? "—" : value.Value.ToString("N0") + unit;
        var rotation = shown?.Rpm switch { 1 => "Solid state", { } rpm => $"{rpm:N0} RPM", null => disk.Rotational ? "Hard disk" : "Solid state" };
        var power = asleep ? "Asleep " + Format.Duration((long)(DateTimeOffset.Now - disk.PowerSince).TotalSeconds)
            : disk.CanSleep ? "Spinning" : "On";
        (string Label, string Value)[] left =
        [
            ("Firmware", Blank(shown?.Firmware)), ("Serial number", Blank(disk.Serial)), ("Interface", shown?.Interface ?? disk.Bus),
            ("Rotation", rotation), ("Drive letters", disk.Volumes.Length > 0 ? DiskHealth.Letters(disk) : "—")
        ];
        (string Label, string Value)[] right =
        [
            ("Power on count", Count(shown?.PowerCycles)), ("Power on hours", Count(smart?.PowerOnHours, " h")),
            ("Load cycles", Count(smart?.LoadCycleCount)), ("Power state", power),
            ("Read at", smart is null ? "—" : smart.ReadAt.LocalDateTime.ToString(smart.ReadAt.LocalDateTime.Date == DateTime.Today ? "HH:mm:ss" : "MMM d HH:mm"))
        ];
        for (var row = 0; row < left.Length; row++)
        {
            Fact(Pad + 174, y + row * 24, 96, 170, left[row]);
            Fact(Pad + 450, y + row * 24, 104, Edge - (Pad + 450) - 104, right[row]);
        }
        return y + 132;

        static string Blank(string? text) => string.IsNullOrWhiteSpace(text) ? "—" : text;
    }

    private void Fact(float x, float y, float labelWidth, float valueWidth, (string Label, string Value) fact)
    {
        Draw(fact.Label, DeckTheme.Caption, DeckTheme.Muted, x, y, labelWidth, 24);
        Draw(fact.Value, DeckTheme.Caption, DeckTheme.Text, x + labelWidth, y, valueWidth, 24);
    }

    private void Card(RectangleF bounds, string label, string value, Color color)
    {
        FillRound(bounds, DeckTheme.Mix(DeckTheme.Background, color, 0.16f), 8);
        Draw(label, DeckTheme.Label, DeckTheme.Muted, bounds.X + 12, bounds.Y + 6, bounds.Width - 20, 16);
        Draw(value, DeckTheme.Heading, color, bounds.X + 12, bounds.Y + 22, bounds.Width - 20, 28);
    }

    private float Table(float y, DiskDetail? shown)
    {
        tableTop = y + 26;
        if (shown is null)
        {
            Draw("Reading the disk…", DeckTheme.Caption, DeckTheme.Muted, Pad, y, Edge - Pad, 26);
            return y + 26;
        }
        if (shown.Attributes.Length == 0)
        {
            Draw(shown.Power == DiskPower.Standby
                    ? "The disk has been asleep since the agent started, so nothing has been read from it yet."
                    : "This disk reports no health attributes.",
                DeckTheme.Caption, DeckTheme.Muted, Pad, y, Edge - Pad, 26);
            return y + 26;
        }

        // SMART has numbered attributes with normalised values; SAS and NVMe readings are a name and a value.
        var numbered = shown.Attributes.Any(attribute => attribute.Id.Length > 0);
        float nameX = Pad + (numbered ? 56 : 24), nameWidth = numbered ? 230 : 400;
        Draw(numbered ? "ID" : "", DeckTheme.Label, DeckTheme.Muted, Pad + 24, y, 30, 26);
        Draw("ATTRIBUTE", DeckTheme.Label, DeckTheme.Muted, nameX, y, nameWidth, 26);
        if (numbered)
        {
            Draw("CURRENT", DeckTheme.Label, DeckTheme.Muted, ColumnCurrent, y, 60, 26, TextFormatFlags.Right);
            Draw("WORST", DeckTheme.Label, DeckTheme.Muted, ColumnWorst, y, 56, 26, TextFormatFlags.Right);
            Draw("THRESHOLD", DeckTheme.Label, DeckTheme.Muted, ColumnThreshold, y, 72, 26, TextFormatFlags.Right);
            Draw("RAW (HEX)", DeckTheme.Label, DeckTheme.Muted, ColumnRaw, y, 108, 26, TextFormatFlags.Right);
            Draw("RAW (DECIMAL)", DeckTheme.Label, DeckTheme.Muted, ColumnDecimal, y, Edge - ColumnDecimal, 26, TextFormatFlags.Right);
        }
        else
        {
            Draw("VALUE", DeckTheme.Label, DeckTheme.Muted, ColumnRaw, y, Edge - ColumnRaw, 26, TextFormatFlags.Right);
        }
        y += 26;
        Line(y);

        // Only the rows scroll; everything above them stays put.
        var view = ClientSize.Height / DpiScale;
        var state = g?.Save();
        g?.SetClip(new RectangleF(0, tableTop + 1, PanelWidth, Math.Max(0, view - tableTop - 1)));
        var rowY = y - scroll;
        foreach (var attribute in shown.Attributes)
        {
            if (rowY + RowHeight > tableTop && rowY < view)
            {
                var color = attribute.Status switch
                {
                    HealthStatus.Bad => DeckTheme.Danger, HealthStatus.Caution => DeckTheme.Warning,
                    HealthStatus.Good => DeckTheme.Ready, _ => DeckTheme.Muted
                };
                var text = attribute.Status is HealthStatus.Bad or HealthStatus.Caution ? color : DeckTheme.Text;
                FillEllipse(new RectangleF(Pad + 6, rowY + 7, 8, 8), color);
                Draw(attribute.Id, DeckTheme.Caption, DeckTheme.Muted, Pad + 24, rowY, 30, RowHeight);
                Draw(attribute.Name, DeckTheme.Caption, text, nameX, rowY, nameWidth, RowHeight);
                if (numbered)
                {
                    Draw($"{attribute.Current}", DeckTheme.Caption, text, ColumnCurrent, rowY, 60, RowHeight, TextFormatFlags.Right);
                    Draw($"{attribute.Worst}", DeckTheme.Caption, DeckTheme.Muted, ColumnWorst, rowY, 56, RowHeight, TextFormatFlags.Right);
                    Draw($"{attribute.Threshold}", DeckTheme.Caption, DeckTheme.Muted, ColumnThreshold, rowY, 72, RowHeight, TextFormatFlags.Right);
                    Draw(attribute.Raw, Mono, DeckTheme.Muted, ColumnRaw, rowY, 108, RowHeight, TextFormatFlags.Right);
                    Draw(Decimal(attribute), Mono, text, ColumnDecimal, rowY, Edge - ColumnDecimal, RowHeight, TextFormatFlags.Right);
                }
                else
                {
                    Draw(attribute.Raw, DeckTheme.Caption, text, ColumnRaw, rowY, Edge - ColumnRaw, RowHeight, TextFormatFlags.Right);
                }
            }
            rowY += RowHeight;
        }
        if (g is not null && state is not null) g.Restore(state);

        var bottom = y + shown.Attributes.Length * RowHeight;
        var overflow = bottom + 16 - view;
        if (g is not null && overflow > 0.5f)
        {
            // A thumb whose length is the visible share of the rows.
            var track = view - tableTop - 8;
            var length = Math.Max(24, track * (view - tableTop) / (bottom + 16 - tableTop));
            var offset = (track - length) * Math.Clamp(scroll / overflow, 0, 1);
            FillRound(new RectangleF(PanelWidth - 9, tableTop + 4 + offset, 4, length), DeckTheme.Border, 2);
        }
        return bottom;
    }

    private static readonly Font Mono = new("Consolas", 9.5f);
    private const float ColumnCurrent = 300, ColumnWorst = 366, ColumnThreshold = 428, ColumnRaw = 508, ColumnDecimal = 624;

    /// <summary>
    /// The raw value in decimal. A temperature attribute packs the lifetime minimum and maximum above the reading,
    /// so only its low byte is shown, as the reading the drive means.
    /// </summary>
    internal static string Decimal(DiskAttribute attribute)
    {
        if (!ulong.TryParse(attribute.Raw, System.Globalization.NumberStyles.HexNumber, null, out var raw)) return "";
        return (attribute.Id is "C2" or "BE" ? raw & 0xFF : raw).ToString("N0");
    }

    private void Line(float y)
    {
        if (g is null) return;
        using var pen = new Pen(DeckTheme.Border, 1);
        g.DrawLine(pen, Pad, y + 0.5f, Edge, y + 0.5f);
    }

    private void Draw(string text, Font font, Color color, float x, float top, float width, float height, TextFormatFlags align = TextFormatFlags.Left)
    {
        if (g is null || text.Length == 0 || width <= 0) return;
        // GDI text ignores the graphics transform but honours the clip, so the rectangle is scaled by hand.
        var bounds = Rectangle.Round(new RectangleF(x * DpiScale, top * DpiScale, width * DpiScale, height * DpiScale));
        TextRenderer.DrawText(g, text, font, bounds, color, TextBase | align | TextFormatFlags.PreserveGraphicsClipping);
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
}
