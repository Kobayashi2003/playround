using NasDeck.Agent;
using NasDeck.Protocol;
using Xunit;

namespace NasDeck.Tests;

public class FormatTests
{
    [Theory]
    [InlineData(0, "0 B")]
    [InlineData(999, "999 B")]
    [InlineData(1536, "1.50 KB")]
    [InlineData(110.0 * 1024 * 1024, "110 MB")]
    [InlineData(4000787030016, "3.64 TB")]
    public void Bytes_keeps_three_significant_digits(double bytes, string expected) => Assert.Equal(expected, Format.Bytes(bytes));

    [Theory]
    [InlineData(15, "15s")]
    [InlineData(2520, "42m")]
    [InlineData(7500, "2h 5m")]
    [InlineData(273600, "3d 4h")]
    public void Duration_shows_the_two_largest_units(long seconds, string expected) => Assert.Equal(expected, Format.Duration(seconds));

    [Theory]
    [InlineData(0, "never")]
    [InlineData(1200, "20 min")]
    [InlineData(3600, "1 h")]
    [InlineData(5400, "1 h 30 min")]
    public void Timeout_reads_like_a_menu(int seconds, string expected) => Assert.Equal(expected, Format.Timeout(seconds));

    [Theory]
    [InlineData("WDC WD40EZAX-00C8UB0", "WD40EZAX")]
    [InlineData("WUS721208BLE6L4", "WUS721208BLE6L4")]
    [InlineData("WDC PC SN730 SDBQNTY-256G-1001", "PC SN730 SDBQNTY")]
    [InlineData("TOSHIBA-TR200", "TR200")]
    [InlineData("HGST HUH721010AL5200", "HUH721010AL5200")]
    [InlineData("ZHITAI SC001 Active 512GB SSD", "ZHITAI SC001 Active 512GB SSD")]
    public void ShortModel_drops_the_vendor_and_the_revision(string model, string expected) => Assert.Equal(expected, Format.ShortModel(model));
}

public class SmartTests
{
    private static byte[] Sector(params (byte Id, long Raw)[] attributes)
    {
        var sector = new byte[512];
        for (var index = 0; index < attributes.Length; index++)
        {
            var offset = 2 + index * 12;
            sector[offset] = attributes[index].Id;
            BitConverter.GetBytes(attributes[index].Raw).AsSpan(0, 6).CopyTo(sector.AsSpan(offset + 5));
        }
        return sector;
    }

    [Fact]
    public void Parse_reads_the_attributes_the_widget_shows()
    {
        // Attribute 194 packs minimum and maximum above the reading: 0x002D_0012_0022 is 34 °C now.
        var smart = Smart.Parse(Sector((4, 1204), (5, 0), (9, 21034), (193, 8311), (194, 0x002D00120022), (197, 2), (198, 1)), DateTimeOffset.UnixEpoch);
        Assert.Equal(34, smart.TemperatureC);
        Assert.Equal(21034, smart.PowerOnHours);
        Assert.Equal(1204, smart.StartStopCount);
        Assert.Equal(8311, smart.LoadCycleCount);
        Assert.Equal(0, smart.Reallocated);
        Assert.Equal(2, smart.Pending);
        Assert.Equal(1, smart.Uncorrectable);
    }

    [Fact]
    public void Parse_falls_back_to_the_airflow_temperature()
    {
        Assert.Equal(31, Smart.Parse(Sector((190, 31)), DateTimeOffset.UnixEpoch).TemperatureC);
        Assert.Equal(40, Smart.Parse(Sector((190, 31), (194, 40)), DateTimeOffset.UnixEpoch).TemperatureC);
        Assert.Null(Smart.Parse(Sector(), DateTimeOffset.UnixEpoch).TemperatureC);
    }

    [Theory]
    [InlineData(0x00, DiskPower.Standby)]
    [InlineData(0x80, DiskPower.Spinning)]
    [InlineData(0xFF, DiskPower.Spinning)]
    public void Check_power_mode_maps_to_a_power_state(byte sectorCount, DiskPower expected) =>
        Assert.Equal(expected, DiskDevice.PowerFromSectorCount(sectorCount));
}

