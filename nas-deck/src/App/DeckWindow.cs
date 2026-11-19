using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>
/// The desktop widget: a borderless panel that is dragged by its background, sits behind other windows
/// unless kept on top, and hides to the notification area. This part is the window itself; the commands and the
/// menus are in the other DeckWindow files.
/// </summary>
internal sealed partial class DeckWindow : Form
{
    private const string AppName = "NAS Deck";

    private readonly CancellationTokenSource lifetime = new();
    private readonly DeckModel model;
    private readonly DeckPainter painter;
    private readonly AgentLink link;
    private readonly Alerts alerts = new();
    private readonly NotifyIcon tray;
    private readonly DeckMenu mainMenu;
    private readonly DeckMenu popup;
    private readonly ToolTip tooltips = new() { InitialDelay = 500, ReshowDelay = 150 };
    private readonly System.Windows.Forms.Timer clock = new() { Interval = 1000 };
    private readonly Icon appIcon;
    private Func<IEnumerable<ToolStripItem>> popupItems = () => [];
    private OwnedIcon? trayIcon;
    private NasTone? trayTone;
    private WidgetState widget = WidgetState.Load();
    private PointF? mouse;
    private string? hoverId;
    private string? pressedId;
    private Point? dragFrom;
    private Point dragWindow;
    private bool dragging;
    private DiskInfoWindow? diskInfo;
    private DiskActivityWindow? diskActivity;
    private string? menuOwner;
    private string? closedBy;
    private DateTime menuClosedAt;
    private bool noticeShown;
    private DateTime deactivatedAt;
    private bool settingsInvalid;
    private bool settingsOpen;
    private bool busy;
    private bool polling;
    private bool exiting;

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    internal DeckWindow()
    {
        Text = AppName;
        appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Icon = appIcon;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        DoubleBuffered = true;
        KeyPreview = true;
        BackColor = DeckTheme.Background;
        TopMost = widget.AlwaysOnTop;
        Opacity = widget.OpacityPercent / 100.0;
        DeckTheme.Attach(this);

        NasSettings settings;
        try
        {
            settings = NasSettings.Load();
        }
        catch (Exception error) when (error is IOException or InvalidDataException or JsonException or UnauthorizedAccessException or ArgumentException)
        {
            settings = new NasSettings();
            settingsInvalid = true;
        }
        model = new DeckModel(settings) { Compact = widget.Compact, Pinned = widget.Pinned, DiskCharts = widget.DiskCharts };
        if (settingsInvalid) SetNotice("Open Settings to repair the configuration.");
        link = new AgentLink(settings);
        model.HasAgentToken = link.HasToken;

        painter = new DeckPainter(new DeckActions
        {
            Power = bounds =>
            {
                if (model.Online) ShowPopup("power", bounds, PowerItems);
                else _ = RunPowerAsync(null);
            },
            More = bounds =>
            {
                if (OpenedBy("more")) mainMenu!.Show(this, ToDevice(bounds.Left, bounds.Bottom + 2));
            },
            ToggleCompact = ToggleCompact,
            TogglePin = TogglePin,
            ToggleDisk = number =>
            {
                if (!model.Expanded.Remove(number)) model.Expanded.Add(number);
                RefreshView();
            },
            DiskPower = disk => _ = ChangeDiskPowerAsync(disk),
            DiskInfo = number => ShowDiskInfo(number),
            DiskActivity = number => ShowDiskActivity(number),
            Timer = bounds => ShowPopup("timer", bounds, TimerItems),
            Clients = bounds => ShowPopup("clients", bounds, ClientItems),
            WakeNas = () => _ = RunPowerAsync(null),
            InstallAgent = InstallAgent,
            OpenVolume = OpenVolume
        });

        mainMenu = new DeckMenu(MainItems);
        popup = new DeckMenu(() => popupItems());
        mainMenu.Closed += OnMenuClosed;
        popup.Closed += OnMenuClosed;
        tray = new NotifyIcon { Icon = appIcon, Text = AppName, ContextMenuStrip = mainMenu, Visible = widget.ShowTrayIcon };
        tray.MouseClick += (_, args) =>
        {
            if (args.Button == MouseButtons.Left) ToggleWidget();
        };
        tray.BalloonTipClicked += (_, _) => ShowWidget();

        clock.Tick += (_, _) =>
        {
            foreach (var expired in model.DiskActivity.Where(entry => entry.Value.Deadline < DateTime.UtcNow).Select(entry => entry.Key).ToArray())
                model.DiskActivity.Remove(expired);
            if (model.Activity is not null || model.NoticeVisible != noticeShown || model.DiskActivity.Count > 0) RefreshView();
        };
        clock.Start();
        DeckTheme.Changed += OnThemeChanged;
        SystemEvents.UserPreferenceChanged += OnPreferenceChanged;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;
        SystemEvents.SessionEnding += OnSessionEnding;
        wakePending = widget.FollowWake;
    }

    protected override CreateParams CreateParams
    {
        get
        {
            // A tool window stays out of Alt+Tab and the taskbar.
            var parameters = base.CreateParams;
            parameters.ExStyle |= 0x80;
            return parameters;
        }
    }

