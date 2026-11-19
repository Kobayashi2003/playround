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
    private const float PanelWidth = 780, Pad = 20, Edge = PanelWidth - Pad, RowHeight = 24, ChipHeight = 38;
    private const int VisibleRows = 19;
    private static readonly Font ModelFont = new("Segoe UI Semibold", 13f);
    private const TextFormatFlags TextBase = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
        | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;
    private static readonly TimeSpan RefreshEvery = TimeSpan.FromSeconds(30);

    private readonly AgentLink link;
    private readonly Func<IReadOnlyList<DiskInfo>> disks;
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer clock = new() { Interval = 2000 };
    private readonly List<(RectangleF Bounds, string Serial)> chips = [];
    private readonly Dictionary<string, DiskDetail> details = [];
    private readonly ThinScrollBar scrollBar = new();
    private string? selected;
    private DateTime fetchedAt;
    private bool fetching;
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
        if (disk.Serial != selected) scrollBar.Offset = 0;
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
        var height = Math.Min(tableTop + VisibleRows * RowHeight + 16, limit);
        var size = new Size((int)Math.Round(PanelWidth * DpiScale), (int)Math.Round(height * DpiScale));
        if (ClientSize != size) ClientSize = size;
        Render(null);
        Invalidate();
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e) => Render(e.Graphics);

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        mouse = new PointF(e.X / DpiScale, e.Y / DpiScale);
        scrollBar.OnMouseMove(mouse.Value);
        Cursor = scrollBar.Dragging || scrollBar.HitTest(mouse.Value) || chips.Any(chip => chip.Bounds.Contains(mouse.Value))
            ? Cursors.Hand : Cursors.Default;
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        mouse = null;
        scrollBar.OnMouseLeave();
        Cursor = Cursors.Default;
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        if (scrollBar.OnMouseDown(point))
        {
            Capture = true;
            Invalidate();
            return;
        }
        var chip = chips.FirstOrDefault(candidate => candidate.Bounds.Contains(point));
        if (chip.Serial is not null) SelectSerial(chip.Serial);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (scrollBar.OnMouseUp())
        {
            Capture = false;
            Invalidate();
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        if (scrollBar.ScrollWheel(e.Delta, RowHeight * 3)) Invalidate();
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
            Draw("The agent reports no disks.", DeckTheme.Caption, DeckTheme.Muted, Pad, y, Edge - Pad, 30);
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
        var width = Math.Min(132f, (Edge - Pad - gap * (perRow - 1)) / perRow);
        for (var index = 0; index < list.Count; index++)
        {
            var disk = list[index];
            var bounds = new RectangleF(Pad + index % perRow * (width + gap), top + index / perRow * (ChipHeight + gap), width, ChipHeight);
            chips.Add((bounds, disk.Serial));
            var active = disk.Serial == selected;
            var hot = mouse is { } point && bounds.Contains(point);
            FillRound(bounds, active ? DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Accent, 0.25f) : hot ? DeckTheme.Panel : DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.55f), 7);
            if (active && g is not null)
            {
                using var path = DeckTheme.RoundedRectangle(bounds, 7);
                using var border = new Pen(DeckTheme.Accent, 1);
                g.DrawPath(border, path);
            }
            var (level, _) = DiskHealth.Of(disk);
            var color = level switch { HealthLevel.Bad => DeckTheme.Danger, HealthLevel.Warning => DeckTheme.Warning, _ => DeckTheme.Ready };
            FillEllipse(new RectangleF(bounds.X + 9, bounds.Y + 9, 7, 7), color);
            Draw(DiskHealth.Letters(disk), DeckTheme.Strong, DeckTheme.Text, bounds.X + 21, bounds.Y + 2, bounds.Width - 25, 19);
            var asleep = disk.Power == DiskPower.Standby;
            Draw(asleep ? "asleep" : disk.Smart?.TemperatureC is { } degrees ? $"{degrees} °C" : "—", DeckTheme.Small, DeckTheme.Muted,
                bounds.X + 21, bounds.Y + 19, bounds.Width - 25, 16);
        }
        var rows = (list.Count + perRow - 1) / perRow;
        return top + Math.Max(rows, 1) * (ChipHeight + gap) + 9;
    }

    private float Summary(float y, DiskInfo disk, DiskDetail? shown)
    {
        Draw($"{shown?.Model ?? disk.Model}   ·   {Format.Bytes(disk.SizeBytes)}", ModelFont, DeckTheme.Text, Pad, y, Edge - Pad, 28);
        y += 36;

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
            Fact(Pad + 172, y + row * 24, 92, 166, left[row]);
            Fact(Pad + 448, y + row * 24, 104, Edge - (Pad + 448) - 104, right[row]);
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
        FillRound(bounds, DeckTheme.Mix(DeckTheme.Background, color, 0.14f), 8);
        if (g is not null)
        {
            using var path = DeckTheme.RoundedRectangle(bounds, 8);
            using var border = new Pen(DeckTheme.Mix(DeckTheme.Border, color, 0.3f), 1);
            g.DrawPath(border, path);
        }
        Draw(label, DeckTheme.Label, DeckTheme.Muted, bounds.X + 12, bounds.Y + 6, bounds.Width - 20, 16);
        Draw(value, DeckTheme.Heading, color, bounds.X + 12, bounds.Y + 22, bounds.Width - 20, 28);
    }

    private float Table(float y, DiskDetail? shown)
    {
        const float headerHeight = 26;
        tableTop = y + headerHeight;
        var view = ClientSize.Height / DpiScale;
        var cardHeight = Math.Max(80, view - y - 16);
        var card = new RectangleF(Pad, y, Edge - Pad, cardHeight);
        FillRound(card, DeckTheme.Panel, 8);
        if (g is not null)
        {
            using var path = DeckTheme.RoundedRectangle(card, 8);
            using var border = new Pen(DeckTheme.Border, 1);
            g.DrawPath(border, path);
        }

        if (shown is null)
        {
            Draw("Reading the disk…", DeckTheme.Caption, DeckTheme.Muted, card.X + 14, card.Y, card.Width - 28, Math.Min(cardHeight, 44));
            return y + 44;
        }
        if (shown.Attributes.Length == 0)
        {
            Draw(shown.Power == DiskPower.Standby
                    ? "The disk has been asleep since the agent started, so nothing has been read from it yet."
                    : "This disk reports no health attributes.",
                DeckTheme.Caption, DeckTheme.Muted, card.X + 14, card.Y, card.Width - 28, Math.Min(cardHeight, 44));
            return y + 44;
        }

        // SMART has numbered attributes with normalised values; SAS and NVMe readings are a name and a value.
        var numbered = shown.Attributes.Any(attribute => attribute.Id.Length > 0);
        var innerLeft = card.Left + 10;
        var innerRight = card.Right - 18;
        float nameX = innerLeft + (numbered ? 54 : 22), nameWidth = numbered ? 222 : 390;
        Draw(numbered ? "ID" : "", DeckTheme.Label, DeckTheme.Muted, innerLeft + 22, y + 1, 28, headerHeight);
        Draw("ATTRIBUTE", DeckTheme.Label, DeckTheme.Muted, nameX, y + 1, nameWidth, headerHeight);
        if (numbered)
        {
            Draw("CURRENT", DeckTheme.Label, DeckTheme.Muted, ColumnCurrent, y + 1, 58, headerHeight, TextFormatFlags.Right);
            Draw("WORST", DeckTheme.Label, DeckTheme.Muted, ColumnWorst, y + 1, 54, headerHeight, TextFormatFlags.Right);
            Draw("THRESHOLD", DeckTheme.Label, DeckTheme.Muted, ColumnThreshold, y + 1, 70, headerHeight, TextFormatFlags.Right);
            Draw("RAW (HEX)", DeckTheme.Label, DeckTheme.Muted, ColumnRaw, y + 1, 102, headerHeight, TextFormatFlags.Right);
            Draw("RAW (DECIMAL)", DeckTheme.Label, DeckTheme.Muted, ColumnDecimal, y + 1, innerRight - ColumnDecimal, headerHeight, TextFormatFlags.Right);
        }
        else
        {
            Draw("VALUE", DeckTheme.Label, DeckTheme.Muted, ColumnRaw, y + 1, innerRight - ColumnRaw, headerHeight, TextFormatFlags.Right);
        }
        y += headerHeight;
        if (g is not null)
        {
            using var sep = new Pen(DeckTheme.Border, 1);
            g.DrawLine(sep, card.Left + 1, y + 0.5f, card.Right - 1, y + 0.5f);
        }

        // Only the rows scroll; everything above them stays put.
        var viewport = Math.Max(0, card.Bottom - tableTop - 6);
        var contentHeight = shown.Attributes.Length * RowHeight + 4;
        scrollBar.Update(new RectangleF(card.Right - 16, tableTop + 3, 14, Math.Max(0, viewport)), viewport, contentHeight);

        var state = g?.Save();
        g?.SetClip(new RectangleF(card.Left + 2, tableTop + 1.5f, card.Width - 4, Math.Max(0, card.Bottom - tableTop - 3)));
        var rowY = y + 2 - scrollBar.Offset;
        foreach (var attribute in shown.Attributes)
        {
            if (rowY + RowHeight > tableTop && rowY < card.Bottom)
            {
                var rowRect = new RectangleF(card.Left + 5, rowY + 1, innerRight - card.Left - 1, RowHeight - 2);
                if (mouse is { } point && point.Y >= tableTop && point.Y <= card.Bottom && !scrollBar.Dragging && rowRect.Contains(point))
                    FillRound(rowRect, DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.65f), 5);
                var color = attribute.Status switch
                {
                    HealthStatus.Bad => DeckTheme.Danger, HealthStatus.Caution => DeckTheme.Warning,
                    HealthStatus.Good => DeckTheme.Ready, _ => DeckTheme.Muted
                };
                var text = attribute.Status is HealthStatus.Bad or HealthStatus.Caution ? color : DeckTheme.Text;
                FillEllipse(new RectangleF(innerLeft + 4, rowY + (RowHeight - 7) / 2, 7, 7), color);
                Draw(attribute.Id, DeckTheme.Caption, DeckTheme.Muted, innerLeft + 22, rowY, 28, RowHeight);
                Draw(attribute.Name, DeckTheme.Caption, text, nameX, rowY, nameWidth, RowHeight);
                if (numbered)
                {
                    Draw($"{attribute.Current}", DeckTheme.Caption, text, ColumnCurrent, rowY, 58, RowHeight, TextFormatFlags.Right);
                    Draw($"{attribute.Worst}", DeckTheme.Caption, DeckTheme.Muted, ColumnWorst, rowY, 54, RowHeight, TextFormatFlags.Right);
                    Draw($"{attribute.Threshold}", DeckTheme.Caption, DeckTheme.Muted, ColumnThreshold, rowY, 70, RowHeight, TextFormatFlags.Right);
                    Draw(attribute.Raw, Mono, DeckTheme.Muted, ColumnRaw, rowY, 102, RowHeight, TextFormatFlags.Right);
                    Draw(Decimal(attribute), Mono, text, ColumnDecimal, rowY, innerRight - ColumnDecimal, RowHeight, TextFormatFlags.Right);
                }
                else
                {
                    Draw(attribute.Raw, DeckTheme.Caption, text, ColumnRaw, rowY, innerRight - ColumnRaw, RowHeight, TextFormatFlags.Right);
                }
            }
            rowY += RowHeight;
        }
        if (g is not null && state is not null) g.Restore(state);
        if (g is not null) scrollBar.Paint(g);
        return y + contentHeight;
    }

    private static readonly Font Mono = new("Consolas", 9f);
    private const float ColumnCurrent = 304, ColumnWorst = 368, ColumnThreshold = 428, ColumnRaw = 504, ColumnDecimal = 612;

    /// <summary>
    /// The raw value in decimal. A temperature attribute packs the lifetime minimum and maximum above the reading,
    /// so only its low byte is shown, as the reading the drive means.
    /// </summary>
    internal static string Decimal(DiskAttribute attribute)
    {
        if (!ulong.TryParse(attribute.Raw, System.Globalization.NumberStyles.HexNumber, null, out var raw)) return "";
        return (attribute.Id is "C2" or "BE" ? raw & 0xFF : raw).ToString("N0");
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
