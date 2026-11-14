using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;
using NasDeck.Protocol;

namespace NasDeck;

/// <summary>
/// Talks to the agent on the NAS. The agent listens only on the NAS's loopback, so the link keeps an
/// <c>ssh -L</c> tunnel open and sends its requests to the local end of it.
/// </summary>
internal sealed class AgentLink : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private static readonly TimeSpan RetryEvery = TimeSpan.FromSeconds(6);

    private readonly ChildJob job = new();
    private NasSettings settings;
    private HttpClient http;
    private Process? tunnel;
    private DateTime tunnelStartedAt;

    internal AgentLink(NasSettings settings)
    {
        this.settings = settings;
        http = CreateClient();
    }

    /// <summary>False until Install-Agent.ps1 has left the agent's token in the data directory.</summary>
    internal bool HasToken { get; private set; }

    /// <summary>The last thing the tunnel's ssh said before it exited, when it has.</summary>
    internal string? TunnelError { get; private set; }

    internal void Configure(NasSettings next)
    {
        StopTunnel();
        settings = next;
        http.Dispose();
        http = CreateClient();
    }

    private HttpClient CreateClient()
    {
        // Loopback is reached directly whatever proxy the system is set to use.
        var client = new HttpClient(new SocketsHttpHandler { UseProxy = false, ConnectTimeout = TimeSpan.FromSeconds(1) })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{settings.AgentPort}/"),
            Timeout = TimeSpan.FromSeconds(4)
        };
        var token = ReadToken();
        HasToken = token is not null;
        if (token is not null) client.DefaultRequestHeaders.Add(AgentApi.TokenHeader, token);
        return client;
    }

    private static string? ReadToken()
    {
        try
        {
            var token = File.Exists(DeckPaths.TokenPath) ? File.ReadAllText(DeckPaths.TokenPath).Trim() : "";
            return token.Length > 0 ? token : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal async Task<Snapshot?> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        if (!HasToken) return null;
        try
        {
            return await http.GetFromJsonAsync<Snapshot>("api/snapshot", Json, cancellationToken);
        }
        catch (Exception error) when (error is HttpRequestException or JsonException
            || (error is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return null;
        }
    }

    internal async Task<DiskDetail?> GetDiskDetailAsync(int number, CancellationToken cancellationToken)
    {
        if (!HasToken) return null;
        try
        {
            return await http.GetFromJsonAsync<DiskDetail>($"api/disks/{number}", Json, cancellationToken);
        }
        catch (Exception error) when (error is HttpRequestException or JsonException
            || (error is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return null;
        }
    }

    internal Task<ActionReply> SleepDiskAsync(int number, bool force, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, $"api/disks/{number}/sleep?force={(force ? "true" : "false")}", null, cancellationToken);

    internal Task<ActionReply> SleepAllAsync(CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, "api/disks/sleep", null, cancellationToken);

    internal Task<ActionReply> WakeDiskAsync(int number, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Post, $"api/disks/{number}/wake", null, cancellationToken);

    internal Task<ActionReply> SetPolicyAsync(PowerPolicy policy, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Put, "api/policy", policy, cancellationToken);

    private async Task<ActionReply> SendAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(method, path);
            if (body is not null) request.Content = JsonContent.Create(body, body.GetType(), options: Json);
            // Flushing a volume before its disk stops can take longer than a snapshot does.
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var response = await http.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode)
                return new ActionReply(false, "failed", $"The agent answered {(int)response.StatusCode}.");
            return await response.Content.ReadFromJsonAsync<ActionReply>(Json, timeout.Token)
                ?? new ActionReply(false, "failed", "The agent sent an empty answer.");
        }
        catch (Exception error) when (error is HttpRequestException or JsonException
            || (error is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return new ActionReply(false, "failed", "The agent did not answer.");
        }
    }

    /// <summary>Starts the tunnel when it is not running. Call it once SSH on the NAS answers.</summary>
    internal void EnsureTunnel()
    {
        if (!HasToken)
        {
            // The installer may have just written the token.
            if (ReadToken() is null) return;
            http.Dispose();
            http = CreateClient();
        }
        if (tunnel is { HasExited: false } || DateTime.UtcNow - tunnelStartedAt < RetryEvery) return;
        StopTunnel();

        var start = new ProcessStartInfo("ssh.exe")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardInput = true
        };
        var forward = $"127.0.0.1:{settings.AgentPort}:127.0.0.1:{settings.AgentPort}";
        foreach (var argument in (string[])["-N", "-L", forward, "-o", "ExitOnForwardFailure=yes", .. NasController.SshOptions(settings), "--", settings.Host])
            start.ArgumentList.Add(argument);
        tunnelStartedAt = DateTime.UtcNow;
        try
        {
            var process = Process.Start(start);
            if (process is null) return;
            job.Add(process);
            process.ErrorDataReceived += (_, line) =>
            {
                if (!string.IsNullOrWhiteSpace(line.Data)) TunnelError = line.Data.Trim();
            };
            process.BeginErrorReadLine();
            tunnel = process;
            TunnelError = null;
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            TunnelError = "Could not start ssh.exe: " + error.Message;
        }
    }

    internal void StopTunnel()
    {
        if (tunnel is null) return;
        try
        {
            if (!tunnel.HasExited) tunnel.Kill();
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        tunnel.Dispose();
        tunnel = null;
        tunnelStartedAt = default;
    }

    public void Dispose()
    {
        StopTunnel();
        http.Dispose();
        job.Dispose();
    }

    /// <summary>A job object that ends its processes with this one, so a crash never leaves a tunnel behind.</summary>
    private sealed class ChildJob : IDisposable
    {
        private const int ExtendedLimitInformation = 9;
        private const uint KillOnJobClose = 0x2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits
        {
            internal long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal nuint MinimumWorkingSetSize, MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal nuint Affinity;
            internal uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits
        {
            internal BasicLimits Basic;
            internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
            internal nuint ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateJobObjectW(IntPtr security, string? name);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, int size);

        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

        private readonly SafeFileHandle handle = CreateJobObjectW(IntPtr.Zero, null);

        internal ChildJob()
        {
            var limits = new ExtendedLimits { Basic = { LimitFlags = KillOnJobClose } };
            SetInformationJobObject(handle, ExtendedLimitInformation, ref limits, Marshal.SizeOf<ExtendedLimits>());
        }

        internal void Add(Process process) => AssignProcessToJobObject(handle, process.Handle);

        public void Dispose() => handle.Dispose();
    }
}
