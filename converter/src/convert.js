/*
 * AI Propensity Signal Collector — export converter (browser port of the
 * claude-web and chatgpt adapters).
 *
 * This is a line-for-line port of:
 *   adapters/claude-web/collect.py  (_load_export, _messages_of, _features_of, cmd_import)
 *   adapters/chatgpt/collect.py     (_load_export, _merge_conversation_lists, _messages_of,
 *                                    _features_of, _iso, cmd_import)
 *   core/event_schema.py            (make_event, duration_seconds, utcnow)
 *   core/export.py                  (export_evidence's payload shape and event order)
 * and must produce the same events for the same export — tests/test_converter_parity.py
 * runs both on the same inputs and fails on any difference. If you change
 * what one of them extracts, change the other in the same commit.
 *
 * Message text is read only to measure its length (and to skip blank
 * messages, as the Python does). No text, title, file name or attachment
 * name is ever copied into an event.
 *
 * Python semantics the port has to reproduce, because the numbers must
 * match: dict.get (a present-but-null key returns null, not the default),
 * truthiness ([] and {} are false), len() counting code points rather than
 * UTF-16 units, and str.strip()'s definition of whitespace.
 */

export const CONVERTER_VERSION = "1.0.0";
export const SCHEMA_VERSION = 1;
// Same values as PARSER_VERSION in each adapter's collect.py.
export const PARSER_VERSIONS = { claude_web: 2, chatgpt: 2 };
export const PROVENANCE = "browser_converter";

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

function isDict(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** dict.get(key, default): a key that is present with a null value returns null. */
function get(obj, key, dflt = undefined) {
  return isDict(obj) && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** `a or b` */
function or(...values) {
  for (const v of values.slice(0, -1)) if (truthy(v)) return v;
  return values[values.length - 1];
}

function asList(v) {
  return Array.isArray(v) ? v : isDict(v) ? Object.values(v) : [];
}

/** str(x) for the values that can reach it here. */
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** len(s): code points, not UTF-16 units (an emoji is 1, not 2). */
function pyLen(s) {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n--; i++; }
    }
  }
  return n;
}

// The characters Python's str.isspace() accepts (what str.strip() removes).
const PY_NOT_SPACE = new RegExp("[^" + [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000].map((c) => "\\u" + c.toString(16).padStart(4, "0")).join("") + "]");
function isBlank(s) {
  return !PY_NOT_SPACE.test(s);
}

function startsWithAny(s, prefixes) {
  return typeof s === "string" && prefixes.some((p) => s.startsWith(p));
}

