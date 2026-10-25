import { mkdir, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const sources = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ["/icon.svg", "icon.svg", "image/svg+xml"],
  [
    "/manifest.webmanifest",
    "manifest.webmanifest",
    "application/manifest+json",
  ],
  ["/icon-192.png", "icon-192.png", "image/png"],
  ["/icon-512.png", "icon-512.png", "image/png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
];
const assets = {};
for (const [path, file, type] of sources) {
  const bytes = await readFile(new URL(`web/${file}`, root));
  assets[path] = type.startsWith("image/png")
    ? { type, encoding: "base64", body: bytes.toString("base64") }
    : { type, body: bytes.toString("utf8") };
}
await mkdir(new URL("cloud/src/", root), { recursive: true });
await writeFile(
  new URL("cloud/src/generated-assets.js", root),
  `export const assets = ${JSON.stringify(assets)};\n`,
);
console.log("Web assets prepared.");
