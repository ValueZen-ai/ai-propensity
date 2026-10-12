#!/usr/bin/env node
// Builds converter/ai-propensity-converter.html: one self-contained file
// that works when opened straight from disk (browsers won't load separate
// script files for a page opened that way), with the CSS and the three
// modules in src/ inlined.
//
// The page's Content-Security-Policy allows exactly the inlined script and
// stylesheet (by SHA-256 hash) and nothing else — no network, no other code.
//
//   node build.mjs           write the file
//   node build.mjs --check   exit 1 if the committed file isn't a fresh build (CI)

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, "src", name), "utf8");
const OUT = join(here, "ai-propensity-converter.html");

// Order matters: a module can only import from modules above it.
const MODULES = ["zip", "convert", "ui"];

function bundleModule(name, code) {
  const exported = [...code.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
  const body = code
    .replace(/^import \{([^}]+)\} from "\.\/(\w+)\.js";$/gm, (_, names, mod) => {
      if (!MODULES.slice(0, MODULES.indexOf(name)).includes(mod)) throw new Error(`${name}.js imports ${mod}.js, which isn't bundled before it`);
      return `const {${names}} = __${mod};`;
    })
    .replace(/^export /gm, "");
  if (/^\s*(import|export)\b/m.test(body)) throw new Error(`${name}.js has an import/export form build.mjs doesn't handle`);
  return `// ---- src/${name}.js ----\nconst __${name} = (() => {\n${body.trimEnd()}\nreturn { ${exported.join(", ")} };\n})();\n`;
}

const sha256 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

export function build() {
  const style = `\n${src("page.css").trimEnd()}\n`;
  const script = `\n"use strict";\n${MODULES.map((m) => bundleModule(m, src(`${m}.js`))).join("\n")}`;
  for (const [what, text, tag] of [["style", style, "</style"], ["script", script, "</script"]]) {
    if (text.toLowerCase().includes(tag)) throw new Error(`the inlined ${what} contains "${tag}", which would end the tag early`);
  }

  const csp = [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  let html = src("page.html");
  for (const [marker, value] of [["__CSP__", csp], ["__STYLE__", style], ["__SCRIPT__", script]]) {
    const parts = html.split(marker);
    if (parts.length !== 2) throw new Error(`page.html must contain ${marker} exactly once`);
    html = parts.join(value);
  }
  return html;
}

const html = build();
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== html) {
    console.error("ai-propensity-converter.html is out of date with converter/src — run `node converter/build.mjs` and commit the result.");
    process.exit(1);
  }
  console.log("ai-propensity-converter.html matches a fresh build.");
} else {
  writeFileSync(OUT, html);
  console.log(`Wrote ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}
