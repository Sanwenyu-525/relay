"""Run the three credential-free P00 workloads in independent processes.

The script records each process's raw JSON result and ready latency. It does
not normalize unlike metrics: Pi is stream-driven, LangGraph is a buffered
graph, and Rig is a buffered blocking runner. All three share two fake model
turns, one controlled tool, 5 ms simulated I/O for the concurrency probe, no
persistence, and 200 sequential samples.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def read_json_line(stream) -> dict:
    line = stream.readline()
    if not line:
        raise RuntimeError("benchmark process exited before emitting JSON")
    return json.loads(line)


def run_protocol(command: list[str], cwd: Path) -> dict:
    started = time.perf_counter()
    process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True)
    try:
        ready = read_json_line(process.stdout)
        ready_ms = (time.perf_counter() - started) * 1000
        process.stdin.write("run\n")
        process.stdin.flush()
        result = read_json_line(process.stdout)
        process.stdin.close()
        return {"ready": ready, "ready_ms": ready_ms, "result": result,
                "returncode": process.wait(timeout=120)}
    finally:
        if process.poll() is None:
            process.kill()
        stderr = process.stderr.read()
        if stderr:
            # Keep diagnostics in the raw record without contaminating stdout.
            result = locals().get("result")
            if result is not None:
                result["stderr"] = stderr


def command_for(runtime: str) -> tuple[list[str], Path]:
    if runtime == "pi":
        return ["node", "pi.mjs"], ROOT / "runtime-bench"
    if runtime == "langgraph":
        return [str(ROOT.parent / ".research" / "poc-venv" / "Scripts" / "python.exe"),
                "bench_workflow.py"], ROOT / "langgraph-poc"
    if runtime == "rig":
        exe = ROOT / "rig-poc" / "target" / "release" / "workflow-os-rig-poc.exe"
        if not exe.exists():
            raise FileNotFoundError(f"missing release binary: {exe}; build it first")
        return [str(exe)], ROOT / "rig-poc"
    raise ValueError(runtime)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "benchmark-latest.json")
    args = parser.parse_args()
    records = []
    for runtime in ("pi", "langgraph", "rig"):
        command, cwd = command_for(runtime)
        for repetition in range(1, args.repetitions + 1):
            records.append({"runtime": runtime, "repetition": repetition,
                            "record": run_protocol(command, cwd)})
    payload = {
        "schema": "p00-runtime-benchmark.v1",
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "configuration": {
            "repetitions": args.repetitions,
            "sequential_iterations": 200,
            "concurrency": 16,
            "concurrent_batches": 10,
            "simulated_io_ms": 5,
            "persistence": "none",
            "workload": "two fake model turns + one controlled tool",
        },
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps({"output": str(args.output), "records": len(records)}))


if __name__ == "__main__":
    main()

