# NAS Deck

- Checks: `dotnet build NasDeck.sln --configuration Release` (warnings are errors) and
  `dotnet test NasDeck.sln --configuration Release`.
- The `.ps1` files are run by Windows PowerShell 5.1, on this PC and on the NAS: keep them ASCII-only and free of
  PowerShell 7 syntax.
- `src/Protocol` is compiled into both the agent and the widget. A change there means reinstalling the agent
  (`.\Install-Agent.ps1 -Build`) as well as rebuilding the widget.
- The agent must never wake a sleeping disk by observing it. Before adding a device call to the sampler, check
  that it is answered without disk I/O, and skip it for a disk in standby otherwise.
- Live disk activity (`DiskActivityTracker` on the NAS and `LocalActivityMonitor` on this PC) must remain purely
  passive: the NAS ETW `DiskIo` session starts on demand and stops after idle, and local handle inspection reads
  kernel object names (`NtQueryObject`) on `FILE_TYPE_DISK` handles only without sending SMB requests.
- Send ATA commands only through `AtaCommand` with the disk's `DiskProtocol`. Behind the NAS's SAS3008,
  `IOCTL_ATA_PASS_THROUGH` returns success with blank registers, which reads as "asleep"; those disks need SAT
  (`Sat`) or SCSI (`Scsi`) commands.
- Do not flush a volume before sending a disk to standby: on the NAS, NTFS wrote again a few seconds after the
  flush and spun the disk straight back up. Windows' own disk idle timer did not spin the NAS's disks down, which
  is why the agent enforces "turn off hard disk after" itself.
- The SSH key path and the `nas-switch-` host-key alias are inherited from NAS Switch on purpose; renaming them
  would make every user set the key up again.
