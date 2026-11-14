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
.\start.ps1 -Build -InstallShortcut -InstallStartup
```

`-InstallShortcut` adds NAS Deck to the Start menu and `-InstallStartup` starts it when you sign in. Run
`.\stop.ps1` to exit a session that `start.ps1` launched; `-RemoveShortcut` and `-RemoveStartup` take the two
shortcuts away again. To build and open the app directly:

```powershell
dotnet build src\App\NasDeck.App.csproj --configuration Release
.\build\NasDeck.App\NasDeck.exe
```

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
- **Sleep after …** sets Windows' "turn off hard disk after" on the NAS. The agent also enforces it, putting a
  hard disk to sleep once it has gone that long without a read or write, because Windows was seen leaving idle
  disks spinning there.
- **Hibernate when idle** (menu) lets the agent hibernate the NAS after a set time with no hard-disk activity and
  no network file open for writing. It does not look at work done only on the NAS's system drive.
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

**Settings** edits the NAS address, SSH user and port, the Wake-on-LAN MAC, broadcast address and port, and the
agent port. Everything the widget writes is in `data/`: `settings.json`, `widget.json` (position, pin and appearance)
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
| `src/Agent` | `Sampler` reads the machine every two seconds and runs the disk commands; `DiskDevice` talks to the disks through `AtaCommand`, `ScsiCommand` and `NvmeHealth`, and `Smart` reads the SMART table; `SleepGuard` decides when a disk may sleep; `AgentState` is `state.json`; `Program` is the HTTP API |
| `src/App` | `DeckWindow` is the window (its commands and menus in `DeckWindow.Commands` and `DeckWindow.Menus`); `DeckPainter` draws it from `DeckModel`; `DiskInfoWindow` is the disk information panel; `AgentLink` is the SSH tunnel and the agent client; `NasController` wakes and powers the NAS |
| `scripts` | Helpers the root scripts call; `Install-AgentOnNas.ps1` runs on the NAS |

The agent runs on any Windows PC for testing: `.\build\NasDeck.Agent\NasDeck.Agent.exe --data data\agent-dev`, with
its token copied to `data\agent-token`; the widget uses an agent that already answers on its port instead of
opening a tunnel.
