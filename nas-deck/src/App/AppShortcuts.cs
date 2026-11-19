using System.Runtime.InteropServices;

namespace NasDeck;

/// <summary>
/// Manages NAS Deck's Windows Start menu and sign-in Startup shortcuts directly from the app
/// via COM <c>IShellLinkW</c>, replacing the old PowerShell registration switches.
/// </summary>
internal static class AppShortcuts
{
    private const string LinkFileName = "NAS Deck.lnk";
    private const string Description = "Watch and manage your NAS from the desktop.";

    internal static string StartMenuPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Programs), LinkFileName);

    internal static string StartupPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Startup), LinkFileName);

    internal static bool HasStartMenu => File.Exists(StartMenuPath);
    internal static bool HasStartup => File.Exists(StartupPath);

    internal static void SetStartMenu(bool enabled) =>
        SetShortcut(StartMenuPath, enabled, Application.ExecutablePath, DeckPaths.ProjectDirectory);

    internal static void SetStartup(bool enabled) =>
        SetShortcut(StartupPath, enabled, Application.ExecutablePath, DeckPaths.ProjectDirectory);

    internal static void SetShortcut(string linkPath, bool enabled, string targetPath, string workingDirectory)
    {
        if (!enabled)
        {
            if (File.Exists(linkPath)) File.Delete(linkPath);
            return;
        }
        var directory = Path.GetDirectoryName(linkPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        CreateShortcut(linkPath, targetPath, workingDirectory, Description);
    }

    internal static void CreateShortcut(string linkPath, string targetPath, string workingDirectory, string description)
    {
        var type = Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), throwOnError: true)!;
        var instance = Activator.CreateInstance(type)!;
        try
        {
            var shellLink = (IShellLinkW)instance;
            shellLink.SetPath(targetPath);
            shellLink.SetWorkingDirectory(workingDirectory);
            shellLink.SetDescription(description);
            shellLink.SetIconLocation(targetPath, 0);
            ((IPersistFile)instance).Save(linkPath, true);
        }
        finally
        {
            Marshal.FinalReleaseComObject(instance);
        }
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath(IntPtr file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr idList);
        void SetIDList(IntPtr idList);
        void GetDescription(IntPtr name, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr dir, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
        void GetArguments(IntPtr args, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation(IntPtr iconPath, int maxIconPath, out int icon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int icon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pathRel, uint reserved);
        void Resolve(IntPtr hwnd, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010B-0000-0000-C000-000000000046")]
    private interface IPersistFile
    {
        void GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile(out IntPtr fileName);
    }
}