    private float DpiScale => DeviceDpi / 96f;

    private Point ToDevice(float x, float y) => new((int)(x * DpiScale), (int)(y * DpiScale));

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        var height = painter.Render(null, model, DpiScale, null, null);
        var size = new Size((int)Math.Round(DeckPainter.Width * DpiScale), (int)Math.Round(height * DpiScale));
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        var margin = DeckTheme.Scale(16, DeviceDpi);
        var location = new Point(area.Right - size.Width - margin, area.Bottom - size.Height - margin);
        if (widget is { Left: { } left, Top: { } top })
        {
            var saved = new Rectangle(left, top, size.Width, size.Height);
            if (Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(saved))) location = saved.Location;
        }
        else
        {
            widget = widget with { AnchorBottom = true };
        }
        Bounds = new Rectangle(location, size);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        ConfigureRecycle();
        RefreshView();
        if (!TopMost) SendToBottom();
        _ = RunAsync();
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        deactivatedAt = DateTime.UtcNow;
        if (!TopMost && Visible) SendToBottom();
    }

    private void SendToBottom() => SetWindowPos(Handle, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        Post(RefreshView);
    }

    private void OnPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) => Post(DeckTheme.Refresh);

    private void OnThemeChanged()
    {
        trayTone = null;
        BackColor = DeckTheme.Background;
        RefreshView();
    }

    internal void Post(Action action)
    {
        if (IsDisposed) return;
        try { BeginInvoke(action); }
        catch (InvalidOperationException) { }
    }

    internal void ShowWidget()
    {
        Show();
        Activate();
        if (!busy) _ = PollAsync();
    }

    private void ToggleWidget()
    {
        // Clicking the tray icon takes focus away first, so "was active a moment ago" stands in for "is active".
        if (Visible && (ActiveForm == this || DateTime.UtcNow - deactivatedAt < TimeSpan.FromMilliseconds(400))) Hide();
        else ShowWidget();
    }

    internal void ExitDeck()
    {
        exiting = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!exiting && e.CloseReason == CloseReason.UserClosing && widget.ShowTrayIcon)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        // Windows may close this window before it raises SessionEnding, and the tunnel the notice needs
        // goes down below, so a shutdown is announced here first.
        if (e.CloseReason == CloseReason.WindowsShutDown) AnnounceShutdown();
        lifetime.Cancel();
        clock.Stop();
        diskInfo?.Close();
        diskActivity?.Close();
        recycleWindow?.Close();
        tray.Visible = false;
        link.StopTunnel();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            DeckTheme.Changed -= OnThemeChanged;
            SystemEvents.UserPreferenceChanged -= OnPreferenceChanged;
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
            SystemEvents.SessionEnding -= OnSessionEnding;
            shortcuts?.Dispose();
            tray.Dispose();
            trayIcon?.Dispose();
            mainMenu.Dispose();
            popup.Dispose();
            tooltips.Dispose();
            clock.Dispose();
            link.Dispose();
            lifetime.Dispose();
        }
        base.Dispose(disposing);
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.Escape:
                if (widget.ShowTrayIcon) Hide();
                return true;
            case Keys.F5:
                _ = PollAsync();
                return true;
            case Keys.Shift | Keys.F10 or Keys.Apps:
                mainMenu.Show(this, ToDevice(24, 48));
                return true;
            case Keys.Control | Keys.Oemcomma:
                _ = EditSettingsAsync();
                return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    // ---- drawing and pointer ----

    protected override void OnPaint(PaintEventArgs e) => painter.Render(e.Graphics, model, DpiScale, mouse, pressedId);

    protected override void OnPaintBackground(PaintEventArgs e) { }

    /// <summary>Resizes the window to its content, redraws it, and brings the tray icon up to date.</summary>
    private void RefreshView()
    {
        if (IsDisposed || !IsHandleCreated) return;
        noticeShown = model.NoticeVisible;
        var height = painter.Render(null, model, DpiScale, null, null);
        var size = new Size((int)Math.Round(DeckPainter.Width * DpiScale), (int)Math.Round(height * DpiScale));
        if (size != Size)
            SetBounds(Left, widget.AnchorBottom ? Bottom - size.Height : Top, size.Width, size.Height);
        Invalidate();
        UpdateTray();
    }

    private Hit? HitAt(PointF point, bool clickable) =>
        painter.Hits.LastOrDefault(hit => hit.Bounds.Contains(point) && (!clickable || hit.Clickable));

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (dragFrom is { } origin)
        {
            var now = Cursor.Position;
            if (!dragging && Math.Abs(now.X - origin.X) + Math.Abs(now.Y - origin.Y) < 5) return;
            dragging = true;
            Location = Snap(new Point(dragWindow.X + now.X - origin.X, dragWindow.Y + now.Y - origin.Y), now);
            return;
        }
        mouse = new PointF(e.X / DpiScale, e.Y / DpiScale);
        var hit = HitAt(mouse.Value, clickable: false);
        Cursor = HitAt(mouse.Value, clickable: true) is not null ? Cursors.Hand : Cursors.Default;
        if (hit?.Id != hoverId)
        {
            hoverId = hit?.Id;
            tooltips.SetToolTip(this, hit?.Tip);
        }
        Invalidate();
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        base.OnMouseLeave(e);
        mouse = null;
        hoverId = null;
        tooltips.SetToolTip(this, null);
        Invalidate();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button != MouseButtons.Left) return;
        var point = new PointF(e.X / DpiScale, e.Y / DpiScale);
        if (HitAt(point, clickable: true) is { } hit)
        {
            pressedId = hit.Id;
            Invalidate();
            return;
        }
        if (model.Pinned) return;
        dragFrom = Cursor.Position;
        dragWindow = Location;
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button == MouseButtons.Right)
        {
            mainMenu.Show(this, e.Location);
            return;
        }
        if (e.Button != MouseButtons.Left) return;
        if (dragFrom is not null)
        {
            dragFrom = null;
            if (dragging) EndDrag();
            dragging = false;
            return;
        }
        var pressed = pressedId;
        pressedId = null;
        Invalidate();
        if (pressed is not null && HitAt(new PointF(e.X / DpiScale, e.Y / DpiScale), clickable: true) is { } hit && hit.Id == pressed)
            hit.Click(hit.Bounds);
    }

    protected override void OnMouseDoubleClick(MouseEventArgs e)
    {
        base.OnMouseDoubleClick(e);
        if (e.Button == MouseButtons.Left && model.Live && HitAt(new PointF(e.X / DpiScale, e.Y / DpiScale), clickable: true) is null)
            ToggleCompact();
    }

    /// <summary>
    /// Where a drag puts the widget: within reach of an edge of the screen under the pointer it jumps to a small
    /// margin from that edge, and it never leaves the screen. Applied while dragging, so the pull is felt.
    /// </summary>
    private Point Snap(Point wanted, Point pointer)
    {
        var area = Screen.FromPoint(pointer).WorkingArea;
        var margin = DeckTheme.Scale(12, DeviceDpi);
        var reach = DeckTheme.Scale(28, DeviceDpi);
        var (left, top) = (wanted.X, wanted.Y);
        if (Math.Abs(left - area.Left - margin) < reach) left = area.Left + margin;
        if (Math.Abs(area.Right - margin - (left + Width)) < reach) left = area.Right - Width - margin;
        if (Math.Abs(top - area.Top - margin) < reach) top = area.Top + margin;
        if (Math.Abs(area.Bottom - margin - (top + Height)) < reach) top = area.Bottom - Height - margin;
        left = Math.Clamp(left, area.Left, Math.Max(area.Left, area.Right - Width));
        top = Math.Clamp(top, area.Top, Math.Max(area.Top, area.Bottom - Height));
        return new Point(left, top);
    }

    private void EndDrag()
    {
        var area = Screen.FromControl(this).WorkingArea;
        SaveWidget(widget with { Left = Left, Top = Top, AnchorBottom = Top + Height / 2 > area.Top + area.Height / 2 });
    }

    private void TogglePin()
    {
        model.Pinned = !model.Pinned;
        SaveWidget(widget with { Pinned = model.Pinned });
        RefreshView();
    }

    private void SaveWidget(WidgetState next)
    {
        widget = next;
        widget.Save();
    }

    private void ToggleCompact()
    {
        model.Compact = !model.Compact;
        SaveWidget(widget with { Compact = model.Compact, Left = Left, Top = Top });
        RefreshView();
        SaveWidget(widget with { Left = Left, Top = Top });
    }

    // ---- tray and notices ----

    private void UpdateTray()
    {
        var tone = settingsInvalid ? NasTone.Attention : model.Tone;
        var lines = $"{AppName} · {model.StatusText}";
        if (model.Snapshot is { } snapshot)
        {
            var hardDisks = snapshot.Disks.Where(disk => disk.Rotational).ToArray();
            lines += $"\nCPU {snapshot.System.CpuPercent:0}%" + (snapshot.System.CpuTempC is { } degrees ? $" {degrees:0} °C" : "")
                + $" · {hardDisks.Count(disk => disk.Power == DiskPower.Standby)}/{hardDisks.Length} disks asleep";
        }
        tray.Text = lines.Length > 127 ? lines[..127] : lines;
        if (trayTone == tone) return;
        trayTone = tone;
        var next = DeckIcons.CreateTrayIcon(appIcon, tone, SystemInformation.SmallIconSize.Width);
        tray.Icon = next.Icon;
        trayIcon?.Dispose();
        trayIcon = next;
    }

    private void SetNotice(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        model.Notice = text.Split('\n')[0].Trim();
        model.NoticeAt = DateTime.UtcNow;
    }

    private void Notify(string text, ToolTipIcon icon = ToolTipIcon.None, bool always = false)
    {
        if (string.IsNullOrWhiteSpace(text) || !tray.Visible || (!always && Visible)) return;
        tray.ShowBalloonTip(5000, AppName, text.Length > 200 ? text[..197] + "…" : text, icon);
    }

    private bool Confirm(string text) => ThemedDialog.Confirm(this, AppName, text);
}
