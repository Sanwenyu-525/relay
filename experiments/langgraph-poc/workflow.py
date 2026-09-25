"""Real LangGraph, disk checkpoints; deterministic model and fake external tool."""

import argparse
import json
from typing import TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from lab import Lab, digest


class State(TypedDict):
    epoch: int
    payload: str
    artifact_hash: str


def build(lab, saver):
    def draft(state):
        return {"artifact_hash": lab.publish(state["epoch"], state["payload"])}

    def approve(state):
        # This node replays from its beginning on resume. No tool effect here.
        answer = interrupt({"digest": state["artifact_hash"], "epoch": state["epoch"]})
        lab.approve(state["epoch"], state["artifact_hash"], answer)
        return {}

    def execute(state):
        lab.execute(state["epoch"], state["artifact_hash"])
        return {}

    def verify(state):
        lab.verify(state["epoch"], state["artifact_hash"])
        return {}

    def complete(state):
        lab.complete(state["epoch"], state["artifact_hash"])
        return {}

    graph = StateGraph(State)
    steps = {"draft": draft, "approve": approve, "execute": execute,
             "verify": verify, "complete": complete}
    previous = START
    for name, action in steps.items():
        graph.add_node(name, action)
        graph.add_edge(previous, name)
        previous = name
    graph.add_edge(previous, END)
    return graph.compile(checkpointer=saver)


def run(root, action, decision=None):
    lab = Lab(root)
    lab.initialize()
    if action == "reconcile":
        return {"reconciliation": lab.reconcile(), **lab.summary()}
    with SqliteSaver.from_conn_string(str(lab.root / "checkpoints.sqlite")) as saver:
        graph = build(lab, saver)
        config = {"configurable": {"thread_id": "p00-single-run"}}
        if action == "start":
            old = graph.get_state(config)
            if old.values:
                raise ValueError("ALREADY_STARTED")
            state = lab.state()
            value = {"epoch": state["epoch"], "payload": state["payload"]}
            graph.invoke(value, config, durability="sync")
        elif action == "resume":
            graph.invoke(Command(resume=decision) if decision is not None else None,
                         config, durability="sync")
        snapshot = graph.get_state(config)
        return {**lab.summary(), "next": list(snapshot.next),
                "interrupts": [item.value for item in snapshot.interrupts],
                "artifact_hash": snapshot.values.get("artifact_hash")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "resume", "status", "reconcile"])
    parser.add_argument("--root", required=True)
    parser.add_argument("--decision", type=json.loads)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.root, args.action, args.decision), ensure_ascii=True))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(2)
