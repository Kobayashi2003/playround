extern alias widget;
using System.Drawing;
using NasDeck.Agent;
using Xunit;
using App = widget::NasDeck;

namespace NasDeck.Tests;

public sealed class ActivityAndUiTests
{
    [Theory]
    [InlineData(@"\Device\Mup\192.168.0.168\nas-m\Movies\clip.mkv", "nas-m", @"Movies\clip.mkv")]
    [InlineData(@"\Device\Mup\kobayashi-nas\nas-f\Docs", "nas-f", "Docs")]
    [InlineData(@"\Device\Mup\;LanmanRedirector\;Z:0000000000012345\192.168.0.168\nas-k\sub\a.bin", "nas-k", @"sub\a.bin")]
    [InlineData(@"\Device\Mup\;Z:0000000000012345\kobayashi-nas\nas-h", "nas-h", "")]
    public void ParseMupPathMatchesConfiguredNas(string devicePath, string share, string relative)
    {
        var hosts = App.LocalActivityMonitor.BuildNasHosts(
            new App.NasSettings { Host = "192.168.0.168" },
            reportedHostName: "kobayashi-nas.local");
        var parsed = App.LocalActivityMonitor.ParseMupPath(devicePath, hosts);
        Assert.NotNull(parsed);
        Assert.Equal(share, parsed.Share);
        Assert.Equal(relative, parsed.RelativePath);
    }

    [Theory]
    [InlineData(@"\Device\HarddiskVolume3\Users\test.txt")]
    [InlineData(@"\Device\Mup\192.168.0.168\IPC$")]
    [InlineData(@"\Device\Mup\other-server\nas-m\clip.mkv")]
    [InlineData(@"\Device\Mup\;LanmanRedirector\")]
    public void ParseMupPathIgnoresNonNasOrIpcPaths(string devicePath)
    {
        var hosts = App.LocalActivityMonitor.BuildNasHosts(
            new App.NasSettings { Host = "192.168.0.168" },
            reportedHostName: "kobayashi-nas");
        Assert.Null(App.LocalActivityMonitor.ParseMupPath(devicePath, hosts));
    }

    [Fact]
    public void DiskActivityBuildListFiltersNoiseAndSortsByThroughput()
    {
        var list = DiskActivityTracker.BuildList([
            (10, "quiet", 200, 100, [0]),
            (4, "System", 5_000_000, 1_000_000, [0, 1]),
            (42, "copytool", 2_000_000, 8_000_000, [2])
        ]);
        Assert.Equal(2, list.Length);
        Assert.Equal("copytool", list[0].Name);
        Assert.Equal([2], list[0].Disks);
        Assert.Equal("System", list[1].Name);
        Assert.Equal([0, 1], list[1].Disks);
    }

    [Fact]
    public void ThinScrollBarClampsAndDragsThumb()
    {
        var bar = new App.ThinScrollBar();
        bar.Update(new RectangleF(100, 10, 14, 200), viewportHeight: 200, contentHeight: 1000);
        Assert.True(bar.Visible);
        Assert.Equal(800, bar.MaxOffset);

        Assert.True(bar.ScrollWheel(-120, 100));
        Assert.Equal(100, bar.Offset);

        var thumb = bar.ThumbBounds();
        Assert.True(bar.OnMouseDown(new PointF(thumb.X + 2, thumb.Y + 4)));
        Assert.True(bar.Dragging);
        bar.OnMouseMove(new PointF(thumb.X + 2, 210));
        Assert.Equal(bar.MaxOffset, bar.Offset);
        Assert.True(bar.OnMouseUp());
        Assert.False(bar.Dragging);
    }

    [Fact]
    public void ThemedCheckListTogglesAllAndTracksCount()
    {
        using var list = new App.ThemedCheckList();
        list.SetItems([("nas-f", true), ("nas-h", false), ("nas-m", false)]);
        Assert.Equal(3, list.TotalCount);
        Assert.Equal(1, list.CheckedCount);
        Assert.Equal(["nas-f"], list.CheckedItems);

        list.SetAllChecked(true);
        Assert.Equal(3, list.CheckedCount);

        list.SetAllChecked(false);
        Assert.Equal(0, list.CheckedCount);
        Assert.Empty(list.CheckedItems);
    }

    [Fact]
    public void AppShortcutsCreatesAndRemovesLinkFile()
    {
        var dir = Directory.CreateTempSubdirectory("nasdeck-shortcut-");
        try
        {
            var link = Path.Combine(dir.FullName, "NAS Deck.lnk");
            App.AppShortcuts.SetShortcut(link, enabled: true, Environment.ProcessPath!, dir.FullName);
            Assert.True(File.Exists(link));
            Assert.True(new FileInfo(link).Length > 0);

            App.AppShortcuts.SetShortcut(link, enabled: false, Environment.ProcessPath!, dir.FullName);
            Assert.False(File.Exists(link));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}
