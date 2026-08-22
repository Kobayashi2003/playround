import fs from "node:fs";
import { registryPath } from "./paths.js";
import { atomicWrite } from "./fsutil.js";
import type { Registry } from "./types.js";

const EMPTY: Registry = { servers: {} };

export function loadRegistry(): Registry {
  if (!fs.existsSync(registryPath)) return structuredClone(EMPTY);
  const raw = fs.readFileSync(registryPath, "utf8");
  const parsed = JSON.parse(raw) as Registry;
  parsed.servers ??= {};
  return parsed;
}

export function saveRegistry(registry: Registry): void {
  atomicWrite(registryPath, JSON.stringify(registry, null, 2) + "\n");
}
