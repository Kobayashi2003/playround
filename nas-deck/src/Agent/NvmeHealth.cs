using System.Buffers.Binary;
using System.Numerics;
using Microsoft.Win32.SafeHandles;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>The NVMe SMART / Health Information log, which Windows hands out through a storage property query.</summary>
internal static class NvmeHealth
{
    private const uint IoctlStorageQueryProperty = 0x002D1400;
    private const int StorageDeviceProtocolSpecificProperty = 50;
    // STORAGE_PROPERTY_QUERY's two fields, then STORAGE_PROTOCOL_SPECIFIC_DATA, then the log page.
    private const int SpecificDataOffset = 8;
    private const int SpecificDataSize = 40;
    private const int LogSize = 512;

    internal static DiskReport? Read(SafeFileHandle disk, DateTimeOffset now)
    {
        var buffer = new byte[SpecificDataOffset + SpecificDataSize + LogSize];
        BinaryPrimitives.WriteInt32LittleEndian(buffer, StorageDeviceProtocolSpecificProperty);
        var specific = buffer.AsSpan(SpecificDataOffset);
        BinaryPrimitives.WriteInt32LittleEndian(specific, 3);                    // ProtocolTypeNvme
        BinaryPrimitives.WriteInt32LittleEndian(specific[4..], 2);               // NVMeDataTypeLogPage
        BinaryPrimitives.WriteInt32LittleEndian(specific[8..], 2);               // the SMART / Health log
        BinaryPrimitives.WriteInt32LittleEndian(specific[16..], SpecificDataSize);
        BinaryPrimitives.WriteInt32LittleEndian(specific[20..], LogSize);
        if (!Native.DeviceIoControl(disk, IoctlStorageQueryProperty, buffer, buffer.Length, buffer, buffer.Length, out _, IntPtr.Zero))
            return null;
        return Parse(buffer.AsSpan(SpecificDataOffset + SpecificDataSize, LogSize), now);
    }

    internal static DiskReport Parse(ReadOnlySpan<byte> log, DateTimeOffset now)
    {
        var warning = log[0];
        var kelvin = BinaryPrimitives.ReadUInt16LittleEndian(log[1..]);
        int? degrees = kelvin is > 223 and < 423 ? kelvin - 273 : null;
        int spare = log[3], spareThreshold = log[4], used = log[5];
        var powerCycles = Counter(log, 112);
        var hours = Counter(log, 128);
        var mediaErrors = Counter(log, 160);

        var rows = new List<DiskAttribute>();
        void Row(string name, string value, HealthStatus status = HealthStatus.Good) =>
            rows.Add(new DiskAttribute("", name, null, null, null, value, status));
        Row("Critical Warning", warning == 0 ? "None" : $"0x{warning:X2}", warning == 0 ? HealthStatus.Good : HealthStatus.Bad);
        if (degrees is not null) Row("Temperature", $"{degrees} °C");
        Row("Available Spare", $"{spare} %", spare < spareThreshold ? HealthStatus.Bad : HealthStatus.Good);
        Row("Available Spare Threshold", $"{spareThreshold} %");
        Row("Percentage Used", $"{used} %", used >= 90 ? HealthStatus.Caution : HealthStatus.Good);
        // A data unit is a thousand 512-byte blocks.
        Row("Data Read", Format.Bytes(Counter(log, 32) * 512000d));
        Row("Data Written", Format.Bytes(Counter(log, 48) * 512000d));
        Row("Host Read Commands", Counter(log, 64).ToString("N0"));
        Row("Host Write Commands", Counter(log, 80).ToString("N0"));
        Row("Controller Busy Time", $"{Counter(log, 96):N0} min");
        Row("Power Cycles", powerCycles.ToString("N0"));
        Row("Power-On Hours", hours.ToString("N0"));
        Row("Unsafe Shutdowns", Counter(log, 144).ToString("N0"));
        Row("Media and Data Integrity Errors", mediaErrors.ToString("N0"), mediaErrors > 0 ? HealthStatus.Caution : HealthStatus.Good);
        Row("Error Log Entries", Counter(log, 176).ToString("N0"));

        var smart = new SmartInfo(degrees, hours, null, null, null, null, mediaErrors, now);
        return new DiskReport(smart, DiskReport.Worst(rows), rows.ToArray(), powerCycles, Rpm: 1, Interface: "NVMe");
    }

    /// <summary>The log's counters are 16 bytes wide; none outgrows a long in a drive's lifetime.</summary>
    private static long Counter(ReadOnlySpan<byte> log, int offset) =>
        (long)BigInteger.Min(new BigInteger(log.Slice(offset, 16), isUnsigned: true), long.MaxValue);
}
