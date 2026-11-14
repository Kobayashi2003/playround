using System.Buffers.Binary;
using System.Text;
using Microsoft.Win32.SafeHandles;
using NasDeck.Protocol;

namespace NasDeck.Agent;

internal sealed record ScsiReply(byte Status, byte[] Data, byte[] Sense)
{
    internal bool Good => Status == 0;
}

/// <summary>
/// SCSI commands through <c>IOCTL_SCSI_PASS_THROUGH</c>, for disks behind a SAS host bus adapter, and the parsing
/// of what they return. ATA disks behind such an adapter are reached through it too, see <see cref="AtaCommand"/>.
/// </summary>
internal static class ScsiCommand
{
    private const uint IoctlScsiPassThrough = 0x0004D004;
    // SCSI_PASS_THROUGH on x64 is 56 bytes; the sense buffer follows it and the data follows the sense.
    private const int HeaderSize = 56;
    private const int SenseSize = 32;
    private const int DataOffset = HeaderSize + SenseSize;

    internal const byte CheckCondition = 0x02;

    /// <summary>Sends a command that reads <paramref name="dataLength"/> bytes, or none; null when Windows refuses it.</summary>
    internal static ScsiReply? Send(SafeFileHandle disk, ReadOnlySpan<byte> cdb, int dataLength = 0)
    {
        var buffer = new byte[DataOffset + dataLength];
        BinaryPrimitives.WriteUInt16LittleEndian(buffer, HeaderSize);
        buffer[6] = (byte)cdb.Length;
        buffer[7] = SenseSize;
        buffer[8] = (byte)(dataLength > 0 ? 1 : 2); // SCSI_IOCTL_DATA_IN, or UNSPECIFIED
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(12), dataLength);
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(16), 15);
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(24), DataOffset);
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(32), HeaderSize);
        cdb.CopyTo(buffer.AsSpan(36));
        if (!Native.DeviceIoControl(disk, IoctlScsiPassThrough, buffer, buffer.Length, buffer, buffer.Length, out _, IntPtr.Zero))
            return null;
        return new ScsiReply(buffer[2], buffer[DataOffset..], buffer[HeaderSize..DataOffset]);
    }

    /// <summary>Sense key, additional sense code and qualifier, from fixed or descriptor format sense data.</summary>
    internal static (byte Key, byte Code, byte Qualifier) ParseSense(ReadOnlySpan<byte> sense) => (sense.Length > 0 ? sense[0] & 0x7F : 0) switch
    {
        0x70 or 0x71 when sense.Length >= 14 => ((byte)(sense[2] & 0x0F), sense[12], sense[13]),
        0x72 or 0x73 when sense.Length >= 4 => ((byte)(sense[1] & 0x0F), sense[2], sense[3]),
        _ => (0, 0, 0)
    };

    /// <summary>INQUIRY's vendor field: "ATA" for a SATA disk that the adapter translates for.</summary>
    internal static string? Vendor(SafeFileHandle disk)
    {
        var reply = Send(disk, [0x12, 0, 0, 0, 36, 0], 36);
        return reply is { Good: true } ? Encoding.ASCII.GetString(reply.Data, 8, 8).Trim() : null;
    }

    /// <summary>
    /// REQUEST SENSE reports the power condition without changing it: "low power condition on" with qualifier
    /// 2 or 4 is the standby that <see cref="Standby"/> requests, in which the spindle is stopped.
    /// </summary>
    internal static DiskPower ReadPower(SafeFileHandle disk)
    {
        var reply = Send(disk, [0x03, 0, 0, 0, 252, 0], 252);
        if (reply is not { Good: true }) return DiskPower.Unknown;
        return PowerFromSense(reply.Data);
    }

    internal static DiskPower PowerFromSense(ReadOnlySpan<byte> sense) =>
        ParseSense(sense) is { Code: 0x5E, Qualifier: 0x02 or 0x04 } ? DiskPower.Standby : DiskPower.Spinning;

    // START STOP UNIT with IMMED and a power condition rather than STOP: from standby the disk spins up by
    // itself on the next read or write, where a stopped one would wait for an explicit START.
    internal static bool Standby(SafeFileHandle disk) => Send(disk, [0x1B, 0x01, 0, 0, 0x30, 0]) is { Good: true };

    internal static bool SpinUp(SafeFileHandle disk) => Send(disk, [0x1B, 0x01, 0, 0, 0x10, 0]) is { Good: true };

    /// <summary>The SAS counterparts of SMART, from the drive's log pages. Only for a spinning disk.</summary>
    internal static DiskReport? ReadReport(SafeFileHandle disk, DateTimeOffset now)
    {
        var temperaturePage = LogPage(disk, 0x0D);
        var cycles = LogPage(disk, 0x0E);
        var background = LogPage(disk, 0x15);
        var writes = LogPage(disk, 0x02);
        var reads = LogPage(disk, 0x03);
        var verifies = LogPage(disk, 0x05);
        var nonMedium = LogPage(disk, 0x06);
        var exceptions = LogPage(disk, 0x2F);

        // Byte 1 of a temperature parameter is degrees Celsius; 0xFF means no reading.
        static int? Degrees(long? value) => value is { } raw && (raw & 0xFF) is > 0 and < 0xFF ? (int)(raw & 0xFF) : null;
        var degrees = Degrees(Value(temperaturePage, 0x0000));
        var minutes = Value(background, 0x0000, length: 4);
        if (degrees is null && minutes is null && cycles is null) return null;

        var startStop = Value(cycles, 0x0004);
        var defects = GrownDefects(disk);
        long? uncorrected = Value(reads, 0x0006) is null && Value(writes, 0x0006) is null
            ? null
            : (Value(reads, 0x0006) ?? 0) + (Value(writes, 0x0006) ?? 0);
        // The informational exceptions parameter starts with a sense code; 5D is "failure prediction threshold exceeded".
        var prediction = Value(exceptions, 0x0000, length: 2);

        var rows = new List<DiskAttribute>();
        void Row(string name, long? value, string unit = "", bool cautionAboveZero = false)
        {
            if (value is null) return;
            rows.Add(new DiskAttribute("", name, null, null, null, value.Value.ToString("N0") + unit,
                cautionAboveZero && value > 0 ? HealthStatus.Caution : HealthStatus.Good));
        }
        if (prediction is { } code)
            rows.Add(new DiskAttribute("", "Failure Prediction", null, null, null,
                code >> 8 == 0x5D ? $"Failure predicted ({code:X4})" : "None", code >> 8 == 0x5D ? HealthStatus.Bad : HealthStatus.Good));
        Row("Temperature", degrees, " °C");
        Row("Reference Temperature", Degrees(Value(temperaturePage, 0x0001)), " °C");
        Row("Power-On Hours", minutes / 60);
        Row("Start-Stop Cycles", startStop);
        Row("Specified Start-Stop Cycles", Value(cycles, 0x0003));
        Row("Load-Unload Cycles", Value(cycles, 0x0006));
        Row("Specified Load-Unload Cycles", Value(cycles, 0x0005));
        Row("Grown Defects", defects, cautionAboveZero: true);
        Row("Read Errors Corrected", Value(reads, 0x0003));
        Row("Read Errors Uncorrected", Value(reads, 0x0006), cautionAboveZero: true);
        Row("Write Errors Corrected", Value(writes, 0x0003));
        Row("Write Errors Uncorrected", Value(writes, 0x0006), cautionAboveZero: true);
        Row("Verify Errors Uncorrected", Value(verifies, 0x0006), cautionAboveZero: true);
        Row("Non-Medium Errors", Value(nonMedium, 0x0000));

        var smart = new SmartInfo(degrees, minutes / 60, startStop, Value(cycles, 0x0006), defects, null, uncorrected, now);
        return new DiskReport(smart, DiskReport.Worst(rows), rows.ToArray(), startStop, RotationRate(disk), "SAS");
    }

    private static long? Value(byte[]? page, int code, int length = 8) => page is null ? null : Parameter(page, code, length);

    /// <summary>The Block Device Characteristics page: 1 is solid state, anything larger the rotation rate.</summary>
    private static int? RotationRate(SafeFileHandle disk)
    {
        var reply = Send(disk, [0x12, 0x01, 0xB1, 0, 64, 0], 64);
        if (reply is not { Good: true } || reply.Data[1] != 0xB1) return null;
        var rate = BinaryPrimitives.ReadUInt16BigEndian(reply.Data.AsSpan(4));
        return rate is 1 or (> 0x0400 and < 0xFFFF) ? rate : null;
    }

    private static byte[]? LogPage(SafeFileHandle disk, byte page)
    {
        // PC 01: cumulative values.
        var reply = Send(disk, [0x4D, 0, (byte)(0x40 | page), 0, 0, 0, 0, 0x02, 0x00, 0], 512);
        return reply is { Good: true } && (reply.Data[0] & 0x3F) == page ? reply.Data : null;
    }

    /// <summary>
    /// A log parameter's value as a big-endian number, or null when the page lacks it. <paramref name="length"/>
    /// limits it to the first bytes, for parameters that pack several fields.
    /// </summary>
    internal static long? Parameter(ReadOnlySpan<byte> page, int code, int length = 8)
    {
        if (page.Length < 4) return null;
        var end = Math.Min(page.Length, 4 + BinaryPrimitives.ReadUInt16BigEndian(page[2..]));
        for (var offset = 4; offset + 4 <= end;)
        {
            var size = page[offset + 3];
            if (BinaryPrimitives.ReadUInt16BigEndian(page[offset..]) == code && offset + 4 + size <= end)
            {
                long value = 0;
                foreach (var b in page.Slice(offset + 4, Math.Min(size, length))) value = value << 8 | b;
                return value;
            }
            offset += 4 + size;
        }
        return null;
    }

    /// <summary>The grown defect list's length, the SAS counterpart of reallocated sectors.</summary>
    private static long? GrownDefects(SafeFileHandle disk)
    {
        // READ DEFECT DATA (10), grown list only, in the 8-byte physical sector format; the header is enough.
        var reply = Send(disk, [0x37, 0, 0x0D, 0, 0, 0, 0, 0, 4, 0], 4);
        // A disk that keeps the list in another format answers with a recovered error and still fills the header.
        if (reply is null || (!reply.Good && ParseSense(reply.Sense).Key != 0x01)) return null;
        return BinaryPrimitives.ReadUInt16BigEndian(reply.Data.AsSpan(2)) / 8;
    }
}
