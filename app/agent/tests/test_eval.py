"""AgentCore Evaluation fixtures: the key behaviours pass locally (no LLM/network).

Each fixture gets a completely isolated fake server, client, and in-memory store
so mutations in one fixture (spend_ceiling override, ap4m mode, etc.) cannot bleed
into subsequent fixtures.
"""

from __future__ import annotations

from swanavi.eval import run_all


def test_eval_suite_passes():
    """Run all six evaluation fixtures in isolation and assert every one passes."""
    summary = run_all()
    failed = [r["name"] for r in summary["results"] if not r["passed"]]
    assert not failed, (
        f"{len(failed)} fixture(s) failed: {', '.join(failed)}\n"
        + "\n".join(
            f"  {r['name']}: expected={r['expected']!r} observed={r['observed']!r}"
            for r in summary["results"]
            if not r["passed"]
        )
    )
    assert summary["passed"] == 6, f"expected 6 fixtures, got {summary['total']}"
