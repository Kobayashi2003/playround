using NasDeck.Protocol;

namespace NasDeck;

/// <summary>The widget's menus, built afresh each time one opens.</summary>
internal sealed partial class DeckWindow
{
    private static readonly int[] TimerMinutes = [10, 20, 30, 60, 120, 180];
    private static readonly int[] HibernateMinutes = [30, 60, 120, 240];

    /// <summary>
    /// Records which button a menu is opening from and says whether to open it. Pressing that button while its
    /// menu is open closes the menu on the press, and the click that follows must not open it again.
    /// </summary>
    private bool OpenedBy(string button)
    {
        if (closedBy == button && DateTime.UtcNow - menuClosedAt < TimeSpan.FromMilliseconds(400))
        {
            closedBy = null;
            return false;
        }
        menuOwner = button;
        return true;
    }

    private void OnMenuClosed(object? sender, ToolStripDropDownClosedEventArgs e)
    {
        closedBy = e.CloseReason == ToolStripDropDownCloseReason.AppClicked ? menuOwner : null;
        menuClosedAt = DateTime.UtcNow;
        menuOwner = null;
    }

    private void ShowPopup(string button, RectangleF anchor, Func<IEnumerable<ToolStripItem>> items)
    {
        if (!OpenedBy(button)) return;
        popupItems = items;
        popup.Show(this, ToDevice(anchor.Left, anchor.Bottom + 2));
    }

    private IEnumerable<ToolStripItem> PowerItems()
    {
        var canPower = !busy && !settingsInvalid && model.Ports is { Ssh: true };
        yield return DeckMenu.Item("Hibernate", DeckGlyph.Power, () => RequestPower(PowerAction.Hibernate), canPower);
        yield return DeckMenu.Item("Restart…", DeckGlyph.Refresh, () => RequestPower(PowerAction.Restart), canPower);
        yield return DeckMenu.Item("Shut down…", DeckGlyph.Exit, () => RequestPower(PowerAction.Shutdown), canPower);
    }

    private IEnumerable<ToolStripItem> TimerItems()
    {
        if (model.Snapshot is not { } snapshot) yield break;
        var current = snapshot.Policy.DiskIdleSeconds;
        var listed = false;
        foreach (var minutes in TimerMinutes)
        {
            var seconds = minutes * 60;
            listed |= current == seconds;
            yield return DeckMenu.Item(Format.Timeout(seconds), null,
                () => _ = SetPolicyAsync(snapshot.Policy with { DiskIdleSeconds = seconds }), isChecked: current == seconds);
        }
        if (current > 0 && !listed)
            yield return DeckMenu.Item(Format.Timeout(current), null, () => { }, isChecked: true);
        yield return DeckMenu.Item("Never", null, () => _ = SetPolicyAsync(snapshot.Policy with { DiskIdleSeconds = 0 }), isChecked: current == 0);
    }

    private IEnumerable<ToolStripItem> HibernateItems()
    {
        if (model.Snapshot is not { } snapshot) yield break;
        var current = snapshot.Policy.AutoHibernateMinutes;
        foreach (var minutes in HibernateMinutes)
            yield return DeckMenu.Item(Format.Timeout(minutes * 60), null,
                () => _ = SetPolicyAsync(snapshot.Policy with { AutoHibernateMinutes = minutes }), isChecked: current == minutes);
        if (current > 0 && !HibernateMinutes.Contains(current))
            yield return DeckMenu.Item(Format.Timeout(current * 60), null, () => { }, isChecked: true);
        yield return DeckMenu.Item("Off", null, () => _ = SetPolicyAsync(snapshot.Policy with { AutoHibernateMinutes = 0 }), isChecked: current == 0);
    }

    private IEnumerable<ToolStripItem> ClientItems()
    {
        if (model.Snapshot is not { } snapshot) yield break;
        foreach (var session in snapshot.Sessions)
        {
            var client = session.Client.Length > 26 ? session.Client[..23] + "…" : session.Client;
            yield return DeckMenu.Label($"{client} · {session.User} · idle {Format.Duration(session.IdleSeconds)}", DeckTheme.Text, strong: true);
        }
        if (snapshot.OpenFiles.Length > 0)
        {
            yield return DeckMenu.Separator();
            foreach (var file in snapshot.OpenFiles.OrderByDescending(file => file.Writing).Take(12))
            {
                var path = file.Path.Length > 44 ? file.Path[..14] + "…" + file.Path[^29..] : file.Path;
                yield return DeckMenu.Label((file.Writing ? "W · " : "") + path, file.Writing ? DeckTheme.Warning : DeckTheme.Muted);
            }
            if (snapshot.OpenFiles.Length > 12) yield return DeckMenu.Label($"and {snapshot.OpenFiles.Length - 12} more");
        }
        yield return DeckMenu.Separator();
        yield return DeckMenu.Item("Disk activity…", DeckGlyph.Activity, () => ShowDiskActivity(null));
    }

