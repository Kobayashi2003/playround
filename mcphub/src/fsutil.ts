import fs from "node:fs";
import path from "node:path";

/** How many timestamped backups to retain per config file. */
const KEEP_BACKUPS = 5;

/** Create a timestamped backup next to the file, then prune older ones. */
export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, backup);
  pruneBackups(filePath);
  return backup;
}

/** Keep only the newest KEEP_BACKUPS ".bak" files for a given config path. */
function pruneBackups(filePath: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"))
    .sort(); // ISO timestamps sort chronologically
  for (const old of backups.slice(0, -KEEP_BACKUPS)) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
}

/** Write via a temp file + rename so a crash never leaves a half-written config. */
export function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // never leave a stray temp file behind
    throw err;
  }
}

export function readTextIfExists(filePath: string): string | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}
