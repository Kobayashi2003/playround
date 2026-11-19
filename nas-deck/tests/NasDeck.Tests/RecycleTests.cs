extern alias widget;
using Xunit;
using App = widget::NasDeck;

namespace NasDeck.Tests;

public sealed class RecycleTests : IDisposable
{
    private readonly string temp = Directory.CreateTempSubdirectory("nasdeck-recycle-").FullName;
    private string Root => Directory.CreateDirectory(Path.Combine(temp, "share")).FullName;
    private App.RecycleStore Store => new(Path.Combine(temp, "journal"));

    [Fact]
    public void RestartCanRestoreFolderAndKeepBothOnConflict()
    {
        var source = Directory.CreateDirectory(Path.Combine(Root, "Photos")).FullName;
        File.WriteAllText(Path.Combine(source, "image.txt"), "original");
        var entry = Store.Move(Root, source);
        Assert.False(Directory.Exists(source));
        Assert.Equal(entry, Assert.Single(Store.List()));
        Directory.CreateDirectory(source);
        Assert.Throws<App.RestoreConflict>(() => Store.Restore(entry.Id));
        Store.Restore(entry.Id, keepBoth: true);
        Assert.True(Directory.Exists(source));
        Assert.Equal("original", File.ReadAllText(Path.Combine(Root, "Photos (restored 1)", "image.txt")));
        Assert.Empty(Store.List());
    }

    [Fact]
    public void PurgeAffectsOnlyTheSelectedPayload()
    {
        var source = Path.Combine(Root, "sample.txt");
        File.WriteAllText(source, "first");
        var first = Store.Move(Root, source);
        File.WriteAllText(source, "second");
        var second = Store.Move(Root, source);
        Store.Purge(first.Id);
        Assert.False(File.Exists(first.Payload));
        Store.Restore(second.Id);
        Assert.Equal("second", File.ReadAllText(source));
    }

    [Fact]
    public void LockedFileDoesNotLoseItsOriginal()
    {
        var source = Path.Combine(Root, "in use");
        using var file = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        Assert.Throws<IOException>(() => Store.Move(Root, source));
        Assert.True(File.Exists(source));
        Assert.Empty(Store.List());
    }

    [Theory]
    [InlineData("")]
    [InlineData(@"..\outside")]
    [InlineData(@".nas-deck-recycle\anything")]
    public void RejectsUnsafeSource(string relative)
    {
        Assert.Throws<IOException>(() => Store.Move(Root, Path.Combine(Root, relative)));
        Assert.Empty(Store.List());
    }

    [Theory]
    [InlineData(46, false, false, false, false, true)]
    [InlineData(68, true, false, false, false, true)]
    [InlineData(68, false, false, false, false, false)]
    [InlineData(46, false, true, false, false, false)]
    [InlineData(68, true, true, false, false, false)]
    [InlineData(46, true, false, false, false, false)]
    [InlineData(68, true, false, true, false, false)]
    [InlineData(68, true, false, false, true, false)]
    public void OnlyTheTwoShortcutsMatch(int key, bool ctrl, bool shift, bool alt, bool win, bool expected) =>
        Assert.Equal(expected, App.ExplorerShortcuts.Matches(key, ctrl, shift, alt, win));

    [Theory]
    [InlineData(@"\\nas\media\photo", true)]
    [InlineData(@"\\NAS.EXAMPLE\MEDIA", true)]
    [InlineData(@"\\nas\media-private\photo", false)]
    [InlineData(@"\\other\media\photo", false)]
    [InlineData(@"D:\media\photo", false)]
    public void MatchesCompleteShareAndHost(string path, bool expected)
    {
        var settings = new App.NasSettings { Host = "nas", RecycleHostAlias = "nas.example", RecycleShares = ["Media"] };
        Assert.Equal(expected, App.ExplorerReader.ProtectedRoot(path, settings) != null);
    }

    [Fact]
    public void DeletePermanentlyRemovesFileAndFolderWithoutJournal()
    {
        var file = Path.Combine(Root, "temp.bin");
        File.WriteAllText(file, "bye");
        var folder = Directory.CreateDirectory(Path.Combine(Root, "scratch")).FullName;
        File.WriteAllText(Path.Combine(folder, "nested.txt"), "bye");

        Store.DeletePermanently(Root, file);
        Store.DeletePermanently(Root, folder);

        Assert.False(File.Exists(file));
        Assert.False(Directory.Exists(folder));
        Assert.Empty(Store.List());
        Assert.Throws<IOException>(() => Store.DeletePermanently(Root, Path.Combine(Root, @"..\outside")));
    }

    public void Dispose() => Directory.Delete(temp, recursive: true);
}