public class SleepGuardTests
{
    private static readonly DiskIdentity HardDisk = new(1, "WDC WD40EZAX", "S1", "SATA", true, 4000787030016, DiskProtocol.Ata);
    private static readonly DateTimeOffset Now = new(2026, 11, 14, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void An_idle_disk_may_sleep() =>
        Assert.Null(SleepGuard.Refuse(HardDisk, DiskPower.Spinning, Now, Now.AddMinutes(-5), null, force: false));

    [Fact]
    public void A_disk_in_use_is_left_spinning_unless_forced()
    {
        Assert.Equal("busy", SleepGuard.Refuse(HardDisk, DiskPower.Spinning, Now, Now.AddSeconds(-5), null, force: false)?.Code);
        Assert.Null(SleepGuard.Refuse(HardDisk, DiskPower.Spinning, Now, Now.AddSeconds(-5), null, force: true));
    }

    [Fact]
    public void A_disk_that_just_woke_from_a_commanded_sleep_cools_down_first()
    {
        var reply = SleepGuard.Refuse(HardDisk, DiskPower.Spinning, Now, Now.AddMinutes(-2), Now.AddMinutes(-4), force: false);
        Assert.Equal("cooldown", reply?.Code);
        Assert.Contains("6 min", reply!.Message);
        Assert.Null(SleepGuard.Refuse(HardDisk, DiskPower.Spinning, Now, Now.AddMinutes(-2), Now.AddMinutes(-11), force: false));
    }

    [Fact]
    public void A_sleeping_disk_is_not_commanded_again()
    {
        var reply = SleepGuard.Refuse(HardDisk, DiskPower.Standby, Now, Now.AddHours(-1), null, force: true);
        Assert.True(reply is { Ok: true, Code: "asleep" });
    }

    [Theory]
    [InlineData("None", false)]
    [InlineData("Sat", false)]
    [InlineData("None", true)]
    public void Only_hard_disks_the_agent_can_command_take_it(string protocol, bool rotational) =>
        Assert.Equal("unsupported", SleepGuard.Refuse(HardDisk with { Protocol = Enum.Parse<DiskProtocol>(protocol), Rotational = rotational }, DiskPower.Spinning, Now, Now.AddHours(-1), null, force: true)?.Code);

    [Theory]
    [InlineData(299, false)]
    [InlineData(300, true)]
    public void A_disk_sleeps_once_its_idle_time_is_up(int idle, bool expired) =>
        Assert.Equal(expired, SleepGuard.IdleExpired(HardDisk, DiskPower.Spinning, Now, Now.AddSeconds(-idle), 300));

    [Fact]
    public void The_idle_timer_skips_disabled_asleep_and_unknown_disks()
    {
        Assert.False(SleepGuard.IdleExpired(HardDisk, DiskPower.Spinning, Now, Now.AddHours(-5), 0));
        Assert.False(SleepGuard.IdleExpired(HardDisk, DiskPower.Standby, Now, Now.AddHours(-5), 300));
        Assert.False(SleepGuard.IdleExpired(HardDisk, DiskPower.Unknown, Now, Now.AddHours(-5), 300));
        Assert.False(SleepGuard.IdleExpired(HardDisk with { Bus = "NVMe", Rotational = false, Protocol = DiskProtocol.None }, DiskPower.Spinning, Now, Now.AddHours(-5), 300));
    }
}

public class WakeLogTests
{
    [Fact]
    public void Spin_ups_are_counted_per_day_and_the_log_is_bounded()
    {
        var record = new DiskRecord();
        var day = new DateTimeOffset(2026, 11, 14, 23, 0, 0, TimeSpan.Zero);
        for (var index = 0; index < 20; index++) record.RecordWake(day.AddMinutes(index), $"cause {index}");
        Assert.Equal(20, record.SpinUps);
        Assert.Equal(DiskRecord.WakesKept, record.Wakes.Count);
        Assert.Equal("cause 19", record.Wakes[0].Cause);

        record.RollDay(day.AddHours(2));
        Assert.Equal(0, record.SpinUps);
        Assert.Equal(DiskRecord.WakesKept, record.Wakes.Count);
    }

    [Fact]
    public void A_wake_is_put_down_to_a_network_file_on_that_disk_first()
    {
        VolumeInfo[] volumes = [new("F:", "HDD", 1, 1)];
        SmbOpenFile[] files = [new(@"H:\other.bin", "ann", false), new(@"F:\media\film.mkv", "ben", false)];
        Assert.Equal(@"SMB · ben · F:\media\film.mkv", Sampler.WakeCause(volumes, files, ["SearchIndexer"]));
        Assert.Equal("Local · SearchIndexer, MsMpEng", Sampler.WakeCause(volumes, files[..1], ["SearchIndexer", "MsMpEng"]));
        Assert.Equal("Unknown", Sampler.WakeCause(volumes, [], []));
    }

    [Fact]
    public void State_survives_a_round_trip()
    {
        var path = Path.Combine(Path.GetTempPath(), $"nasdeck-test-{Guid.NewGuid():N}", "state.json");
        try
        {
            var state = new AgentState { AutoHibernateMinutes = 60 };
            state.Disks["S1"] = new DiskRecord();
            state.Disks["S1"].RecordWake(DateTimeOffset.UnixEpoch, "Unknown");
            state.Save(path);
            var loaded = AgentState.Load(path);
            Assert.Equal(60, loaded.AutoHibernateMinutes);
            Assert.Equal(1, loaded.Disks["S1"].SpinUps);
            Assert.Equal("Unknown", loaded.Disks["S1"].Wakes[0].Cause);
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(path)!, recursive: true);
        }
    }
}

