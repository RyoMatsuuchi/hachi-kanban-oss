#!/usr/bin/env python3
"""hachi-handover-now の CLI 委譲と候補選択のテスト。"""

from __future__ import annotations

import importlib.util
import io
import json
import os
from importlib.machinery import SourceFileLoader
from pathlib import Path
import shlex
import subprocess
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("hachi-handover-now")
LOADER = SourceFileLoader("hachi_handover_now", str(SCRIPT))
SPEC = importlib.util.spec_from_loader("hachi_handover_now", LOADER)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"スクリプトを読み込めません: {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TtyBuffer(io.StringIO):
    """テスト用の TTY ストリーム。"""

    def isatty(self) -> bool:
        return True


def ready_select(readables, _writable, _exceptional, _timeout):
    """入力がすぐ読める select のスタブ。"""
    return list(readables), [], []


def candidate(command: str, index: int) -> dict[str, object]:
    return {
        "orchestratorId": f"o_{index}",
        "label": f"label-{index}",
        "project": "hachi-kanban",
        "sessionId": f"session-{index}",
        "generation": index,
        "missionTaskId": f"mission-{index}",
        "missionTitle": f"mission title {index}",
        "command": command,
    }


def response(
    status: str,
    candidates: list[dict[str, object]],
    *,
    returncode: int,
    applied: bool = False,
) -> subprocess.CompletedProcess[str]:
    payload: dict[str, object] = {
        "resolution": {
            "status": status,
            "reason": f"reason-{status}",
            "candidates": candidates,
        },
    }
    if status == "resolved":
        payload.update(
            {
                "blocked": False,
                "blockReasons": [],
                "successorSessionId": "successor-session",
            }
        )
        if applied:
            payload["tmuxSessionName"] = "hachi-next"
    return subprocess.CompletedProcess(
        ["hachi"],
        returncode,
        json.dumps(payload, ensure_ascii=False),
        "",
    )


def provider_blocked_response(provider: str) -> subprocess.CompletedProcess[str]:
    """Claude tmux で起動できない provider の resolved preflight 応答。"""
    base = response(
        "resolved",
        [candidate("hachi orchestrator handover --session session-1 --generation 1 --apply", 1)],
        returncode=1,
    )
    payload = json.loads(base.stdout)
    reason = (
        f"provider-launchable: この経路は claude 後継だけを起動します（session provider={provider}）。"
        "Codex は reference §0.7.5 の手動手順を使ってください"
    )
    payload.update(
        {
            "blocked": True,
            "blockReasons": [reason],
            "preflight": [{"name": "provider-launchable", "ok": False, "reason": reason}],
        }
    )
    return subprocess.CompletedProcess(["hachi"], 1, json.dumps(payload, ensure_ascii=False), "")


class StubRunner:
    """handover 解決と選択後の CLI 呼び出しを記録するスタブ。"""

    def __init__(self, first: subprocess.CompletedProcess[str], second: subprocess.CompletedProcess[str] | None = None) -> None:
        self.first = first
        self.second = second
        self.calls: list[list[str]] = []

    def __call__(self, args) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(args))
        if len(self.calls) == 1:
            return self.first
        if self.second is None:
            raise AssertionError("CLI が想定より多く呼ばれました")
        return self.second


def run_main(runner, *, argv=None, input_stream=None, output=None, error=None, select_fn=ready_select) -> int:
    test_argv = [] if argv is None else argv
    return MODULE.main(
        test_argv,
        runner=runner,
        input_stream=input_stream or io.StringIO(),
        output=output or io.StringIO(),
        error=error or io.StringIO(),
        select_fn=select_fn,
    )


class HachiHandoverNowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "", "TMUX": ""}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_ambiguous_non_tty_outputs_commands_verbatim_and_fails(self) -> None:
        command_a = "hachi orchestrator handover --session 'session with space' --generation 1 --mission 'mission a' --apply"
        command_b = "hachi orchestrator handover --session session-2 --generation 2 --mission mission-2 --apply"
        runner = StubRunner(
            response("ambiguous", [candidate(command_a, 1), candidate(command_b, 2)], returncode=2)
        )
        output = io.StringIO()

        result = run_main(runner, output=output)

        self.assertEqual(result, 2)
        self.assertEqual(output.getvalue(), f"{command_a}\n{command_b}\n")
        self.assertEqual(len(runner.calls), 1)

    def test_ambiguous_tty_valid_selection_executes_only_selected_candidate(self) -> None:
        command_a = "hachi orchestrator handover --session session-1 --generation 1 --mission mission-1 --apply"
        command_b = "hachi orchestrator handover --session session-2 --generation 2 --mission mission-2 --apply"
        runner = StubRunner(
            response("ambiguous", [candidate(command_a, 1), candidate(command_b, 2)], returncode=2),
            response("resolved", [candidate(command_b, 2)], returncode=0, applied=True),
        )
        output = TtyBuffer()
        input_stream = TtyBuffer("2\n")

        result = run_main(runner, input_stream=input_stream, output=output)

        self.assertEqual(result, 0)
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(runner.calls[1], shlex.split(command_b)[1:] + ["--json"])
        self.assertIn("tmux attach -t hachi-next", output.getvalue())

    def test_ambiguous_tty_eof_or_invalid_input_fails_closed_without_execution(self) -> None:
        command_a = "hachi orchestrator handover --session session-1 --generation 1 --mission mission-1 --apply"
        command_b = "hachi orchestrator handover --session session-2 --generation 2 --mission mission-2 --apply"
        for input_text in ("", "99\n"):
            with self.subTest(input_text=repr(input_text)):
                runner = StubRunner(
                    response("ambiguous", [candidate(command_a, 1), candidate(command_b, 2)], returncode=2)
                )
                output = TtyBuffer()
                input_stream = TtyBuffer(input_text)

                result = run_main(runner, input_stream=input_stream, output=output)

                self.assertEqual(result, 2)
                self.assertEqual(len(runner.calls), 1)
                self.assertIn(command_a, output.getvalue())
                self.assertIn(command_b, output.getvalue())

    def test_none_outputs_takeover_command_and_never_enters_input(self) -> None:
        takeover = "hachi orchestrator session takeover o_1 --stale-sec 90"
        runner = StubRunner(response("none", [candidate(takeover, 1)], returncode=2))
        output = TtyBuffer()
        input_stream = TtyBuffer("1\n")

        def unexpected_select(*_args):
            raise AssertionError("none は対話してはいけません")

        result = run_main(
            runner,
            input_stream=input_stream,
            output=output,
            select_fn=unexpected_select,
        )

        self.assertEqual(result, 2)
        self.assertEqual(output.getvalue(), f"{takeover}\n")
        self.assertEqual(len(runner.calls), 1)

    def test_resolved_apply_is_default_and_prints_attach_command(self) -> None:
        command = "hachi orchestrator handover --session session-1 --generation 1 --mission mission-1 --apply"
        runner = StubRunner(response("resolved", [candidate(command, 1)], returncode=0, applied=True))
        output = io.StringIO()

        result = run_main(runner, output=output)

        self.assertEqual(result, 0)
        self.assertEqual(runner.calls, [["orchestrator", "handover", "--apply", "--json"]])
        self.assertIn("tmux attach -t hachi-next", output.getvalue())

    def test_no_input_skips_tty_selection(self) -> None:
        command_a = "hachi orchestrator handover --session session-1 --generation 1 --mission mission-1 --apply"
        command_b = "hachi orchestrator handover --session session-2 --generation 2 --mission mission-2 --apply"
        runner = StubRunner(
            response("ambiguous", [candidate(command_a, 1), candidate(command_b, 2)], returncode=2)
        )
        output = TtyBuffer()
        input_stream = TtyBuffer("1\n")

        result = run_main(
            runner,
            argv=["--no-input"],
            input_stream=input_stream,
            output=output,
        )

        self.assertEqual(result, 2)
        self.assertEqual(len(runner.calls), 1)
        self.assertEqual(output.getvalue(), f"{command_a}\n{command_b}\n")

    def test_n_selects_dry_run_without_apply(self) -> None:
        command = "hachi orchestrator handover --session session-1 --generation 1 --mission mission-1"
        runner = StubRunner(response("resolved", [candidate(command, 1)], returncode=0))
        output = io.StringIO()

        result = run_main(runner, argv=["-n"], output=output)

        self.assertEqual(result, 0)
        self.assertEqual(runner.calls, [["orchestrator", "handover", "--json"]])
        self.assertIn("dry-run", output.getvalue())

    def test_provider_launchable_failure_guides_codex_without_candidate_or_attach(self) -> None:
        runner = StubRunner(provider_blocked_response("codex"))
        output = io.StringIO()
        error = io.StringIO()

        result = run_main(runner, output=output, error=error)

        self.assertEqual(result, 2)
        self.assertEqual(runner.calls, [["orchestrator", "handover", "--apply", "--json"]])
        self.assertEqual(output.getvalue(), "")
        self.assertIn("provider の起動経路が一致しない", error.getvalue())
        self.assertIn("handoff-prepare → create_thread → handoff-accept", error.getvalue())
        self.assertNotIn("tmux attach", error.getvalue())


if __name__ == "__main__":
    unittest.main()
