using System.Buffers.Binary;
using Microsoft.Win32.SafeHandles;

namespace NasDeck.Agent;

/// <summary>What an ATA command returned: the sector count register and any data read.</summary>
internal sealed record AtaReply(byte Count, byte[] Data);

/// <summary>
/// ATA commands, sent straight to a SATA disk with <c>IOCTL_ATA_PASS_THROUGH</c>, or wrapped in the SCSI
/// ATA PASS-THROUGH (16) command for a SATA disk behind a SAS adapter (SAT, what smartctl calls <c>-d sat</c>).
/// The two are not interchangeable: an adapter's driver answers the direct form with success and blank registers.
/// </summary>
internal static class AtaCommand
{
    private const uint IoctlAtaPassThrough = 0x0004D02C;
    private const int HeaderSize = 48;

    internal const byte CheckPowerMode = 0xE5;
    internal const byte StandbyImmediate = 0xE0;
    internal const byte IdleImmediate = 0xE1;
    internal const byte Identify = 0xEC;
    internal const byte Smart = 0xB0;
    // Feature register values for the SMART command.
    internal const byte SmartReadData = 0xD0;
    internal const byte SmartReadThresholds = 0xD1;

    /// <summary>Null when the command failed. <paramref name="dataSize"/> bytes are read with a PIO data-in command.</summary>
    internal static AtaReply? Send(SafeFileHandle disk, DiskProtocol protocol, byte command, byte features = 0,
        byte lbaMid = 0, byte lbaHigh = 0, int dataSize = 0) => protocol switch
    {
        DiskProtocol.Ata => Direct(disk, command, features, lbaMid, lbaHigh, dataSize),
        DiskProtocol.Sat => Translated(disk, command, features, lbaMid, lbaHigh, dataSize),
        _ => null
    };

    private static AtaReply? Direct(SafeFileHandle disk, byte command, byte features, byte lbaMid, byte lbaHigh, int dataSize)
    {
        var buffer = new byte[HeaderSize + dataSize];
        BinaryPrimitives.WriteUInt16LittleEndian(buffer, HeaderSize);
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(2), (ushort)(0x01 | (dataSize > 0 ? 0x02 : 0))); // READY, DATA_IN
        BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(8), (uint)dataSize);
        BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(12), 10);
        BinaryPrimitives.WriteUInt64LittleEndian(buffer.AsSpan(24), HeaderSize);
        var task = buffer.AsSpan(40, 8);
        task[0] = features;
        task[1] = (byte)(dataSize > 0 ? 1 : 0);
        task[3] = lbaMid;
        task[4] = lbaHigh;
        task[6] = command;
        if (!Native.DeviceIoControl(disk, IoctlAtaPassThrough, buffer, buffer.Length, buffer, buffer.Length, out _, IntPtr.Zero)) return null;
        // On return the task file holds the registers: [0] error, [1] sector count, [6] status with bit 0 as ERR.
        return (buffer[46] & 0x01) != 0 ? null : new AtaReply(buffer[41], buffer[HeaderSize..]);
    }

    private static AtaReply? Translated(SafeFileHandle disk, byte command, byte features, byte lbaMid, byte lbaHigh, int dataSize)
    {
        Span<byte> cdb = stackalloc byte[16];
        cdb[0] = 0x85;
        // Protocol 4 is PIO data-in, 3 non-data. A non-data command asks for the registers back (CK_COND).
        cdb[1] = (byte)((dataSize > 0 ? 4 : 3) << 1);
        cdb[2] = (byte)(dataSize > 0 ? 0x0E : 0x20);
        cdb[4] = features;
        cdb[6] = (byte)(dataSize > 0 ? 1 : 0);
        cdb[10] = lbaMid;
        cdb[12] = lbaHigh;
        cdb[14] = command;
        var reply = ScsiCommand.Send(disk, cdb, dataSize);
        if (reply is null) return null;
        if (dataSize > 0) return reply.Good ? new AtaReply(0, reply.Data) : null;
        if (reply.Good) return new AtaReply(0, []);
        return reply.Status == ScsiCommand.CheckCondition && Registers(reply.Sense) is { } registers && (registers.Status & 0x01) == 0
            ? new AtaReply(registers.Count, [])
            : null;
    }

    /// <summary>The ATA status return that SAT puts in the sense data, in descriptor or fixed format.</summary>
    internal static (byte Count, byte Status)? Registers(ReadOnlySpan<byte> sense)
    {
        switch (sense.Length > 0 ? sense[0] & 0x7F : 0)
        {
            case 0x72 when sense.Length >= 8:
                for (var offset = 8; offset + 14 <= sense.Length && offset < 8 + sense[7];)
                {
                    if (sense[offset] == 0x09) return (sense[offset + 5], sense[offset + 13]);
                    offset += 2 + sense[offset + 1];
                }
                return null;
            case 0x70 when sense.Length >= 7 && ScsiCommand.ParseSense(sense) is { Code: 0x00, Qualifier: 0x1D }:
                return (sense[6], sense[4]);
            default:
                return null;
        }
    }
}
