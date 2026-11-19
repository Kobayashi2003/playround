// The parts of the supervisor PowerShell cannot do on its own. Compiled by
// lib/Native.ps1 with Add-Type on every launch.
//
//   LogHub      reads each child's stdout and stderr on the thread pool, where a
//               PowerShell script block has no runspace to run in, and fans every
//               line out to the console, a per-source log file and a ring buffer
//               the admin page reads.
//   ProcTree    every process's parent, from one Toolhelp snapshot, so an app's
//               memory and CPU include the grandchildren that do its real work.
//   SystemStats machine-wide CPU and memory without a CIM round trip.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AppGateway
{
    public sealed class LogLine
    {
        public long Seq { get; set; }
        public DateTime Time { get; set; }
        public string Source { get; set; }
        public string Stream { get; set; }
        public string Text { get; set; }
    }

    public sealed class LogHub : IDisposable
    {
        private readonly object _lock = new object();
        private readonly Dictionary<string, LinkedList<LogLine>> _buffers =
            new Dictionary<string, LinkedList<LogLine>>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, StreamWriter> _files =
            new Dictionary<string, StreamWriter>(StringComparer.OrdinalIgnoreCase);
        private readonly string _dir;
        private readonly int _capacity;
        private readonly long _rotateBytes;
        private long _seq;

        public bool Echo { get; set; }

        public LogHub(string dir, int capacity, long rotateBytes)
        {
            _dir = dir;
            _capacity = Math.Max(100, capacity);
            _rotateBytes = rotateBytes;
            Echo = true;
            if (!string.IsNullOrEmpty(_dir)) Directory.CreateDirectory(_dir);
        }

        public string FileFor(string source)
        {
            if (string.IsNullOrEmpty(_dir)) return null;
            return Path.Combine(_dir, source + ".log");
        }

        public string[] Sources()
        {
            lock (_lock)
            {
                var keys = new List<string>(_buffers.Keys);
                keys.Sort(StringComparer.OrdinalIgnoreCase);
                return keys.ToArray();
            }
        }

        public long LastSeq { get { lock (_lock) { return _seq; } } }

        public void Write(string source, string stream, string text)
        {
            if (text == null) return;
            var now = DateTime.Now;
            LogLine line;
            lock (_lock)
            {
                line = new LogLine { Seq = ++_seq, Time = now, Source = source, Stream = stream, Text = text };
                LinkedList<LogLine> buf;
                if (!_buffers.TryGetValue(source, out buf))
                {
                    buf = new LinkedList<LogLine>();
                    _buffers[source] = buf;
                }
                buf.AddLast(line);
                while (buf.Count > _capacity) buf.RemoveFirst();

                var w = Writer(source);
                if (w != null)
                {
                    try { w.WriteLine("{0:yyyy-MM-dd HH:mm:ss.fff} {1} {2}", now, stream == "err" ? "E" : "-", text); }
                    catch (IOException) { }
                }
            }
            if (Echo)
            {
                // ANSI rather than Console.ForegroundColor: the host writes from
                // another thread, and a colour set here would bleed into its line.
                var color = stream == "err" ? "33" : "36";
                Console.Out.WriteLine("\u001b[" + color + "m[" + source + "]\u001b[0m " + text);
            }
        }

        private StreamWriter Writer(string source)
        {
            if (string.IsNullOrEmpty(_dir)) return null;
            StreamWriter w;
            if (_files.TryGetValue(source, out w)) return w;
            var path = FileFor(source);
            try
            {
                // Rotated once, when first opened in this run: a single .1 keeps the
                // previous run's tail without the folder growing without bound.
                var info = new FileInfo(path);
                if (info.Exists && info.Length > _rotateBytes)
                {
                    var old = path + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(path, old);
                }
                var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                w = new StreamWriter(fs, new UTF8Encoding(false)) { AutoFlush = true };
            }
            catch (IOException) { w = null; }
            catch (UnauthorizedAccessException) { w = null; }
            _files[source] = w;
            return w;
        }

        public LogLine[] Read(string source, long after, int max)
        {
            lock (_lock)
            {
                LinkedList<LogLine> buf;
                if (!_buffers.TryGetValue(source, out buf)) return new LogLine[0];
                var result = new List<LogLine>();
                // Newest first, then reversed: a poll asks for the tail, and the
                // buffer may be thousands of lines long.
                for (var node = buf.Last; node != null && result.Count < max; node = node.Previous)
                {
                    if (node.Value.Seq <= after) break;
                    result.Add(node.Value);
                }
                result.Reverse();
                return result.ToArray();
            }
        }

        /// <summary>Every source interleaved in the order the lines arrived.</summary>
        public LogLine[] ReadAll(long after, int max)
        {
            lock (_lock)
            {
                var result = new List<LogLine>();
                foreach (var buf in _buffers.Values)
                {
                    for (var node = buf.Last; node != null && node.Value.Seq > after; node = node.Previous)
                        result.Add(node.Value);
                }
                result.Sort((a, b) => a.Seq.CompareTo(b.Seq));
                if (result.Count > max) result.RemoveRange(0, result.Count - max);
                return result.ToArray();
            }
        }

        public void Clear(string source)
        {
            lock (_lock)
            {
                LinkedList<LogLine> buf;
                if (_buffers.TryGetValue(source, out buf)) buf.Clear();
            }
        }

        public Process Start(string source, string file, string[] args, string cwd, IDictionary<string, string> env)
        {
            var psi = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                // The child stays on this console, so Ctrl+C still reaches it and its
                // own shutdown runs; only its output comes through here.
                CreateNoWindow = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Console.OutputEncoding,
                StandardErrorEncoding = Console.OutputEncoding,
            };
            if (args != null) foreach (var a in args) psi.ArgumentList.Add(a);
            if (!string.IsNullOrEmpty(cwd)) psi.WorkingDirectory = cwd;
            if (env != null) foreach (var kv in env) psi.Environment[kv.Key] = kv.Value;

            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            p.OutputDataReceived += (s, e) => { if (e.Data != null) Write(source, "out", e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) Write(source, "err", e.Data); };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        public void Dispose()
        {
            lock (_lock)
            {
                foreach (var w in _files.Values) { if (w != null) try { w.Dispose(); } catch (IOException) { } }
                _files.Clear();
            }
        }
    }

    public sealed class ProcUsage
    {
        public int[] Pids { get; set; }
        public long WorkingSet { get; set; }
        public double CpuSeconds { get; set; }
        public int Threads { get; set; }
    }

    public static class ProcTree
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        /// <summary>pid -> parent pid for every process on the machine.</summary>
        public static Dictionary<int, int> Parents()
        {
            var map = new Dictionary<int, int>();
            var snap = CreateToolhelp32Snapshot(0x2, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
            try
            {
                var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                if (!Process32FirstW(snap, ref e)) return map;
                do { map[(int)e.th32ProcessID] = (int)e.th32ParentProcessID; }
                while (Process32NextW(snap, ref e));
            }
            finally { CloseHandle(snap); }
            return map;
        }

        private static DateTime StartOf(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return p.StartTime; }
            catch (Exception) { return DateTime.MaxValue; }
        }

        /// <summary>The process and everything under it. A parent pid can outlive
        /// its process and be reused, so a "child" older than its parent is not one.</summary>
        public static ProcUsage Usage(int rootPid, Dictionary<int, int> parents)
        {
            var children = new Dictionary<int, List<int>>();
            foreach (var kv in parents)
            {
                if (kv.Key == kv.Value) continue;
                List<int> list;
                if (!children.TryGetValue(kv.Value, out list)) { list = new List<int>(); children[kv.Value] = list; }
                list.Add(kv.Key);
            }

            var pids = new List<int>();
            var usage = new ProcUsage();
            var queue = new Queue<KeyValuePair<int, DateTime>>();
            var seen = new HashSet<int>();
            queue.Enqueue(new KeyValuePair<int, DateTime>(rootPid, DateTime.MinValue));
            while (queue.Count > 0)
            {
                var item = queue.Dequeue();
                if (!seen.Add(item.Key)) continue;
                Process p;
                try { p = Process.GetProcessById(item.Key); }
                catch (Exception) { continue; }
                using (p)
                {
                    DateTime start;
                    try { start = p.StartTime; } catch (Exception) { start = DateTime.MinValue; }
                    if (start < item.Value) continue;
                    pids.Add(item.Key);
                    try { usage.WorkingSet += p.WorkingSet64; } catch (Exception) { }
                    try { usage.CpuSeconds += p.TotalProcessorTime.TotalSeconds; } catch (Exception) { }
                    try { usage.Threads += p.Threads.Count; } catch (Exception) { }
                    List<int> kids;
                    if (children.TryGetValue(item.Key, out kids))
                        foreach (var k in kids) queue.Enqueue(new KeyValuePair<int, DateTime>(k, start));
                }
            }
            usage.Pids = pids.ToArray();
            return usage;
        }

        public static string NameOf(int pid)
        {
            try { using (var p = Process.GetProcessById(pid)) return p.ProcessName; }
            catch (Exception) { return null; }
        }
    }

    public static class SystemStats
    {
        [DllImport("kernel32.dll")]
        private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

        [StructLayout(LayoutKind.Sequential)]
        private struct MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);

        [DllImport("kernel32.dll")]
        private static extern ushort SetThreadUILanguage(ushort langId);

        /// <summary>Request en-US (0x0409) Win32 error messages on this thread so
        /// gateway logs stay in English regardless of the host Windows display language.</summary>
        public static void UseEnglishMessages()
        {
            try { SetThreadUILanguage(0x0409); } catch { }
        }

        private static long _idle, _total;
        private static double _last = -1;

        /// <summary>Busy share of all cores since the previous call, 0-100.</summary>
        public static double Cpu()
        {
            long idle, kernel, user;
            if (!GetSystemTimes(out idle, out kernel, out user)) return -1;
            // Kernel time includes idle time.
            var total = kernel + user;
            var dTotal = total - _total;
            var dIdle = idle - _idle;
            _idle = idle; _total = total;
            if (dTotal <= 0) return _last;
            _last = Math.Round(100.0 * (dTotal - dIdle) / dTotal, 1);
            return _last;
        }

        public static ulong[] Memory()
        {
            var m = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX)) };
            if (!GlobalMemoryStatusEx(ref m)) return new ulong[] { 0, 0 };
            return new ulong[] { m.ullTotalPhys, m.ullAvailPhys };
        }
    }
}