public class HbaTests
{
    private static byte[] Bytes(string hex) => Convert.FromHexString(hex.Replace(" ", ""));

    [Fact]
    public void Sas_log_pages_give_temperature_and_cycles()
    {
        // Captured from an HGST HUH721010AL5200 behind a SAS3008: 32 °C, 49 start-stop cycles.
        var temperature = Bytes("0D 00 00 0C 00 00 43 02 00 20 00 01 43 02 00 32");
        var cycles = Bytes("0E 00 00 34 00 01 41 06 32 30 31 37 33 31 00 02 01 06 32 30 31 37 33 31 00 03 43 04 00 00 C3 50 00 04 43 04 00 00 00 31");
        Assert.Equal(0x20, ScsiCommand.Parameter(temperature, 0x0000));
        Assert.Equal(49, ScsiCommand.Parameter(cycles, 0x0004));
        Assert.Equal(50000, ScsiCommand.Parameter(cycles, 0x0003));
        Assert.Null(ScsiCommand.Parameter(cycles, 0x0006));
    }

    [Theory]
    [InlineData("70 00 00 00 00 00 00 0A 00 00 00 00 00 00", DiskPower.Spinning)]
    [InlineData("70 00 00 00 00 00 00 0A 00 00 00 00 5E 04", DiskPower.Standby)]
    [InlineData("70 00 00 00 00 00 00 0A 00 00 00 00 5E 02", DiskPower.Standby)]
    [InlineData("70 00 00 00 00 00 00 0A 00 00 00 00 5E 05", DiskPower.Spinning)]
    [InlineData("72 00 5E 04", DiskPower.Standby)]
    public void Request_sense_reports_a_sas_disk_in_standby(string sense, DiskPower expected) =>
        Assert.Equal(expected, ScsiCommand.PowerFromSense(Bytes(sense)));

    [Fact]
    public void Sat_returns_the_ata_registers_in_the_sense_data()
    {
        // CHECK POWER MODE on a SATA SSD behind the same adapter: count 0xFF (active), status 0x50.
        var sense = Bytes("72 01 00 1D 00 00 00 0E 09 0C 00 00 00 FF 00 00 00 00 00 00 00 50 00 00 00 00 00 00 00 00 00 00");
        Assert.Equal(((byte)0xFF, (byte)0x50), AtaCommand.Registers(sense));
        Assert.Null(AtaCommand.Registers(Bytes("72 05 20 00 00 00 00 00")));
    }

    [Fact]
    public void Identify_text_swaps_each_pair_of_characters() =>
        Assert.Equal("ZHITAI SC001", DiskDevice.IdentifyText(System.Text.Encoding.ASCII.GetBytes("HZTIIAS 0C10    "), 0, 8));
}

public class DiskReportTests
{
    private static byte[] Sector(params (byte Id, byte Current, byte Worst, long Raw)[] attributes)
    {
        var sector = new byte[512];
        for (var index = 0; index < attributes.Length; index++)
        {
            var offset = 2 + index * 12;
            (sector[offset], sector[offset + 3], sector[offset + 4]) = (attributes[index].Id, attributes[index].Current, attributes[index].Worst);
            BitConverter.GetBytes(attributes[index].Raw).AsSpan(0, 6).CopyTo(sector.AsSpan(offset + 5));
        }
        return sector;
    }

    private static byte[] Thresholds(params (byte Id, byte Limit)[] limits)
    {
        var sector = new byte[512];
        for (var index = 0; index < limits.Length; index++)
            (sector[2 + index * 12], sector[3 + index * 12]) = (limits[index].Id, limits[index].Limit);
        return sector;
    }

    private static byte[] Identify(ushort rotation, ushort negotiated)
    {
        var identify = new byte[512];
        System.Text.Encoding.ASCII.GetBytes("DW04ZEXA").CopyTo(identify, 27 * 2);
        BitConverter.GetBytes(rotation).CopyTo(identify, 217 * 2);
        BitConverter.GetBytes(negotiated).CopyTo(identify, 77 * 2);
        return identify;
    }

