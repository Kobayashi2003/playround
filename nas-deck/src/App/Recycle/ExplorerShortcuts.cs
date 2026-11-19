using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace NasDeck;

internal sealed class ExplorerShortcuts : IDisposable
{
    private delegate nint Hook(int code, nint message, nint data);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint SetWindowsHookEx(int type, Hook callback, nint module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] private static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandle(string? name);

    private readonly BlockingCollection<Action> requests = new(1);
    private readonly NasSettings settings;
    private readonly Action<ExplorerSelection> selected;
    private readonly Action<string> report;
    private readonly ExplorerReader reader = new();
    private readonly Hook callback;
    private readonly HashSet<int> swallowed = [];
    private int reading;
    private volatile bool disposed;
    private volatile Control? pump;

    internal ExplorerShortcuts(NasSettings settings, Action<ExplorerSelection> selected, Action<string> report)
    {
        this.settings = settings;
        this.selected = selected;
        this.report = report;
        callback = OnKey;
        StartThread("NAS Deck Explorer selection", () =>
        {
            foreach (var action in requests.GetConsumingEnumerable()) action();
        });
        StartThread("NAS Deck Explorer shortcuts", RunHook);
    }

    private static void StartThread(string name, ThreadStart run)
    {
        var thread = new Thread(run) { Name = name, IsBackground = true };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    private void RunHook()
    {
        using var control = new Control();
        _ = control.Handle;
        pump = control;
        var hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
        try
        {
            if (hook == 0) report("Explorer shortcuts could not start: " + new Win32Exception().Message);
            else if (!disposed) Application.Run();
        }
        finally
        {
            if (hook != 0) UnhookWindowsHookEx(hook);
            pump = null;
        }
    }

    internal static bool Matches(int key, bool ctrl, bool shift, bool alt, bool win) =>
        !shift && !alt && !win && (key == (int)Keys.Delete && !ctrl || key == (int)Keys.D && ctrl);

    private nint OnKey(int code, nint message, nint data)
    {
        nint Pass() => CallNextHookEx(0, code, message, data);
        if (code < 0 || disposed) return Pass();
        int key = Marshal.ReadInt32(data);
        if (key is not ((int)Keys.Delete or (int)Keys.D)) return Pass();
        if (message is 0x101 or 0x105) return swallowed.Remove(key) ? 1 : Pass();
        if (swallowed.Contains(key)) return 1;
        static bool Down(Keys k) => GetAsyncKeyState((int)k) < 0;
        if (!Matches(key, Down(Keys.ControlKey), Down(Keys.ShiftKey), Down(Keys.Menu), Down(Keys.LWin) || Down(Keys.RWin)))
            return Pass();
        if (ExplorerPane.Focused() is not { } pane) return Pass();
        if (Interlocked.Exchange(ref reading, 1) == 0)
        {
            var native = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var consumed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            try
            {
                requests.Add(() =>
                {
                    try
                    {
                        var selection = reader.Read(pane, settings, pass => native.TrySetResult(pass));
                        native.TrySetResult(false);
                        if (!disposed && selection is { Paths.Length: > 0 }) selected(selection);
                        else if (!disposed && native.Task.Result && consumed.Task.Result)
                            report("Explorer was busy. Press the shortcut again in the active folder.");
                    }
                    catch (Exception e)
                    {
                        native.TrySetResult(false);
                        if (!disposed) report(e.Message);
                    }
                    finally { Volatile.Write(ref reading, 0); }
                });
                // Explorer or an SMB provider can stall. Never replay a delete after this callback returns.
                bool pass = native.Task.Wait(110) && native.Task.Result && ExplorerPane.Focused() == pane;
                consumed.SetResult(!pass);
                if (pass) return Pass();
            }
            catch (InvalidOperationException) when (disposed) { return Pass(); }
        }
        swallowed.Add(key);
        return 1;
    }

    public void Dispose()
    {
        disposed = true;
        requests.CompleteAdding();
        try { pump?.BeginInvoke(Application.ExitThread); }
        catch (InvalidOperationException) { }
    }
}
