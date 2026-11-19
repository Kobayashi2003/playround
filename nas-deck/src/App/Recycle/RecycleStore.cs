using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace NasDeck;

internal sealed record RecycledItem(Guid Id, string Root, string RelativePath, DateTimeOffset Removed)
{
    internal string Original => Path.Combine(Root, RelativePath);
    internal string Name => Path.GetFileName(RelativePath);
    internal string Slot => Path.Combine(Root, RecycleStore.BinName, Id.ToString("N"));
    internal string Payload => Path.Combine(Slot, Name);
}

internal sealed class RestoreConflict(string path) : IOException($"An item already exists at {path}.");

internal sealed class RecycleStore(string journal)
{
    internal const string BinName = ".nas-deck-recycle";
    private static readonly StringComparison IgnoreCase = StringComparison.OrdinalIgnoreCase;

    // Without COPY_ALLOWED, a cross-volume move fails before the source can be removed.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string source, string destination, uint flags);

    private static void Rename(string source, string destination)
    {
        if (!MoveFileEx(source, destination, 0))
        {
            var error = Marshal.GetLastWin32Error();
            if (error is 80 or 183) throw new RestoreConflict(destination);
            throw new IOException(new Win32Exception(error).Message);
        }
    }

    private string Record(Guid id) => Path.Combine(journal, id.ToString("N") + ".json");

    internal RecycledItem[] List()
    {
        if (!Directory.Exists(journal)) return [];
        return Directory.EnumerateFiles(journal, "*.json")
            .Select(file => Read(Guid.ParseExact(Path.GetFileNameWithoutExtension(file), "N")))
            .OrderByDescending(item => item.Removed).ToArray();
    }

    private RecycledItem Read(Guid id)
    {
        var item = JsonSerializer.Deserialize<RecycledItem>(File.ReadAllText(Record(id)));
        if (item is null || item.Id != id || !Path.IsPathFullyQualified(item.Root))
            throw new InvalidDataException("Invalid recycle record.");
        ValidateRelative(item.RelativePath);
        return item;
    }

    private static void ValidateRelative(string path)
    {
        if (Path.IsPathRooted(path) || path.Split('\\', '/').Any(part =>
            part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ')
            || part.Equals(BinName, IgnoreCase) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0))
            throw new IOException("Select a file or folder inside the protected share, outside its recycle folder.");
    }

    private static void CheckPath(string root, string path)
    {
        for (var current = Path.TrimEndingDirectorySeparator(path); ; current = Path.GetDirectoryName(current)!)
        {
            if (File.GetAttributes(current).HasFlag(FileAttributes.ReparsePoint))
                throw new IOException($"Linked files and folders cannot be recycled here: {current}");
            if (Path.TrimEndingDirectorySeparator(root).Equals(current, IgnoreCase)) return;
            if (Path.GetDirectoryName(current) is null) throw new InvalidDataException("Path is outside its share.");
        }
    }

    internal RecycledItem Move(string root, string original)
    {
        var relative = Path.GetRelativePath(root, original);
        ValidateRelative(relative);
        CheckPath(root, original);
        var item = new RecycledItem(Guid.NewGuid(), root, relative, DateTimeOffset.Now);
        var bin = Path.Combine(root, BinName);
        Directory.CreateDirectory(bin);
        CheckPath(root, bin);
        Directory.CreateDirectory(item.Slot);
        CheckPath(root, item.Slot);
        Directory.CreateDirectory(journal);
        var record = Record(item.Id);
        // The mapping is durable before the SMB rename, including if this PC loses power just after it.
        using (var stream = new FileStream(record + ".tmp", FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(stream, item);
            stream.Flush(true);
        }
        File.Move(record + ".tmp", record);
        try { Rename(original, item.Payload); }
        catch (IOException)
        {
            // Only discard the journal if the server confirms the slot is empty.
            try { Directory.Delete(item.Slot); File.Delete(record); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
            throw;
        }
        return item;
    }

    internal void Restore(Guid id, bool keepBoth = false)
    {
        var item = Read(id);
        CheckPath(item.Root, item.Payload);
        CheckPath(item.Root, Path.GetDirectoryName(item.Original)!);
        var destination = item.Original;
        var directory = File.GetAttributes(item.Payload).HasFlag(FileAttributes.Directory);
        var extension = directory ? "" : Path.GetExtension(destination);
        for (var suffix = 1; ; suffix++)
        {
            try
            {
                if (File.Exists(destination) || Directory.Exists(destination)) throw new RestoreConflict(destination);
                Rename(item.Payload, destination);
                break;
            }
            catch (RestoreConflict) when (keepBoth)
            {
                destination = item.Original[..(item.Original.Length - extension.Length)]
                    + $" (restored {suffix})" + extension;
            }
        }
        Finish(item);
    }

    internal void DeletePermanently(string root, string original)
    {
        var relative = Path.GetRelativePath(root, original);
        ValidateRelative(relative);
        CheckPath(root, original);
        var attributes = File.GetAttributes(original);
        if (attributes.HasFlag(FileAttributes.Directory)) Directory.Delete(original, recursive: true);
        else File.Delete(original);
    }

    internal void Purge(Guid id)
    {
        var item = Read(id);
        CheckPath(item.Root, item.Slot);
        try
        {
            var attributes = File.GetAttributes(item.Payload);
            if (attributes.HasFlag(FileAttributes.Directory)) Directory.Delete(item.Payload, recursive: true);
            else File.Delete(item.Payload);
        }
        catch (FileNotFoundException) { } // The move or cleanup may already have completed before a crash.
        Finish(item);
    }

    private void Finish(RecycledItem item)
    {
        File.Delete(Record(item.Id));
        try { Directory.Delete(item.Slot); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }
}