    private IEnumerable<ToolStripItem> MainItems()
    {
        var live = model.Live;
        var online = model.Online;
        var canCommand = !busy && !settingsInvalid;
        yield return DeckMenu.Label(model.StatusText, DeckTheme.ToneColor(model.Tone), strong: true);
        yield return DeckMenu.Label(model.Settings.Host);
        yield return DeckMenu.Separator();

        if (online)
            foreach (var item in PowerItems()) yield return item;
        else
            yield return DeckMenu.Item("Wake NAS", DeckGlyph.Power, () => _ = RunPowerAsync(null), canCommand);

        if (live)
        {
            yield return DeckMenu.Separator();
            yield return DeckMenu.Item("Put all disks to sleep", DeckGlyph.Moon, () => _ = SleepAllAsync());
            yield return DeckMenu.Sub("Disk sleep timer", DeckGlyph.Timer, TimerItems());
            yield return DeckMenu.Sub("Hibernate when idle", DeckGlyph.Power, HibernateItems());
            yield return DeckMenu.Item("Disk information…", DeckGlyph.Info, () => ShowDiskInfo(null));
            yield return DeckMenu.Item("Disk activity…", DeckGlyph.Activity, () => ShowDiskActivity(null));
        }
        else
        {
            yield return DeckMenu.Separator();
            yield return DeckMenu.Item("Disk activity…", DeckGlyph.Activity, () => ShowDiskActivity(null));
        }
        if (online)
        {
            if (!live) yield return DeckMenu.Separator();
            var shares = model.Snapshot?.Shares ?? [];
            if (shares.Length > 0)
                yield return DeckMenu.Sub("Open share", DeckGlyph.Folder,
                    shares.Select(share => DeckMenu.Item($"{share.Name}", null, () => OpenShare(share.Name), hint: share.Path)));
            else
                yield return DeckMenu.Item("Open in Explorer", DeckGlyph.Folder, () => Launch("explorer.exe", $@"\\{model.Settings.Host}"));
            yield return DeckMenu.Item("Remote Desktop", DeckGlyph.Screen, () => Launch("mstsc.exe", $"/v:{model.Settings.Host}"));
        }
        yield return DeckMenu.Item("NAS Recycle Bin…", DeckGlyph.Folder, ShowRecycleBin);
        if (undoRecycle.Length > 0)
            yield return DeckMenu.Item("Undo last recycle", null, () => _ = ChangeRecycledAsync(undoRecycle, false), !recycleBusy);
        yield return DeckMenu.Sub("Follow this PC", DeckGlyph.Power, FollowItems());

        yield return DeckMenu.Separator();
        yield return DeckMenu.Item("Always on top", null, () =>
        {
            TopMost = !TopMost;
            SaveWidget(widget with { AlwaysOnTop = TopMost });
            if (!TopMost) SendToBottom();
        }, isChecked: TopMost);
        yield return DeckMenu.Item("Pin in place", null, TogglePin, isChecked: model.Pinned);
        if (live) yield return DeckMenu.Item("Compact", null, ToggleCompact, isChecked: model.Compact);
        yield return DeckMenu.Item("Disk activity charts", null, () =>
        {
            model.DiskCharts = !model.DiskCharts;
            SaveWidget(widget with { DiskCharts = model.DiskCharts });
            RefreshView();
        }, isChecked: model.DiskCharts);
        yield return DeckMenu.Sub("Opacity", null, new[] { 100, 90, 80, 70, 60 }.Select(percent =>
            DeckMenu.Item($"{percent}%", null, () =>
            {
                Opacity = percent / 100.0;
                SaveWidget(widget with { OpacityPercent = percent });
            }, isChecked: widget.OpacityPercent == percent)));
        if (widget.ShowTrayIcon || !Visible)
            yield return DeckMenu.Item(Visible ? "Hide widget" : "Show widget", null, () =>
            {
                if (Visible) Hide();
                else ShowWidget();
            });

        yield return DeckMenu.Separator();
        yield return DeckMenu.Item("Refresh", DeckGlyph.Refresh, () => _ = PollAsync(), canCommand, hint: "F5");
        yield return DeckMenu.Item("Settings…", DeckGlyph.Settings, () => _ = EditSettingsAsync(), !busy);
        yield return DeckMenu.Separator();
        yield return DeckMenu.Item("Exit", DeckGlyph.Exit, ExitDeck);
    }
}
