using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>CPU, memory and network readings; rates are measured between two calls of <see cref="Read"/>.</summary>
internal sealed class SystemMetrics
{
    private readonly string hostName = System.Net.Dns.GetHostName().ToLowerInvariant();
    private readonly string cpuName = ReadCpuName();
    private long lastIdle, lastKernel, lastUser, lastRx, lastTx;
    private long lastTicks;

    internal SystemInfo Read(double? cpuTemperature)
    {
        var ticks = Stopwatch.GetTimestamp();
        var seconds = lastTicks == 0 ? 0 : Stopwatch.GetElapsedTime(lastTicks, ticks).TotalSeconds;

        double cpu = 0;
        if (Native.GetSystemTimes(out var idle, out var kernel, out var user))
        {
            // Kernel time includes idle time.
            var total = kernel - lastKernel + (user - lastUser);
            if (lastTicks != 0 && total > 0) cpu = Math.Clamp(100.0 * (total - (idle - lastIdle)) / total, 0, 100);
            (lastIdle, lastKernel, lastUser) = (idle, kernel, user);
        }

        var memory = new Native.MemoryStatus { Length = (uint)Marshal.SizeOf<Native.MemoryStatus>() };
        Native.GlobalMemoryStatusEx(ref memory);

        long rx = 0, tx = 0;
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (adapter.OperationalStatus != OperationalStatus.Up
                || adapter.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
            var statistics = adapter.GetIPStatistics();
            rx += statistics.BytesReceived;
            tx += statistics.BytesSent;
        }
        // A counter that went backwards means an adapter left; report nothing rather than a spike.
        var rxRate = seconds > 0 && rx >= lastRx ? (rx - lastRx) / seconds : 0;
        var txRate = seconds > 0 && tx >= lastTx ? (tx - lastTx) / seconds : 0;
        (lastRx, lastTx, lastTicks) = (rx, tx, ticks);

        return new SystemInfo(hostName, cpuName, Math.Round(cpu, 1), cpuTemperature,
            (long)memory.TotalPhysical, (long)(memory.TotalPhysical - memory.AvailablePhysical),
            Math.Round(rxRate), Math.Round(txRate), Environment.TickCount64 / 1000);
    }

    private static string ReadCpuName()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
        return (key?.GetValue("ProcessorNameString") as string ?? "").Trim();
    }
}
