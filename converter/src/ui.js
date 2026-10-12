/*
 * The page: picks up the export the person drops or chooses, runs it
 * through convert.js, shows what the resulting file contains, and saves it.
 * Nothing here talks to a network — the page's Content-Security-Policy
 * would block it if anything tried.
 */

import { CONVERTER_VERSION, PARSER_VERSIONS, ExportError, buildEvidence, convert, loadExport } from "./convert.js";
import { listZipEntries } from "./zip.js";

const $ = (id) => document.getElementById(id);

const SOURCE_LABELS = { chatgpt: "ChatGPT", claude_web: "Claude" };
const FEATURE_LABELS = {
  web_search: "Web search",
  file_upload: "File uploads",
  image_input: "Images",
  reasoning: "Thinking / reasoning",
  deep_research: "Deep research",
  projects: "Projects",
  connectors: "Connectors / apps",
  created_files: "Canvas / artifacts",
};

const exportsBySource = new Map(); // source -> {result, files, notes, from}
let evidence = null; // {payload, filename, json}
let showingAll = false;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fmt = (n) => n.toLocaleString();

function size(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function setStatus(text) {
  $("status").textContent = text;
}

function showError(text) {
  $("error").textContent = text;
  $("error").hidden = !text;
}

// ---------------------------------------------------------------------------
// Getting files in. Each "group" is one export: a zip, a folder, or a set
// of loose JSON files chosen together.
// ---------------------------------------------------------------------------

function fileWrapper(file, name) {
  return { name, size: file.size, text: () => file.text() };
}

function isZip(file) {
  return file.name.toLowerCase().endsWith(".zip");
}

function groupsFromFileList(fileList) {
  const files = [...fileList];
  const groups = files.filter(isZip).map((file) => ({ kind: "zip", file, label: file.name }));
  const loose = files.filter((f) => !isZip(f));
  if (loose.length) {
    const label = loose[0].webkitRelativePath ? loose[0].webkitRelativePath.split("/")[0] : loose.map((f) => f.name).join(", ");
    groups.push({
      kind: "files",
      label,
      files: loose.map((f) => fileWrapper(f, f.webkitRelativePath || f.name)),
    });
  }
  return groups;
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDirectory(dirEntry) {
  const out = [];
  const reader = dirEntry.createReader();
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const entry of batch) {
      if (entry.isDirectory) out.push(...await readDirectory(entry));
      else out.push(fileWrapper(await entryFile(entry), entry.fullPath.replace(/^\//, "")));
    }
  }
  return out;
}

function groupsFromDrop(dataTransfer) {
  // Everything has to be pulled off the DataTransfer before the drop event
  // returns, so this part is synchronous and the reading happens after.
  const entries = [...(dataTransfer.items || [])]
    .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  const fileList = dataTransfer.files;
  return (async () => {
    if (!entries.length) return groupsFromFileList(fileList);
    const groups = [];
    const loose = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        setStatus(`Looking inside ${entry.name}…`);
        groups.push({ kind: "files", label: entry.name, files: await readDirectory(entry) });
      } else {
        const file = await entryFile(entry);
        if (isZip(file)) groups.push({ kind: "zip", file, label: file.name });
        else loose.push(fileWrapper(file, file.name));
      }
    }
    if (loose.length) groups.push({ kind: "files", label: loose.map((f) => f.name).join(", "), files: loose });
    return groups;
  })();
}

// ---------------------------------------------------------------------------
// Converting
// ---------------------------------------------------------------------------

async function convertGroup(group) {
  setStatus(`Opening ${group.label}…`);
  await tick();
  const onRead = async (f) => {
    const bytes = f.uncompressedSize ?? f.size;
    setStatus(`Reading ${f.name.split(/[\\/]/).pop()}${bytes == null ? "" : ` (${size(bytes)})`}…`);
    await tick();
  };
  const files = group.kind === "zip" ? await listZipEntries(group.file) : group.files;
  const loaded = await loadExport(files, { fromZip: group.kind === "zip", onRead });
  setStatus(`Counting ${fmt(loaded.conversations.length)} conversations…`);
  await tick();
  const result = convert(loaded.source, loaded.conversations);
  return { result, files: loaded.files, notes: loaded.notes, from: group.label };
}

async function handleGroups(groupsPromise) {
  showError("");
  let groups;
  try {
    groups = await groupsPromise;
  } catch (err) {
    showError(`Couldn't open that: ${err.message}`);
    setStatus("");
    return;
  }
  if (!groups.length) return;

  const added = [];
  for (const group of groups) {
    try {
      const converted = await convertGroup(group);
      const { source, stats } = converted.result;
      if (stats.imported === 0) {
        showError(`No conversations could be read from ${group.label}. If the export isn't empty, its format may have changed. Please report it at github.com/ValueZen-ai/ai-propensity/issues.`);
        continue;
      }
      const replaced = exportsBySource.has(source);
      exportsBySource.set(source, converted);
      added.push(`${SOURCE_LABELS[source]}${replaced ? " (replaced the earlier one)" : ""}`);
    } catch (err) {
      const message = err instanceof ExportError ? err.message : `Something went wrong reading ${group.label}: ${err.message}`;
      showError(message);
    }
  }
  setStatus(added.length ? `Added ${added.join(" and ")}.` : "");
  render();
}

// ---------------------------------------------------------------------------
// Showing the result
// ---------------------------------------------------------------------------

function summarize(events) {
  const ends = events.filter((e) => e.event === "session_end");
  const starts = events.filter((e) => e.event === "session_start").map((e) => String(e.ts).slice(0, 10)).sort();
  const featureSessions = {};
  for (const e of ends) for (const f of e.features || []) featureSessions[f] = (featureSessions[f] || 0) + 1;
  const fieldsByEvent = {};
  for (const e of events) {
    const keys = (fieldsByEvent[e.event] = fieldsByEvent[e.event] || new Set());
    for (const k of Object.keys(e)) keys.add(k);
  }
  return {
    conversations: ends.length,
    yourMessages: ends.reduce((n, e) => n + (e.user_turns || 0), 0),
    aiReplies: ends.reduce((n, e) => n + (e.ai_turns || 0), 0),
    first: starts[0],
    last: starts[starts.length - 1],
    featureSessions,
    fieldsByEvent,
    hasModel: events.some((e) => e.event === "ai_turn" && e.model),
  };
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function month(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

function period(first, last) {
  if (!first || !last) return "—";
  const a = month(first);
  const b = month(last);
  return a === b ? a : `${a} – ${b}`;
}

function stat(value, label) {
  return el("div", { className: "stat" }, el("b", { textContent: value }), el("span", { textContent: label }));
}

function renderExports() {
  const list = $("exports");
  list.replaceChildren();
  for (const [source, info] of exportsBySource) {
    const { stats } = info.result;
    const skipped = stats.empty + stats.noId;
    const detail = `${fmt(stats.imported)} conversations from ${info.from}` +
      (skipped ? ` · ${fmt(skipped)} empty ones skipped` : "");
    const remove = el("button", { className: "btn", type: "button", textContent: "Remove" });
    remove.setAttribute("aria-label", `Remove the ${SOURCE_LABELS[source]} export`);
    remove.addEventListener("click", () => {
      exportsBySource.delete(source);
      setStatus("");
      render();
    });
    const notes = info.notes.length ? el("span", { textContent: ` · ${info.notes.join(" ")}` }) : "";
    list.append(el("div", { className: "export" },
      el("div", { className: "what" }, el("b", { textContent: SOURCE_LABELS[source] }), el("span", { textContent: detail }), notes),
      remove));
  }
  const more = [...Object.keys(SOURCE_LABELS)].filter((s) => !exportsBySource.has(s)).map((s) => SOURCE_LABELS[s]);
  if (more.length) {
    list.append(el("p", { className: "hint", textContent: `Also use ${more.join(" or ")}? Add that export in step 2 and it will be included in the same file.` }));
  }
}

function renderSummary(s) {
  $("stats").replaceChildren(
    stat(fmt(s.conversations), "conversations"),
    stat(fmt(s.yourMessages), "messages you sent"),
    stat(fmt(s.aiReplies), "AI replies"),
    stat(period(s.first, s.last), "period covered"),
  );

  const features = Object.entries(s.featureSessions).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${FEATURE_LABELS[k] || k} (${fmt(n)})`);
  const included = [
    "When each conversation started and ended",
    "How many messages you and the AI sent",
    "How long the messages were, as character counts only",
    `Which features were used: ${features.length ? features.join(", ") : "none seen"}`,
    ...(s.hasModel ? ["Which ChatGPT model wrote each reply"] : []),
    "A random ID for each conversation, so a later upload doesn't count it twice",
  ];
  $("included").replaceChildren(...included.map((text) => el("li", { textContent: text })));

  const fieldText = Object.entries(s.fieldsByEvent)
    .map(([event, keys]) => `${event}: ${[...keys].join(", ")}`).join(" · ");
  $("fields").textContent = `Every field in the file, by record type. ${fieldText}`;
}

const PREVIEW_SESSIONS = 3;

function renderJson() {
  const pre = $("json");
  if (showingAll) {
    pre.textContent = evidence.json;
    $("show-all").hidden = true;
    return;
  }
  // The first few conversations' records, so the shape is easy to read.
  const ids = [];
  for (const e of evidence.payload.events) {
    if (!ids.includes(e.session_id)) ids.push(e.session_id);
    if (ids.length === PREVIEW_SESSIONS) break;
  }
  const sample = evidence.payload.events.filter((e) => ids.includes(e.session_id));
  const rest = evidence.payload.events.length - sample.length;
  pre.textContent = JSON.stringify({ ...evidence.payload, events: sample }, null, 2) +
    (rest > 0 ? `\n\n… and ${fmt(rest)} more records like these.` : "");
  $("show-all").hidden = rest <= 0;
}

function render() {
  const has = exportsBySource.size > 0;
  $("review").hidden = !has;
  $("save").hidden = !has;
  if (!has) {
    evidence = null;
    return;
  }
  const built = buildEvidence([...exportsBySource.values()].map((x) => x.result));
  evidence = { ...built, json: JSON.stringify(built.payload, null, 2) };
  showingAll = false;
  renderExports();
  renderSummary(summarize(built.payload.events));
  renderJson();
  runSearch();
  $("saved").hidden = true;
  $("filename").hidden = false;
  $("filename").textContent = `It goes to your browser's Downloads folder as ${built.filename} (${size(new Blob([evidence.json]).size)}).`;
}

function runSearch() {
  const out = $("search-result");
  const q = $("search").value.trim();
  out.className = "search-result";
  if (!evidence || q.length < 3) {
    out.textContent = q ? "Type at least 3 characters." : "";
    return;
  }
  const hay = evidence.json.toLowerCase();
  const needle = q.toLowerCase();
  let count = 0;
  let first = -1;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
    if (first < 0) first = i;
    count++;
  }
  if (!count) {
    out.classList.add("ok");
    out.textContent = `✓ "${q}" is not in the file.`;
    return;
  }
  const start = Math.max(0, evidence.json.lastIndexOf("\n", first) + 1);
  const end = evidence.json.indexOf("\n", first);
  const line = evidence.json.slice(start, end < 0 ? undefined : end).trim();
  out.classList.add("found");
  out.textContent = `Found ${fmt(count)} time${count === 1 ? "" : "s"}, as part of a field like ${line}. Fields hold only names, dates, IDs and numbers.`;
}

function save() {
  if (!evidence) return;
  const url = URL.createObjectURL(new Blob([evidence.json], { type: "application/json" }));
  const a = el("a", { href: url, download: evidence.filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  // A page can't learn the real folder path, only that the browser took the file.
  $("saved-name").textContent = evidence.filename;
  $("saved").hidden = false;
  $("filename").hidden = true;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function setupTabs() {
  const tabs = [$("tab-chatgpt"), $("tab-claude")];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });
}

function setup() {
  setupTabs();
  $("version").textContent = `Converter v${CONVERTER_VERSION} · ChatGPT rules v${PARSER_VERSIONS.chatgpt} · Claude rules v${PARSER_VERSIONS.claude_web}`;

  const fileInput = $("file-input");
  const folderInput = $("folder-input");
  $("pick-file").addEventListener("click", () => fileInput.click());
  $("pick-folder").addEventListener("click", () => folderInput.click());
  for (const input of [fileInput, folderInput]) {
    input.addEventListener("change", () => {
      const groups = groupsFromFileList(input.files);
      input.value = "";
      handleGroups(Promise.resolve(groups));
    });
  }

  const drop = $("drop");
  // Dropping anywhere on the page works; outside the drop zone, a stray
  // drop must not make the browser navigate away to the file.
  window.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) drop.classList.remove("over"); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    handleGroups(groupsFromDrop(e.dataTransfer));
  });

  $("search").addEventListener("input", runSearch);
  $("show-all").addEventListener("click", () => { showingAll = true; renderJson(); });
  $("download").addEventListener("click", save);
}

setup();
