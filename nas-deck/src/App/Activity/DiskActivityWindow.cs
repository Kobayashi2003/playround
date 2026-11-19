using System.Drawing.Drawing2D;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>
/// Real-time disk I/O process monitor for both the NAS and this PC. Hand-drawn in logical pixels like
/// <see cref="DiskInfoWindow"/>, with interactive thin scrollbars, per-disk filtering and pause control.
/// </summary>
internal sealed class DiskActivityWindow : Form
{
    private const float PanelWidth = 768, PanelHeight = 584, Pad = 20, Edge = PanelWidth - Pad;
    private const float HeaderHeight = 25, RowHeight = 26, ChipHeight = 38;
    private const float ScrollTrackWidth = 14;
    private const TextFormatFlags TextBase = TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine
        | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis;
    private static readonly Font Mono = new("Consolas", 9f);

    private sealed record ClickTarget(RectangleF Bounds, Action Click);
    private sealed record RowTip(RectangleF Bounds, string Text);
    private sealed record DisplayRow(string Name, string Pid, string? Badge, Color BadgeColor, string Detail, double Read, double Write, bool Passive, string? FullTip);

    private readonly AgentLink link;
    private readonly Func<Snapshot?> getSnapshot;
    private readonly Func<NasSettings> getSettings;
    private readonly LocalActivityMonitor localMonitor = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly System.Windows.Forms.Timer clock = new() { Interval = 1500 };
    private readonly ToolTip tooltips = new() { InitialDelay = 400, ReshowDelay = 120 };
    private readonly ThinScrollBar nasScroll = new();
    private readonly ThinScrollBar localScroll = new();
    private readonly List<ClickTarget> targets = [];
    private readonly List<RowTip> rowTips = [];

    private NasActivity? nasActivity;
    private bool nasUnsupported;
    private LocalProcessActivity[] localActivity = [];
    private int? filterDiskNumber;
    private bool localNasOnly;
    private bool paused;
    private bool polling;
    private bool firstSample = true;
    private string? activeTip;
    private PointF? mouse;
    private RectangleF nasCardBounds;
    private RectangleF localCardBounds;
    private Graphics? g;

    internal DiskActivityWindow(AgentLink link, Func<Snapshot?> getSnapshot, Func<NasSettings> getSettings, int? diskNumber)
    {
        this.link = link;
        this.getSnapshot = getSnapshot;
        this.getSettings = getSettings;
        filterDiskNumber = diskNumber;

        Text = "Disk activity";
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

        clock.Tick += (_, _) => { if (!paused) _ = RefreshAsync(forceHandles: false); };
        clock.Start();
    }

    private float DpiScale => DeviceDpi / 96f;

    internal void FilterDisk(int? number)
    {
        if (filterDiskNumber == number) return;
        filterDiskNumber = number;
        nasScroll.Offset = 0;
        localScroll.Offset = 0;
        Invalidate();
    }

    private void OnThemeChanged()
    {
        BackColor = DeckTheme.Background;
        Invalidate();
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        ApplySize();
        CenterToScreen();
        _ = InitialLoadAsync();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        BeginInvoke(ApplySize);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        lifetime.Cancel();
        clock.Dispose();
        tooltips.Dispose();
        DeckTheme.Changed -= OnThemeChanged;
        base.OnFormClosed(e);
    }

    private void ApplySize()
    {
        if (IsDisposed || !IsHandleCreated) return;
        var area = Screen.FromControl(this).WorkingArea;
        var logicalHeight = Math.Min(PanelHeight, area.Height * 0.88f / DpiScale);
        var size = new Size((int)Math.Round(PanelWidth * DpiScale), (int)Math.Round(logicalHeight * DpiScale));
        if (ClientSize != size) ClientSize = size;
        Invalidate();
    }

    private async Task InitialLoadAsync()
    {
        // Take an immediate baseline for local deltas, then a live sample shortly after so both lists populate fast.
        var hosts = LocalActivityMonitor.BuildNasHosts(getSettings(), getSnapshot()?.System.HostName);
        await Task.Run(() => localMonitor.Sample(hosts, forceHandleScan: true));
        if (IsDisposed || lifetime.IsCancellationRequested) return;
        await RefreshAsync(forceHandles: false);
        try { await Task.Delay(500, lifetime.Token); }
        catch (OperationCanceledException) { return; }
        if (!paused && !IsDisposed) await RefreshAsync(forceHandles: false);
    }

