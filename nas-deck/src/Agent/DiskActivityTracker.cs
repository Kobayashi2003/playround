using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>
/// Tracks live per-process disk read and write throughput on the NAS without ever touching or waking a disk.
/// Starts a private kernel DiskIo ETW session on demand when the widget asks for activity, and closes it after
/// a short idle period so normal monitoring carries zero overhead. Falls back to <c>GetProcessIoCounters</c>
/// when kernel tracing is unavailable (for example when running unprivileged).
/// </summary>
internal sealed class DiskActivityTracker(ILogger logger) : IDisposable
{
    private const string SessionName = "NasDeck-DiskIo";
    private const uint WnodeFlagTracedGuid = 0x00020000;
    private const uint EventTraceRealTimeMode = 0x00000100;
    private const uint EventTraceSystemLoggerMode = 0x02000000;
    private const uint ProcessTraceModeRealTime = 0x00000100;
    private const uint ProcessTraceModeEventRecord = 0x10000000;
    private const uint EventTraceFlagDiskIo = 0x00000100;
    private const uint EventTraceControlStop = 1;
    private const uint ErrorAlreadyExists = 183;
    private const uint ThreadQueryLimitedInformation = 0x0800;
    private const byte DiskIoReadOpcode = 10;
    private const byte DiskIoWriteOpcode = 11;
    private static readonly Guid DiskIoGuid = new("3d6fa8d4-fe05-11d0-9dda-00c04fd7ba7c");
    private static readonly TimeSpan IdleTimeout = TimeSpan.FromSeconds(45);
    private const double WindowSeconds = 2.0;

    private sealed class Bucket
    {
        internal long SecondHalf;
        internal readonly Dictionary<int, ProcessCounters> ByPid = [];
    }

    private sealed class ProcessCounters
    {
        internal long ReadBytes;
        internal long WriteBytes;
        internal readonly HashSet<int> Disks = [];
    }

    private readonly object gate = new();
    private readonly Bucket[] ring = Enumerable.Range(0, 6).Select(_ => new Bucket()).ToArray();
    private readonly ConcurrentDictionary<uint, (int Pid, long SeenTick)> threadPid = new();
    private readonly Dictionary<int, (string Name, long SeenTick)> pidNames = [];
    private Dictionary<int, (string Name, ulong Read, ulong Write)> prevCounters = [];
    private DateTimeOffset prevCountersAt;
    private DateTimeOffset lastRequestedAt;
    private DateTimeOffset etwStartedAt;
    private ulong traceHandle;
    private Thread? consumerThread;
    private EtwNative.EventRecordCallbackDelegate? callbackPin;
    private bool etwRunning;
    private bool etwUnavailable;
    private bool disposed;

    /// <summary>Returns current NAS disk activity (processes + SMB open files) and keeps the tracker warm.</summary>
    internal NasActivity Read(SmbOpenFile[] openFiles)
    {
        var now = DateTimeOffset.Now;
        lock (gate)
        {
            lastRequestedAt = now;
            if (!etwRunning && !etwUnavailable && !disposed) StartEtw(now);
            var useEtw = etwRunning && (now - etwStartedAt).TotalSeconds >= 0.8;
            if (useEtw)
            {
                var processes = AggregateEtw(now);
                return new NasActivity(now, PerDisk: true, processes, openFiles);
            }
        }
        return new NasActivity(now, PerDisk: false, SampleProcessCounters(now), openFiles);
    }

    /// <summary>Called periodically by <see cref="Sampler"/> to stop the ETW session once nobody is watching.</summary>
    internal void StopIfIdle()
    {
        lock (gate)
        {
            if (etwRunning && DateTimeOffset.Now - lastRequestedAt > IdleTimeout) StopEtwLocked();
        }
    }

    private ProcessDiskIo[] AggregateEtw(DateTimeOffset now)
    {
        var currentHalf = Environment.TickCount64 / 500;
        var minHalf = currentHalf - 4;
        var totals = new Dictionary<int, ProcessCounters>();
        foreach (var bucket in ring)
        {
            if (bucket.SecondHalf < minHalf || bucket.SecondHalf > currentHalf) continue;
            foreach (var (pid, counters) in bucket.ByPid)
            {
                if (!totals.TryGetValue(pid, out var agg)) totals[pid] = agg = new ProcessCounters();
                agg.ReadBytes += counters.ReadBytes;
                agg.WriteBytes += counters.WriteBytes;
                foreach (var disk in counters.Disks) agg.Disks.Add(disk);
            }
        }
        var span = Math.Clamp((now - etwStartedAt).TotalSeconds, 0.5, WindowSeconds);
        return BuildList(totals.Select(entry => (
            Pid: entry.Key,
            Name: ResolveProcessName(entry.Key),
            ReadRate: entry.Value.ReadBytes / span,
            WriteRate: entry.Value.WriteBytes / span,
            Disks: entry.Value.Disks.Order().ToArray())));
    }

