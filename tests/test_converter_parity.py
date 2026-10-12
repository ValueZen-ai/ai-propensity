"""The browser converter (converter/src/*.js) must produce exactly what the
claude-web and chatgpt adapters produce for the same export. These tests run
both on the same synthetic exports — as a zip (deflated, stored and ZIP64),
an unzipped folder and a loose JSON file — and compare every event.

The fixtures deliberately include the places where JavaScript and Python
disagree unless the port is careful: emoji (len() counts code points),
present-but-null fields (dict.get), empty lists/dicts (truthiness), blank
messages (str.strip()), fractional unix timestamps, split
conversations-NNN.json files, and conversations with no messages or no id.

Needs Node 20+ on PATH; skipped otherwise.

Run from the repo root:  python3 -m pytest tests
"""

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core import export as core_export, local_storage  # noqa: E402
from test_adapters import _gpt_node, chatgpt, claude_web  # noqa: E402

CLI = ROOT / "converter" / "test" / "cli.mjs"


def _node():
    node = shutil.which("node")
    if not node:
        return None
    major = int(subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip().lstrip("v").split(".")[0])
    return node if major >= 20 else None


NODE = _node()
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node 20+ on PATH")

IGNORED = ("observed_at", "provenance")


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(local_storage, "STORE_DIR", tmp_path / "events")
    monkeypatch.setattr(local_storage, "STATE_DIR", tmp_path / ".state")
    monkeypatch.setattr(local_storage, "BACKFILL_MANIFEST", tmp_path / ".state" / "_backfill_manifest.json")
    monkeypatch.setattr(core_export, "STORE_DIR", tmp_path / "events")
    return tmp_path


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def chatgpt_conversations():
    rich = {"conversation_id": "g1", "create_time": 1727000000.25, "update_time": 1727000900.9999999,
            "conversation_template_id": "g-p-abc", "plugin_ids": ["p1"], "mapping": {
                "root": {"message": None},
                "n1": _gpt_node("user", "Plan a trip 🚀🚀 with émojis", t=1727000001.5),
                "n2": _gpt_node("assistant", "Sure — here's a plan", t=1727000005.0,
                                metadata={"model_slug": "gpt-5-thinking", "search_result_groups": [{}]}),
                "n3": _gpt_node("user", "   \n\t ", t=1727000010.0),  # blank: skipped
                "n4": _gpt_node("tool", "", author_name="canmore.create_textdoc", t=1727000011.0),
                "n5": _gpt_node("user", "", t=1727000012.0, content={"content_type": "multimodal_text", "parts": [
                    {"content_type": "image_asset_pointer"}, "what is this?"]}),
                "n6": _gpt_node("assistant", "A cat.", t=1727000015.0, metadata={"model_slug": None}),
                "n7": _gpt_node("assistant", "Report", t=1727000020.0, metadata={
                    "async_task_title": "Deep dive", "attachments": [{"mime_type": "application/pdf"}, None]}),
            }}
    no_times = {"conversation_id": "g2", "create_time": None, "update_time": None, "gizmo_id": "g-68e5f1dea7", "mapping": {
        "a": _gpt_node("user", "hi", t=1727100000.0),
        "b": _gpt_node("assistant", "hello", t=1727100060.0,
                       metadata={"content_references": [{"type": "webpage"}], "model_slug": "gpt-4o"}),
    }}
    next_day = {"id": "g3", "create_time": 1727200000, "update_time": 1727203600, "plugin_ids": [], "mapping": {
        "a": _gpt_node("user", "x" * 50, t=1727200001),
        "b": _gpt_node("assistant", "y" * 70, t=1727200002, content={"content_type": "thoughts", "parts": ["z"]}),
    }}
    empty = {"conversation_id": "g4", "create_time": 1727300000, "update_time": 1727300001, "mapping": {
        "a": _gpt_node("user", "  "),
    }}
    no_id = {"create_time": 1727300000, "mapping": {"a": _gpt_node("user", "orphan")}}
    return [rich, no_times, next_day, empty, no_id]


def claude_conversations():
    rich = {"uuid": "c1", "created_at": "2026-10-01T09:00:00.123456Z", "updated_at": "2026-10-01T09:30:05Z", "chat_messages": [
        {"sender": "human", "text": "Summarise this 👨‍👩‍👧 doc", "created_at": "2026-10-01T09:00:01Z",
         "attachments": [{"file_name": "notes.txt"}], "files": [{"file_name": "photo.HEIC"}, None]},
        {"sender": "assistant", "text": "Here you go", "created_at": "2026-10-01T09:00:09Z", "content": [
            {"type": "thinking", "thinking": ""}, "not-a-dict",
            {"type": "tool_use", "name": "web_fetch"},
            {"type": "tool_use", "name": "Artifacts"},
            {"type": "tool_use", "name": "project_knowledge_search"},
            {"type": "tool_use", "name": "launch_extended_search_task_research"},
            {"type": "tool_use", "name": "gmail_search"},
            {"type": "tool_use", "name": None},
        ]},
        {"sender": "human", "text": [{"text": "nested"}, {"text": None}, "skip"], "created_at": "2026-10-01T09:10:00Z"},
        {"sender": "assistant", "text": None, "created_at": ""},
    ]}
    falls_back_to_messages = {"id": "c2", "created_at": None, "chat_messages": [
        {"role": "user", "text": "q", "timestamp": "2026-10-03T12:00:00Z", "attachments": []},
        {"role": "assistant", "text": "a", "timestamp": "2026-10-03T12:00:30Z"},
    ]}
    bad_dates = {"uuid": "c3", "created_at": "2026-02-30T10:00:00Z", "updated_at": "2026-03-01T10:00:00Z",
                 "chat_messages": [{"sender": "human", "text": "x", "created_at": "2026-03-01T10:00:00Z"}]}
    empty = {"uuid": "c4", "chat_messages": []}
    return [rich, falls_back_to_messages, bad_dates, empty]


