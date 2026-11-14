using System.ComponentModel;
using System.Diagnostics;

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

    internal SettingsWindow(NasSettings settings, Action installAgent)
    {
        Settings = settings;
        this.installAgent = installAgent;
        Text = Caption;
        DeckTheme.Attach(this);
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(440, 462);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        BackColor = DeckTheme.Background;
        ForeColor = DeckTheme.Text;
        Font = DeckTheme.Body;
        host.Text = settings.Host;
        user.Text = settings.SshUser;
        sshPort.Text = settings.SshPort.ToString();
        mac.Text = settings.MacAddress;
        broadcast.Text = settings.BroadcastAddress;
        wakePort.Text = settings.WakePort.ToString();
        agentPort.Text = settings.AgentPort.ToString();

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(24, 20, 24, 20) };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 40));
        root.Controls.Add(new Label { Text = "Settings", AutoSize = true, Font = DeckTheme.Title, Margin = Padding.Empty }, 0, 0);

        var navigation = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty };
        var pages = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        var tabs = new List<(SurfaceButton Button, TableLayoutPanel Page)>();
        foreach (var title in (string[])["Connection", "Wake-on-LAN", "Agent"])
        {
            var button = new SurfaceButton { Text = title, Size = new Size(124, 36), Margin = new Padding(0, 0, 8, 0) };
            DeckTheme.StyleButton(button, tabs.Count == 0);
            var page = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, Padding = new Padding(0, 8, 0, 0), Margin = Padding.Empty };
            page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            button.Click += (_, _) =>
            {
                page.BringToFront();
                foreach (var tab in tabs)
                {
                    tab.Button.Primary = tab.Page == page;
                    tab.Button.Invalidate();
                }
            };
            navigation.Controls.Add(button);
            pages.Controls.Add(page);
            tabs.Add((button, page));
        }
        var (connectionPage, wakePage, agentPage) = (tabs[0].Page, tabs[1].Page, tabs[2].Page);
        root.Controls.Add(navigation, 0, 1);

        AddField(connectionPage, "NAS address", host);
        AddField(connectionPage, "SSH username", user);
        AddField(connectionPage, "SSH port", sshPort);
        var setupKey = new SurfaceButton { Text = "Save and set up SSH key…", Dock = DockStyle.Top, Height = 38, Font = DeckTheme.Caption, Margin = new Padding(0, 10, 0, 0) };
        DeckTheme.StyleButton(setupKey);
        connectionPage.Controls.Add(setupKey);

        AddField(wakePage, "MAC address", mac);
        AddField(wakePage, "Broadcast address", broadcast);
        AddField(wakePage, "Wake port", wakePort);
        wakePage.Controls.Add(Note("Update the broadcast address if the NAS changes subnet."));

        AddField(agentPage, "Agent port", agentPort);
        agentPage.Controls.Add(Note("The monitoring agent listens on this loopback port on the NAS, and an SSH tunnel brings it to the same port here. Reinstall the agent after changing it.", 64));
        var install = new SurfaceButton { Text = "Save and install or update the agent…", Dock = DockStyle.Top, Height = 38, Font = DeckTheme.Caption, Margin = new Padding(0, 10, 0, 0) };
        DeckTheme.StyleButton(install);
        agentPage.Controls.Add(install);

        connectionPage.BringToFront();
        root.Controls.Add(pages, 0, 2);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, Margin = Padding.Empty };
        var save = new SurfaceButton { Text = "Save changes", Size = new Size(126, 38), Margin = Padding.Empty };
        var cancel = new SurfaceButton { Text = "Cancel", Size = new Size(88, 38), DialogResult = DialogResult.Cancel, Margin = new Padding(0, 0, 8, 0) };
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

    private static Label Note(string text, int height = 45) => new()
    {
        Text = text, Dock = DockStyle.Top, Height = height, Font = DeckTheme.Caption, ForeColor = DeckTheme.Muted, Margin = new Padding(0, 10, 0, 0)
    };

    private static void AddField(TableLayoutPanel page, string title, TextBox field)
    {
        var row = page.RowCount++;
        page.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        var group = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        group.Controls.Add(new Label { Text = title, AutoSize = true, Font = DeckTheme.Caption, ForeColor = DeckTheme.Muted, Location = new Point(0, 0) });
        var frame = new Panel { BackColor = DeckTheme.Panel, Location = new Point(0, 24), Height = 36, Width = 400, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Padding = new Padding(10, 7, 10, 7) };
        field.Dock = DockStyle.Fill;
        field.AccessibleName = title;
        frame.Controls.Add(field);
        frame.Paint += (_, e) => { using var pen = new Pen(field.Focused ? DeckTheme.Accent : DeckTheme.Border); e.Graphics.DrawRectangle(pen, 0, 0, frame.Width - 1, frame.Height - 1); };
        field.GotFocus += (_, _) => frame.Invalidate();
        field.LostFocus += (_, _) => frame.Invalidate();
        group.Controls.Add(frame);
        group.Resize += (_, _) => frame.Width = group.ClientSize.Width;
        page.Controls.Add(group, 0, row);
    }

    private static TextBox CreateInput(int maxLength = 255) => new()
    {
        BackColor = DeckTheme.Panel, ForeColor = DeckTheme.Text, BorderStyle = BorderStyle.None,
        Margin = Padding.Empty, MaxLength = maxLength, Font = DeckTheme.Body
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
            AgentPort = agentPortNumber
        };
        try
        {
            edited.Save();
            Settings = edited;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or ArgumentException)
        {
            MessageBox.Show(this, error.Message, Caption, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        afterwards?.Invoke();
        DialogResult = DialogResult.OK;
    }
}
