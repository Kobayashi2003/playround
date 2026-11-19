using System.ComponentModel;
using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace NasDeck;

internal sealed class SettingsWindow : Form
{
    private const string Caption = "NAS Deck Settings";

    private readonly TextBox host = CreateInput();
    private readonly TextBox user = CreateInput();
    private readonly TextBox mac = CreateInput();
    private readonly TextBox broadcast = CreateInput();
    private readonly TextBox sshPort = CreateInput(maxLength: 5);
    private readonly TextBox wakePort = CreateInput(maxLength: 5);
    private readonly TextBox agentPort = CreateInput(maxLength: 5);
    private readonly Action installAgent;

    internal NasSettings Settings { get; private set; }
    internal bool ShowTrayIcon => showTrayIcon.Checked;

    private readonly ThemedCheckBox startMenuShortcut = CreateCardCheckBox("Show in Start menu");
    private readonly ThemedCheckBox startupShortcut = CreateCardCheckBox("Start when I sign in");
    private readonly ThemedCheckBox showTrayIcon = CreateCardCheckBox("Show system tray icon");
    private readonly ThemedCheckBox recycleEnabled = CreateCardCheckBox("Use NAS Recycle Bin in Explorer");
    private readonly ThemedCheckList shares = new()
    {
        Dock = DockStyle.Fill,
        Margin = new Padding(0, 4, 0, 0),
        AccessibleName = "Protected shares",
        EmptyText = "Connect the NAS to list its shares, then reopen Settings."
    };
    private readonly string? nasAlias;

