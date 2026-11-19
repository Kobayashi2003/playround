# NAS Deck

A desktop widget for a Windows NAS. It shows the NAS's CPU load and temperature, memory, network traffic and, for
each disk, whether it is spinning or asleep, its temperature, read and write speed and free space. From the widget
you wake, hibernate, restart or shut down the NAS, put disks to sleep and wake them, and set how long an idle disk
waits before Windows spins it down. It replaces
[NAS Switch](../../garbage/playround/nas-switch/README.md).

It has two parts: the widget on this PC, and a small agent service on the NAS that the widget reaches through an
SSH tunnel. Without the agent the widget still shows whether the NAS is up and can wake and hibernate it.

## Run

Install the .NET 8 SDK for building, the .NET 8 Desktop Runtime for running, and the Windows OpenSSH Client.

```powershell
.\start.ps1 -Build
```

Run `.\stop.ps1` to exit a running NAS Deck instance. Start menu shortcut, sign-in startup and system tray icon
visibility are managed inside **Settings → General**. To build and open the app directly:

```powershell
dotnet build src\App\NasDeck.App.csproj --configuration Release
.\build\NasDeck.App\NasDeck.exe
```

## NAS Recycle Bin

Open **Settings → Recycle Bin** with the agent connected, enable the Explorer shortcuts, tick the shares to
protect and save. **Select all** checks every listed share, then becomes **Clear all**. Protection starts
disabled. Explorer can use a UNC path or a mapped drive pointing to the
configured NAS address or its reported host name. Once configured, recycling uses the signed-in user's SMB
connection and works while the widget is in the tray.

In the active Explorer tab's file list, select files or folders and press **Delete** or **Ctrl+D**. Review the
names and original folders, then choose **Move to bin** (or click **Delete permanently** twice to bypass the bin).
Cancel leaves the selection in place. If the active tab
cannot be identified in time, the shortcut can be consumed; retry it when Explorer is ready. **Shift+Delete**,
Explorer's toolbar and context-menu delete, search results, other applications and other computers keep their
normal Windows behaviour.

Each item is renamed into `<share>\.nas-deck-recycle\<id>\<original name>` on the same share. Its original path
and deletion time are recorded in `data/recycle` on this PC, under the directory selected by `NAS_DECK_DATA_DIR`.
Keep that directory when moving NAS Deck. Recycle data uses the share's existing permissions. Linked paths,
cross-volume moves, locked files and permission failures are reported individually.

Use **Undo last recycle** in the widget or tray menu to restore the last batch from this session. **NAS Recycle
Bin…** lists this PC's recorded items even after a restart or after disabling the shortcuts. Select rows to
restore them or delete them permanently. Restore needs the original parent folder to exist. A name conflict
offers **Keep both**, which adds a numbered suffix. Permanent deletion requires confirmation. Items stay on
the share until restored or manually purged.

## Set up the NAS

1. **SSH key.** With the NAS online, open **Settings** from the widget's menu and choose **Save and set up SSH
   key**, or run `.\Setup-SshKey.ps1`. It authorises a dedicated key (`~/.ssh/nas-switch-ed25519`, kept from NAS
   Switch) that the Windows SSH agent holds. The SSH account must be an administrator on the NAS.
