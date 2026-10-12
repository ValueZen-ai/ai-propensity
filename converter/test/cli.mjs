#!/usr/bin/env node
// Runs the converter's own pipeline (the same loadExport -> convert ->
// buildEvidence the page runs) from the command line, for the parity test
// and for checking a real export against the Python adapters:
//
//   node converter/test/cli.mjs <export.zip | folder | conversations.json> [...more exports]
//
// Prints the evidence file to stdout.

import { openAsBlob } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { buildEvidence, convert, loadExport } from "../src/convert.js";
import { listZipEntries } from "../src/zip.js";

async function filesUnder(dir, root = dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...await filesUnder(full, root));
    else out.push(diskFile(full, path.relative(root, full)));
  }
  return out;
}

function diskFile(full, name) {
  return { name, text: async () => (await openAsBlob(full)).text() };
}

async function convertPath(p) {
  if ((await stat(p)).isDirectory()) {
    return loadExport(await filesUnder(p));
  }
  if (p.toLowerCase().endsWith(".zip")) {
    return loadExport(await listZipEntries(await openAsBlob(p)), { fromZip: true });
  }
  return loadExport([diskFile(p, path.basename(p))]);
}

const results = [];
for (const p of process.argv.slice(2)) {
  const loaded = await convertPath(p);
  results.push(convert(loaded.source, loaded.conversations));
}
const evidence = buildEvidence(results);
process.stdout.write(JSON.stringify(evidence ? evidence.payload : null));
