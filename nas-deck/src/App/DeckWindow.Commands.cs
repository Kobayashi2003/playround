using System.ComponentModel;
using System.Diagnostics;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>What the widget does: polling the NAS, power and disk commands, settings.</summary>
internal sealed partial class DeckWindow
{
    private async Task RunAsync()
    {
        var token = lifetime.Token;
        while (!token.IsCancellationRequested)
        {
            await PollAsync();
            try { await Task.Delay(model.Online ? 2000 : 5000, token); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>Reads the agent when it answers; otherwise checks whether the NAS is up and opens the tunnel.</summary>
    private async Task PollAsync()
    {
        if (busy || polling || settingsInvalid || settingsOpen || exiting) return;
        polling = true;
        try
        {
            var token = lifetime.Token;
            var snapshot = await link.GetSnapshotAsync(token);
            if (busy) return;
            if (snapshot is not null)
            {
                Accept(snapshot);
            }
            else if (model.Snapshot is null || DateTime.UtcNow - model.SnapshotAt > TimeSpan.FromSeconds(7))
            {
                // One missed reading is a hiccup; several mean the agent or the NAS went away.
                model.Snapshot = null;
                var ports = await NasController.ProbeAsync(model.Settings, token);
                if (busy) return;
                model.Ports = ports;
                model.CheckedAt = DateTime.Now;
                if (ports.Ssh && File.Exists(DeckPaths.KeyPath)) link.EnsureTunnel();
                else link.StopTunnel();
            }
            model.HasAgentToken = link.HasToken;
            model.AgentProblem = link.TunnelError;
            RefreshView();
        }
        catch (OperationCanceledException) { }
        finally { polling = false; }
    }

    private void Accept(Snapshot snapshot)
    {
        var isNew = model.Snapshot?.At != snapshot.At;
        model.Snapshot = snapshot;
        model.SnapshotAt = DateTime.UtcNow;
        model.Ports = new NasStatus(true, true);
        model.CheckedAt = DateTime.Now;
        if (isNew)
        {
            model.Cpu.Add(snapshot.System.CpuPercent);
            model.Rx.Add(snapshot.System.NetRxBytesPerSec);
            foreach (var disk in snapshot.Disks)
            {
                if (!model.DiskIo.TryGetValue(disk.Serial, out var io)) model.DiskIo[disk.Serial] = io = (new Series(90), new Series(90));
                io.Read.Add(disk.ReadBytesPerSec);
                io.Write.Add(disk.WriteBytesPerSec);
            }
        }
        foreach (var disk in snapshot.Disks)
            if (model.DiskActivity.TryGetValue(disk.Number, out var pending) && disk.Power == pending.Expected)
                model.DiskActivity.Remove(disk.Number);
        foreach (var message in alerts.Evaluate(snapshot))
            Notify(message, ToolTipIcon.Warning, always: true);
    }

    // ---- power ----

    private void RequestPower(PowerAction action)
    {
        var snapshot = model.Snapshot;
        var writing = snapshot?.OpenFiles.Count(file => file.Writing) ?? 0;
        var active = snapshot?.Disks.Any(disk => disk.Rotational && disk.ReadBytesPerSec + disk.WriteBytesPerSec > 1024 * 1024) ?? false;
        var verb = action switch { PowerAction.Hibernate => "Hibernate", PowerAction.Restart => "Restart", _ => "Shut down" };
        var concerns = new List<string>();
        if (writing > 0) concerns.Add($"{writing} file{(writing == 1 ? " is" : "s are")} open for writing over the network.");
        if (active) concerns.Add("A disk is being read or written right now.");
        if (action == PowerAction.Shutdown) concerns.Add("After a full shutdown, Wake-on-LAN may not be able to start the NAS again.");
        if (concerns.Count > 0 || action != PowerAction.Hibernate)
        {
            if (!Confirm(string.Join("\n", concerns) + (concerns.Count > 0 ? "\n\n" : "") + $"{verb} the NAS?")) return;
        }
        _ = RunPowerAsync(action);
    }

    /// <summary>Wakes the NAS (null) or sends it a power command, then watches until the result shows.</summary>
    private async Task RunPowerAsync(PowerAction? action)
    {
        if (busy || exiting) return;
        if (settingsInvalid)
        {
            _ = EditSettingsAsync();
            return;
        }
        var wake = action is null;
        var token = lifetime.Token;
        busy = true;
        model.Activity = action switch
        {
            null => "Waking…", PowerAction.Hibernate => "Hibernating…", PowerAction.Restart => "Restarting…", _ => "Shutting down…"
        };
        model.ActivityStarted = DateTime.UtcNow;
        RefreshView();
        var message = "";
        var icon = ToolTipIcon.Info;
        try
        {
            if (wake)
            {
                await NasController.WakeAsync(model.Settings, token);
            }
            else
            {
                if (!File.Exists(DeckPaths.KeyPath))
                    throw new InvalidOperationException("Open Settings and set up the SSH key first.");
                link.StopTunnel();
                await NasController.PowerAsync(model.Settings, action!.Value, token);
                model.Snapshot = null;
            }

            var timer = Stopwatch.StartNew();
            var limit = wake ? TimeSpan.FromSeconds(90) : TimeSpan.FromSeconds(40);
            var offlineChecks = 0;
            do
            {
                await Task.Delay(wake ? 1500 : 800, token);
                var ports = await NasController.ProbeAsync(model.Settings, token);
                model.Ports = ports;
                model.CheckedAt = DateTime.Now;
                offlineChecks = ports.IsOnline ? 0 : offlineChecks + 1;
                if (wake ? ports.IsReady : offlineChecks == 2)
                {
                    message = wake ? "The NAS is online." : action == PowerAction.Restart ? "The NAS is restarting." : "The NAS went offline.";
                    return;
                }
                RefreshView();
            } while (timer.Elapsed < limit);

            message = wake ? "Wake unconfirmed. Check the NAS." : "The NAS still responds; the command may not have run.";
            icon = ToolTipIcon.Warning;
        }
        catch (OperationCanceledException) when (exiting) { }
        catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException or Win32Exception)
        {
            message = error.Message;
            icon = ToolTipIcon.Warning;
            if (message.Length > 150 && Visible)
            {
                MessageBox.Show(this, message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                message = "The command failed. Check the NAS and try again.";
            }
        }
        finally
        {
            busy = false;
            model.Activity = null;
            if (!exiting)
            {
                SetNotice(message);
                Notify(message, icon);
                RefreshView();
                _ = PollAsync();
            }
        }
    }

    // ---- disks ----

    private async Task ChangeDiskPowerAsync(DiskInfo disk)
    {
        if (model.DiskActivity.ContainsKey(disk.Number)) return;
        var token = lifetime.Token;
        var asleep = disk.Power == DiskPower.Standby;
        var letters = DiskHealth.Letters(disk);
        model.DiskActivity[disk.Number] = (asleep ? "waking…" : "stopping…", asleep ? DiskPower.Spinning : DiskPower.Standby, DateTime.UtcNow.AddSeconds(30));
        RefreshView();
        try
        {
            var reply = asleep
                ? await link.WakeDiskAsync(disk.Number, token)
                : await link.SleepDiskAsync(disk.Number, force: false, token);
            if (!reply.Ok && reply.Code is "busy" or "cooldown")
            {
                if (Confirm($"{reply.Message}\n\nPut {letters} to sleep anyway?"))
                    reply = await link.SleepDiskAsync(disk.Number, force: true, token);
                else
                    reply = new ActionReply(true, "cancelled", "");
            }
            if (!reply.Ok || reply.Code is "cancelled" or "asleep") model.DiskActivity.Remove(disk.Number);
            if (!reply.Ok) SetNotice($"{letters} {reply.Message}");
        }
        catch (OperationCanceledException) { }
        if (!exiting) RefreshView();
    }

    private async Task SleepAllAsync()
    {
        try
        {
            var reply = await link.SleepAllAsync(lifetime.Token);
            SetNotice(reply.Message);
            RefreshView();
        }
        catch (OperationCanceledException) { }
    }

    private async Task SetPolicyAsync(PowerPolicy policy)
    {
        if (policy.DiskIdleSeconds is > 0 and < 1200
            && !Confirm($"With a {Format.Timeout(policy.DiskIdleSeconds)} timer the disks stop and start more often, and spin-ups are what wears them.\n\nUse it anyway?"))
            return;
        try
        {
            var reply = await link.SetPolicyAsync(policy, lifetime.Token);
            SetNotice(reply.Ok ? null : reply.Message);
            await PollAsync();
            RefreshView();
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>Opens the disk information panel on a disk, or brings the open one forward.</summary>
    private void ShowDiskInfo(int? number)
    {
        if (!model.Live) return;
        if (diskInfo is null or { IsDisposed: true })
        {
            diskInfo = new DiskInfoWindow(link, () => model.Disks.ToList(), number);
            diskInfo.Show();
            return;
        }
        if (number is not null) diskInfo.Select(number);
        diskInfo.Activate();
    }

    private void OpenVolume(string letter)
    {
        var root = letter + @"\";
        var shares = model.Snapshot?.Shares ?? [];
        var share = shares.FirstOrDefault(candidate => candidate.Path.Equals(root, StringComparison.OrdinalIgnoreCase))
            ?? shares.FirstOrDefault(candidate => candidate.Path.StartsWith(root, StringComparison.OrdinalIgnoreCase));
        // Every volume also has an administrative share, which needs an administrator's credentials.
        OpenShare(share?.Name ?? letter.TrimEnd(':') + "$");
    }

    private void OpenShare(string name) => Launch("explorer.exe", $@"\\{model.Settings.Host}\{name}");

    private void Launch(string program, params string[] arguments)
    {
        try
        {
            var start = new ProcessStartInfo(program) { UseShellExecute = false };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            Process.Start(start)?.Dispose();
        }
        catch (Win32Exception error)
        {
            SetNotice(error.Message);
            RefreshView();
        }
    }

    private void InstallAgent()
    {
        try
        {
            var start = new ProcessStartInfo(NasController.PowerShellPath) { UseShellExecute = true, WorkingDirectory = DeckPaths.ProjectDirectory };
            foreach (var argument in (string[])["-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", Path.Combine(DeckPaths.ProjectDirectory, "Install-Agent.ps1")])
                start.ArgumentList.Add(argument);
            Process.Start(start)?.Dispose();
        }
        catch (Win32Exception error)
        {
            MessageBox.Show(this, error.Message, "Could not open the agent installer", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task EditSettingsAsync()
    {
        if (settingsOpen || busy) return;
        using var dialog = new SettingsWindow(model.Settings, InstallAgent);
        settingsOpen = true;
        DialogResult result;
        try { result = dialog.ShowDialog(this); }
        finally { settingsOpen = false; }
        if (result != DialogResult.OK) return;
        model.Settings = dialog.Settings;
        settingsInvalid = false;
        model.Snapshot = null;
        model.Ports = null;
        model.CheckedAt = null;
        model.Cpu.Clear();
        model.Rx.Clear();
        model.DiskIo.Clear();
        link.Configure(model.Settings);
        RefreshView();
        await PollAsync();
    }
}
