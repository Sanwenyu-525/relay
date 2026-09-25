from bench_workflow import build, run_once


def test_uncheckpointed_graph_matches_common_workload():
    assert run_once() == {"calls": 2, "effects": 1, "output": "fixture"}


def test_graph_has_no_checkpointer_for_baseline():
    graph = build()
    assert graph.checkpointer is None

