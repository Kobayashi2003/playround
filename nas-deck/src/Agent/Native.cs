using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace NasDeck.Agent;

internal static class Native
{
    internal const uint GenericRead = 0x80000000;
    internal const uint GenericWrite = 0x40000000;
    internal const uint ShareReadWrite = 0x3;
    internal const uint OpenExisting = 3;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DeviceIoControl(SafeFileHandle device, uint code, byte[]? input, int inputSize,
        byte[]? output, int outputSize, out int returned, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetDevicePowerState(SafeFileHandle device, [MarshalAs(UnmanagedType.Bool)] out bool on);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    [StructLayout(LayoutKind.Sequential)]
    internal struct MemoryStatus
    {
        internal uint Length;
        internal uint MemoryLoad;
        internal ulong TotalPhysical;
        internal ulong AvailablePhysical;
        internal ulong TotalPageFile;
        internal ulong AvailablePageFile;
        internal ulong TotalVirtual;
        internal ulong AvailableVirtual;
        internal ulong AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperations;
        internal ulong WriteOperations;
        internal ulong OtherOperations;
        internal ulong ReadBytes;
        internal ulong WriteBytes;
        internal ulong OtherBytes;
    }

    internal const uint ProcessQueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetProcessIoCounters(SafeProcessHandle process, out IoCounters counters);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr memory);

    [DllImport("powrprof.dll")]
    internal static extern uint PowerGetActiveScheme(IntPtr root, out IntPtr scheme);

    [DllImport("powrprof.dll")]
    internal static extern uint PowerReadACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, out uint value);

    [DllImport("powrprof.dll")]
    internal static extern uint PowerWriteACValueIndex(IntPtr root, ref Guid scheme, ref Guid subgroup, ref Guid setting, uint value);

    [DllImport("powrprof.dll")]
    internal static extern uint PowerSetActiveScheme(IntPtr root, ref Guid scheme);

    internal const int MaxPreferredLength = -1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct SessionInfo10
    {
        internal string? Client;
        internal string? User;
        internal uint Seconds;
        internal uint IdleSeconds;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct FileInfo3
    {
        internal uint Id;
        internal uint Permissions;
        internal uint Locks;
        internal string? Path;
        internal string? User;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct ShareInfo2
    {
        internal string? Name;
        internal uint Type;
        internal string? Remark;
        internal uint Permissions;
        internal uint MaxUses;
        internal uint CurrentUses;
        internal string? Path;
        internal string? Password;
    }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern int NetSessionEnum(string? server, string? client, string? user, int level,
        out IntPtr buffer, int preferredLength, out int read, out int total, ref IntPtr resume);

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern int NetFileEnum(string? server, string? basePath, string? user, int level,
        out IntPtr buffer, int preferredLength, out int read, out int total, ref IntPtr resume);

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern int NetShareEnum(string? server, int level, out IntPtr buffer, int preferredLength,
        out int read, out int total, ref IntPtr resume);

    [DllImport("netapi32.dll")]
    internal static extern int NetApiBufferFree(IntPtr buffer);
}
