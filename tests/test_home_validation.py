"""Validation tests for the Home reader.

``data.json`` is model-authored, so these tests are mostly about hostile or
sloppy input: a widget type that does not exist, a `javascript:` URL dressed up
as an action, a table with ten thousand rows, a file caught mid-write. The rule
under test throughout is that bad input is *reported* — never rendered, never
crashing the fleet.

Stdlib ``unittest`` on purpose: the Hermes venv ships no test runner, and a
plugin's own suite should not need one installed to be runnable.

    PYTHONPATH=~/.hermes/hermes-agent \\
      ~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException

_SPEC = importlib.util.spec_from_file_location(
    "bot_control_center_api", Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"
)
api = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(api)


def _iso(minutes_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _schema(*widgets):
    schema, _ = api.validate_schema({"version": 1, "widgets": list(widgets)})

    return schema


class SchemaTests(unittest.TestCase):
    def test_widget_vocabulary_is_closed(self):
        schema, warnings = api.validate_schema(
            {"version": 1, "widgets": [{"id": "ok", "type": "kpi"}, {"id": "nope", "type": "iframe"}]}
        )

        # The unsupported widget survives as a placeholder rather than
        # vanishing: a silently dropped widget looks like it was never declared.
        self.assertEqual([(w["id"], w["supported"]) for w in schema["widgets"]], [("ok", True), ("nope", False)])
        self.assertTrue(any("iframe" in message for message in warnings))

    def test_duplicate_and_nameless_widgets_are_dropped_with_a_reason(self):
        schema, warnings = api.validate_schema(
            {"version": 1, "widgets": [{"id": "a", "type": "kpi"}, {"id": "a", "type": "table"}, {"type": "kpi"}]}
        )

        self.assertEqual([w["id"] for w in schema["widgets"]], ["a"])
        self.assertEqual(schema["widgets"][0]["type"], "kpi")
        self.assertTrue(any("duplicated" in message for message in warnings))
        self.assertTrue(any("no id" in message for message in warnings))

    def test_widget_count_is_capped(self):
        schema, warnings = api.validate_schema(
            {"version": 1, "widgets": [{"id": f"w{i}", "type": "kpi"} for i in range(40)]}
        )

        self.assertEqual(len(schema["widgets"]), api.MAX_WIDGETS)
        self.assertTrue(any("only the first" in message for message in warnings))

    def test_only_the_four_action_types_survive(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "actions": [
                    {"id": "run", "label": "Run", "type": "run_routine", "job": "digest"},
                    {"id": "chat", "label": "Chat", "type": "open_chat"},
                    {"id": "exec", "label": "Run locally", "type": "exec"},
                ],
            }
        )

        self.assertEqual([a["id"] for a in schema["actions"]], ["run", "chat"])
        self.assertEqual(schema["toolbar"], schema["actions"])
        self.assertTrue(any("exec" in message for message in warnings))

    def test_toolbar_is_the_same_strip_as_actions(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "toolbar": [
                    {"id": "review", "label": "Review", "type": "send_prompt", "prompt": "Review the dashboard."}
                ],
            }
        )

        self.assertEqual([a["id"] for a in schema["toolbar"]], ["review"])
        self.assertEqual(schema["actions"], schema["toolbar"])
        self.assertEqual(schema["toolbar"][0]["prompt"], "Review the dashboard.")
        self.assertEqual(warnings, [])

    def test_actions_win_when_toolbar_also_disagrees(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "actions": [{"id": "old", "label": "Run", "type": "run_routine", "job": "digest"}],
                "toolbar": [{"id": "new", "label": "Review", "type": "send_prompt", "prompt": "Review."}],
            }
        )

        self.assertEqual([a["id"] for a in schema["actions"]], ["old"])
        self.assertEqual(schema["toolbar"], schema["actions"])
        self.assertEqual(warnings, [])

    def test_send_prompt_without_a_prompt_is_not_a_button(self):
        schema, warnings = api.validate_schema(
            {"version": 1, "widgets": [], "actions": [{"id": "r", "type": "send_prompt"}]}
        )

        self.assertEqual(schema["actions"], [])
        self.assertTrue(any("without a prompt" in message for message in warnings))

    def test_an_oversized_prompt_is_truncated(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "toolbar": [{"id": "r", "type": "send_prompt", "prompt": "x" * 5000}],
            }
        )

        self.assertEqual(len(schema["actions"][0]["prompt"]), api.CAPS["prompt_chars"])
        self.assertTrue(any("truncated" in message for message in warnings))

    def test_buttons_widget_keeps_nested_buttons(self):
        schema, _ = api.validate_schema(
            {
                "version": 1,
                "widgets": [
                    {
                        "id": "triage",
                        "type": "buttons",
                        "buttons": [
                            {"id": "review", "label": "Review", "type": "send_prompt", "prompt": "Review the page."}
                        ],
                    }
                ],
            }
        )

        self.assertEqual(schema["widgets"][0]["type"], "buttons")
        self.assertEqual([b["id"] for b in schema["widgets"][0]["buttons"]], ["review"])

    def test_list_line_buttons_keep_declared_ids_only(self):
        schema = _schema(
            {
                "id": "findings",
                "type": "list",
                "buttons": [
                    {"id": "genuine", "label": "Genuine", "type": "send_prompt", "prompt": "Mark genuine."},
                    {"id": "escalate", "label": "Escalate", "type": "send_prompt", "prompt": "Escalate."},
                ],
            }
        )
        data, warnings = api.validate_data(
            {
                "widgets": {
                    "findings": {
                        "items": [
                            {
                                "id": "api-2-disk",
                                "title": "disk full",
                                "buttons": ["genuine", "escalate", "nope"],
                            },
                            {"title": "no id", "buttons": ["genuine"]},
                        ]
                    }
                }
            },
            schema,
        )

        items = data["widgets"]["findings"]["items"]
        self.assertEqual(items[0]["buttons"], ["genuine", "escalate"])
        self.assertNotIn("buttons", items[1])
        self.assertTrue(any("unknown button" in message for message in warnings))
        self.assertTrue(any("need an id" in message for message in warnings))

    def test_non_http_action_urls_are_refused(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "actions": [
                    {"id": "x", "type": "open_url", "url": "javascript:void(0)"},
                    {"id": "f", "type": "open_url", "url": "file:///tmp/notes.md"},
                    {"id": "ok", "type": "open_url", "url": "https://example.com"},
                ],
            }
        )

        self.assertEqual([a["id"] for a in schema["actions"]], ["ok"])
        self.assertEqual(len([m for m in warnings if "http(s)" in m]), 2)

    def test_an_action_without_its_target_is_not_a_button(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "actions": [{"id": "r", "type": "run_routine"}, {"id": "p", "type": "open_path"}],
            }
        )

        self.assertEqual(schema["actions"], [])
        self.assertEqual(len(warnings), 2)

    def test_open_path_expands_the_home_shorthand(self):
        schema, _ = api.validate_schema(
            {"version": 1, "widgets": [], "actions": [{"id": "p", "type": "open_path", "path": "~/notes.md"}]}
        )

        self.assertEqual(schema["actions"][0]["path"], str(Path.home() / "notes.md"))

    def test_a_newer_schema_version_still_renders(self):
        schema, warnings = api.validate_schema({"version": 99, "widgets": [{"id": "a", "type": "kpi"}]})

        self.assertEqual(len(schema["widgets"]), 1)
        self.assertTrue(any("newer" in message for message in warnings))

    def test_a_non_object_schema_is_a_single_clear_error(self):
        schema, warnings = api.validate_schema(["not", "a", "schema"])

        self.assertEqual(schema, {})
        self.assertEqual(warnings, ["schema.json must be a JSON object"])


class DataTests(unittest.TestCase):
    def test_data_for_an_undeclared_widget_is_reported_not_rendered(self):
        schema = _schema({"id": "declared", "type": "kpi"})
        data, warnings = api.validate_data(
            {"widgets": {"declared": {"items": []}, "smuggled": {"items": []}}}, schema
        )

        self.assertEqual(set(data["widgets"]), {"declared"})
        self.assertTrue(any("smuggled" in message for message in warnings))

    def test_collections_are_capped_per_type(self):
        schema = _schema(
            {"id": "k", "type": "kpi"},
            {"id": "t", "type": "table"},
            {"id": "l", "type": "list"},
        )
        data, warnings = api.validate_data(
            {
                "widgets": {
                    "k": {"items": [{"label": f"{i}", "value": "1"} for i in range(50)]},
                    "t": {"columns": ["a", "b"], "rows": [["1", "2"] for _ in range(500)]},
                    "l": {"items": [{"title": f"{i}"} for i in range(500)]},
                }
            },
            schema,
        )

        self.assertEqual(len(data["widgets"]["k"]["items"]), api.CAPS["kpi_items"])
        self.assertEqual(len(data["widgets"]["t"]["rows"]), api.CAPS["table_rows"])
        self.assertEqual(len(data["widgets"]["l"]["items"]), api.CAPS["list_items"])
        self.assertEqual(len(warnings), 3)

    def test_table_rows_are_trimmed_to_the_declared_column_count(self):
        schema = _schema({"id": "t", "type": "table"})
        data, _ = api.validate_data(
            {"widgets": {"t": {"columns": ["a", "b"], "rows": [["1", "2", "3", "4"]]}}}, schema
        )

        self.assertEqual(data["widgets"]["t"]["rows"], [["1", "2"]])

    def test_markdown_is_truncated_rather_than_streamed_whole(self):
        schema = _schema({"id": "m", "type": "markdown"})
        data, warnings = api.validate_data({"widgets": {"m": {"text": "x" * 50_000}}}, schema)

        self.assertEqual(len(data["widgets"]["m"]["text"]), api.CAPS["markdown_chars"])
        self.assertTrue(any("truncated" in message for message in warnings))

    def test_timeseries_accepts_timestamps_and_drops_unplottable_points(self):
        schema = _schema({"id": "s", "type": "timeseries"})
        data, _ = api.validate_data(
            {
                "widgets": {
                    "s": {
                        "series": [
                            {
                                "label": "items",
                                "points": [
                                    ["2026-08-29T00:00:00Z", 5],
                                    [1, 6],
                                    ["not a date", 7],
                                    [2, "not a number"],
                                    [3],
                                ],
                            }
                        ]
                    }
                }
            },
            schema,
        )

        points = data["widgets"]["s"]["series"][0]["points"]

        self.assertEqual([point[1] for point in points], [5.0, 6.0])
        self.assertEqual(points[0][0], datetime(2026, 8, 29, tzinfo=timezone.utc).timestamp())

    def test_unknown_tones_and_levels_fall_back_instead_of_leaking_through(self):
        schema = _schema({"id": "k", "type": "kpi"}, {"id": "a", "type": "alerts"})
        data, _ = api.validate_data(
            {
                "widgets": {
                    "k": {"items": [{"label": "x", "value": "1", "tone": "on-fire"}]},
                    "a": {"items": [{"level": "catastrophe", "message": "x"}]},
                }
            },
            schema,
        )

        self.assertEqual(data["widgets"]["k"]["items"][0]["tone"], "neutral")
        self.assertEqual(data["widgets"]["a"]["items"][0]["level"], "info")

    def test_an_unsupported_widget_gets_no_payload_even_if_data_exists(self):
        schema = _schema({"id": "x", "type": "iframe"})
        data, _ = api.validate_data({"widgets": {"x": {"items": [{"title": "hi"}]}}}, schema)

        self.assertEqual(data["widgets"], {})

    def test_staleness_is_computed_from_updated_at(self):
        schema = _schema({"id": "k", "type": "kpi"})

        fresh, _ = api.validate_data({"updated_at": _iso(10), "stale_after_minutes": 60}, schema)
        stale, _ = api.validate_data({"updated_at": _iso(600), "stale_after_minutes": 60}, schema)
        defaulted, _ = api.validate_data({"updated_at": _iso(10), "stale_after_minutes": -5}, schema)

        self.assertIs(fresh["stale"], False)
        self.assertIs(stale["stale"], True)
        self.assertEqual(defaulted["stale_after_minutes"], api.DEFAULT_STALE_AFTER_MINUTES)

    def test_a_missing_updated_at_is_never_reported_as_stale(self):
        schema = _schema({"id": "k", "type": "kpi"})
        data, _ = api.validate_data({"widgets": {}}, schema)

        self.assertIsNone(data["updated_at"])
        self.assertIs(data["stale"], False)


class FileTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.tmp = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def test_a_missing_file_is_not_an_error(self):
        payload, error = api._read_json(self.tmp / "absent.json")

        self.assertIsNone(payload)
        self.assertIsNone(error)

    def test_a_torn_write_is_reported_as_such(self):
        path = self.tmp / "data.json"
        path.write_text('{"widgets": {"a": ')

        payload, error = api._read_json(path)

        self.assertIsNone(payload)
        self.assertIn("not valid JSON", error)

    def test_an_oversized_file_is_refused_before_parsing(self):
        path = self.tmp / "data.json"
        path.write_text(json.dumps({"pad": "x" * (api.MAX_FILE_BYTES + 100)}))

        payload, error = api._read_json(path)

        self.assertIsNone(payload)
        self.assertIn("limit", error)

    def test_reading_a_home_for_an_unknown_bot_is_a_404(self):
        with self.assertRaises(HTTPException) as caught:
            api.read_home("definitely-not-a-profile")

        self.assertEqual(caught.exception.status_code, 404)


class RunActionSchemaTests(unittest.TestCase):
    def test_run_action_keeps_script_and_notify(self):
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "toolbar": [
                    {"id": "email", "label": "Send", "type": "run_action", "script": "send-digest", "notify": True},
                    {"id": "quiet", "label": "Ignore", "type": "run_action", "script": "ignore"},
                ],
            }
        )

        self.assertEqual(warnings, [])
        self.assertEqual(
            [(a["script"], a["notify"]) for a in schema["toolbar"]], [("send-digest", True), ("ignore", False)]
        )

    def test_a_script_must_be_a_bare_file_name(self):
        bad = ["", "../../bin/sh", "mail.py", "send digest", "Ignore", "-rf", "a/b", "x" * 65]
        schema, warnings = api.validate_schema(
            {
                "version": 1,
                "widgets": [],
                "toolbar": [
                    {"id": f"b{i}", "type": "run_action", **({"script": name} if name else {})}
                    for i, name in enumerate(bad)
                ],
            }
        )

        self.assertEqual(schema["toolbar"], [])
        self.assertEqual(len(warnings), len(bad))

    def test_acked_seq_passes_through_and_bad_values_fall_back(self):
        schema = _schema({"id": "k", "type": "kpi"})

        good, warnings = api.validate_data({"acked_seq": 7}, schema)
        self.assertEqual(good["acked_seq"], 7)
        self.assertEqual(warnings, [])

        for value in (-1, "7", True, 1.5):
            data, warnings = api.validate_data({"acked_seq": value}, schema)
            self.assertEqual(data["acked_seq"], 0)
            self.assertTrue(any("acked_seq" in message for message in warnings))

        missing, warnings = api.validate_data({}, schema)
        self.assertEqual(missing["acked_seq"], 0)
        self.assertEqual(warnings, [])


def _issues_schema():
    return _schema(
        {
            "id": "issues",
            "type": "list",
            "buttons": [{"id": "ignore", "label": "Ignore", "type": "run_action", "script": "ignore"}],
        },
        {"id": "alerts", "type": "alerts"},
    )


def _issues_data(schema, acked_seq=0):
    data, _ = api.validate_data(
        {
            "acked_seq": acked_seq,
            "widgets": {
                "issues": {
                    "items": [
                        {"id": "api-2-disk", "title": "disk full", "tone": "bad", "buttons": ["ignore"]},
                        {"id": "payments", "title": "timeout", "buttons": ["ignore"]},
                    ]
                },
                "alerts": {"items": [{"id": "a1", "level": "warn", "message": "slow"}]},
            },
        },
        schema,
    )

    return data


def _event(seq, widget, item, **result):
    return {"seq": seq, "widget": widget, "item": item, "button": "ignore", "result": {"ok": True, **result}}


class OverlayTests(unittest.TestCase):
    def test_hide_removes_the_row_until_the_bot_acks(self):
        schema = _issues_schema()
        events = [_event(1, "issues", "api-2-disk", hide=True)]

        data = _issues_data(schema)
        pending = api.apply_action_overlay(data, schema, events)
        self.assertEqual([i["id"] for i in data["widgets"]["issues"]["items"]], ["payments"])
        self.assertEqual(len(pending), 1)

        # Acked but the bot kept the row: the bot's data wins.
        acked = _issues_data(schema, acked_seq=1)
        pending = api.apply_action_overlay(acked, schema, events)
        self.assertEqual([i["id"] for i in acked["widgets"]["issues"]["items"]], ["api-2-disk", "payments"])
        self.assertEqual(pending, [])

    def test_patch_keeps_only_display_fields_for_that_row_type(self):
        schema = _issues_schema()
        data = _issues_data(schema)
        events = [
            _event(1, "issues", "api-2-disk", patch={"detail": "sent to on-call", "tone": "good", "url": "javascript:x", "buttons": []}),
            _event(2, "alerts", "a1", patch={"level": "error", "tone": "good", "message": "m" * 999}),
            _event(3, "issues", "payments", patch={"tone": "on-fire"}),
        ]

        api.apply_action_overlay(data, schema, events)
        first, second = data["widgets"]["issues"]["items"]
        alert = data["widgets"]["alerts"]["items"][0]

        self.assertEqual((first["detail"], first["tone"], first["url"], first["buttons"]), ("sent to on-call", "good", "", ["ignore"]))
        self.assertEqual(second["tone"], "neutral")
        self.assertEqual(alert["level"], "error")
        self.assertNotIn("tone", alert)
        self.assertEqual(len(alert["message"]), api.PATCH_CLIPS["message"])

    def test_failed_and_unknown_events_change_nothing(self):
        schema = _issues_schema()
        data = _issues_data(schema)
        events = [
            {"seq": 1, "widget": "issues", "item": "api-2-disk", "result": {"ok": False, "hide": True}},
            _event(2, "nope", "api-2-disk", hide=True),
            _event(3, "issues", None, hide=True),
        ]

        api.apply_action_overlay(data, schema, events)

        self.assertEqual(len(data["widgets"]["issues"]["items"]), 2)


def _write_script(home: Path, name: str, body: str, mode: int = 0o755) -> Path:
    path = home / "actions" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(mode)

    return path


IGNORE_SCRIPT = """#!/bin/sh
cat > "$PWD/stdin.json"
touch "$PWD/ran"
echo '{"ok": true, "hide": true, "message": "Ignored"}'
"""


class RunActionTests(unittest.TestCase):
    """The runner end to end, against a real temp Home and real subprocesses."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        root = Path(self._dir.name)
        self.home = root / "profiles" / "monitor" / "home"
        self.home.mkdir(parents=True)
        self.approvals = root / "approvals"

        (self.home / "schema.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "toolbar": [{"id": "digest", "label": "Digest", "type": "run_action", "script": "digest"}],
                    "widgets": [
                        {
                            "id": "issues",
                            "type": "list",
                            "buttons": [
                                {"id": "ignore", "label": "Ignore", "type": "run_action", "script": "ignore"},
                                {"id": "review", "label": "Review", "type": "send_prompt", "prompt": "x"},
                            ],
                        }
                    ],
                }
            )
        )
        self._write_data()

        originals = (api._bot_home_dir, api._approvals_root, api.SCRIPT_TIMEOUT_S)
        api._bot_home_dir = lambda bot: self.home
        api._approvals_root = lambda: self.approvals

        def restore():
            api._bot_home_dir, api._approvals_root, api.SCRIPT_TIMEOUT_S = originals

        self.addCleanup(restore)

    def _write_data(self, acked_seq=0, ids=("api-2-disk", "payments")):
        items = [{"id": i, "title": f"title {i}", "buttons": ["ignore", "review"]} for i in ids]
        (self.home / "data.json").write_text(json.dumps({"acked_seq": acked_seq, "widgets": {"issues": {"items": items}}}))

    def _approve(self, name):
        digest, _ = api._script_digest(self.home / "actions" / name)
        api.save_approval("monitor", name, digest)

    def _click(self, button="ignore", widget="issues", item="api-2-disk"):
        return api.run_action_for_home("monitor", self.home, api.read_home("monitor"), button, widget, item)

    def _log(self):
        return api.read_action_events(self.home)

    def test_an_unapproved_script_is_shown_not_run(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT)

        with self.assertRaises(HTTPException) as caught:
            self._click()

        detail = caught.exception.detail
        self.assertEqual(caught.exception.status_code, 409)
        self.assertTrue(detail["needs_approval"])
        self.assertIn("touch", detail["source"])
        self.assertFalse((self.home / "ran").exists())
        self.assertEqual(self._log(), [])

    def test_an_approved_script_runs_logs_and_hides_the_row(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT)
        self._approve("ignore")

        result = self._click()

        self.assertEqual((result["ok"], result["hide"], result["message"], result["seq"]), (True, True, "Ignored", 1))
        stdin = json.loads((self.home / "stdin.json").read_text())
        self.assertEqual(stdin["widget"], "issues")
        self.assertEqual(stdin["item"]["id"], "api-2-disk")
        self.assertNotIn("buttons", stdin["item"])

        log = self._log()
        self.assertEqual([(e["seq"], e["item"], e["button"], e["script"]) for e in log], [(1, "api-2-disk", "ignore", "ignore")])

        home = api.read_home("monitor")
        self.assertEqual([i["id"] for i in home["data"]["widgets"]["issues"]["items"]], ["payments"])
        self.assertEqual(len(home["pending_actions"]), 1)

        # A hidden row cannot be clicked again.
        with self.assertRaises(HTTPException) as caught:
            self._click()

        self.assertEqual(caught.exception.status_code, 404)

    def test_seq_keeps_climbing_past_the_ack(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT)
        self._approve("ignore")
        self._click()

        self._write_data(acked_seq=5)
        result = self._click(item="payments")

        self.assertEqual(result["seq"], 6)
        home = api.read_home("monitor")
        self.assertEqual([i["id"] for i in home["data"]["widgets"]["issues"]["items"]], ["api-2-disk"])

    def test_editing_an_approved_script_asks_again(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT)
        self._approve("ignore")
        _write_script(self.home, "ignore", IGNORE_SCRIPT + "rm -rf /tmp/nothing\n")

        with self.assertRaises(HTTPException) as caught:
            self._click()

        self.assertEqual(caught.exception.status_code, 409)
        self.assertFalse((self.home / "ran").exists())

    def test_approve_route_refuses_a_stale_hash(self):
        import asyncio

        _write_script(self.home, "ignore", IGNORE_SCRIPT)

        with self.assertRaises(HTTPException) as caught:
            asyncio.run(api.approve_action("monitor", api.ApproveActionBody(script="ignore", sha256="0" * 64)))

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(api.load_approvals("monitor"), {})

        digest, _ = api._script_digest(self.home / "actions" / "ignore")
        asyncio.run(api.approve_action("monitor", api.ApproveActionBody(script="ignore", sha256=digest)))
        self.assertEqual(api.load_approvals("monitor"), {"ignore": digest})

    def test_a_symlink_out_of_actions_is_refused(self):
        outside = Path(self._dir.name) / "evil"
        outside.write_text(IGNORE_SCRIPT)
        outside.chmod(0o755)
        (self.home / "actions").mkdir()
        (self.home / "actions" / "ignore").symlink_to(outside)

        with self.assertRaises(HTTPException) as caught:
            self._click()

        self.assertEqual(caught.exception.status_code, 403)

    def test_a_script_that_is_not_executable_is_refused(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT, mode=0o644)

        with self.assertRaises(HTTPException) as caught:
            self._click()

        self.assertEqual(caught.exception.status_code, 400)

    def test_only_run_action_buttons_the_row_offers_can_run(self):
        _write_script(self.home, "ignore", IGNORE_SCRIPT)
        self._approve("ignore")

        for button, widget, item, status in (
            ("review", "issues", "api-2-disk", 400),
            ("nope", "issues", "api-2-disk", 404),
            ("ignore", "issues", "ghost", 404),
            ("ignore", "missing", "api-2-disk", 404),
        ):
            with self.assertRaises(HTTPException) as caught:
                self._click(button, widget, item)

            self.assertEqual(caught.exception.status_code, status, (button, widget, item))

    def test_a_toolbar_click_gets_no_row(self):
        _write_script(self.home, "digest", '#!/bin/sh\ncat > "$PWD/stdin.json"\necho \'{"ok": true}\'\n')
        self._approve("digest")

        result = self._click("digest", None, None)

        self.assertTrue(result["ok"])
        stdin = json.loads((self.home / "stdin.json").read_text())
        self.assertEqual((stdin["widget"], stdin["item"]), (None, None))

    def test_bad_runs_are_failures_and_still_logged(self):
        cases = {
            "exit": ("#!/bin/sh\necho oops >&2\nexit 3\n", "exited 3: oops"),
            "garbage": ("#!/bin/sh\necho not json\n", "did not print one JSON object"),
            "not-ok": ('#!/bin/sh\necho \'{"ok": "yes", "hide": true}\'\n', ""),
            "slow": ("#!/bin/sh\nsleep 5\n", "longer than"),
        }
        api.SCRIPT_TIMEOUT_S = 1

        for name, (body, expected) in cases.items():
            schema = json.loads((self.home / "schema.json").read_text())
            schema["toolbar"] = [{"id": name, "type": "run_action", "script": name}]
            (self.home / "schema.json").write_text(json.dumps(schema))
            _write_script(self.home, name, body)
            self._approve(name)

            result = self._click(name, None, None)

            self.assertFalse(result["ok"], name)
            self.assertFalse(result["hide"], name)
            self.assertIn(expected, result["message"], name)

        self.assertEqual([e["result"]["ok"] for e in self._log()], [False] * len(cases))

    def test_the_routes_round_trip_over_http(self):
        # Through FastAPI, with this module loaded from a file path the way the
        # plugin loader does it — body models must validate in that setup, and
        # the 409 body must be the `{"detail": {...}}` shape the page parses.
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        _write_script(self.home, "ignore", IGNORE_SCRIPT)
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/hermes-bot-hq")
        client = TestClient(app)
        base = "/api/plugins/hermes-bot-hq/home/monitor"
        click = {"button_id": "ignore", "widget_id": "issues", "item_id": "api-2-disk"}

        refused = client.post(f"{base}/run-action", json=click)
        self.assertEqual(refused.status_code, 409)
        detail = refused.json()["detail"]
        self.assertTrue(detail["needs_approval"])

        approved = client.post(f"{base}/approve-action", json={"script": detail["script"], "sha256": detail["sha256"]})
        self.assertEqual(approved.status_code, 200)

        ran = client.post(f"{base}/run-action", json=click)
        self.assertEqual(ran.status_code, 200)
        self.assertEqual(ran.json()["message"], "Ignored")

        toolbar = client.post(f"{base}/run-action", json={"button_id": "ignore"})
        self.assertEqual(toolbar.status_code, 404)

        home = client.get(base).json()
        self.assertEqual([i["id"] for i in home["data"]["widgets"]["issues"]["items"]], ["payments"])

    def test_the_log_is_compacted_without_losing_unacked_events(self):
        lines = [json.dumps({"seq": seq, "result": {"ok": True}}) for seq in range(1, api.MAX_LOG_LINES + 1)]
        (self.home / "actions.jsonl").write_text("\n".join(lines) + "\n")

        record = api.append_action_event(self.home, {"widget": None, "item": None}, acked_seq=1500)
        log = self._log()

        self.assertEqual(record["seq"], api.MAX_LOG_LINES + 1)
        self.assertEqual(log[0]["seq"], 1501)
        self.assertEqual(log[-1]["seq"], api.MAX_LOG_LINES + 1)
        self.assertLessEqual(len(log), api.MAX_LOG_LINES)


class RoutineResolutionTests(unittest.TestCase):
    def test_a_routine_resolves_by_id_or_name_with_or_without_the_bot_prefix(self):
        jobs = [{"job_id": "abc123", "name": "[bot:researcher] Morning Digest"}]

        for reference in ("abc123", "Morning Digest", "morning digest", "[bot:researcher] Morning Digest"):
            self.assertEqual(api._resolve_job_id(reference, jobs, "researcher"), "abc123")

        self.assertIsNone(api._resolve_job_id("Evening Digest", jobs, "researcher"))


if __name__ == "__main__":
    unittest.main()
