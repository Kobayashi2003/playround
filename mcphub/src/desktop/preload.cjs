// Preload runs in an isolated context and must be CommonJS. It exposes a small,
// explicit API to the renderer instead of the full ipcRenderer surface.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  load: () => invoke("state:load"),
  toggle: (name, tool, on) => invoke("server:toggle", name, tool, on),
  add: (name, def) => invoke("server:add", name, def),
  remove: (name) => invoke("server:remove", name),
  importTool: (tool) => invoke("tool:import", tool),
});