    private async Task RefreshAsync(bool forceHandles)
    {
        if (polling || IsDisposed || lifetime.IsCancellationRequested) return;
        polling = true;
        try
        {
            var token = lifetime.Token;
            var snapshot = getSnapshot();
            var hosts = LocalActivityMonitor.BuildNasHosts(getSettings(), snapshot?.System.HostName);

            var nasTask = snapshot is not null
                ? link.GetActivityAsync(token)
                : Task.FromResult<(NasActivity?, bool)>((null, false));
            var localTask = Task.Run(() => localMonitor.Sample(hosts, forceHandles || firstSample), token);
            await Task.WhenAll(nasTask, localTask);
            if (IsDisposed || token.IsCancellationRequested) return;

            var (activity, unsupported) = await nasTask;
            nasActivity = activity;
            nasUnsupported = unsupported;
            localActivity = await localTask;
            firstSample = false;
            Invalidate();
        }
        catch (OperationCanceledException) { }
        finally { polling = false; }
    }

    // ---- input ----

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnPaint(PaintEventArgs e) => Render(e.Graphics);

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        mouse = new PointF(e.X / DpiScale, e.Y / DpiScale);
        var dirty = nasScroll.OnMouseMove(mouse.Value) | localScroll.OnMouseMove(mouse.Value);
        if (nasScroll.Dragging || localScroll.Dragging)
        {
            if (dirty) Invalidate();
            return;
        }
        var overInteractive = nasScroll.HitTest(mouse.Value) || localScroll.HitTest(mouse.Value)
            || targets.Any(t => t.Bounds.Contains(mouse.Value));
        Cursor = overInteractive ? Cursors.Hand : Cursors.Default;
        var tip = rowTips.FirstOrDefault(t => t.Bounds.Contains(mouse.Value))?.Text;
        if (tip != activeTip)
        {
            activeTip = tip;
            tooltips.SetToolTip(this, tip);
        }
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        mouse = null;
        nasScroll.OnMouseLeave();
        localScroll.OnMouseLeave();
        Cursor = Cursors.Default;
        if (activeTip is not null) { activeTip = null; tooltips.SetToolTip(this, null); }
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        if (nasScroll.OnMouseDown(point) || localScroll.OnMouseDown(point))
        {
            Capture = true;
            Invalidate();
            return;
        }
        foreach (var target in targets)
        {
            if (target.Bounds.Contains(point))
            {
                target.Click();
                Invalidate();
                return;
            }
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (nasScroll.OnMouseUp() | localScroll.OnMouseUp())
        {
            Capture = false;
            Invalidate();
        }
    }