# ---------------------------------------------------------------------------
# Running each side
# ---------------------------------------------------------------------------

def run_python(monkeypatch, adapter, path, source):
    monkeypatch.setattr(sys, "argv", ["collect.py", "import", str(path)])
    adapter.cmd_import()
    out_path, _ = core_export.export_evidence(source)
    return json.loads(Path(out_path).read_text())


def run_js(path):
    proc = subprocess.run([NODE, str(CLI), str(path)], capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def comparable(payload):
    return {
        "source": payload["source"],
        "tiers_included": payload["tiers_included"],
        "events": [{k: v for k, v in e.items() if k not in IGNORED} for e in payload["events"]],
    }


def write_zip(path, members, *, compression=zipfile.ZIP_DEFLATED, force_zip64=False):
    with zipfile.ZipFile(path, "w", compression=compression) as zf:
        zf.writestr("images/ignored.png", b"\x89PNG not really")
        for name, payload in members.items():
            with zf.open(name, "w", force_zip64=force_zip64) as f:
                f.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return path


def split_chatgpt(convs):
    # Split exports are chunked lists; filename order decides merge order.
    return {"export/conversations-001.json": convs[2:], "export/conversations-000.json": convs[:2]}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("variant", ["deflated", "stored", "zip64", "split_zip", "folder", "split_folder", "json"])
def test_chatgpt_parity(store, tmp_path, monkeypatch, variant):
    convs = chatgpt_conversations()
    if variant == "deflated":
        path = write_zip(tmp_path / "x.zip", {"conversations.json": convs})
    elif variant == "stored":
        path = write_zip(tmp_path / "x.zip", {"conversations.json": convs}, compression=zipfile.ZIP_STORED)
    elif variant == "zip64":
        path = write_zip(tmp_path / "x.zip", {"conversations.json": convs}, force_zip64=True)
    elif variant == "split_zip":
        path = write_zip(tmp_path / "x.zip", split_chatgpt(convs))
    elif variant == "folder":
        path = tmp_path / "folder"
        path.mkdir()
        (path / "conversations.json").write_text(json.dumps(convs))
        (path / "chat.html").write_text("<html></html>")
    elif variant == "split_folder":
        path = tmp_path / "folder"
        path.mkdir()
        for name, chunk in split_chatgpt(convs).items():
            (path / Path(name).name).write_text(json.dumps(chunk))
    else:
        path = tmp_path / "anything.json"
        path.write_text(json.dumps(convs))

    py = run_python(monkeypatch, chatgpt, path, "chatgpt")
    js = run_js(path)
    assert comparable(js) == comparable(py)
    assert len(py["events"]) > 10


@pytest.mark.parametrize("variant", ["deflated", "zip64", "folder", "json"])
def test_claude_web_parity(store, tmp_path, monkeypatch, variant):
    convs = claude_conversations()
    members = {"data-2026/users.json": [{"uuid": "u"}], "data-2026/conversations.json": convs}
    if variant == "deflated":
        path = write_zip(tmp_path / "x.zip", members)
    elif variant == "zip64":
        path = write_zip(tmp_path / "x.zip", members, force_zip64=True)
    elif variant == "folder":
        path = tmp_path / "folder"
        path.mkdir()
        (path / "conversations.json").write_text(json.dumps(convs))
        (path / "projects.json").write_text("[]")
    else:
        path = tmp_path / "claude.json"
        path.write_text(json.dumps(convs))

    py = run_python(monkeypatch, claude_web, path, "claude_web")
    js = run_js(path)
    assert comparable(js) == comparable(py)
    assert len(py["events"]) > 5


def test_combined_export_matches_python_only_flag(store, tmp_path, monkeypatch):
    gpt = write_zip(tmp_path / "gpt.zip", {"conversations.json": chatgpt_conversations()})
    cl = write_zip(tmp_path / "claude.zip", {"conversations.json": claude_conversations()})
    for adapter, path in ((chatgpt, gpt), (claude_web, cl)):
        monkeypatch.setattr(sys, "argv", ["collect.py", "import", str(path)])
        adapter.cmd_import()
    out_path, _ = core_export.export_evidence("chatgpt", only_sources={"chatgpt", "claude_web"})
    py = json.loads(Path(out_path).read_text())

    proc = subprocess.run([NODE, str(CLI), str(gpt), str(cl)], capture_output=True, text=True, check=True)
    js = json.loads(proc.stdout)
    assert js["source"] == "chatgpt+claude_web"
    assert comparable(js) == comparable(py)


def test_converter_html_is_a_fresh_build():
    proc = subprocess.run([NODE, str(ROOT / "converter" / "build.mjs"), "--check"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
