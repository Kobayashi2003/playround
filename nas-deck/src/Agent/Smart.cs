using System.Buffers.Binary;
using NasDeck.Protocol;

namespace NasDeck.Agent;

/// <summary>
/// One health reading of a disk: the counters the widget shows, the full table for the disk information panel,
/// and what only a spinning disk can be asked.
/// </summary>
internal sealed record DiskReport(SmartInfo Smart, HealthStatus Health, DiskAttribute[] Attributes, long? PowerCycles = null,
    int? Rpm = null, string? Interface = null, string? Model = null)
{
    internal static HealthStatus Worst(IEnumerable<DiskAttribute> attributes) =>
        attributes.Select(attribute => attribute.Status).DefaultIfEmpty(HealthStatus.Unknown).Max();
}

/// <summary>ATA SMART: the attribute sector, its thresholds and the IDENTIFY data.</summary>
internal static class Smart
{
    private static readonly Dictionary<byte, string> Names = new()
    {
        [0x01] = "Read Error Rate", [0x02] = "Throughput Performance", [0x03] = "Spin-Up Time", [0x04] = "Start/Stop Count",
        [0x05] = "Reallocated Sectors Count", [0x07] = "Seek Error Rate", [0x08] = "Seek Time Performance",
        [0x09] = "Power-On Hours", [0x0A] = "Spin Retry Count", [0x0B] = "Recalibration Retries", [0x0C] = "Power Cycle Count",
        [0x16] = "Helium Level", [0xA7] = "SSD Protect Mode", [0xA8] = "SATA PHY Error Count", [0xA9] = "Bad Block Count",
        [0xAA] = "Available Reserved Space", [0xAB] = "Program Fail Count", [0xAC] = "Erase Fail Count",
        [0xAD] = "Wear Leveling Count", [0xAE] = "Unexpected Power Loss Count", [0xAF] = "Program Fail Count (Chip)",
        [0xB0] = "Erase Fail Count (Chip)", [0xB1] = "Wear Range Delta", [0xB4] = "Unused Reserved Block Count",
        [0xB5] = "Program Fail Count (Total)", [0xB6] = "Erase Fail Count (Total)", [0xB7] = "Runtime Bad Block",
        [0xB8] = "End-to-End Error", [0xBB] = "Reported Uncorrectable Errors", [0xBC] = "Command Timeout",
        [0xBD] = "High Fly Writes", [0xBE] = "Airflow Temperature", [0xBF] = "G-Sense Error Rate",
        [0xC0] = "Power-Off Retract Count", [0xC1] = "Load/Unload Cycle Count", [0xC2] = "Temperature",
        [0xC3] = "Hardware ECC Recovered", [0xC4] = "Reallocation Event Count", [0xC5] = "Current Pending Sector Count",
        [0xC6] = "Uncorrectable Sector Count", [0xC7] = "UltraDMA CRC Error Count", [0xC8] = "Write Error Rate",
        [0xCA] = "Percent Lifetime Remaining", [0xCE] = "Flying Height", [0xDC] = "Disk Shift", [0xDE] = "Loaded Hours",
        [0xDF] = "Load/Unload Retry Count", [0xE0] = "Load Friction", [0xE2] = "Load-In Time", [0xE7] = "SSD Life Left",
        [0xE8] = "Available Reserved Space", [0xE9] = "Media Wearout Indicator", [0xEA] = "Average Erase Count",
        [0xF0] = "Head Flying Hours", [0xF1] = "Total Host Writes", [0xF2] = "Total Host Reads", [0xF5] = "NAND Writes",
        [0xF9] = "NAND Writes (GiB)", [0xFE] = "Free Fall Protection"
    };

    /// <summary>Reads the attributes the widget shows out of an ATA SMART attribute sector.</summary>
    internal static SmartInfo Parse(ReadOnlySpan<byte> sector, DateTimeOffset readAt)
    {
        int? temperature = null;
        long? hours = null, startStop = null, loadCycles = null, reallocated = null, pending = null, uncorrectable = null;
        // Thirty 12-byte entries from offset 2: id, flags (2), value, worst, raw (6), reserved.
        for (var offset = 2; offset + 12 <= 362 && offset + 12 <= sector.Length; offset += 12)
        {
            var id = sector[offset];
            if (id == 0) continue;
            var raw = sector.Slice(offset + 5, 6);
            var low = BinaryPrimitives.ReadUInt32LittleEndian(raw);
            switch (id)
            {
                case 4: startStop = low; break;
                case 5: reallocated = low; break;
                // Some drives keep minutes in the upper raw bytes; the low four are the hours.
                case 9: hours = low; break;
                case 193: loadCycles = low; break;
                // The raw value also carries the lifetime minimum and maximum; the low byte is the reading.
                case 194: temperature = raw[0]; break;
                case 190: temperature ??= raw[0]; break;
                case 197: pending = low; break;
                case 198: uncorrectable = low; break;
            }
        }
        if (temperature is <= 0 or > 120) temperature = null;
        return new SmartInfo(temperature, hours, startStop, loadCycles, reallocated, pending, uncorrectable, readAt);
    }