    internal static ProcessDiskIo[] BuildList(IEnumerable<(int Pid, string Name, double ReadRate, double WriteRate, int[] Disks)> rows, int max = 32) =>
        rows.Where(row => row.ReadRate + row.WriteRate >= 512)
            .OrderByDescending(row => row.ReadRate + row.WriteRate)
            .Take(max)
            .Select(row => new ProcessDiskIo(row.Pid, row.Name, Math.Round(row.ReadRate), Math.Round(row.WriteRate), row.Disks))
            .ToArray();

    private ProcessDiskIo[] SampleProcessCounters(DateTimeOffset now)
    {
        var current = new Dictionary<int, (string Name, ulong Read, ulong Write)>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id == 0 || process.Id == Environment.ProcessId) continue;
                using var handle = Native.OpenProcess(Native.ProcessQueryLimitedInformation, false, process.Id);
                if (handle.IsInvalid || !Native.GetProcessIoCounters(handle, out var counters)) continue;
                current[process.Id] = (process.Id == 4 ? "System" : process.ProcessName, counters.ReadBytes, counters.WriteBytes);
            }
        }
        lock (gate)
        {
            var seconds = prevCountersAt == default ? 0 : (now - prevCountersAt).TotalSeconds;
            var result = seconds is > 0.2 and < 30
                ? BuildList(current.Select(entry =>
                {
                    if (!prevCounters.TryGetValue(entry.Key, out var before) || before.Name != entry.Value.Name)
                        return (entry.Key, entry.Value.Name, 0d, 0d, Array.Empty<int>());
                    var read = entry.Value.Read >= before.Read ? (entry.Value.Read - before.Read) / seconds : 0;
                    var write = entry.Value.Write >= before.Write ? (entry.Value.Write - before.Write) / seconds : 0;
                    return (entry.Key, entry.Value.Name, read, write, Array.Empty<int>());
                }))
                : [];
            prevCounters = current;
            prevCountersAt = now;
            return result;
        }
    }

    private void StartEtw(DateTimeOffset now)
    {
        foreach (var bucket in ring)
        {
            bucket.SecondHalf = 0;
            bucket.ByPid.Clear();
        }
        var status = TryStartTrace(out _);
        if (status == ErrorAlreadyExists)
        {
            StopTraceByName();
            status = TryStartTrace(out _);
        }
        if (status != 0)
        {
            etwUnavailable = true;
            logger.LogInformation("Kernel DiskIo trace unavailable (error {Status}); falling back to process I/O counters.", status);
            return;
        }

        callbackPin = OnEventRecord;
        var logfile = new EtwNative.EventTraceLogfile
        {
            LoggerName = SessionName,
            ProcessTraceMode = ProcessTraceModeRealTime | ProcessTraceModeEventRecord,
            EventRecordCallback = Marshal.GetFunctionPointerForDelegate(callbackPin)
        };
        var consumer = EtwNative.OpenTraceW(ref logfile);
        if (consumer == unchecked((ulong)-1))
        {
            StopTraceByName();
            etwUnavailable = true;
            logger.LogInformation("OpenTraceW failed for kernel DiskIo trace; falling back to process I/O counters.");
            return;
        }

        traceHandle = consumer;
        etwStartedAt = now;
        etwRunning = true;
        consumerThread = new Thread(() => ConsumeLoop(consumer))
        {
            IsBackground = true,
            Name = "NasDeck-DiskIo-ETW"
        };
        consumerThread.Start();
    }

    private void ConsumeLoop(ulong consumer)
    {
        try
        {
            var handles = new[] { consumer };
            _ = EtwNative.ProcessTrace(handles, 1, IntPtr.Zero, IntPtr.Zero);
        }
        catch (Exception error)
        {
            logger.LogDebug(error, "ETW DiskIo consumer exited.");
        }
    }

    private void OnEventRecord(IntPtr recordPtr)
    {
        var header = Marshal.PtrToStructure<EtwNative.EventRecord>(recordPtr);
        if (header.Header.ProviderId != DiskIoGuid) return;
        var opcode = header.Header.EventDescriptor.Opcode;
        if (opcode is not (DiskIoReadOpcode or DiskIoWriteOpcode)) return;
        if (header.UserData == IntPtr.Zero || header.UserDataLength < 12) return;

        var diskNumber = Marshal.ReadInt32(header.UserData, 0);
        var transferSize = (uint)Marshal.ReadInt32(header.UserData, 8);
        if (transferSize == 0) return;

        int pid;
        if (header.Header.ProcessId != 0xFFFFFFFF && header.Header.ProcessId != 0)
        {
            pid = unchecked((int)header.Header.ProcessId);
        }
        else if (header.UserDataLength >= 52)
        {
            var issuingThread = unchecked((uint)Marshal.ReadInt32(header.UserData, 48));
            pid = ResolveThreadPid(issuingThread);
        }
        else
        {
            pid = 4;
        }
        if (pid == Environment.ProcessId) return;

        var half = Environment.TickCount64 / 500;
        lock (gate)
        {
            var slot = ring[(int)(half % ring.Length)];
            if (slot.SecondHalf != half)
            {
                slot.SecondHalf = half;
                slot.ByPid.Clear();
            }
            if (!slot.ByPid.TryGetValue(pid, out var entry)) slot.ByPid[pid] = entry = new ProcessCounters();
            if (opcode == DiskIoReadOpcode) entry.ReadBytes += transferSize;
            else entry.WriteBytes += transferSize;
            if (diskNumber >= 0) entry.Disks.Add(diskNumber);
        }
    }

    private int ResolveThreadPid(uint threadId)
    {
        if (threadId == 0) return 4;
        var tick = Environment.TickCount64;
        if (threadPid.TryGetValue(threadId, out var cached) && tick - cached.SeenTick < 10_000)
            return cached.Pid;

        var pid = 4;
        var handle = EtwNative.OpenThread(ThreadQueryLimitedInformation, false, threadId);
        if (handle != IntPtr.Zero)
        {
            try
            {
                var found = EtwNative.GetProcessIdOfThread(handle);
                if (found > 0) pid = unchecked((int)found);
            }
            finally
            {
                EtwNative.CloseHandle(handle);
            }
        }
        if (threadPid.Count > 2048) threadPid.Clear();
        threadPid[threadId] = (pid, tick);
        return pid;
    }

    private string ResolveProcessName(int pid)
    {
        if (pid <= 4) return "System";
        var tick = Environment.TickCount64;
        if (pidNames.TryGetValue(pid, out var cached) && tick - cached.SeenTick < 15_000)
            return cached.Name;

        var name = $"PID {pid}";
        try
        {
            using var process = Process.GetProcessById(pid);
            name = process.ProcessName;
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { }
        if (pidNames.Count > 512) pidNames.Clear();
        pidNames[pid] = (name, tick);
        return name;
    }

    private void StopEtwLocked()
    {
        if (!etwRunning) return;
        etwRunning = false;
        var consumer = traceHandle;
        traceHandle = 0;
        StopTraceByName();
        if (consumer != 0) _ = EtwNative.CloseTrace(consumer);
        consumerThread = null;
    }

    private static uint TryStartTrace(out ulong handle)
    {
        var propsSize = Marshal.SizeOf<EtwNative.EventTraceProperties>();
        var total = propsSize + (SessionName.Length + 2) * 2;
        var buffer = Marshal.AllocHGlobal(total);
        try
        {
            for (var i = 0; i < total; i++) Marshal.WriteByte(buffer, i, 0);
            var props = new EtwNative.EventTraceProperties
            {
                Wnode = new EtwNative.WnodeHeader
                {
                    BufferSize = (uint)total,
                    ClientContext = 1,
                    Flags = WnodeFlagTracedGuid
                },
                BufferSize = 64,
                MinimumBuffers = 4,
                MaximumBuffers = 16,
                LogFileMode = EventTraceRealTimeMode | EventTraceSystemLoggerMode,
                EnableFlags = EventTraceFlagDiskIo,
                FlushTimer = 1,
                LoggerNameOffset = (uint)propsSize
            };
            Marshal.StructureToPtr(props, buffer, false);
            return EtwNative.StartTraceW(out handle, SessionName, buffer);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void StopTraceByName()
    {
        var propsSize = Marshal.SizeOf<EtwNative.EventTraceProperties>();
        var total = propsSize + 512;
        var buffer = Marshal.AllocHGlobal(total);
        try
        {
            for (var i = 0; i < total; i++) Marshal.WriteByte(buffer, i, 0);
            var props = new EtwNative.EventTraceProperties
            {
                Wnode = new EtwNative.WnodeHeader { BufferSize = (uint)total },
                LoggerNameOffset = (uint)propsSize
            };
            Marshal.StructureToPtr(props, buffer, false);
            _ = EtwNative.ControlTraceW(0, SessionName, buffer, EventTraceControlStop);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            StopEtwLocked();
        }
    }
}
