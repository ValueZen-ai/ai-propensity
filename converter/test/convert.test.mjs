// What the page tells people when they give it the wrong thing. Output
// parity with the Python adapters is tested from tests/test_converter_parity.py.
//
//   node --test converter/test/*.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import { ExportError, buildEvidence, convert, loadExport } from "../src/convert.js";

const file = (name, content) => ({ name, text: async () => (typeof content === "string" ? content : JSON.stringify(content)) });

test("detects ChatGPT and Claude from content, not file name", async () => {
  const gpt = await loadExport([file("export/conversations.json", [{ conversation_id: "a", mapping: {} }])]);
  assert.equal(gpt.source, "chatgpt");
  const claude = await loadExport([file("export/conversations.json", [{ uuid: "a", chat_messages: [] }])]);
  assert.equal(claude.source, "claude_web");
});

test("a folder without a conversations file explains what to choose", async () => {
  await assert.rejects(loadExport([file("photos/a.json", []), file("photos/b.jpg", "")]), (err) => err instanceof ExportError && /No conversations file found/.test(err.message));
});

test("Claude Code / Codex history is pointed at the command-line collector", async () => {
  await assert.rejects(loadExport([file(".claude/projects/x/session.jsonl", "{}"), file("notes.txt", "")]),
    (err) => err instanceof ExportError && /command-line collector/.test(err.message));
});

test("invalid JSON says the download may be incomplete", async () => {
  await assert.rejects(loadExport([file("conversations.json", "[{")]), (err) => err instanceof ExportError && /incomplete/.test(err.message));
});

test("an empty export is reported, not converted to an empty file", async () => {
  await assert.rejects(loadExport([file("conversations.json", [])]), ExportError);
});

test("one ChatGPT split file that isn't a list is skipped with a note", async () => {
  const loaded = await loadExport([
    file("conversations-000.json", [{ conversation_id: "a", mapping: {} }]),
    file("conversations-001.json", { not: "a list" }),
  ]);
  assert.equal(loaded.conversations.length, 1);
  assert.match(loaded.notes[0], /conversations-001\.json/);
});

test("the evidence file never carries message text or titles", () => {
  const secret = "my secret plan";
  const { events } = convert("claude_web", [{
    uuid: "c", name: secret, created_at: "2026-10-01T09:00:00Z",
    chat_messages: [{ sender: "human", text: secret, files: [{ file_name: `${secret}.pdf` }] }, { sender: "assistant", text: secret }],
  }]);
  const json = JSON.stringify(buildEvidence([{ source: "claude_web", events }]).payload);
  assert.ok(!json.includes("secret"));
});

test("nothing to export gives null", () => {
  assert.equal(buildEvidence([{ source: "chatgpt", events: [] }]), null);
});
