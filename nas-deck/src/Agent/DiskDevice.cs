using System.Buffers.Binary;
using System.Text;
using Microsoft.Win32.SafeHandles;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>How the agent talks to a disk, which depends on how it is attached rather than what it is.</summary>
internal enum DiskProtocol
{
    /// <summary>Nothing beyond what Windows reports: NVMe, USB and the like.</summary>
    None,
    /// <summary>A SATA disk on the motherboard's controller.</summary>
    Ata,
    /// <summary>A SATA disk behind a SAS adapter, which translates ATA commands sent inside SCSI ones.</summary>
    Sat,
    /// <summary>A SAS disk.</summary>
    Scsi
}

internal sealed record DiskIdentity(int Number, string Model, string Serial, string Bus, bool Rotational, long SizeBytes,
    DiskProtocol Protocol, string Firmware = "")
{
    internal bool CanSleep => Rotational && Protocol != DiskProtocol.None;
}

internal readonly record struct DiskCounters(long BytesRead, long BytesWritten, long Operations);

/// <summary>
/// Raw access to <c>\\.\PhysicalDriveN</c>. Nothing here reads the platters, so a sleeping disk stays asleep,
/// except <see cref="SpinUp"/> and the health readings, which a caller sends only to a spinning disk.
/// </summary>
internal static class DiskDevice
{
    private const uint IoctlDiskPerformance = 0x00070020;
    private const uint IoctlDiskGetLengthInfo = 0x0007405C;
    private const uint IoctlStorageQueryProperty = 0x002D1400;
    private const uint IoctlStorageGetDeviceNumber = 0x002D1080;

    private const int StorageDeviceProperty = 0;
    private const int StorageDeviceSeekPenaltyProperty = 7;
    private const int StorageDeviceTemperatureProperty = 52;

    private static SafeFileHandle Open(string path, uint access) =>
        Native.CreateFileW(path, access, Native.ShareReadWrite, IntPtr.Zero, Native.OpenExisting, 0, IntPtr.Zero);

    private static SafeFileHandle OpenDisk(int number, bool command = false) =>
        Open($@"\\.\PhysicalDrive{number}", command ? Native.GenericRead | Native.GenericWrite : 0);

    internal static DiskIdentity? Identify(int number)
    {
        using var disk = OpenDisk(number);
        if (disk.IsInvalid) return null;

        var descriptor = QueryProperty(disk, StorageDeviceProperty, size: 1024);
        if (descriptor is null) return null;
        var model = (ReadText(descriptor, 12) + " " + ReadText(descriptor, 16)).Trim();
        var firmware = ReadText(descriptor, 20);
        var serial = ReadText(descriptor, 24);
        var bus = BinaryPrimitives.ReadInt32LittleEndian(descriptor.AsSpan(28)) switch
        {
            3 => "ATA", 7 => "USB", 8 => "RAID", 10 => "SAS", 11 => "SATA", 17 => "NVMe", _ => "Other"
        };
        var seek = QueryProperty(disk, StorageDeviceSeekPenaltyProperty, size: 16);
        var rotational = seek is not null && seek[8] != 0;

        var protocol = DiskProtocol.None;
        using (var commands = OpenDisk(number, command: true))
        {
            if (bus is "SATA" or "ATA") protocol = DiskProtocol.Ata;
            // INQUIRY is answered by the adapter for a SATA disk and from memory by a SAS one: neither spins up.
            else if (bus == "SAS" && !commands.IsInvalid && ScsiCommand.Vendor(commands) is { } vendor)
                protocol = vendor == "ATA" ? DiskProtocol.Sat : DiskProtocol.Scsi;
        }

        long size = 0;
        using (var readable = Open($@"\\.\PhysicalDrive{number}", Native.GenericRead))
        {
            var length = new byte[8];
            if (!readable.IsInvalid && Native.DeviceIoControl(readable, IoctlDiskGetLengthInfo, null, 0, length, 8, out _, IntPtr.Zero))
                size = BinaryPrimitives.ReadInt64LittleEndian(length);
        }
        return new DiskIdentity(number, model, serial, bus, rotational, size, protocol, firmware);
    }

