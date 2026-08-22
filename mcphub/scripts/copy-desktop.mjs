// Copy the desktop assets that tsc does not emit (preload, html, renderer JS).
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("src/desktop");
const dest = path.resolve("dist/desktop");
fs.mkdirSync(dest, { recursive: true });

for (const file of ["preload.cjs", "index.html", "renderer.js"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
fs.copyFileSync(path.resolve("assets/icon.png"), path.join(dest, "icon.png"));
console.log("Copied desktop assets to dist/desktop");
