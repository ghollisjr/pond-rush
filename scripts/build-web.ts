// ============================================================================
// build-web.ts
//
// Builds the publishable site into dist/.
//
// The bundle filename carries a hash of its own contents — app.<hash>.js — so
// it can never be served stale. A plain app.js is cached by the browser, and
// GitHub Pages sets max-age=600 on it, which is how a deploy ends up invisible
// for ten minutes to anyone with the page already open.
//
// Hashing does not make the *page* fresh — Pages caches index.html for the
// same ten minutes and we cannot set headers there. What it does guarantee is
// that the pair is always consistent: you never get new HTML running old JS,
// and the moment the new HTML does arrive its bundle is fetched rather than
// pulled from cache. Worst case is a wholly consistent ten-minute-old site,
// which is a different and much safer failure than a half-updated one.
//
// Dev is unaffected: `npm run dev` serves web/ directly with a plain app.js,
// which is what web/index.html references.
// ============================================================================

import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = (p: string) => `${root}${p}`;

const DEV_BUNDLE = "app.js";

await rm(src("dist"), { recursive: true, force: true });
await mkdir(src("dist"), { recursive: true });

const result = await build({
  entryPoints: [src("src/ui/main.ts")],
  bundle: true,
  format: "esm",
  minify: true,
  outdir: src("dist"),
  entryNames: "app.[hash]",
  metafile: true,
});

const outputs = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
if (outputs.length !== 1) {
  throw new Error(`Expected exactly one bundle, got ${outputs.length}: ${outputs}`);
}
const bundle = outputs[0].split("/").pop()!;

// Point the page at the hashed bundle. If the reference is not there, the
// build is wrong and publishing it would ship a blank page — so fail loudly
// rather than writing an index.html that loads nothing.
const html = await readFile(src("web/index.html"), "utf8");
if (!html.includes(`src="${DEV_BUNDLE}"`)) {
  throw new Error(`web/index.html does not reference "${DEV_BUNDLE}" — cannot rewrite it.`);
}
await writeFile(src("dist/index.html"), html.replace(`src="${DEV_BUNDLE}"`, `src="${bundle}"`));

// The default theme pack ships with the site.
await cp(src("web/theme"), src("dist/theme"), { recursive: true });

console.log(`dist/  index.html -> ${bundle}`);
