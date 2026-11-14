using System.Security.Principal;

namespace NasDeck;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        var name = $@"Local\NasDeck.{WindowsIdentity.GetCurrent().User!.Value}";
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Show");
        using var stop = new EventWaitHandle(false, EventResetMode.AutoReset, $"{name}.Stop.{Environment.ProcessId}");
        using var instance = new Mutex(true, name, out var firstInstance);
        if (!firstInstance)
        {
            show.Set();
            return;
        }

        using var window = new DeckWindow();
        _ = window.Handle;
        var showWait = ThreadPool.RegisterWaitForSingleObject(show,
            (_, _) => window.Post(window.ShowWidget), null, Timeout.Infinite, false);
        var stopWait = ThreadPool.RegisterWaitForSingleObject(stop,
            (_, _) => window.Post(window.ExitDeck), null, Timeout.Infinite, true);
        try
        {
            Application.Run(window);
        }
        finally
        {
            showWait.Unregister(null);
            stopWait.Unregister(null);
            instance.ReleaseMutex();
        }
    }
}