    protected override void OnMouseWheel(MouseEventArgs e)
    {
        base.OnMouseWheel(e);
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        var scrolled = localCardBounds.Contains(point)
            ? localScroll.ScrollWheel(e.Delta, RowHeight * 2.5f)
            : nasScroll.ScrollWheel(e.Delta, RowHeight * 2.5f);
        if (scrolled) Invalidate();
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.Escape:
                Close();
                return true;
            case Keys.F5:
                _ = RefreshAsync(forceHandles: true);
                return true;
            case Keys.Space:
                paused = !paused;
                Invalidate();
                return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    // ---- rendering ----

    private void Render(Graphics graphics)
    {
        g = graphics;
        targets.Clear();
        rowTips.Clear();
        g.Clear(DeckTheme.Background);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var saved = g.Save();
        g.ScaleTransform(DpiScale, DpiScale);

        var snapshot = getSnapshot();
        var logicalHeight = ClientSize.Height / DpiScale;

        var y = DrawHeader(12, snapshot);
        if (snapshot is { Disks.Length: > 0 }) y = DrawDiskChips(y + 4, snapshot.Disks);
        else y += 4;

        var remaining = Math.Max(260, logicalHeight - y - 16);
        const float sectionGap = 12;
        var sectionHeight = (remaining - sectionGap) / 2f;

        var nasRows = BuildNasRows(snapshot);
        var localRows = BuildLocalRows(snapshot);

        var nasTitle = snapshot is not null ? $"NAS · {snapshot.System.HostName}" : $"NAS · {getSettings().Host}";
        var nasSubtitle = snapshot is null ? "offline"
            : nasUnsupported ? "agent update needed"
            : nasActivity?.PerDisk == true ? "per-disk I/O"
            : nasActivity is not null ? "process totals"
            : "connecting…";
        var nasTotalR = snapshot?.Disks.Where(d => filterDiskNumber is null || d.Number == filterDiskNumber).Sum(d => d.ReadBytesPerSec) ?? 0;
        var nasTotalW = snapshot?.Disks.Where(d => filterDiskNumber is null || d.Number == filterDiskNumber).Sum(d => d.WriteBytesPerSec) ?? 0;
        var nasRateText = snapshot is not null && nasTotalR + nasTotalW > 0
            ? $"R {Format.Rate(nasTotalR)}   W {Format.Rate(nasTotalW)}"
            : snapshot is not null ? "Idle" : "";
        var nasEmpty = snapshot is null ? "NAS is offline."
            : nasUnsupported ? "Update the NAS agent (Install-Agent.ps1 -Build) to inspect NAS processes."
            : filterDiskNumber is { } num ? $"No active NAS disk I/O on {DiskLabel(snapshot, num)}."
            : "No active NAS disk I/O right now.";

        nasCardBounds = DrawSection(y, sectionHeight, nasTitle, nasSubtitle, nasRateText,
            "DISKS / OPEN FILES", nasRows, nasEmpty, nasScroll, showLocalFilter: false);

        var localNasCount = localActivity.Count(p => p.TouchesNas);
        var localSub = localNasCount > 0
            ? $"{localNasCount} accessing NAS"
            : "local I/O & NAS handles";
        var localEmpty = filterDiskNumber is { } dnum && snapshot is not null
            ? $"No local processes currently hold open handles on {DiskLabel(snapshot, dnum)}."
            : localNasOnly
                ? "No local processes currently hold open handles to the NAS."
                : "No active local disk I/O right now.";

        localCardBounds = DrawSection(y + sectionHeight + sectionGap, sectionHeight,
            $"THIS PC · {Environment.MachineName}", localSub, "",
            "TARGET / NAS PATH", localRows, localEmpty, localScroll, showLocalFilter: true);

        g.Restore(saved);
        g = null;
    }

    private float DrawHeader(float y, Snapshot? snapshot)
    {
        var dotColor = paused ? DeckTheme.Warning : snapshot is not null ? DeckTheme.Ready : DeckTheme.Muted;
        FillEllipse(new RectangleF(Pad + 1, y + 9.5f, 7, 7), dotColor);
        var note = paused ? "Paused  ·  Space to resume" : snapshot is not null ? "Live  ·  updating every 1.5 s" : "Local only  ·  NAS offline";
        Draw(note, DeckTheme.Small, paused ? DeckTheme.Warning : DeckTheme.Muted, Pad + 14, y, 280, 26);

        var refreshRect = new RectangleF(Edge - 74, y, 74, 26);
        var pauseRect = new RectangleF(refreshRect.Left - 80, y, 74, 26);
        DrawPillButton(pauseRect, paused ? "Resume" : "Pause", active: paused, () => paused = !paused);
        DrawPillButton(refreshRect, "Refresh", active: false, () => _ = RefreshAsync(forceHandles: true));
        return y + 30;
    }

    private float DrawDiskChips(float top, DiskInfo[] disks)
    {
        const float gap = 5;
        var count = disks.Length + 1;
        var perRow = Math.Min(Math.Max(count, 1), 10);
        var width = Math.Min(110f, (Edge - Pad - gap * (perRow - 1)) / perRow);

        for (var index = 0; index < count; index++)
        {
            var bounds = new RectangleF(Pad + index % perRow * (width + gap), top + index / perRow * (ChipHeight + gap), width, ChipHeight);
            if (index == 0)
            {
                var active = filterDiskNumber is null;
                var hot = mouse is { } p && bounds.Contains(p);
                FillRound(bounds, active ? DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Accent, 0.25f) : hot ? DeckTheme.Panel : DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.55f), 7);
                if (active) StrokeRound(bounds, DeckTheme.Accent, 7);
                Draw("All disks", DeckTheme.Strong, active ? DeckTheme.Text : DeckTheme.Muted, bounds.X + 8, bounds.Y + 4, bounds.Width - 16, 17, TextFormatFlags.HorizontalCenter);
                var activeDisks = disks.Count(d => d.ReadBytesPerSec + d.WriteBytesPerSec > 0);
                Draw(activeDisks > 0 ? $"{activeDisks} busy" : $"{disks.Length} disks", DeckTheme.Small, DeckTheme.Muted,
                    bounds.X + 8, bounds.Y + 20, bounds.Width - 16, 15, TextFormatFlags.HorizontalCenter);
                targets.Add(new ClickTarget(bounds, () => FilterDisk(null)));
                continue;
            }

            var disk = disks[index - 1];
            var isSelected = filterDiskNumber == disk.Number;
            var isHot = mouse is { } pt && bounds.Contains(pt);
            FillRound(bounds, isSelected ? DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Accent, 0.25f) : isHot ? DeckTheme.Panel : DeckTheme.Mix(DeckTheme.Background, DeckTheme.Panel, 0.55f), 7);
            if (isSelected) StrokeRound(bounds, DeckTheme.Accent, 7);