    internal SettingsWindow(NasSettings settings, bool trayIconVisible, Action installAgent, IEnumerable<string> availableShares, string? nasAlias)
    {
        Settings = settings;
        this.nasAlias = nasAlias ?? settings.RecycleHostAlias;
        this.installAgent = installAgent;
        Text = Caption;
        DeckTheme.Attach(this);
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(548, 446);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        BackColor = DeckTheme.Background;
        ForeColor = DeckTheme.Text;
        Font = DeckTheme.Caption;
        host.Text = settings.Host;
        user.Text = settings.SshUser;
        sshPort.Text = settings.SshPort.ToString();
        mac.Text = settings.MacAddress;
        broadcast.Text = settings.BroadcastAddress;
        wakePort.Text = settings.WakePort.ToString();
        agentPort.Text = settings.AgentPort.ToString();
        startMenuShortcut.Checked = AppShortcuts.HasStartMenu;
        startupShortcut.Checked = AppShortcuts.HasStartup;
        showTrayIcon.Checked = trayIconVisible;

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(20, 16, 20, 16) };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 16));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));

        var tabTitles = (string[])["General", "Connection", "Wake-on-LAN", "Agent", "Recycle Bin"];
        var navigation = new SegmentedTabs(tabTitles) { Dock = DockStyle.Fill, Margin = Padding.Empty };
        var pages = new Panel { Dock = DockStyle.Fill, Margin = new Padding(0, 14, 0, 0) };
        var tabPages = new TableLayoutPanel[tabTitles.Length];
        for (var i = 0; i < tabTitles.Length; i++)
        {
            var page = new TableLayoutPanel
            {
                Dock = DockStyle.Fill, ColumnCount = 1,
                Padding = Padding.Empty, Margin = Padding.Empty
            };
            page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            pages.Controls.Add(page);
            tabPages[i] = page;
        }
        navigation.SelectedIndexChanged += (_, _) => tabPages[navigation.SelectedIndex].BringToFront();
        var (generalPage, connectionPage, wakePage, agentPage, recyclePage) = (tabPages[0], tabPages[1], tabPages[2], tabPages[3], tabPages[4]);
        root.Controls.Add(navigation, 0, 0);

        generalPage.RowCount = 4;
        generalPage.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        generalPage.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        generalPage.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
        generalPage.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        generalPage.Controls.Add(CreateToggleCard(startMenuShortcut, "Adds or removes the NAS Deck shortcut in the Windows Start menu."), 0, 0);
        generalPage.Controls.Add(CreateToggleCard(startupShortcut, "Launches NAS Deck automatically after you sign in to Windows."), 0, 1);
        generalPage.Controls.Add(CreateToggleCard(showTrayIcon, "Shows the status icon in the taskbar notification area. Needed to hide the widget to the tray."), 0, 2);

        AddField(connectionPage, "NAS address", host);
        AddField(connectionPage, "SSH username", user);
        AddField(connectionPage, "SSH port", sshPort);
        var setupKey = new SurfaceButton
        {
            Text = "Save and set up SSH key…", Dock = DockStyle.Top, Height = 34,
            Font = DeckTheme.Caption, Margin = new Padding(0, 8, 0, 0)
        };
        DeckTheme.StyleButton(setupKey);
        connectionPage.Controls.Add(setupKey);

        AddField(wakePage, "MAC address", mac);
        AddField(wakePage, "Broadcast address", broadcast);
        AddField(wakePage, "Wake port", wakePort);
        wakePage.Controls.Add(Note("Update the broadcast address if the NAS changes subnet.", 30));

        AddField(agentPage, "Agent port", agentPort);
        agentPage.Controls.Add(Note(
            "The monitoring agent listens on this loopback port on the NAS, and an SSH tunnel brings it to the same port here. Reinstall the agent after changing it.",
            50));
        var install = new SurfaceButton
        {
            Text = "Save and install or update the agent…", Dock = DockStyle.Top, Height = 34,
            Font = DeckTheme.Caption, Margin = new Padding(0, 8, 0, 0)
        };
        DeckTheme.StyleButton(install);
        agentPage.Controls.Add(install);

        recyclePage.RowCount = 3;
        recyclePage.RowStyles.Add(new RowStyle(SizeType.Absolute, 80));
        recyclePage.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        recyclePage.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        recycleEnabled.Checked = settings.RecycleEnabled;

        var available = availableShares.Concat(settings.RecycleShares)
            .Distinct(StringComparer.OrdinalIgnoreCase).Order().ToArray();
        shares.SetItems(available.Select(name =>
            (name, settings.RecycleShares.Contains(name, StringComparer.OrdinalIgnoreCase))));

        recyclePage.Controls.Add(CreateToggleCard(recycleEnabled, available.Length == 0
            ? "Connect the NAS to list its shares, then reopen Settings."
            : "Intercepts Delete and Ctrl+D on protected shares. Shift+Delete keeps Windows delete."), 0, 0);
        recyclePage.Controls.Add(CreateShareHeader(), 0, 1);
        recyclePage.Controls.Add(shares, 0, 2);

        generalPage.BringToFront();
        root.Controls.Add(pages, 0, 1);

        root.Controls.Add(DeckTheme.CreateDivider(), 0, 2);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false, Margin = Padding.Empty
        };
        var save = new SurfaceButton { Text = "Save changes", Size = new Size(112, 34), Font = DeckTheme.Strong, Margin = Padding.Empty };
        var cancel = new SurfaceButton { Text = "Cancel", Size = new Size(78, 34), Font = DeckTheme.Caption, DialogResult = DialogResult.Cancel, Margin = new Padding(0, 0, 8, 0) };
        DeckTheme.StyleButton(save, true);
        DeckTheme.StyleButton(cancel);
        actions.Controls.AddRange([save, cancel]);
        root.Controls.Add(actions, 0, 3);
        Controls.Add(root);
        AcceptButton = save;
        CancelButton = cancel;
        save.Click += (_, _) => SaveSettings(null);
        setupKey.Click += (_, _) => SaveSettings(RunKeySetup);
        install.Click += (_, _) => SaveSettings(this.installAgent);
    }

    private static ThemedCheckBox CreateCardCheckBox(string text) => new()
    {
        Text = text,
        Dock = DockStyle.Fill,
        BackColor = DeckTheme.Panel,
        Margin = Padding.Empty,
        AccessibleName = text
    };

    private static Control CreateToggleCard(ThemedCheckBox checkBox, string description)
    {
        var card = new Panel
        {
            Dock = DockStyle.Fill, BackColor = DeckTheme.Background,
            Padding = new Padding(12, 10, 12, 10), Margin = new Padding(0, 0, 0, 10)
        };
        card.Paint += (_, e) =>
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var scale = card.DeviceDpi / 96f;
            using var path = DeckTheme.RoundedRectangle(new RectangleF(0.5f, 0.5f, card.Width - 1.5f, card.Height - 1.5f), 7 * scale);
            using var fill = new SolidBrush(DeckTheme.Panel);
            e.Graphics.FillPath(fill, path);
            using var border = new Pen(DeckTheme.Border, 1);
            e.Graphics.DrawPath(border, path);
        };
        var inner = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2,
            BackColor = DeckTheme.Panel, Margin = Padding.Empty, Padding = Padding.Empty
        };
        inner.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        inner.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        inner.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        inner.Controls.Add(checkBox, 0, 0);
        inner.Controls.Add(new Label
        {
            Text = description, Dock = DockStyle.Fill, Font = DeckTheme.Small,
            ForeColor = DeckTheme.Muted, BackColor = DeckTheme.Panel,
            Margin = new Padding(24, 3, 0, 0), Padding = Padding.Empty
        }, 0, 1);
        card.Controls.Add(inner);
        return card;
    }

    private Control CreateShareHeader()
    {
        var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = new Padding(0, 2, 0, 2) };
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 84));
        var summary = new Label
        {
            Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = DeckTheme.Muted,
            Font = DeckTheme.Label, Margin = Padding.Empty
        };
        var toggle = new SurfaceButton { Dock = DockStyle.Fill, Font = DeckTheme.Small, Margin = new Padding(0, 2, 0, 2) };
        DeckTheme.StyleButton(toggle);
        header.Controls.Add(summary, 0, 0);
        header.Controls.Add(toggle, 1, 0);

        void UpdateHeader()
        {
            var total = shares.TotalCount;
            var selected = shares.CheckedCount;
            summary.Text = $"PROTECTED SHARES  ·  {selected} / {total}";
            toggle.Text = total > 0 && selected == total ? "Clear all" : "Select all";
            toggle.Enabled = shares.Enabled && total > 0;
        }

        shares.CheckedChanged += (_, _) => UpdateHeader();
        toggle.Click += (_, _) => shares.SetAllChecked(shares.CheckedCount < shares.TotalCount);
        recycleEnabled.CheckedChanged += (_, _) =>
        {
            shares.Enabled = recycleEnabled.Checked;
            UpdateHeader();
        };
        shares.Enabled = recycleEnabled.Checked;
        UpdateHeader();
        return header;
    }

    private static Label Note(string text, int height = 36, int topMargin = 6) => new()
    {
        Text = text, Dock = DockStyle.Top, Height = height, Font = DeckTheme.Small,
        ForeColor = DeckTheme.Muted, Margin = new Padding(0, topMargin, 0, 0)
    };

    private static void AddField(TableLayoutPanel page, string title, TextBox field)
    {
        var row = page.RowCount++;
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
        var group = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        group.Controls.Add(new Label
        {
            Text = title.ToUpperInvariant(), AutoSize = true, Font = DeckTheme.Label,
            ForeColor = DeckTheme.Muted, Location = new Point(0, 2)
        });
        var frame = new Panel
        {
            BackColor = DeckTheme.Background,
            Location = new Point(0, 20),
            Height = 34,
            Width = 400,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            Padding = new Padding(10, 7, 10, 7)
        };
        field.Dock = DockStyle.Fill;
        field.AccessibleName = title;
        frame.Controls.Add(field);
        frame.Paint += (_, e) =>
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var scale = frame.DeviceDpi / 96f;
            using var path = DeckTheme.RoundedRectangle(new RectangleF(0.5f, 0.5f, frame.Width - 1.5f, frame.Height - 1.5f), 7 * scale);
            using var fill = new SolidBrush(DeckTheme.Panel);
            e.Graphics.FillPath(fill, path);
            using var pen = new Pen(field.Focused ? DeckTheme.Accent : DeckTheme.Border, 1);
            e.Graphics.DrawPath(pen, path);
        };
        field.GotFocus += (_, _) => frame.Invalidate();
        field.LostFocus += (_, _) => frame.Invalidate();
        group.Controls.Add(frame);
        group.Resize += (_, _) => frame.Width = group.ClientSize.Width;
        page.Controls.Add(group, 0, row);
    }

    private static TextBox CreateInput(int maxLength = 255) => new()
    {
        BackColor = DeckTheme.Panel, ForeColor = DeckTheme.Text, BorderStyle = BorderStyle.None,
        Margin = Padding.Empty, MaxLength = maxLength, Font = DeckTheme.Caption
    };

    private void RunKeySetup()
    {
        try
        {
            var start = new ProcessStartInfo(NasController.PowerShellPath) { UseShellExecute = true };
            foreach (var argument in new[] { "-NoProfile", "-NoExit", "-File", Path.Combine(DeckPaths.ProjectDirectory, "Setup-SshKey.ps1") })
                start.ArgumentList.Add(argument);
            Process.Start(start)?.Dispose();
        }
        catch (Win32Exception error)
        {
            MessageBox.Show(this, error.Message, "Could not open SSH key setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void SaveSettings(Action? afterwards)
    {
        if (!int.TryParse(sshPort.Text, out var sshPortNumber) || !int.TryParse(wakePort.Text, out var wakePortNumber)
            || !int.TryParse(agentPort.Text, out var agentPortNumber))
        {
            MessageBox.Show(this, "Enter a number for each port.", Caption, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var edited = new NasSettings
        {
            Host = host.Text.Trim(), SshUser = user.Text.Trim(), SshPort = sshPortNumber,
            MacAddress = mac.Text.Trim().ToUpperInvariant(), BroadcastAddress = broadcast.Text.Trim(), WakePort = wakePortNumber,
            AgentPort = agentPortNumber,
            RecycleEnabled = recycleEnabled.Checked && host.Text.Trim().Equals(Settings.Host, StringComparison.OrdinalIgnoreCase),
            RecycleShares = host.Text.Trim().Equals(Settings.Host, StringComparison.OrdinalIgnoreCase)
                ? shares.CheckedItems : [],
            RecycleHostAlias = host.Text.Trim().Equals(Settings.Host, StringComparison.OrdinalIgnoreCase) ? nasAlias : null
        };
        try
        {
            edited.Save();
            AppShortcuts.SetStartMenu(startMenuShortcut.Checked);
            AppShortcuts.SetStartup(startupShortcut.Checked);
            Settings = edited;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or ArgumentException or System.Runtime.InteropServices.COMException)
        {
            MessageBox.Show(this, error.Message, Caption, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        afterwards?.Invoke();
        DialogResult = DialogResult.OK;
    }
}
