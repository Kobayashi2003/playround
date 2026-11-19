using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace NasDeck;

internal readonly record struct NasStatus(bool Ssh, bool Smb)
{
    public bool IsOnline => Ssh || Smb;
    public bool IsReady => Ssh && Smb;
}

internal enum PowerAction { Hibernate, Restart, Shutdown }

/// <summary>What works without the agent: reachability, Wake-on-LAN, and power commands over SSH.</summary>
internal static class NasController
{
    internal static string PowerShellPath { get; } = Path.Combine(Environment.SystemDirectory,
        "WindowsPowerShell", "v1.0", "powershell.exe");

    internal static async Task<NasStatus> ProbeAsync(NasSettings settings, CancellationToken cancellationToken)
    {
        var ssh = IsPortOpenAsync(settings.Host, settings.SshPort, cancellationToken);
        var smb = IsPortOpenAsync(settings.Host, 445, cancellationToken);
        return new NasStatus(await ssh, await smb);
    }

    private static async Task<bool> IsPortOpenAsync(string host, int port, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(1));
        using var client = new TcpClient();
        try
        {
            await client.ConnectAsync(host, port, timeout.Token);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }

    /// <summary>Sends a short burst of magic packets; a single datagram is easily lost.</summary>
    internal static async Task WakeAsync(NasSettings settings, CancellationToken cancellationToken)
    {
        var mac = settings.MacAddress.Split('-', ':').Select(part => byte.Parse(part, NumberStyles.HexNumber)).ToArray();
        var packet = Enumerable.Repeat((byte)0xFF, 6).Concat(Enumerable.Repeat(mac, 16).SelectMany(bytes => bytes)).ToArray();
        using var udp = new UdpClient(AddressFamily.InterNetwork) { EnableBroadcast = true };
        try
        {
            var target = new IPEndPoint(IPAddress.Parse(settings.BroadcastAddress), settings.WakePort);
            for (var burst = 0; burst < 3; burst++)
            {
                if (burst > 0) await Task.Delay(150, cancellationToken);
                await udp.SendAsync(packet, target, cancellationToken);
            }
        }
        catch (SocketException error)
        {
            throw new IOException("The Wake-on-LAN packet could not be sent: " + error.Message, error);
        }
    }

    internal static Task PowerAsync(NasSettings settings, PowerAction action, CancellationToken cancellationToken) =>
        RunScriptAsync("Send-NasPower.ps1", cancellationToken, "-Action", action.ToString(),
            "-ComputerName", settings.Host, "-UserName", settings.SshUser, "-Port", settings.SshPort.ToString(),
            "-IdentityFile", DeckPaths.KeyPath, "-HostKeyAlias", settings.HostKeyAlias);

    /// <summary>The options every SSH connection to the NAS shares; the host is appended by the caller.</summary>
    internal static string[] SshOptions(NasSettings settings) =>
    [
        "-p", settings.SshPort.ToString(), "-i", DeckPaths.KeyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes", "-o", "HostKeyAlias=" + settings.HostKeyAlias, "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "-l", settings.SshUser
    ];

    private static async Task RunScriptAsync(string script, CancellationToken cancellationToken, params string[] arguments)
    {
        var start = new ProcessStartInfo(PowerShellPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-File", Path.Combine(DeckPaths.ProjectDirectory, "scripts", script) })
            start.ArgumentList.Add(argument);
        foreach (var argument in arguments)
            start.ArgumentList.Add(argument);

        using var process = Process.Start(start) ?? throw new IOException("Could not start PowerShell.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(40));
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        using var stop = timeout.Token.Register(() =>
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
        });
        await process.WaitForExitAsync();
        if (timeout.IsCancellationRequested)
        {
            cancellationToken.ThrowIfCancellationRequested();
            throw new TimeoutException("The command timed out. Check the NAS and refresh its status.");
        }

        if (process.ExitCode != 0)
        {
            var details = (await error + "\n" + await output).Trim();
            if (details.Contains("Permission denied", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("SSH rejected the key. Run Set up SSH key in Settings and try again.");
            if (details.Contains("Host key verification failed", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("SSH could not verify the NAS identity. Check the address and SSH key setup.");
            throw new InvalidOperationException(details.Length == 0 ? $"PowerShell exited with code {process.ExitCode}." : details);
        }
    }
}
