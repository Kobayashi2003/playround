using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NasDeck;

internal sealed record NasHandleTarget(string Share, string RelativePath)
{
    internal string Display => string.IsNullOrEmpty(RelativePath) ? Share : $"{Share} › {RelativePath}";
}

internal sealed record LocalProcessActivity(
    int Pid,
    string Name,
    double ReadBytesPerSec,
    double WriteBytesPerSec,
    NasHandleTarget[] NasTargets)
{
    internal bool TouchesNas => NasTargets.Length > 0;
}

/// <summary>
/// Reads per-process I/O throughput on this PC and discovers which local user processes currently hold open
/// handles to shares on the configured NAS. Handle inspection uses kernel object names only
/// (<c>NtQueryObject</c> on <c>FILE_TYPE_DISK</c> handles), so it never sends SMB requests or wakes disks.
/// </summary>
internal sealed class LocalActivityMonitor
{
    private const uint ProcessDupHandle = 0x0040;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint DuplicateSameAccess = 0x0002;
    private const uint FileTypeDisk = 1;
    private const int SystemExtendedHandleInformation = 64;
    private const int ObjectNameInformation = 1;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const double MinActiveBytesPerSec = 1024;

    private readonly object gate = new();
    private Dictionary<int, (string Name, ulong Read, ulong Write)> previous = [];
    private DateTimeOffset previousAt;
    private Dictionary<int, NasHandleTarget[]> cachedNasHandles = [];
    private DateTimeOffset lastHandleScan;
    private int fileTypeIndex = -1;