    [Fact]
    public void A_healthy_table_is_good_and_keeps_every_column()
    {
        var report = Smart.Report(Sector((0x05, 200, 200, 0), (0x0C, 100, 100, 864), (0xC2, 119, 104, 0x1C)),
            Thresholds((0x05, 140)), Identify(5400, 3 << 1), DateTimeOffset.UnixEpoch);
        Assert.Equal(HealthStatus.Good, report.Health);
        Assert.Equal(864, report.PowerCycles);
        Assert.Equal(5400, report.Rpm);
        Assert.Equal("SATA 6.0 Gb/s", report.Interface);
        Assert.Equal("WD40EZAX", report.Model);
        Assert.Equal(new DiskAttribute("05", "Reallocated Sectors Count", 200, 200, 140, "000000000000", HealthStatus.Good), report.Attributes[0]);
        Assert.Equal("00000000001C", report.Attributes[2].Raw);
        Assert.Null(report.Attributes[2].Threshold);
    }

    [Fact]
    public void Reallocated_sectors_are_a_caution_and_a_value_under_its_threshold_is_bad()
    {
        var caution = Smart.Report(Sector((0x05, 199, 199, 8)), Thresholds((0x05, 140)), [], DateTimeOffset.UnixEpoch);
        Assert.Equal(HealthStatus.Caution, caution.Health);
        var bad = Smart.Report(Sector((0x05, 120, 120, 900), (0x09, 80, 80, 5)), Thresholds((0x05, 140)), [], DateTimeOffset.UnixEpoch);
        Assert.Equal(HealthStatus.Bad, bad.Health);
        Assert.Equal(HealthStatus.Good, bad.Attributes[1].Status);
    }

    [Fact]
    public void A_solid_state_drive_does_not_get_mechanical_attribute_names()
    {
        var report = Smart.Report(Sector((0xCE, 200, 200, 7)), [], Identify(1, 3 << 1), DateTimeOffset.UnixEpoch);
        Assert.Equal("Vendor Specific", report.Attributes[0].Name);
        Assert.Equal(1, report.Rpm);
    }

    [Fact]
    public void The_nvme_health_log_is_read_by_offset()
    {
        var log = new byte[512];
        BitConverter.GetBytes((ushort)(273 + 47)).CopyTo(log, 1);
        (log[3], log[4], log[5]) = (100, 10, 2);
        BitConverter.GetBytes(435L).CopyTo(log, 112);
        BitConverter.GetBytes(6411L).CopyTo(log, 128);
        var report = NvmeHealth.Parse(log, DateTimeOffset.UnixEpoch);
        Assert.Equal(HealthStatus.Good, report.Health);
        Assert.Equal(47, report.Smart.TemperatureC);
        Assert.Equal(6411, report.Smart.PowerOnHours);
        Assert.Equal(435, report.PowerCycles);

        log[0] = 0x04;
        log[3] = 5;
        Assert.Equal(HealthStatus.Bad, NvmeHealth.Parse(log, DateTimeOffset.UnixEpoch).Health);
    }
}

public class HostFollowTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 15, 12, 0, 0, TimeSpan.Zero);
    private static readonly FollowPlan Plan = new(HostPowerAction.Hibernate, Now, ["192.168.0.173", "fe80::5f69:23a0:9531:46de%19"]);

    [Fact]
    public void Nothing_happens_before_the_grace_period_ends() =>
        Assert.Equal(HostFollow.Verdict.Wait, HostFollow.Decide(Plan with { Due = Now.AddMinutes(1) }, Now, [], 0).Verdict);

    [Fact]
    public void The_pc_own_sessions_do_not_hold_the_nas_up()
    {
        SmbSession[] own = [new("192.168.0.173", "17312", 600, 300), new("[::ffff:192.168.0.173]", "17312", 600, 300), new("[fe80::5f69:23a0:9531:46de]", "17312", 600, 300)];
        Assert.Equal(HostFollow.Verdict.Go, HostFollow.Decide(Plan, Now, own, 0).Verdict);
    }

    [Fact]
    public void Another_client_keeps_the_nas_on()
    {
        var (verdict, reason) = HostFollow.Decide(Plan, Now, [new("192.168.0.50", "tv", 60, 10)], 0);
        Assert.Equal(HostFollow.Verdict.Skip, verdict);
        Assert.Contains("192.168.0.50 (tv)", reason);
    }

    [Fact]
    public void Busy_disks_put_it_off() =>
        Assert.Equal(HostFollow.Verdict.Postpone, HostFollow.Decide(Plan, Now, [], 40 * 1024 * 1024).Verdict);

    [Theory]
    [InlineData(@"\\192.168.0.173", "192.168.0.173")]
    [InlineData("[::ffff:192.168.0.173]", "192.168.0.173")]
    [InlineData("FE80::1", "fe80::1")]
    [InlineData("fe80::5f69:23a0:9531:46de%19", "fe80::5f69:23a0:9531:46de")]
    [InlineData("DESKTOP-PC", "DESKTOP-PC")]
    public void Addresses_compare_however_windows_writes_them(string written, string expected) =>
        Assert.Equal(expected, HostFollow.Normalize(written));
}
