"""Credential-free LangGraph workload used by the P00 runtime comparison.

This is intentionally a separate graph from ``workflow.py``: it has no
checkpoint saver and only models the common workload (two fake model turns and
one controlled tool). The existing checkpointed recovery experiment remains
the authority for persistence semantics.
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class BenchState(TypedDict):
    calls: int
    effects: int
    output: str


def build(delay_seconds: float = 0.0):
    def fake_model_one(state: BenchState):
        return {"calls": state["calls"] + 1}

    def controlled_gateway(state: BenchState):
        if delay_seconds:
            time.sleep(delay_seconds)
        return {"effects": state["effects"] + 1}

    def fake_model_two(state: BenchState):
        return {"calls": state["calls"] + 1, "output": "fixture"}

    graph = StateGraph(BenchState)
    graph.add_node("model_one", fake_model_one)
    graph.add_node("gateway", controlled_gateway)
    graph.add_node("model_two", fake_model_two)
    graph.add_edge(START, "model_one")
    graph.add_edge("model_one", "gateway")
    graph.add_edge("gateway", "model_two")
    graph.add_edge("model_two", END)
    # No checkpointer: this is the functionally equivalent buffered baseline.
    return graph.compile()


def run_once(delay_seconds: float = 0.0) -> BenchState:
    result = build(delay_seconds).invoke({"calls": 0, "effects": 0, "output": ""})
    if (result["calls"], result["effects"], result["output"]) != (2, 1, "fixture"):
        raise RuntimeError(f"incorrect workload result: {result!r}")
    return result


def process_rss_bytes() -> int:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("page_fault_count", wintypes.DWORD),
                        ("peak_working_set", ctypes.c_size_t), ("working_set", ctypes.c_size_t)]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        return int(counters.working_set if ok else 0)
    try:
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)
    except (ImportError, AttributeError):
        return 0


def percentile(values: list[float], fraction: float) -> float:
    values = sorted(values)
    index = max(0, int((len(values) * fraction + 0.999999999)) - 1)
    return values[index]


def bench(sequential_iterations: int = 200, batches: int = 10,
          concurrency: int = 16, io_ms: float = 5.0) -> dict:
    for _ in range(20):
        run_once()
    samples = []
    for _ in range(sequential_iterations):
        started = time.perf_counter()
        run_once()
        samples.append((time.perf_counter() - started) * 1000)
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for _ in range(batches):
            futures = [pool.submit(run_once, io_ms / 1000) for _ in range(concurrency)]
            for future in futures:
                future.result()
    elapsed = time.perf_counter() - started
    return {
        "runtime": "langgraph",
        "langgraph": "1.2.11",
        "mode": "buffered_graph",
        "persistence": "none",
        "simulated_io_ms": io_ms,
        "sequential_iterations": sequential_iterations,
        "sequential_p50_ms": percentile(samples, 0.50),
        "sequential_p95_ms": percentile(samples, 0.95),
        "concurrency": concurrency,
        "concurrent_runs": batches * concurrency,
        "concurrent_runs_per_second": batches * concurrency / elapsed,
        "rss_bytes": process_rss_bytes(),
    }


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--bench":
        print(json.dumps(bench(), separators=(",", ":")))
        return
    print(json.dumps({"ready": True, "runtime": "langgraph", "version": "1.2.11",
                      "pid": os.getpid()}), flush=True)
    if sys.stdin.readline().strip() == "run":
        print(json.dumps(bench(), separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()

