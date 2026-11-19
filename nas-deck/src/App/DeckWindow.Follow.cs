using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>
/// Following this PC: the NAS is woken when the PC starts or resumes, and told when the PC sleeps or shuts down.
/// The agent then waits a grace period and checks that nobody else is using the NAS before following, so a
/// restart, which Windows does not tell apart from a shutdown, is called off by the PC coming back.
/// </summary>
internal sealed partial class DeckWindow
{
    private static readonly int[] GraceMinutes = [1, 2, 5, 10];

    private const int SystemMetricShuttingDown = 0x2000;

    private bool announcePresence = true;
    private bool leavingAnnounced;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);
    private bool wakePending;
    private string? shownFollowNote;

    private void OnPowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        switch (e.Mode)
        {
            case PowerModes.Suspend:
                if (widget.FollowSleep) AnnounceLeaving(HostPowerAction.Hibernate);
                break;
            case PowerModes.Resume:
                announcePresence = true;
                leavingAnnounced = false;
                FollowLog.Write("resumed");
                if (widget.FollowWake) Post(() => _ = WakeAfterResumeAsync());
                break;
        }
    }

    private void OnSessionEnding(object sender, SessionEndingEventArgs e)
    {
        if (e.Reason == SessionEndReasons.SystemShutdown) AnnounceShutdown();
    }

    /// <summary>
    /// Called from both ways Windows reports a shutdown, whichever comes first. A sign-out alone ends the session
    /// too, but leaves the PC running, so it is told apart by the system metric.
    /// </summary>
    private void AnnounceShutdown()
    {
        if (widget.FollowSleep && GetSystemMetrics(SystemMetricShuttingDown) != 0) AnnounceLeaving(HostPowerAction.Shutdown);
    }

    /// <summary>Windows gives a program only a moment before it suspends or ends the session, so this waits 1.5 s at most.</summary>
    private void AnnounceLeaving(HostPowerAction action)
    {
        if (leavingAnnounced) return;
        leavingAnnounced = true;
        if (!model.Live)
        {
            FollowLog.Write($"{action}: not sent, the agent was out of reach");
            return;
        }
        var request = new HostLeaving(action, widget.FollowGraceMinutes * 60, LocalAddresses());
        string outcome;
        try
        {
            var sending = Task.Run(() => link.HostLeavingAsync(request, CancellationToken.None));
            outcome = !sending.Wait(1500) ? "no answer within 1.5 s"
                : sending.Result.Ok ? "sent: " + sending.Result.Message
                : "refused: " + sending.Result.Message;
        }
        catch (AggregateException error)
        {
            outcome = "failed: " + error.InnerException?.Message;
        }
        FollowLog.Write($"{action}: {outcome}");
    }

    private static string[] LocalAddresses() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up && adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
            .Where(address => address.Address.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
            .Select(address => address.Address.ToString())
            .ToArray();

    private async Task WakeAfterResumeAsync()
    {
        // The network adapter needs a few seconds after a resume before a packet can leave.
        try
        {
            for (var waited = 0; waited < 30 && !NetworkInterface.GetIsNetworkAvailable(); waited++)
                await Task.Delay(1000, lifetime.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        wakePending = true;
        await PollAsync();
    }

    /// <summary>After a check of the NAS: wakes it once if it is off and a start or resume asked for it.</summary>
    private void WakeIfPending()
    {
        if (!wakePending || (!model.Live && model.Ports is null)) return;
        wakePending = false;
        if (!model.Online) Post(() => _ = RunPowerAsync(null));
    }

    /// <summary>With a reading from the agent: calls off a pending follow once, and shows why the NAS last stayed on.</summary>
    private void ReportPresence(Snapshot snapshot)
    {
        if (snapshot.Follow?.Note is { } note && note != shownFollowNote)
        {
            shownFollowNote = note;
            SetNotice(note);
            Notify(note, ToolTipIcon.Info, always: true);
        }
        if (!announcePresence) return;
        announcePresence = false;
        _ = link.HostPresentAsync(lifetime.Token);
    }

    private IEnumerable<ToolStripItem> FollowItems()
    {
        yield return DeckMenu.Item("Wake with this PC", null,
            () => SaveWidget(widget with { FollowWake = !widget.FollowWake }), isChecked: widget.FollowWake);
        yield return DeckMenu.Item("Sleep / shut down with PC", null,
            () => SaveWidget(widget with { FollowSleep = !widget.FollowSleep }), isChecked: widget.FollowSleep);
        yield return DeckMenu.Sub("Grace period", DeckGlyph.Timer, GraceItems(), enabled: widget.FollowSleep);
    }

    private IEnumerable<ToolStripItem> GraceItems()
    {
        // A restart must sign in and start NAS Deck within this time, or the NAS goes down and is woken again.
        foreach (var minutes in GraceMinutes)
            yield return DeckMenu.Item($"{minutes} min", null, () => SaveWidget(widget with { FollowGraceMinutes = minutes }),
                isChecked: widget.FollowGraceMinutes == minutes);
        if (!GraceMinutes.Contains(widget.FollowGraceMinutes))
            yield return DeckMenu.Item($"{widget.FollowGraceMinutes} min", null, () => { }, isChecked: true);
    }
}
