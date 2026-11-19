using System.Runtime.InteropServices;
using System.Text;

namespace NasDeck;

internal sealed record ExplorerPane(nint Window, nint View)
{
    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    {
        internal int Size, Flags;
        internal nint Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal Rectangle CaretRect;
    }

    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder buffer, int length);

    private static string Class(nint window)
    {
        var buffer = new StringBuilder(96);
        GetClassName(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    internal static ExplorerPane? Focused()
    {
        var top = GetForegroundWindow();
        if (Class(top) != "CabinetWClass") return null;
        var info = new GuiThreadInfo { Size = Marshal.SizeOf<GuiThreadInfo>() };
        if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, out _), ref info) || info.Flags != 0
            || Class(info.Focus) is not ("DirectUIHWND" or "SysListView32" or "SHELLDLL_DefView")) return null;
        for (var child = info.Focus; child != 0 && child != top; child = GetAncestor(child, 1))
            if (Class(child) == "SHELLDLL_DefView" && GetAncestor(child, 2) == top) return new(top, child);
        return null;
    }
}

internal sealed record ExplorerSelection(string Root, string[] Paths);

internal sealed class ExplorerReader
{
    [ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IServiceProvider
    {
        [PreserveSig] int QueryService(in Guid service, in Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellBrowser browser);
    }

    [ComImport, Guid("000214E2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellBrowser
    {
        void GetWindow(out nint window);
        void ContextSensitiveHelp(); void InsertMenus(); void SetMenu(); void RemoveMenus();
        void SetStatusText(); void EnableModeless(); void TranslateAccelerator(); void BrowseObject();
        void GetViewStateStream(); void GetControlWindow(); void SendControlMsg();
        void QueryActiveShellView([MarshalAs(UnmanagedType.Interface)] out IShellView view);
    }

    [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellView { void GetWindow(out nint window); void ContextSensitiveHelp(); }

    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    private static extern int WNetGetConnection(string drive, StringBuilder remote, ref int size);

    internal static string ExpandDrive(string path)
    {
        if (path.Length < 3 || path[1] != ':' || path[2] != '\\') return path;
        int size = 512;
        var remote = new StringBuilder(size);
        int status = WNetGetConnection(path[..2], remote, ref size);
        if (status == 234)
        {
            remote = new StringBuilder(size);
            status = WNetGetConnection(path[..2], remote, ref size);
        }
        if (status == 2250) return path;
        if (status != 0) throw new IOException("Explorer could not resolve the mapped drive.");
        return Path.Join(remote.ToString(), path[3..]);
    }

    internal static string? ProtectedRoot(string path, NasSettings settings)
    {
        if (!path.StartsWith(@"\\", StringComparison.Ordinal)) return null;
        var root = Path.GetPathRoot(path)?.TrimEnd('\\');
        if (root is null) return null;
        var parts = root[2..].Split('\\');
        if (parts.Length != 2 || !(parts[0].Equals(settings.Host, StringComparison.OrdinalIgnoreCase)
            || parts[0].Equals(settings.RecycleHostAlias, StringComparison.OrdinalIgnoreCase))) return null;
        return settings.RecycleShares.Contains(parts[1], StringComparer.OrdinalIgnoreCase) ? root : null;
    }

    private static readonly Guid TopLevelBrowser = new("4C96BE40-915C-11CF-99D3-00AA004AE837");
    private object? shell;

    private static nint ViewWindow(object window)
    {
        if (((IServiceProvider)window).QueryService(TopLevelBrowser, typeof(IShellBrowser).GUID, out var browser) < 0) return 0;
        try
        {
            browser.QueryActiveShellView(out var view);
            try { view.GetWindow(out var handle); return handle; }
            finally { Marshal.ReleaseComObject(view); }
        }
        finally { Marshal.ReleaseComObject(browser); }
    }

    internal ExplorerSelection? Read(ExplorerPane pane, NasSettings settings, Action<bool> resolved)
    {
        if (ExplorerPane.Focused() != pane) throw new IOException("Explorer focus changed. Select the items and try again.");
        shell ??= Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true)!)!;
        var owned = new Stack<object>();
        dynamic Own(object obj) { owned.Push(obj); return obj; }
        try
        {
            dynamic windows = Own(((dynamic)shell).Windows());
            for (int i = 0; i < (int)windows.Count; i++)
            {
                dynamic window = Own(windows.Item(i));
                if ((nint)(int)window.HWND != pane.Window || ViewWindow((object)window) != pane.View) continue;
                dynamic document = Own(window.Document);
                dynamic folder = Own(document.Folder);
                dynamic self = Own(folder.Self);
                string directory = ExpandDrive((string)self.Path);
                var root = ProtectedRoot(directory, settings);
                if (root is null)
                {
                    resolved(ExplorerPane.Focused() == pane);
                    return null;
                }
                resolved(false);
                dynamic selected = Own(document.SelectedItems());
                int count = selected.Count;
                var paths = new string[count];
                for (int j = 0; j < count; j++)
                {
                    dynamic entry = selected.Item(j);
                    try { paths[j] = ExpandDrive((string)entry.Path); }
                    finally { Marshal.ReleaseComObject(entry); }
                    if (!string.Equals(Path.TrimEndingDirectorySeparator(directory), Path.TrimEndingDirectorySeparator(Path.GetDirectoryName(paths[j]) ?? ""),
                            StringComparison.OrdinalIgnoreCase))
                        throw new IOException("The selection contains an item outside the active folder.");
                }
                if (ExplorerPane.Focused() != pane || ViewWindow((object)window) != pane.View)
                    throw new IOException("The active Explorer tab changed. Select the items again.");
                return new(root, paths);
            }
            throw new IOException("Explorer is still loading the active folder. Try again.");
        }
        finally { foreach (var obj in owned) Marshal.ReleaseComObject(obj); }
    }
}
