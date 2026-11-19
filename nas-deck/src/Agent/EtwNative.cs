using System.Runtime.InteropServices;

namespace NasDeck.Agent;

/// <summary>Win32 ETW real-time trace and thread-PID P/Invoke definitions for <see cref="DiskActivityTracker"/>.</summary>
internal static class EtwNative
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    internal delegate void EventRecordCallbackDelegate(IntPtr eventRecord);

    [StructLayout(LayoutKind.Sequential)]
    internal struct WnodeHeader
    {
        internal uint BufferSize;
        internal uint ProviderId;
        internal ulong HistoricalContext;
        internal long TimeStamp;
        internal Guid Guid;
        internal uint ClientContext;
        internal uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventTraceProperties
    {
        internal WnodeHeader Wnode;
        internal uint BufferSize;
        internal uint MinimumBuffers;
        internal uint MaximumBuffers;
        internal uint MaximumFileSize;
        internal uint LogFileMode;
        internal uint FlushTimer;
        internal uint EnableFlags;
        internal int AgeLimit;
        internal uint NumberOfBuffers;
        internal uint FreeBuffers;
        internal uint EventsLost;
        internal uint BuffersWritten;
        internal uint LogBuffersLost;
        internal uint RealTimeBuffersLost;
        internal IntPtr LoggerThreadId;
        internal uint LogFileNameOffset;
        internal uint LoggerNameOffset;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventTraceHeader
    {
        internal ushort Size;
        internal ushort FieldTypeFlags;
        internal uint Version;
        internal uint ThreadId;
        internal uint ProcessId;
        internal long TimeStamp;
        internal Guid Guid;
        internal uint KernelTime;
        internal uint UserTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventTrace
    {
        internal EventTraceHeader Header;
        internal uint InstanceId;
        internal uint ParentInstanceId;
        internal Guid ParentGuid;
        internal IntPtr MofData;
        internal uint MofLength;
        internal uint ClientContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SystemTime
    {
        internal ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct TimeZoneInformation
    {
        internal int Bias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string StandardName;
        internal SystemTime StandardDate;
        internal int StandardBias;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] internal string DaylightName;
        internal SystemTime DaylightDate;
        internal int DaylightBias;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TraceLogfileHeader
    {
        internal uint BufferSize;
        internal uint Version;
        internal uint ProviderVersion;
        internal uint NumberOfProcessors;
        internal long EndTime;
        internal uint TimerResolution;
        internal uint MaximumFileSize;
        internal uint LogFileMode;
        internal uint BuffersWritten;
        internal Guid LogInstanceGuid;
        internal IntPtr LoggerName;
        internal IntPtr LogFileName;
        internal TimeZoneInformation TimeZone;
        internal long BootTime;
        internal long PerfFreq;
        internal long StartTime;
        internal uint ReservedFlags;
        internal uint BuffersLost;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct EventTraceLogfile
    {
        internal string? LogFileName;
        internal string? LoggerName;
        internal long CurrentTime;
        internal uint BuffersRead;
        internal uint ProcessTraceMode;
        internal EventTrace CurrentEvent;
        internal TraceLogfileHeader LogfileHeader;
        internal IntPtr BufferCallback;
        internal uint BufferSize;
        internal uint Filled;
        internal uint EventsLost;
        internal IntPtr EventRecordCallback;
        internal uint IsKernelTrace;
        internal IntPtr Context;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventDescriptor
    {
        internal ushort Id;
        internal byte Version;
        internal byte Channel;
        internal byte Level;
        internal byte Opcode;
        internal ushort Task;
        internal ulong Keyword;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventHeader
    {
        internal ushort Size;
        internal ushort HeaderType;
        internal ushort Flags;
        internal ushort EventProperty;
        internal uint ThreadId;
        internal uint ProcessId;
        internal long TimeStamp;
        internal Guid ProviderId;
        internal EventDescriptor EventDescriptor;
        internal uint KernelTime;
        internal uint UserTime;
        internal Guid ActivityId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EtwBufferContext
    {
        internal byte ProcessorNumber;
        internal byte Alignment;
        internal ushort LoggerId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct EventRecord
    {
        internal EventHeader Header;
        internal EtwBufferContext BufferContext;
        internal ushort ExtendedDataCount;
        internal ushort UserDataLength;
        internal IntPtr ExtendedData;
        internal IntPtr UserData;
        internal IntPtr UserContext;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern uint StartTraceW(out ulong sessionHandle, string sessionName, IntPtr properties);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern uint ControlTraceW(ulong sessionHandle, string? sessionName, IntPtr properties, uint controlCode);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    internal static extern ulong OpenTraceW(ref EventTraceLogfile logfile);

    [DllImport("advapi32.dll")]
    internal static extern uint ProcessTrace(ulong[] handleArray, uint handleCount, IntPtr startTime, IntPtr endTime);

    [DllImport("advapi32.dll")]
    internal static extern uint CloseTrace(ulong traceHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenThread(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint GetProcessIdOfThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}