/** sorted() over strings: code point order. */
function pySorted(strings) {
  return [...strings].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function lower(v) {
  return typeof v === "string" ? v.toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// core/event_schema.py
// ---------------------------------------------------------------------------

function isoSeconds(date) {
  return date.toISOString().slice(0, 19) + "Z";
}

export function utcnow() {
  return isoSeconds(new Date());
}

/** ts_to_seconds: strptime(ts[:19], "%Y-%m-%dT%H:%M:%S") read as UTC, or null. */
function tsToSeconds(ts) {
  if (typeof ts !== "string" || !ts) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(ts.slice(0, 19));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
      || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    return null; // strptime rejects e.g. Feb 30 or 25:00
  }
  return Math.floor(ms / 1000);
}

function durationSeconds(startTs, endTs) {
  const s = tsToSeconds(startTs);
  const e = tsToSeconds(endTs);
  return s && e && e >= s ? e - s : null;
}

function makeEvent(type, sessionId, source, extra, ts) {
  return {
    schema_version: SCHEMA_VERSION,
    ts: truthy(ts) ? ts : utcnow(),
    event: type,
    source,
    session_id: sessionId,
    historical: true,
    observed_at: utcnow(),
    provenance: PROVENANCE,
    ...extra,
  };
}

function sum(items, fn) {
  let total = 0;
  for (const x of items) total += fn(x);
  return total;
}

// ---------------------------------------------------------------------------
// adapters/claude-web/collect.py
// ---------------------------------------------------------------------------

const CLAUDE_CANDIDATES = ["conversations.json", "conversations_v2.json"];
const CLAUDE_WEB_TOOLS = ["web_search", "web_search_fast", "web_fetch"];
const CLAUDE_CREATE_TOOLS = ["create_file", "artifacts", "repl", "present_files"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"];
const CLAUDE_CONNECTOR_PREFIXES = [
  "google_drive", "gdrive", "gmail", "gcal", "google_calendar", "slack", "notion",
  "github", "asana", "linear", "jira", "confluence", "atlassian",
];

function claudeFeaturesOf(conversation) {
  const features = new Set();
  for (const m of asList(or(get(conversation, "chat_messages", []), []))) {
    if (truthy(get(m, "attachments"))) features.add("file_upload");
    for (const f of asList(or(get(m, "files"), []))) {
      const name = lower(or(get(or(f, {}), "file_name"), ""));
      features.add(IMAGE_EXTS.some((ext) => name.endsWith(ext)) ? "image_input" : "file_upload");
    }
    for (const block of asList(or(get(m, "content"), []))) {
      if (!isDict(block)) continue;
      const kind = get(block, "type");
      if (kind === "thinking") features.add("reasoning");
      if (kind !== "tool_use") continue;
      const name = lower(or(get(block, "name"), ""));
      if (CLAUDE_WEB_TOOLS.includes(name)) features.add("web_search");
      else if (CLAUDE_CREATE_TOOLS.includes(name)) features.add("created_files");
      else if (name === "project_knowledge_search") features.add("projects");
      else if (name.includes("research")) features.add("deep_research");
      else if (startsWithAny(name, CLAUDE_CONNECTOR_PREFIXES)) features.add("connectors");
    }
  }
  return features;
}

function claudeMessagesOf(conversation) {
  const out = [];
  for (const m of asList(or(get(conversation, "chat_messages", []), []))) {
    const role = or(get(m, "sender"), get(m, "role"), "");
    let text = get(m, "text", "");
    if (Array.isArray(text)) {
      text = text.filter(isDict).map((c) => pyStr(get(c, "text", ""))).join(" ");
    }
    out.push({ role, text: typeof text === "string" ? text : truthy(text) ? pyStr(text) : "",
               ts: or(get(m, "created_at"), get(m, "timestamp"), "") });
  }
  return out;
}

const isClaudeUser = (role) => role === "human" || role === "user";

export function convertClaudeWeb(conversations) {
  const source = "claude_web";
  const events = [];
  const stats = { conversations: conversations.length, imported: 0, empty: 0, noId: 0 };
  for (const conv of conversations) {
    const sessionId = or(get(conv, "uuid"), get(conv, "id"), "");
    if (!truthy(sessionId)) { stats.noId++; continue; }
    const messages = claudeMessagesOf(conv);
    if (!messages.length) { stats.empty++; continue; }

    const userTurns = messages.filter((m) => isClaudeUser(m.role)).length;
    const aiTurns = messages.filter((m) => m.role === "assistant").length;
    const startTs = or(get(conv, "created_at"), messages[0].ts);
    const endTs = or(get(conv, "updated_at"), messages[messages.length - 1].ts);

    events.push(makeEvent("session_start", sessionId, source, { project: "claude.ai" }, startTs));
    for (const m of messages) {
      if (m.role === "assistant") events.push(makeEvent("ai_turn", sessionId, source, {}, or(m.ts, startTs)));
    }
    events.push(makeEvent("session_end", sessionId, source, {
      trigger: "export_import",
      ai_turns: aiTurns,
      user_turns: userTurns,
      duration_seconds: durationSeconds(startTs, endTs),
      user_chars_total: sum(messages.filter((m) => isClaudeUser(m.role)), (m) => pyLen(m.text)),
      ai_chars_total: sum(messages.filter((m) => m.role === "assistant"), (m) => pyLen(m.text)),
      features: pySorted(claudeFeaturesOf(conv)),
    }, or(endTs, startTs)));
    stats.imported++;
  }
  return { source, events, stats };
}

// ---------------------------------------------------------------------------
// adapters/chatgpt/collect.py
// ---------------------------------------------------------------------------

const WEB_REFERENCE_TYPES = ["grouped_webpages", "webpage_extended", "webpage"];

function chatgptMessagesOf(conversation) {
  // Object.values keeps the export's key order for non-numeric keys, which
  // ChatGPT's node ids always are — the same order Python's dict gives.
  const nodes = [];
  for (const node of asList(get(conversation, "mapping", {}))) {
    const msg = get(node, "message");
    if (!truthy(msg)) continue;
    const role = get(or(get(msg, "author"), {}), "role", "");
    const parts = asList(get(or(get(msg, "content"), {}), "parts", []));
    const text = parts.filter((p) => typeof p === "string").join(" ");
    if (isBlank(text)) continue;
    nodes.push({
      role,
      text,
      ts: get(msg, "create_time"),
      model: get(or(get(msg, "metadata"), {}), "model_slug", ""),
    });
  }
  const key = (n) => (truthy(n.ts) ? Number(n.ts) : 0);
  nodes.sort((a, b) => key(a) - key(b)); // stable, like list.sort
  return nodes;
}

function chatgptFeaturesOf(conversation) {
  const features = new Set();
  const template = or(get(conversation, "conversation_template_id"), get(conversation, "gizmo_id"), "");
  if (typeof template === "string" && template.startsWith("g-p-")) features.add("projects");
  if (truthy(get(conversation, "plugin_ids"))) features.add("connectors");

  for (const node of asList(or(get(conversation, "mapping"), {}))) {
    const msg = get(node, "message");
    if (!truthy(msg)) continue;
    const md = or(get(msg, "metadata"), {});
    const content = or(get(msg, "content"), {});
    const author = or(get(msg, "author"), {});
    const role = get(author, "role", "");
    const toolName = role === "tool" ? or(get(author, "name"), "") : "";
    const recipient = or(get(msg, "recipient"), "");
    const model = or(get(md, "model_slug"), "");

    if (truthy(get(md, "search_result_groups"))
        || asList(or(get(md, "content_references"), [])).some((r) => WEB_REFERENCE_TYPES.includes(get(or(r, {}), "type")))
        || startsWithAny(toolName, ["web", "browser"]) || startsWithAny(recipient, ["web", "browser"])) {
      features.add("web_search");
    }

    for (const a of asList(or(get(md, "attachments"), []))) {
      const mime = or(get(or(a, {}), "mime_type"), "");
      features.add(typeof mime === "string" && mime.startsWith("image/") ? "image_input" : "file_upload");
    }
    if (role === "user" && get(content, "content_type") === "multimodal_text") {
      if (asList(or(get(content, "parts"), [])).some((part) => isDict(part) && get(part, "content_type") === "image_asset_pointer")) {
        features.add("image_input");
      }
    }

    const ctype = get(content, "content_type");
    if (ctype === "thoughts" || ctype === "reasoning_recap" || (typeof model === "string" && model.includes("thinking"))) {
      features.add("reasoning");
    }
    if (truthy(get(md, "async_task_title")) || (typeof model === "string" && model.includes("research"))) {
      features.add("deep_research");
    }
    if (startsWithAny(toolName, ["canmore", "python", "dalle", "image_gen"]) || startsWithAny(recipient, ["canmore", "python"])) {
      features.add("created_files");
    }
  }
  return features;
}

function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** _iso: unix seconds -> "YYYY-MM-DDTHH:MM:SSZ", or null. */
function iso(unixTs) {
  if (!truthy(unixTs)) return null;
  const t = Number(unixTs);
  if (!Number.isFinite(t)) return null;
  // datetime.fromtimestamp: split off the fraction, round it half-to-even
  // to microseconds (carrying into the seconds), then strftime drops it.
  let seconds = Math.trunc(t);
  const us = roundHalfEven((t - seconds) * 1e6);
  if (us >= 1e6) seconds += 1;
  else if (us < 0) seconds -= 1;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : isoSeconds(d);
}

export function convertChatGPT(conversations) {
  const source = "chatgpt";
  const events = [];
  const stats = { conversations: conversations.length, imported: 0, empty: 0, noId: 0 };
  for (const conv of conversations) {
    const sessionId = or(get(conv, "conversation_id"), get(conv, "id"), "");
    if (!truthy(sessionId)) { stats.noId++; continue; }
    const messages = chatgptMessagesOf(conv);
    if (!messages.length) { stats.empty++; continue; }

    const userTurns = messages.filter((m) => m.role === "user").length;
    const assistantTurns = messages.filter((m) => m.role === "assistant");
    // `_iso(a) or (b and _iso(b))`
    const first = messages[0].ts;
    const last = messages[messages.length - 1].ts;
    const startTs = or(iso(get(conv, "create_time")), truthy(first) ? iso(first) : first);
    const endTs = or(iso(get(conv, "update_time")), truthy(last) ? iso(last) : last);

    events.push(makeEvent("session_start", sessionId, source, { project: "chatgpt.com" }, startTs));
    for (const m of assistantTurns) {
      events.push(makeEvent("ai_turn", sessionId, source, { model: m.model === undefined ? "" : m.model }, or(iso(m.ts), startTs)));
    }
    events.push(makeEvent("session_end", sessionId, source, {
      trigger: "export_import",
      ai_turns: assistantTurns.length,
      user_turns: userTurns,
      duration_seconds: durationSeconds(startTs, endTs),
      user_chars_total: sum(messages.filter((m) => m.role === "user"), (m) => pyLen(m.text)),
      ai_chars_total: sum(assistantTurns, (m) => pyLen(m.text)),
      features: pySorted(chatgptFeaturesOf(conv)),
    }, or(endTs, startTs)));
    stats.imported++;
  }
  return { source, events, stats };
}

// ---------------------------------------------------------------------------
// Loading an export: a zip, an unzipped folder, or loose JSON file(s).
// `files` is a list of {name, text()} — `name` is the path inside the zip
// or folder. Mirrors each adapter's _load_export().
// ---------------------------------------------------------------------------

export class ExportError extends Error {}

const basename = (path) => path.split(/[\\/]/).pop();
const depth = (path) => path.split(/[\\/]/).length;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function isChatgptZipName(name) {
  const base = basename(name);
  return base === "conversations.json" || base.startsWith("conversations-");
}

function isChatgptSplitFile(name) {
  const base = basename(name);
  return base.startsWith("conversations-") && base.endsWith(".json");
}

function shallowest(files) {
  return [...files].sort((a, b) => depth(a.name) - depth(b.name))[0];
}

async function parseJson(file) {
  try {
    return JSON.parse(await file.text());
  } catch (err) {
    throw new ExportError(`${basename(file.name)} isn't valid JSON (${err.message}). The file may be incomplete — try downloading the export again.`);
  }
}

function sourceOf(list) {
  const first = asList(list).find(isDict);
  if (!first) return null;
  if ("mapping" in first) return "chatgpt";
  if ("chat_messages" in first) return "claude_web";
  return null;
}

const NOT_AN_EXPORT =
  "No conversations file found. Choose the export you downloaded from ChatGPT " +
  "(Settings → Data controls → Export data) or Claude (Settings → Privacy → Export data) — " +
  "the .zip from the email, or the folder it unzips to.";

function looksLikeCodingTool(files) {
  return files.some((f) => /(^|[\\/])\.?(claude|codex)[\\/]/.test(f.name) || /rollout-.*\.jsonl$/.test(f.name) || f.name.endsWith(".jsonl"));
}

/**
 * Load one export into {source, conversations}. `fromZip` selects the
 * zip-reading rules (vs. the folder rules) from the adapters, which differ
 * slightly in which conversations file they prefer. `onRead(file)`, if
 * given, is awaited before each file is read (for progress messages).
 */
export async function loadExport(files, { fromZip = false, onRead = null } = {}) {
  const parsed = new Map(); // name -> parsed JSON, so nothing is read twice
  const read = async (f) => {
    if (!parsed.has(f.name)) {
      if (onRead) await onRead(f);
      parsed.set(f.name, await parseJson(f));
    }
    return parsed.get(f.name);
  };

  // One loose .json file of any name: the adapters' "path is a .json file" case.
  if (!fromZip && files.length === 1 && files[0].name.toLowerCase().endsWith(".json")) {
    const raw = await read(files[0]);
    if (!Array.isArray(raw)) throw new ExportError(`${basename(files[0].name)} isn't a conversations file from a ChatGPT or Claude export.`);
    const source = sourceOf(raw);
    if (!source && raw.length) throw new ExportError(`${basename(files[0].name)} doesn't look like a ChatGPT or Claude export.`);
    if (!source) throw new ExportError("That file has no conversations in it.");
    return { source, conversations: raw, files: [basename(files[0].name)], notes: [] };
  }

  const candidates = files.filter((f) => CLAUDE_CANDIDATES.includes(basename(f.name)) || isChatgptZipName(f.name));
  if (!candidates.length) {
    throw new ExportError(looksLikeCodingTool(files)
      ? "This looks like Claude Code or Codex history, not a ChatGPT/Claude chat export. For those, use the command-line collector (see the README)."
      : NOT_AN_EXPORT);
  }

  // Work out which product this is from the first conversation's shape —
  // both products name their file conversations.json.
  let source = null;
  for (const f of candidates.filter((c) => c.name.toLowerCase().endsWith(".json"))) {
    source = sourceOf(await read(f));
    if (source) break;
  }
  if (!source) throw new ExportError("This export has no conversations in it (or its format isn't one this page recognises).");

  const notes = [];
  let chosen;
  let conversations;
  if (source === "claude_web") {
    if (fromZip) {
      // names[0] in the zip's own order
      chosen = [files.find((f) => CLAUDE_CANDIDATES.includes(basename(f.name)))];
    } else {
      // Folder: conversations.json first, then conversations_v2.json.
      for (const name of CLAUDE_CANDIDATES) {
        const matches = files.filter((f) => basename(f.name) === name);
        if (matches.length) { chosen = [shallowest(matches)]; break; }
      }
    }
    const raw = await read(chosen[0]);
    if (!Array.isArray(raw)) throw new ExportError("Expected the export's conversations file to be a list of conversations. The export format may have changed — please report it.");
    conversations = raw;
  } else {
    if (fromZip) {
      chosen = files.filter((f) => isChatgptZipName(f.name)).sort(byName);
    } else {
      const whole = files.filter((f) => basename(f.name) === "conversations.json");
      chosen = whole.length ? [shallowest(whole)] : files.filter((f) => isChatgptSplitFile(f.name)).sort(byName);
    }
    // _merge_conversation_lists
    conversations = [];
    for (const f of chosen) {
      const payload = await read(f);
      if (!Array.isArray(payload)) { notes.push(`Skipped ${basename(f.name)}: not a list of conversations.`); continue; }
      conversations.push(...payload);
    }
  }
  return { source, conversations, files: chosen.map((f) => basename(f.name)), notes };
}

export function convert(source, conversations) {
  if (source === "claude_web") return convertClaudeWeb(conversations);
  if (source === "chatgpt") return convertChatGPT(conversations);
  throw new ExportError(`Unknown source ${source}`);
}

// ---------------------------------------------------------------------------
// core/export.py::export_evidence — one upload file for one or more sources
// ---------------------------------------------------------------------------

export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `results` is a list of convert() results. Returns {payload, filename}, or
 * null when there are no events. Events come out in the order the Python
 * export reads them: by day (ts[:10]), then in the order they were made.
 */
export function buildEvidence(results) {
  const today = localDate();
  const keyed = [];
  for (const r of results) {
    for (const ev of r.events) {
      keyed.push({ key: String(ev.ts || "").slice(0, 10) || today, ev });
    }
  }
  if (!keyed.length) return null;
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // stable
  const sources = pySorted(new Set(results.map((r) => r.source)));
  const label = sources.join("+");
  return {
    payload: {
      schema_version: SCHEMA_VERSION,
      source: label,
      exported_at: utcnow(),
      tiers_included: ["basic"],
      events: keyed.map((k) => k.ev),
    },
    filename: `propensity-evidence-${label}-${today}.json`,
  };
}
