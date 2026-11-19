namespace NasDeck;

internal sealed partial class DeckWindow
{
    private readonly RecycleStore recycleStore = new(Path.Combine(DeckPaths.DataDirectory, "recycle"));
    private ExplorerShortcuts? shortcuts;
    private RecycleWindow? recycleWindow;
    private Guid[] undoRecycle = [];
    private bool recycleBusy;

    private void ConfigureRecycle()
    {
        shortcuts?.Dispose();
        shortcuts = null;
        var config = model.Settings;
        if (!config.RecycleEnabled) return;
        shortcuts = new ExplorerShortcuts(config,
            selection => Post(() => { if (model.Settings == config) _ = RecycleSelectionAsync(selection); }),
            problem => Post(() => { if (model.Settings == config) RecycleNotice(problem); }));
    }

    private void RecycleNotice(string message)
    {
        SetNotice(message);
        RefreshView();
        if (tray.Visible) tray.ShowBalloonTip(4500, "NAS Recycle Bin", message, ToolTipIcon.Info);
    }

    private void ShowRecycleBin()
    {
        if (recycleWindow is null or { IsDisposed: true })
        {
            recycleWindow = new RecycleWindow(headingText: null, browser: true);
            recycleWindow.Requested += (ids, purge) => _ = ChangeRecycledAsync(ids, purge);
            recycleWindow.Show();
        }
        ReloadRecycle();
        recycleWindow.Activate();
    }

    private void ReloadRecycle()
    {
        if (recycleWindow is not { IsDisposed: false }) return;
        try { recycleWindow.Reload(recycleStore.List()); }
        catch (Exception e) { recycleWindow.Reload([], "Cannot read recycle history. " + e.Message); }
    }

    private async Task RecycleSelectionAsync(ExplorerSelection selection)
    {
        if (recycleBusy || exiting) return;
        recycleBusy = true;
        try
        {
            var choice = RecycleWindow.PromptRecycle(selection.Paths);
            if (choice == RecycleChoice.Cancel) return;

            var failures = new List<string>();
            if (choice == RecycleChoice.DeletePermanently)
            {
                var deleted = 0;
                await Task.Run(() =>
                {
                    foreach (var path in selection.Paths)
                    {
                        try { recycleStore.DeletePermanently(selection.Root, path); deleted++; }
                        catch (Exception e) { failures.Add($"{path} — {e.Message}"); }
                    }
                });
                if (deleted > 0)
                    RecycleNotice($"Permanently deleted {deleted} item{(deleted == 1 ? "" : "s")}.");
                ReportRecycleErrors(failures);
                return;
            }

            var moved = new List<Guid>();
            await Task.Run(() =>
            {
                foreach (var path in selection.Paths)
                {
                    try { moved.Add(recycleStore.Move(selection.Root, path).Id); }
                    catch (Exception e) { failures.Add($"{path} — {e.Message}"); }
                }
            });
            if (moved.Count > 0)
            {
                undoRecycle = moved.ToArray();
                RecycleNotice($"Recycled {moved.Count} item{(moved.Count == 1 ? "" : "s")}. Choose “Undo last recycle” in the widget menu to restore.");
            }
            ReportRecycleErrors(failures);
        }
        finally { recycleBusy = false; ReloadRecycle(); }
    }

    private async Task ChangeRecycledAsync(Guid[] ids, bool purge)
    {
        if (recycleBusy || exiting || ids.Length == 0) return;
        recycleBusy = true;
        try
        {
            var items = recycleStore.List().Where(item => ids.Contains(item.Id)).ToArray();
            if (items.Length == 0) return;
            var noun = items.Length == 1 ? "1 item" : $"{items.Length} items";
            if (purge && !RecycleWindow.Confirm($"Permanently delete {noun}?",
                "This removes the selected items from the NAS. This action cannot be undone.", "Delete permanently",
                items.Select(item => item.Original), recycleWindow, danger: true)) return;

            var failures = new List<string>();
            int completed = 0;
            foreach (var item in items)
            {
                try
                {
                    try
                    {
                        await Task.Run(() => { if (purge) recycleStore.Purge(item.Id); else recycleStore.Restore(item.Id); });
                    }
                    catch (RestoreConflict) when (!purge)
                    {
                        if (!RecycleWindow.Confirm("A file or folder has this name",
                            "Keep both to add a numbered suffix to the restored item.", "Keep both", [item.Original], recycleWindow)) continue;
                        await Task.Run(() => recycleStore.Restore(item.Id, keepBoth: true));
                    }
                    undoRecycle = undoRecycle.Where(id => id != item.Id).ToArray();
                    completed++;
                }
                catch (Exception e) { failures.Add($"{item.Original} — {e.Message}"); }
            }
            if (completed > 0) RecycleNotice($"{(purge ? "Permanently deleted" : "Restored")} {completed} item(s).");
            ReportRecycleErrors(failures);
        }
        catch (Exception e) { ReportRecycleErrors([e.Message]); }
        finally { recycleBusy = false; ReloadRecycle(); }
    }

    private void ReportRecycleErrors(List<string> failures)
    {
        if (failures.Count > 0)
            MessageBox.Show(string.Join(Environment.NewLine, failures), $"{failures.Count} recycle action(s) need attention",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