    internal LocalProcessActivity[] Sample(IReadOnlySet<string> nasHosts, bool forceHandleScan = false)
    {
        var now = DateTimeOffset.Now;
        if (nasHosts.Count > 0 && (forceHandleScan || now - lastHandleScan >= TimeSpan.FromSeconds(3)))
        {
            var scanned = ScanNasHandles(nasHosts);
            lock (gate)
            {
                cachedNasHandles = scanned;
                lastHandleScan = now;
            }
        }

        var current = new Dictionary<int, (string Name, ulong Read, ulong Write)>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id is 0 or 4 || process.Id == Environment.ProcessId) continue;
                var handle = OpenProcess(ProcessQueryLimitedInformation, false, process.Id);
                if (handle == IntPtr.Zero) continue;
                try
                {
                    if (GetProcessIoCounters(handle, out var counters))
                        current[process.Id] = (process.ProcessName, counters.ReadBytes, counters.WriteBytes);
                }
                finally
                {
                    CloseHandle(handle);
                }
            }
        }

        Dictionary<int, (string Name, ulong Read, ulong Write)> prev;
        DateTimeOffset prevAt;
        Dictionary<int, NasHandleTarget[]> handles;
        lock (gate)
        {
            prev = previous;
            prevAt = previousAt;
            handles = cachedNasHandles;
            previous = current;
            previousAt = now;
        }

        var seconds = prevAt == default ? 0 : (now - prevAt).TotalSeconds;
        var hasDelta = seconds is > 0.2 and < 30;
        var results = new List<LocalProcessActivity>();
        foreach (var (pid, info) in current)
        {
            double readRate = 0, writeRate = 0;
            if (hasDelta && prev.TryGetValue(pid, out var before) && before.Name == info.Name)
            {
                readRate = info.Read >= before.Read ? (info.Read - before.Read) / seconds : 0;
                writeRate = info.Write >= before.Write ? (info.Write - before.Write) / seconds : 0;
            }
            var targets = handles.TryGetValue(pid, out var found) ? found : [];
            if (targets.Length == 0 && readRate + writeRate < MinActiveBytesPerSec) continue;
            results.Add(new LocalProcessActivity(pid, info.Name, Math.Round(readRate), Math.Round(writeRate), targets));
        }

        return results
            .OrderByDescending(item => item.TouchesNas && item.ReadBytesPerSec + item.WriteBytesPerSec >= MinActiveBytesPerSec)
            .ThenByDescending(item => item.ReadBytesPerSec + item.WriteBytesPerSec)
            .ThenByDescending(item => item.TouchesNas)
            .ThenBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .Take(40)
            .ToArray();
    }

    internal static HashSet<string> BuildNasHosts(NasSettings settings, string? reportedHostName)
    {
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Add(settings.Host);
        Add(settings.RecycleHostAlias);
        Add(reportedHostName);
        return hosts;

        void Add(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            var trimmed = value.Trim().TrimStart('\\');
            if (trimmed.Length == 0) return;
            hosts.Add(trimmed);
            var dot = trimmed.IndexOf('.');
            if (dot > 0 && !char.IsDigit(trimmed[0])) hosts.Add(trimmed[..dot]);
        }
    }

    /// <summary>
    /// Parses a Windows kernel MUP device path such as <c>\Device\Mup\192.168.0.168\nas-f\dir\file</c> or
    /// <c>\Device\Mup\;LanmanRedirector\;Z:0000000000012345\kobayashi-nas\nas-f\dir\file</c> and returns the
    /// share and relative path when the server matches one of <paramref name="nasHosts"/>.
    /// </summary>
    internal static NasHandleTarget? ParseMupPath(string devicePath, IReadOnlySet<string> nasHosts)
    {
        const string prefix = @"\Device\Mup\";
        if (!devicePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var rest = devicePath.AsSpan(prefix.Length);
        while (rest.Length > 0 && rest[0] == ';')
        {
            var slash = rest.IndexOf('\\');
            if (slash < 0) return null;
            rest = rest[(slash + 1)..];
        }
        var hostEnd = rest.IndexOf('\\');
        if (hostEnd <= 0) return null;
        var host = rest[..hostEnd].ToString();
        if (!nasHosts.Contains(host)) return null;
        var afterHost = rest[(hostEnd + 1)..];
        if (afterHost.IsEmpty) return null;
        var shareEnd = afterHost.IndexOf('\\');
        var share = (shareEnd < 0 ? afterHost : afterHost[..shareEnd]).ToString();
        if (share.Length == 0 || share.Equals("IPC$", StringComparison.OrdinalIgnoreCase)) return null;
        var relative = shareEnd < 0 ? "" : afterHost[(shareEnd + 1)..].ToString().Trim('\\');
        return new NasHandleTarget(share, relative);
    }

    private Dictionary<int, NasHandleTarget[]> ScanNasHandles(IReadOnlySet<string> nasHosts)
    {
        var found = new Dictionary<int, List<NasHandleTarget>>();
        var myPid = Environment.ProcessId;
        using var selfFile = fileTypeIndex < 0 ? File.OpenRead(Environment.ProcessPath!) : null;
        var selfHandle = selfFile?.SafeFileHandle.DangerousGetHandle() ?? IntPtr.Zero;

        var buffer = QueryHandleBuffer(out var count);
        if (buffer == IntPtr.Zero) return [];
        try
        {
            var stride = Marshal.SizeOf<SystemHandleEntryEx>();
            var pidOffset = (int)Marshal.OffsetOf<SystemHandleEntryEx>(nameof(SystemHandleEntryEx.UniqueProcessId));
            var handleOffset = (int)Marshal.OffsetOf<SystemHandleEntryEx>(nameof(SystemHandleEntryEx.HandleValue));
            var typeOffset = (int)Marshal.OffsetOf<SystemHandleEntryEx>(nameof(SystemHandleEntryEx.ObjectTypeIndex));
            var start = buffer + IntPtr.Size * 2;

            if (fileTypeIndex < 0)
            {
                for (long i = 0; i < count; i++)
                {
                    var entry = start + (nint)(i * stride);
                    if (Marshal.ReadIntPtr(entry, pidOffset).ToInt64() == myPid
                        && Marshal.ReadIntPtr(entry, handleOffset) == selfHandle)
                    {
                        fileTypeIndex = (ushort)Marshal.ReadInt16(entry, typeOffset);
                        break;
                    }
                }
                if (fileTypeIndex < 0) return [];
            }

            var byPid = new Dictionary<int, List<IntPtr>>();
            var wantedType = (ushort)fileTypeIndex;
            for (long i = 0; i < count; i++)
            {
                var entry = start + (nint)(i * stride);
                if ((ushort)Marshal.ReadInt16(entry, typeOffset) != wantedType) continue;
                var pid = (int)Marshal.ReadIntPtr(entry, pidOffset).ToInt64();
                if (pid <= 4 || pid == myPid) continue;
                if (!byPid.TryGetValue(pid, out var list)) byPid[pid] = list = [];
                list.Add(Marshal.ReadIntPtr(entry, handleOffset));
            }

            var currentProcess = GetCurrentProcess();
            var nameBuffer = Marshal.AllocHGlobal(2048);
            try
            {
                foreach (var (pid, handles) in byPid)
                {
                    var processHandle = OpenProcess(ProcessDupHandle | ProcessQueryLimitedInformation, false, pid);
                    if (processHandle == IntPtr.Zero) continue;
                    try
                    {
                        foreach (var remoteHandle in handles)
                        {
                            if (!DuplicateHandle(processHandle, remoteHandle, currentProcess, out var dup, 0, false, DuplicateSameAccess))
                                continue;
                            try
                            {
                                if (GetFileType(dup) != FileTypeDisk) continue;
                                if (NtQueryObject(dup, ObjectNameInformation, nameBuffer, 2048, out _) != 0) continue;
                                var us = Marshal.PtrToStructure<UnicodeString>(nameBuffer);
                                if (us.Length == 0 || us.Buffer == IntPtr.Zero) continue;
                                var name = Marshal.PtrToStringUni(us.Buffer, us.Length / 2);
                                if (string.IsNullOrEmpty(name)) continue;
                                if (ParseMupPath(name, nasHosts) is not { } target) continue;
                                if (!found.TryGetValue(pid, out var targets)) found[pid] = targets = [];
                                if (targets.Count < 8 && !targets.Contains(target)) targets.Add(target);
                            }
                            finally
                            {
                                CloseHandle(dup);
                            }
                        }
                    }
                    finally
                    {
                        CloseHandle(processHandle);
                    }
                }
            }
            finally
            {
                Marshal.FreeHGlobal(nameBuffer);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return found.ToDictionary(entry => entry.Key, entry => entry.Value.ToArray());
    }

    private static IntPtr QueryHandleBuffer(out long count)
    {
        count = 0;
        var size = 4 << 20;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            var buffer = Marshal.AllocHGlobal(size);
            var status = NtQuerySystemInformation(SystemExtendedHandleInformation, buffer, size, out var needed);
            if (status == StatusInfoLengthMismatch)
            {
                Marshal.FreeHGlobal(buffer);
                size = Math.Max(size * 2, needed + 262_144);
                continue;
            }
            if (status != 0)
            {
                Marshal.FreeHGlobal(buffer);
                return IntPtr.Zero;
            }
            count = Marshal.ReadIntPtr(buffer).ToInt64();
            return buffer;
        }
        return IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperations, WriteOperations, OtherOperations;
        internal ulong ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemHandleEntryEx
    {
        internal IntPtr Object;
        internal IntPtr UniqueProcessId;
        internal IntPtr HandleValue;
        internal uint GrantedAccess;
        internal ushort CreatorBackTraceIndex;
        internal ushort ObjectTypeIndex;
        internal uint HandleAttributes;
        internal uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        internal ushort Length;
        internal ushort MaximumLength;
        internal IntPtr Buffer;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessIoCounters(IntPtr process, out IoCounters counters);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);

    [DllImport("kernel32.dll")]
    private static extern uint GetFileType(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