            var asleep = disk.Power == DiskPower.Standby;
            var busy = !asleep && disk.ReadBytesPerSec + disk.WriteBytesPerSec > 0;
            var dotColor = asleep ? DeckTheme.Muted : busy ? DeckTheme.Accent : DeckTheme.Ready;
            if (asleep)
            {
                using var pen = new Pen(DeckTheme.Muted, 1.3f);
                g!.DrawEllipse(pen, bounds.X + 8, bounds.Y + 9, 7, 7);
            }
            else
            {
                FillEllipse(new RectangleF(bounds.X + 8, bounds.Y + 9, 7, 7), dotColor);
            }
            Draw(DiskHealth.Letters(disk), DeckTheme.Strong, asleep ? DeckTheme.Muted : DeckTheme.Text, bounds.X + 20, bounds.Y + 2, bounds.Width - 24, 18);
            var sub = asleep ? "asleep" : busy ? ShortRate(disk.ReadBytesPerSec + disk.WriteBytesPerSec) : "idle";
            Draw(sub, DeckTheme.Small, busy ? DeckTheme.Accent : DeckTheme.Muted, bounds.X + 20, bounds.Y + 19, bounds.Width - 24, 16);
            var diskNumber = disk.Number;
            targets.Add(new ClickTarget(bounds, () => FilterDisk(diskNumber)));
        }

        var rows = (count + perRow - 1) / perRow;
        return top + rows * (ChipHeight + gap) + 6;
    }

    private RectangleF DrawSection(
        float top,
        float totalHeight,
        string title,
        string subtitle,
        string rightSummary,
        string detailColumnHeader,
        DisplayRow[] rows,
        string emptyMessage,
        ThinScrollBar scroll,
        bool showLocalFilter)
    {
        const float titleBarHeight = 24;
        var measuredTitle = TextRenderer.MeasureText(title, DeckTheme.Strong).Width / DpiScale + 4;
        var titleW = Math.Min(340f, measuredTitle);
        Draw(title, DeckTheme.Strong, DeckTheme.Text, Pad, top, titleW, titleBarHeight);
        var subX = Pad + titleW + 8;
        var subRight = showLocalFilter ? Edge - 160 : Edge - 216;
        if (subRight > subX + 30) Draw(subtitle, DeckTheme.Small, DeckTheme.Muted, subX, top, subRight - subX, titleBarHeight);

        if (showLocalFilter)
        {
            var nasOnlyRect = new RectangleF(Edge - 74, top + 2, 74, 22);
            var allRect = new RectangleF(nasOnlyRect.Left - 78, top + 2, 74, 22);
            DrawPillButton(allRect, "All active", active: !localNasOnly, () => { localNasOnly = false; localScroll.Offset = 0; });
            DrawPillButton(nasOnlyRect, "NAS only", active: localNasOnly, () => { localNasOnly = true; localScroll.Offset = 0; });
        }
        else if (!string.IsNullOrEmpty(rightSummary))
        {
            Draw(rightSummary, DeckTheme.Small, DeckTheme.Muted, Edge - 210, top + 1, 210, titleBarHeight, TextFormatFlags.Right);
        }

        var cardTop = top + titleBarHeight + 4;
        var cardHeight = Math.Max(100, totalHeight - titleBarHeight - 4);
        var card = new RectangleF(Pad, cardTop, Edge - Pad, cardHeight);
        FillRound(card, DeckTheme.Panel, 8);
        StrokeRound(card, DeckTheme.Border, 8);

        var viewport = Math.Max(0, card.Height - HeaderHeight - 6);
        scroll.Update(new RectangleF(card.Right - ScrollTrackWidth - 2, card.Top + HeaderHeight + 3, ScrollTrackWidth, viewport), viewport, rows.Length * RowHeight);

        var contentRight = card.Right - (scroll.Visible ? ScrollTrackWidth + 6 : 10);
        const float colName = Pad + 12, nameW = 166;
        const float colPid = colName + nameW + 8, pidW = 54;
        const float colWriteW = 84, colReadW = 84;
        var colWrite = contentRight - colWriteW;
        var colRead = colWrite - colReadW - 8;
        var colDetail = colPid + pidW + 10;
        var detailW = Math.Max(60, colRead - colDetail - 10);

        Draw("PROCESS", DeckTheme.Label, DeckTheme.Muted, colName, card.Top + 1, nameW, HeaderHeight);
        Draw("PID", DeckTheme.Label, DeckTheme.Muted, colPid, card.Top + 1, pidW, HeaderHeight, TextFormatFlags.Right);
        Draw(detailColumnHeader, DeckTheme.Label, DeckTheme.Muted, colDetail, card.Top + 1, detailW, HeaderHeight);
        Draw("READ", DeckTheme.Label, DeckTheme.Muted, colRead, card.Top + 1, colReadW, HeaderHeight, TextFormatFlags.Right);
        Draw("WRITE", DeckTheme.Label, DeckTheme.Muted, colWrite, card.Top + 1, colWriteW, HeaderHeight, TextFormatFlags.Right);

        using (var sep = new Pen(DeckTheme.Border, 1))
            g!.DrawLine(sep, card.Left + 1, card.Top + HeaderHeight + 0.5f, card.Right - 1, card.Top + HeaderHeight + 0.5f);

        if (rows.Length == 0)
        {
            Draw(emptyMessage, DeckTheme.Caption, DeckTheme.Muted, card.Left + 16, card.Top + HeaderHeight, card.Width - 32, card.Height - HeaderHeight, TextFormatFlags.HorizontalCenter);
            return card;
        }

        var clip = new RectangleF(card.Left + 2, card.Top + HeaderHeight + 1.5f, card.Width - 4, Math.Max(0, card.Height - HeaderHeight - 3));
        var state = g!.Save();
        g.SetClip(clip);
        for (var i = 0; i < rows.Length; i++)
        {
            var rowY = card.Top + HeaderHeight + 2 + i * RowHeight - scroll.Offset;
            if (rowY + RowHeight < card.Top + HeaderHeight || rowY > card.Bottom) continue;

            var rowRect = new RectangleF(card.Left + 5, rowY + 1, contentRight - card.Left - 3, RowHeight - 2);
            if (mouse is { } pt && clip.Contains(pt) && !scroll.Dragging && rowRect.Contains(pt))
                FillRound(rowRect, DeckTheme.Mix(DeckTheme.Panel, DeckTheme.Border, 0.6f), 5);

            var row = rows[i];
            if (!string.IsNullOrEmpty(row.FullTip))
                rowTips.Add(new RowTip(RectangleF.Intersect(rowRect, clip), row.FullTip));
            var nameDrawW = nameW;
            if (row.Badge is { Length: > 0 } badge)
            {
                var badgeW = badge.Length * 6.5f + 12;
                nameDrawW = Math.Max(60, nameW - badgeW - 6);
                var badgeRect = new RectangleF(colName + nameDrawW + 4, rowY + (RowHeight - 16) / 2, badgeW, 16);
                FillRound(badgeRect, DeckTheme.Mix(DeckTheme.Panel, row.BadgeColor, 0.22f), 4);
                Draw(badge, DeckTheme.Label, row.BadgeColor, badgeRect.X, badgeRect.Y, badgeRect.Width, badgeRect.Height, TextFormatFlags.HorizontalCenter);
            }

            Draw(row.Name, DeckTheme.Caption, row.Passive ? DeckTheme.Muted : DeckTheme.Text, colName, rowY, nameDrawW, RowHeight);
            Draw(row.Pid, Mono, DeckTheme.Muted, colPid, rowY, pidW, RowHeight, TextFormatFlags.Right);
            Draw(row.Detail, DeckTheme.Small, row.Badge == "WRITE" ? DeckTheme.Warning : DeckTheme.Muted, colDetail, rowY, detailW, RowHeight);
            Draw(row.Read > 0 ? Format.Rate(row.Read) : "—", Mono, row.Read > 0 ? DeckTheme.Accent : DeckTheme.Muted, colRead, rowY, colReadW, RowHeight, TextFormatFlags.Right);
            Draw(row.Write > 0 ? Format.Rate(row.Write) : "—", Mono, row.Write > 0 ? DeckTheme.Warning : DeckTheme.Muted, colWrite, rowY, colWriteW, RowHeight, TextFormatFlags.Right);
        }
        g.Restore(state);
        scroll.Paint(g);
        return card;
    }

    private DisplayRow[] BuildNasRows(Snapshot? snapshot)
    {
        if (snapshot is null || nasUnsupported) return [];
        var rows = new List<DisplayRow>();
        var openFiles = nasActivity?.OpenFiles ?? snapshot.OpenFiles;
        var filteredFiles = FilterOpenFiles(snapshot, openFiles);

        if (nasActivity is not null)
        {
            foreach (var proc in nasActivity.Processes)
            {
                if (filterDiskNumber is { } num && nasActivity.PerDisk && !proc.Disks.Contains(num)) continue;
                var diskText = proc.Disks.Length > 0
                    ? string.Join(", ", proc.Disks.Select(d => DiskLabel(snapshot, d)))
                    : nasActivity.PerDisk ? "—" : "All I/O";
                if (proc.Pid == 4 && filteredFiles.Length > 0)
                {
                    var sample = ShortPath(filteredFiles[0].Path);
                    diskText = $"{diskText}  ·  SMB: {sample}" + (filteredFiles.Length > 1 ? $" (+{filteredFiles.Length - 1})" : "");
                }
                var isSystemSmb = proc.Pid == 4 && filteredFiles.Length > 0;
                var fullTip = isSystemSmb ? string.Join(Environment.NewLine, filteredFiles.Take(6).Select(f => f.Path)) : null;
                rows.Add(new DisplayRow(proc.Name, proc.Pid.ToString(), isSystemSmb ? "SMB" : null, DeckTheme.Accent,
                    diskText, proc.ReadBytesPerSec, proc.WriteBytesPerSec, Passive: false, fullTip));
            }
        }

        // Also surface open SMB files directly so files holding a disk awake are always visible.
        foreach (var file in filteredFiles.OrderByDescending(f => f.Writing).Take(10))
        {
            var label = string.IsNullOrWhiteSpace(file.User) ? "SMB handle" : $"SMB · {file.User}";
            rows.Add(new DisplayRow(
                label,
                "—",
                file.Writing ? "WRITE" : "OPEN",
                file.Writing ? DeckTheme.Warning : DeckTheme.Muted,
                ShortPath(file.Path),
                0, 0,
                Passive: true,
                FullTip: file.Path));
        }

        return rows.ToArray();
    }

    private DisplayRow[] BuildLocalRows(Snapshot? snapshot)
    {
        var diskLetters = filterDiskNumber is { } num && snapshot is not null
            ? snapshot.Disks.FirstOrDefault(d => d.Number == num)?.Volumes.Select(v => v.Letter).ToHashSet(StringComparer.OrdinalIgnoreCase)
            : null;
        var shareToLetter = BuildShareToLetter(snapshot);

        var rows = new List<DisplayRow>();
        foreach (var proc in localActivity)
        {
            if (localNasOnly && !proc.TouchesNas) continue;

            var matchedTargets = proc.NasTargets;
            if (diskLetters is not null)
            {
                matchedTargets = proc.NasTargets
                    .Where(t => shareToLetter.TryGetValue(t.Share, out var letter) && diskLetters.Contains(letter))
                    .ToArray();
                if (matchedTargets.Length == 0) continue;
            }

            string detail;
            string? fullTip = null;
            if (matchedTargets.Length > 0)
            {
                var first = matchedTargets[0];
                var prefix = shareToLetter.TryGetValue(first.Share, out var letter) ? $"[{letter}] " : "";
                detail = prefix + ShortPath(first.Display) + (matchedTargets.Length > 1 ? $" (+{matchedTargets.Length - 1})" : "");
                fullTip = string.Join(Environment.NewLine, matchedTargets.Select(t => t.Display));
            }
            else
            {
                detail = "Local I/O";
            }

            rows.Add(new DisplayRow(proc.Name, proc.Pid.ToString(),
                matchedTargets.Length > 0 ? "NAS" : null, DeckTheme.Accent,
                detail, proc.ReadBytesPerSec, proc.WriteBytesPerSec, Passive: false, fullTip));
        }
        return rows.ToArray();
    }

    private SmbOpenFile[] FilterOpenFiles(Snapshot snapshot, SmbOpenFile[] files)
    {
        if (filterDiskNumber is not { } num) return files;
        var disk = snapshot.Disks.FirstOrDefault(d => d.Number == num);
        if (disk is null || disk.Volumes.Length == 0) return [];
        return files.Where(f => disk.Volumes.Any(v => f.Path.StartsWith(v.Letter, StringComparison.OrdinalIgnoreCase))).ToArray();
    }

    private static Dictionary<string, string> BuildShareToLetter(Snapshot? snapshot)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (snapshot is null) return map;
        foreach (var share in snapshot.Shares)
        {
            if (share.Path.Length >= 2 && share.Path[1] == ':')
                map[share.Name] = share.Path[..2].ToUpperInvariant();
        }
        foreach (var disk in snapshot.Disks)
        {
            foreach (var vol in disk.Volumes)
            {
                var letter = vol.Letter.TrimEnd(':');
                if (letter.Length == 1) map.TryAdd(letter + "$", vol.Letter.ToUpperInvariant());
            }
        }
        return map;
    }

    private static string DiskLabel(Snapshot snapshot, int number) =>
        snapshot.Disks.FirstOrDefault(d => d.Number == number) is { } disk ? DiskHealth.Letters(disk) : $"Disk {number}";

    private static string ShortRate(double bytesPerSec)
    {
        var parts = Format.Bytes(bytesPerSec).Split(' ');
        return parts.Length == 2 ? parts[0] + parts[1][..1] + "/s" : Format.Rate(bytesPerSec);
    }

    private static string ShortPath(string path) =>
        path.Length > 48 ? path[..15] + "…" + path[^32..] : path;

    private void DrawPillButton(RectangleF bounds, string label, bool active, Action click)
    {
        var hot = mouse is { } pt && bounds.Contains(pt);
        var fill = active ? DeckTheme.Accent : hot ? DeckTheme.Border : DeckTheme.Panel;
        FillRound(bounds, fill, 6);
        if (!active) StrokeRound(bounds, DeckTheme.Border, 6);
        Draw(label, DeckTheme.Small, active ? DeckTheme.Background : DeckTheme.Text, bounds.X, bounds.Y, bounds.Width, bounds.Height, TextFormatFlags.HorizontalCenter);
        targets.Add(new ClickTarget(bounds, click));
    }

    private void Draw(string text, Font font, Color color, float x, float top, float width, float height, TextFormatFlags align = TextFormatFlags.Left)
    {
        if (g is null || text.Length == 0 || width <= 0) return;
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

    private void StrokeRound(RectangleF bounds, Color color, float radius)
    {
        if (g is null) return;
        using var shape = DeckTheme.RoundedRectangle(bounds, radius);
        using var pen = new Pen(color, 1);
        g.DrawPath(pen, shape);
    }

    private void FillEllipse(RectangleF bounds, Color color)
    {
        if (g is null) return;
        using var brush = new SolidBrush(color);
        g.FillEllipse(brush, bounds);
    }
}
