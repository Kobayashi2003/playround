using System.Runtime.InteropServices;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>What the file server holds in memory about its clients; none of these calls touch a disk.</summary>
internal static class SmbInfo
{
    private const uint ShareTypeMask = 0xFF;
    private const uint ShareTypeSpecial = 0x80000000;
    private const uint PermissionWrite = 0x2;
    private const uint PermissionCreate = 0x4;

    private delegate int Enumerate(out IntPtr buffer, out int read, ref IntPtr resume);

    internal static SmbSession[] Sessions() =>
        Read<Native.SessionInfo10, SmbSession>(
            (out IntPtr buffer, out int read, ref IntPtr resume) =>
                Native.NetSessionEnum(null, null, null, 10, out buffer, Native.MaxPreferredLength, out read, out _, ref resume),
            entry => new SmbSession((entry.Client ?? "").TrimStart('\\'), entry.User ?? "", (int)entry.Seconds, (int)entry.IdleSeconds));

    internal static SmbOpenFile[] OpenFiles() =>
        Read<Native.FileInfo3, SmbOpenFile>(
            (out IntPtr buffer, out int read, ref IntPtr resume) =>
                Native.NetFileEnum(null, null, null, 3, out buffer, Native.MaxPreferredLength, out read, out _, ref resume),
            entry => new SmbOpenFile(entry.Path ?? "", entry.User ?? "", (entry.Permissions & (PermissionWrite | PermissionCreate)) != 0));

    /// <summary>The disk shares a person made; the administrative ones (C$, ADMIN$) are left out.</summary>
    internal static ShareInfo[] Shares() =>
        Read<Native.ShareInfo2, ShareInfo?>(
            (out IntPtr buffer, out int read, ref IntPtr resume) =>
                Native.NetShareEnum(null, 2, out buffer, Native.MaxPreferredLength, out read, out _, ref resume),
            entry => (entry.Type & ShareTypeSpecial) == 0 && (entry.Type & ShareTypeMask) == 0 && !string.IsNullOrEmpty(entry.Name)
                ? new ShareInfo(entry.Name, entry.Path ?? "")
                : null)
        .OfType<ShareInfo>().ToArray();

    private static TResult[] Read<TEntry, TResult>(Enumerate enumerate, Func<TEntry, TResult> convert) where TEntry : struct
    {
        var resume = IntPtr.Zero;
        if (enumerate(out var buffer, out var read, ref resume) != 0 || buffer == IntPtr.Zero) return [];
        try
        {
            var size = Marshal.SizeOf<TEntry>();
            var results = new TResult[read];
            for (var index = 0; index < read; index++)
                results[index] = convert(Marshal.PtrToStructure<TEntry>(buffer + index * size));
            return results;
        }
        finally
        {
            _ = Native.NetApiBufferFree(buffer);
        }
    }
}
