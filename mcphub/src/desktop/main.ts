import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import {
  listServers,
  status,
  enable,
  disable,
  addServer,
  removeServer,
  importFrom,
} from "../core.js";
import { ALL_TOOLS, type McpServer, type ToolId } from "../types.js";

const here = import.meta.dirname;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 820,
    height: 560,
    icon: path.join(here, "icon.png"),
    webPreferences: { preload: path.join(here, "preload.cjs") },
  });
  win.loadFile(path.join(here, "index.html"));
}

/** Wrap a handler so any thrown error is returned to the renderer, not swallowed. */
function handle<T>(channel: string, fn: (...args: any[]) => T): void {
  ipcMain.handle(channel, (_e, ...args) => {
    try {
      return { ok: true, data: fn(...args) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

handle("state:load", () => ({ tools: ALL_TOOLS, servers: listServers(), status: status() }));
handle("server:toggle", (name: string, tool: ToolId, on: boolean) =>
  on ? enable(name, [tool]) : disable(name, [tool])
);
handle("server:add", (name: string, def: McpServer) => addServer(name, def));
handle("server:remove", (name: string) => removeServer(name));
handle("tool:import", (tool: ToolId) => importFrom(tool));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
