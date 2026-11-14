using System.Runtime.InteropServices;

namespace NasDeck.Agent;

/// <summary>"Turn off hard disk after" in the active power plan, on AC power.</summary>
internal static class PowerPlan
{
    private static Guid diskSubgroup = new("0012ee47-9041-4b5d-9b77-535fba8b1442");
    private static Guid diskIdle = new("6738e2c4-e8a5-4a42-b16a-e040e769756e");

    internal static int? ReadDiskIdleSeconds()
    {
        if (ActiveScheme() is not { } scheme) return null;
        return Native.PowerReadACValueIndex(IntPtr.Zero, ref scheme, ref diskSubgroup, ref diskIdle, out var value) == 0
            ? (int)Math.Min(value, int.MaxValue)
            : null;
    }

    internal static bool WriteDiskIdleSeconds(int seconds)
    {
        if (ActiveScheme() is not { } scheme) return false;
        // The new value takes effect only once the plan is applied again.
        return Native.PowerWriteACValueIndex(IntPtr.Zero, ref scheme, ref diskSubgroup, ref diskIdle, (uint)seconds) == 0
            && Native.PowerSetActiveScheme(IntPtr.Zero, ref scheme) == 0;
    }

    private static Guid? ActiveScheme()
    {
        if (Native.PowerGetActiveScheme(IntPtr.Zero, out var pointer) != 0) return null;
        try { return Marshal.PtrToStructure<Guid>(pointer); }
        finally { Native.LocalFree(pointer); }
    }
}