    internal static DiskCounters? ReadCounters(int number)
    {
        using var disk = OpenDisk(number);
        if (disk.IsInvalid) return null;
        var data = new byte[88];
        if (!Native.DeviceIoControl(disk, IoctlDiskPerformance, null, 0, data, data.Length, out _, IntPtr.Zero)) return null;
        return new DiskCounters(
            BinaryPrimitives.ReadInt64LittleEndian(data),
            BinaryPrimitives.ReadInt64LittleEndian(data.AsSpan(8)),
            (long)BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(40)) + BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(44)));
    }

    /// <summary>
    /// Windows powers the device down itself when its own idle timer fires, and a command sent then would
    /// power it back up, so the device power state is read first and the drive is asked only when Windows
    /// believes it is on, which is the case after <see cref="Standby"/>.
    /// </summary>
    internal static DiskPower ReadPower(DiskIdentity identity)
    {
        using var disk = OpenDisk(identity.Number, command: true);
        if (disk.IsInvalid) return DiskPower.Unknown;
        if (Native.GetDevicePowerState(disk, out var on) && !on) return DiskPower.Standby;
        if (identity.Protocol == DiskProtocol.Scsi) return ScsiCommand.ReadPower(disk);
        var reply = AtaCommand.Send(disk, identity.Protocol, AtaCommand.CheckPowerMode);
        return reply is null ? DiskPower.Unknown : PowerFromSectorCount(reply.Count);
    }

    internal static DiskPower PowerFromSectorCount(byte count) => count is 0x00 or 0x01 ? DiskPower.Standby : DiskPower.Spinning;

    internal static bool Standby(DiskIdentity identity)
    {
        using var disk = OpenDisk(identity.Number, command: true);
        if (disk.IsInvalid) return false;
        return identity.Protocol == DiskProtocol.Scsi
            ? ScsiCommand.Standby(disk)
            : AtaCommand.Send(disk, identity.Protocol, AtaCommand.StandbyImmediate) is not null;
    }

    internal static bool SpinUp(DiskIdentity identity)
    {
        using var disk = OpenDisk(identity.Number, command: true);
        if (disk.IsInvalid) return false;
        return identity.Protocol == DiskProtocol.Scsi
            ? ScsiCommand.SpinUp(disk)
            : AtaCommand.Send(disk, identity.Protocol, AtaCommand.IdleImmediate) is not null;
    }

    /// <summary>
    /// SMART for an ATA disk, the log pages for a SAS one, the health log for NVMe, the temperature alone for
    /// anything else. A sleeping hard disk may spin up to answer, so it is not asked.
    /// </summary>
    internal static DiskReport? ReadReport(DiskIdentity identity, DateTimeOffset now)
    {
        using var disk = OpenDisk(identity.Number, command: true);
        if (disk.IsInvalid) return null;
        switch (identity.Protocol)
        {
            case DiskProtocol.Ata or DiskProtocol.Sat:
                byte[]? ReadSmart(byte feature) =>
                    AtaCommand.Send(disk, identity.Protocol, AtaCommand.Smart, feature, lbaMid: 0x4F, lbaHigh: 0xC2, dataSize: 512)?.Data;
                if (ReadSmart(AtaCommand.SmartReadData) is not { } sector) return null;
                var identify = AtaCommand.Send(disk, identity.Protocol, AtaCommand.Identify, dataSize: 512)?.Data;
                return Smart.Report(sector, ReadSmart(AtaCommand.SmartReadThresholds) ?? [], identify ?? [], now);
            case DiskProtocol.Scsi:
                return ScsiCommand.ReadReport(disk, now);
            default:
                if (identity.Bus == "NVMe" && NvmeHealth.Read(disk, now) is { } health) return health;
                return ReadTemperature(disk) is { } degrees
                    ? new DiskReport(new SmartInfo(degrees, null, null, null, null, null, null, now), HealthStatus.Unknown, [])
                    : null;
        }
    }

    /// <summary>The temperature Windows reports, which it can for NVMe.</summary>
    private static int? ReadTemperature(SafeFileHandle disk)
    {
        var data = QueryProperty(disk, StorageDeviceTemperatureProperty, size: 512);
        // STORAGE_TEMPERATURE_DATA_DESCRIPTOR: InfoCount at 12, the first STORAGE_TEMPERATURE_INFO at 24.
        if (data is null || BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(12)) == 0) return null;
        var value = BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan(26));
        return value is > -50 and < 150 ? value : null;
    }

    /// <summary>The physical disk a drive letter lives on, for a volume that sits on one disk.</summary>
    internal static int? DiskNumberOfVolume(char letter)
    {
        using var volume = Open($@"\\.\{letter}:", 0);
        if (volume.IsInvalid) return null;
        var data = new byte[12];
        if (!Native.DeviceIoControl(volume, IoctlStorageGetDeviceNumber, null, 0, data, data.Length, out _, IntPtr.Zero)) return null;
        return BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(4));
    }

    private static byte[]? QueryProperty(SafeFileHandle disk, int propertyId, int size)
    {
        var query = new byte[12];
        BinaryPrimitives.WriteInt32LittleEndian(query, propertyId);
        var data = new byte[size];
        return Native.DeviceIoControl(disk, IoctlStorageQueryProperty, query, query.Length, data, data.Length, out _, IntPtr.Zero)
            ? data
            : null;
    }

    private static string ReadText(byte[] descriptor, int offsetField)
    {
        var offset = BinaryPrimitives.ReadInt32LittleEndian(descriptor.AsSpan(offsetField));
        if (offset <= 0 || offset >= descriptor.Length) return "";
        var end = Array.IndexOf(descriptor, (byte)0, offset);
        return Encoding.ASCII.GetString(descriptor, offset, (end < 0 ? descriptor.Length : end) - offset).Trim();
    }

    /// <summary>A text field of ATA IDENTIFY data, whose words hold their two characters swapped.</summary>
    internal static string IdentifyText(ReadOnlySpan<byte> identify, int word, int words)
    {
        var text = new char[words * 2];
        for (var i = 0; i < words; i++)
        {
            text[i * 2] = (char)identify[(word + i) * 2 + 1];
            text[i * 2 + 1] = (char)identify[(word + i) * 2];
        }
        return new string(text).Trim(' ', '\0');
    }
}
