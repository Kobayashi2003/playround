import { mkdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const sources = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/icon.svg", "icon.svg", "image/svg+xml"],
];
const assets = {};
for (const [path, file, type] of sources)
  assets[path] = {
    type,
    body: await readFile(new URL(`web/${file}`, root), "utf8"),
  };
await mkdir(new URL("cloud/src/", root), { recursive: true });
await writeFile(
  new URL("cloud/src/generated-assets.js", root),
  `export const assets = ${JSON.stringify(assets)};\n`,
);
console.log("Web assets prepared.");
