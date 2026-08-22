// Rasterize assets/icon.svg into a PNG and a multi-size Windows ICO.
// Run manually (`node scripts/generate-icon.mjs`) when the SVG changes.
import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const assets = path.resolve("assets");
const svg = fs.readFileSync(path.join(assets, "icon.svg"));

const renderPng = (size) =>
  new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

// App PNG (used as the Electron window icon).
fs.writeFileSync(path.join(assets, "icon.png"), renderPng(256));

// ICO bundles several sizes so Windows picks the crispest one per context.
const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(renderPng));
fs.writeFileSync(path.join(assets, "icon.ico"), ico);

console.log("Generated assets/icon.png and assets/icon.ico");