2. **Agent.** Run:

   ```powershell
   .\Install-Agent.ps1 -Build -InstallPawnIO
   ```

   It publishes the agent, copies it to `C:\NasDeck` on the NAS and registers it as the `NasDeckAgent` service.
   `-InstallPawnIO` also installs the [PawnIO](https://pawnio.eu) driver there, which the CPU temperature is read
   through; leave it out and everything works except that reading. Run the script again with `-Build` to update
   the agent, or with `-Uninstall` to remove the service and its folder; PawnIO stays, and is removed from the
   NAS's Installed apps. `-InstallDirectory` chooses another folder on the NAS.

## The widget

Drag it by its background; it pulls to a screen edge as it comes near and remembers its place. The pin button
at the top, or **Pin in place** in the menu, stops it from being dragged. It sits behind other windows unless
**Always on top** is ticked in its menu. Right-click it, or use the **⋯** button, for the menu; the tray icon has
the same menu, and clicking the icon shows or hides the widget. Double-click the background, or use the chevron, to
switch between the full and the compact view.

- **Power button.** Wakes an offline NAS with Wake-on-LAN. Online, it offers hibernate, restart and shut down,
  sent over SSH. It asks first when files are open for writing or a disk is busy.
- **Disk rows.** A green dot is a spinning disk, with a halo while it is read or written; a moon is a sleeping
  one; amber and red mark a warm or failing disk. Click a row for its SMART counters, today's spin-ups and what
  last woke it. The button at the right end puts the disk to sleep or wakes it.
  Under each row a small chart shows three minutes of reads (blue) and writes (amber); **Disk activity charts**
  in the menu turns the charts off.
- **Disk information** (menu, or **Details…** in an opened row) opens a panel in the manner of CrystalDiskInfo:
  health, temperature, firmware, serial number, interface, rotation rate, power-on count and hours, and the
  whole attribute table, which is SMART with thresholds for SATA, the log pages for SAS and the health log for
  NVMe. A sleeping disk shows what was read while it last spun; the panel never wakes one.
- **Disk activity** (menu, **Activity…** in an opened row, or from the **Clients** popup) opens a live monitor
  showing which processes on the NAS (per physical disk via on-demand kernel DiskIo events, plus open SMB files)
  and which processes on this PC (with open NAS share handles highlighted) are reading or writing disks. It never
  wakes sleeping disks, and the NAS trace stops automatically once the window is closed.
- **Sleep after …** sets Windows' "turn off hard disk after" on the NAS. The agent also enforces it, putting a
  hard disk to sleep once it has gone that long without a read or write, because Windows was seen leaving idle
  disks spinning there.
- **Hibernate when idle** (menu) lets the agent hibernate the NAS after a set time with no hard-disk activity and
  no network file open for writing. It does not look at work done only on the NAS's system drive.
- **Follow this PC** (menu) ties the NAS to this PC. *Wake with this PC* sends the wake packets when NAS Deck
  starts after you sign in and whenever the PC resumes. *Sleep / shut down with PC* tells the agent as the PC
  sleeps or hibernates (the NAS hibernates) or shuts down (the NAS shuts down). The agent waits first, two minutes
  unless *Grace period* says otherwise (`FollowGraceMinutes` in `widget.json`), so a restart, which Windows does
  not tell apart from a shutdown, is called off when NAS Deck starts again; a restart that takes longer to reach
  the desktop lets the NAS go down, and it is woken as NAS Deck starts. The NAS stays on if another device is
  connected over SMB, saying why the next time NAS Deck connects, and waits while its disks are busy. The agent
  notes each notice in the NAS's Application event log (source `NasDeck.Agent`). A PC that loses power or crashes
  sends nothing, so the NAS stays on.
- **Clients** at the bottom lists who is connected over SMB and which files they hold open.

Notifications report a hot disk or CPU, reallocated or unreadable sectors, a nearly full volume, and a disk that
has spun up a dozen times in a day.

### Putting disks to sleep

"Sleep" is the ATA standby command: the platters stop and the heads park, the same thing Windows does when its
idle timer runs out. A SAS disk gets the SCSI equivalent, a START STOP UNIT that puts it in standby rather than
stopping it. It is not a power cut, which software cannot do. The next access spins the disk up again, after a
few seconds' wait, or about twenty for a large SAS disk.

Disks behind a SAS host bus adapter (an LSI/Broadcom SAS3008, for example) work like those on the motherboard:
SATA disks there are reached through the adapter's ATA translation, and SAS disks report temperature, hours,
start-stop and load cycles, grown defects and uncorrected errors from their log pages instead of SMART.

Spinning up is what wears a disk, so the agent rations it: it refuses a disk that was used in the last 30
seconds, or that woke within 10 minutes of the last sleep command, unless you confirm. The last-wake line names
the likely cause, an SMB client's open file or the busiest local processes, so that a disk which keeps waking can
be traced to what touches it. While a disk sleeps, the agent reads only its power state and Windows' I/O counters,
neither of which wakes it.

## Configuration

**Settings** has five tabs: **General** (Start menu shortcut, sign-in startup and system tray icon), **Connection**
(NAS address, SSH user and port), **Wake-on-LAN** (MAC, broadcast address and port), **Agent** (agent port and
installer) and **Recycle Bin** (Explorer shortcut interception and protected shares).

Everything the widget writes is in `data/`: `settings.json`, `widget.json` (position, pin, tray icon and
appearance), `follow.log` (each time this PC went down and whether the NAS was told), `recycle/` (recycle history)
and `agent-token`. Set `NAS_DECK_DATA_DIR` to keep it elsewhere; a relative path is relative to this folder.

The widget listens on `127.0.0.1:16000`, the local end of the SSH tunnel; the agent listens on the same port on
the NAS's loopback only, and every request carries the token that `Install-Agent.ps1` generated. The widget
connects straight to the NAS and to loopback and uses no proxy.

On the NAS the agent keeps its token and `state.json` (spin-up counts, wake log, the idle-hibernate setting) in
`C:\NasDeck\data`. Run by hand it takes `--port` and `--data`, the latter defaulting to `..\data` beside the
folder of the executable.

## Development

```powershell
dotnet build NasDeck.sln --configuration Release
dotnet test NasDeck.sln --configuration Release
```

`src/Protocol` holds the types both programs compile; `src/Agent` is the service and `src/App` the widget.

| Folder | Files |
|---|---|
| `src/Protocol` | `Contracts` defines the HTTP API models shared by agent and widget; `Format` formats rates, sizes and durations |
| `src/Agent` | `Sampler` polls every two seconds and runs disk commands; `DiskDevice` talks to disks via `AtaCommand`, `ScsiCommand`, `NvmeHealth` and `Smart`; `DiskActivityTracker` (with `EtwNative`) serves on-demand per-disk ETW I/O; `HostFollow`, `SleepGuard`, `SmbInfo`, `AgentState` and `Program` (HTTP API) |
| `src/App` | `DeckWindow` (+ `.Commands`, `.Menus`, `.Follow`) is the desktop widget; `DeckPainter` renders from `DeckModel`; `DiskInfoWindow` is the SMART panel; `SettingsWindow` and `AppShortcuts` manage settings and Windows shortcuts; `AgentLink` and `NasController` talk to the NAS |
| `src/App/Activity` | `DiskActivityWindow` is the live dual-machine I/O panel; `LocalActivityMonitor` reads local process I/O and open NAS SMB handles |
| `src/App/Recycle` | `ExplorerShortcuts`, `ExplorerSelection`, `RecycleStore`, `RecycleWindow` and `DeckWindow.Recycle` implement the NAS Recycle Bin |
| `src/App/Controls` | Reusable themed WinForms controls: `SurfaceButton`, `ThinScrollBar`, `ThemedInputs` (`ThemedCheckList`, `ThemedCheckBox`, `SegmentedTabs`) and `ThemedDialog` |
| `scripts` | Helpers the root scripts call (`Process-State.ps1`, `Send-NasPower.ps1`); `Install-AgentOnNas.ps1` runs on the NAS |

The agent runs on any Windows PC for testing: `.\build\NasDeck.Agent\NasDeck.Agent.exe --data data\agent-dev`, with
its token copied to `data\agent-token`; the widget uses an agent that already answers on its port instead of
opening a tunnel.
