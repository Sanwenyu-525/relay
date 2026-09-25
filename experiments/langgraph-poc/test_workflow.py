import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from lab import Lab, digest

SCRIPT = Path(__file__).with_name("workflow.py")


def call(root, action, *, decision=None, crash=None, code=0):
    env = os.environ.copy()
    # No remote tracing or inherited crash configuration in this experiment.
    env.update(LANGSMITH_TRACING="false", LANGCHAIN_TRACING_V2="false", POC_CRASH=crash or "")
    command = [sys.executable, str(SCRIPT), action, "--root", str(root)]
    if decision is not None:
        command += ["--decision", json.dumps(decision)]
    result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=25)
    assert result.returncode == code, result.stdout + result.stderr
    return json.loads(result.stdout) if result.stdout.strip() else None


def start(root):
    value = call(root, "start")
    assert value["next"] == ["approve"]
    assert value["effects"] == value["completions"] == 0
    return {"approve": True, **value["interrupts"][0]}


def test_disk_checkpoint_human_resume_in_fresh_process(tmp_path):
    decision = start(tmp_path)
    assert call(tmp_path, "status")["interrupts"]
    completed = call(tmp_path, "resume", decision=decision)
    assert completed["status"] == "DONE"
    assert completed["effects"] == completed["completions"] == 1
    assert completed["next"] == []


def test_duplicate_start_and_resume_never_repeat_effect(tmp_path):
    decision = start(tmp_path)
    assert call(tmp_path, "start", code=2)["error"] == "ALREADY_STARTED"
    call(tmp_path, "resume", decision=decision)
    repeated = call(tmp_path, "resume", decision=decision)
    assert repeated["effects"] == repeated["completions"] == 1


@pytest.mark.parametrize("change,error", [
    ("UPDATE task SET payload='Changed target'", "STALE_CONTENT"),
    ("UPDATE task SET epoch=2", "STALE_EPOCH"),
    ("UPDATE task SET permitted=0", "PERMISSION_REVOKED"),
    ("UPDATE task SET control='CANCEL'", "CONTROL_PENDING"),
])
def test_approval_rechecks_current_authority(tmp_path, change, error):
    decision = start(tmp_path)
    with Lab(tmp_path).db() as db:
        db.execute(change)
    assert call(tmp_path, "resume", decision=decision, code=2)["error"] == error
    result = call(tmp_path, "status")
    assert result["effects"] == result["completions"] == 0


def test_wrong_approval_binding_is_rejected(tmp_path):
    decision = start(tmp_path)
    decision["digest"] = "wrong"
    assert call(tmp_path, "resume", decision=decision, code=2)["error"] == "APPROVAL_MISMATCH"
    assert call(tmp_path, "status")["effects"] == 0


def test_pause_then_resume_same_checkpoint(tmp_path):
    decision = start(tmp_path)
    with Lab(tmp_path).db() as db:
        db.execute("UPDATE task SET control='PAUSE'")
    assert call(tmp_path, "resume", decision=decision, code=2)["error"] == "CONTROL_PENDING"
    with Lab(tmp_path).db() as db:
        db.execute("UPDATE task SET control=NULL")
    result = call(tmp_path, "resume")
    assert result["status"] == "DONE"
    assert result["effects"] == 1


def test_external_success_lost_receipt_requires_reconciliation(tmp_path):
    decision = start(tmp_path)
    call(tmp_path, "resume", decision=decision, crash="after_effect", code=77)
    before = call(tmp_path, "status")
    assert before["effects"] == 1 and before["completions"] == 0
    assert call(tmp_path, "resume", code=2)["error"] == "RECONCILIATION_REQUIRED"
    assert call(tmp_path, "reconcile")["reconciliation"] == "SUCCEEDED"
    completed = call(tmp_path, "resume")
    assert completed["effects"] == completed["completions"] == 1


def test_unknown_without_proof_never_redispatches(tmp_path):
    decision = start(tmp_path)
    call(tmp_path, "resume", decision=decision, crash="before_effect", code=77)
    assert call(tmp_path, "reconcile")["reconciliation"] == "UNKNOWN"
    assert call(tmp_path, "resume", code=2)["error"] == "RECONCILIATION_REQUIRED"
    assert call(tmp_path, "status")["effects"] == 0


@pytest.mark.parametrize("point,committed", [
    ("before_commit", False), ("during_commit", False), ("after_commit", True),
])
def test_business_checkpoint_gap_recovers_without_repeating_effect(tmp_path, point, committed):
    decision = start(tmp_path)
    call(tmp_path, "resume", decision=decision, crash=point, code=77)
    crashed = call(tmp_path, "status")
    assert crashed["effects"] == 1
    assert crashed["completions"] == int(committed)
    assert (crashed["status"] == "DONE") == committed
    result = call(tmp_path, "resume")
    assert result["status"] == "DONE"
    assert result["effects"] == result["completions"] == 1


def test_bad_artifact_cannot_complete(tmp_path):
    decision = start(tmp_path)
    (tmp_path / (decision["digest"] + ".md")).write_text("tampered", encoding="utf-8")
    assert call(tmp_path, "resume", decision=decision, code=2)["error"] == "VERIFICATION_FAILED"
    assert call(tmp_path, "status")["completions"] == 0


def test_duplicate_and_late_transport_evidence_is_not_business_completion(tmp_path):
    start(tmp_path)
    lab = Lab(tmp_path)
    event = {"type": "execution_completed"}
    assert lab.receive_event("e1", 1, event) == "RECORDED"
    assert lab.receive_event("e1", 1, event) == "REPLAY"
    with pytest.raises(ValueError, match="EVENT_ID_CONFLICT"):
        lab.receive_event("e1", 1, {"type": "other"})
    with lab.db() as db:
        db.execute("UPDATE task SET epoch=2")
    with pytest.raises(ValueError, match="STALE_EPOCH"):
        lab.receive_event("e2", 1, event)
    assert lab.summary()["events"] == 1
    assert lab.summary()["status"] != "DONE"
    assert lab.summary()["completions"] == 0