    /// <summary>
    /// The whole table. An attribute below its threshold is failing; reallocated, pending or uncorrectable
    /// sectors are a caution, as CrystalDiskInfo rates them.
    /// </summary>
    internal static DiskReport Report(ReadOnlySpan<byte> sector, ReadOnlySpan<byte> thresholds, ReadOnlySpan<byte> identify, DateTimeOffset readAt)
    {
        var limits = new Dictionary<byte, byte>();
        for (var offset = 2; offset + 12 <= 362 && offset + 12 <= thresholds.Length; offset += 12)
            if (thresholds[offset] != 0) limits[thresholds[offset]] = thresholds[offset + 1];

        var attributes = new List<DiskAttribute>();
        long? powerCycles = null;
        for (var offset = 2; offset + 12 <= 362 && offset + 12 <= sector.Length; offset += 12)
        {
            var id = sector[offset];
            if (id == 0) continue;
            var raw = sector.Slice(offset + 5, 6);
            var low = BinaryPrimitives.ReadUInt32LittleEndian(raw);
            if (id == 0x0C) powerCycles = low;
            int current = sector[offset + 3];
            int? threshold = limits.TryGetValue(id, out var limit) ? limit : null;
            var status = threshold > 0 && current < threshold ? HealthStatus.Bad
                : id is 0x05 or 0xC5 or 0xC6 && low > 0 ? HealthStatus.Caution
                : HealthStatus.Good;
            // Shown most significant byte first, the way the raw column is usually read.
            var reversed = raw.ToArray();
            Array.Reverse(reversed);
            attributes.Add(new DiskAttribute(id.ToString("X2"), Names.GetValueOrDefault(id, "Vendor Specific"), current, sector[offset + 4],
                threshold, Convert.ToHexString(reversed), status));
        }

        int? rpm = null;
        string? link = null, model = null;
        if (identify.Length >= 512)
        {
            // Word 217: 1 is a solid-state drive, anything larger the rotation rate.
            var rate = BinaryPrimitives.ReadUInt16LittleEndian(identify[(217 * 2)..]);
            if (rate is 1 or (> 0x0400 and < 0xFFFF)) rpm = rate;
            // Word 77 bits 3:1 hold the negotiated SATA generation; word 76 the ones the drive supports.
            var generation = BinaryPrimitives.ReadUInt16LittleEndian(identify[(77 * 2)..]) >> 1 & 0x7;
            if (generation == 0)
            {
                var supported = BinaryPrimitives.ReadUInt16LittleEndian(identify[(76 * 2)..]);
                generation = supported is 0 or 0xFFFF ? 0 : (supported & 0x8) != 0 ? 3 : (supported & 0x4) != 0 ? 2 : (supported & 0x2) != 0 ? 1 : 0;
            }
            link = generation switch { 1 => "SATA 1.5 Gb/s", 2 => "SATA 3.0 Gb/s", 3 => "SATA 6.0 Gb/s", _ => "SATA" };
            model = DiskDevice.IdentifyText(identify, word: 27, words: 20) is { Length: > 0 } name ? name : null;
        }
        // Solid-state drives reuse the numbers of mechanical attributes for readings of their own.
        if (rpm == 1)
            for (var index = 0; index < attributes.Count; index++)
                if (attributes[index].Id is "02" or "03" or "07" or "08" or "0A" or "0B" or "BD" or "CE" or "DC" or "DE" or "DF" or "E0" or "E2" or "F0")
                    attributes[index] = attributes[index] with { Name = "Vendor Specific" };
        return new DiskReport(Parse(sector, readAt), DiskReport.Worst(attributes), attributes.ToArray(), powerCycles, rpm, link, model);
    }
}
