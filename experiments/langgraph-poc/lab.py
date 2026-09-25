"""P00 single-run test authority. SQLite here is NOT the product database."""

import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Lab:
    def __init__(self, root):
        self.root = Path(root)

    @contextmanager
    def db(self, name="business.sqlite"):
        connection = sqlite3.connect(self.root / name)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task (
                    id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER,
                    payload TEXT, control TEXT, permitted INTEGER, status TEXT);
                CREATE TABLE IF NOT EXISTS operation (
                    id TEXT PRIMARY KEY, digest TEXT, status TEXT);
                CREATE TABLE IF NOT EXISTS verification (digest TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS completion (
                    epoch INTEGER PRIMARY KEY, digest TEXT);
                CREATE TABLE IF NOT EXISTS event (
                    id TEXT PRIMARY KEY, epoch INTEGER, payload TEXT);
            """)
            db.execute("INSERT OR IGNORE INTO task VALUES(1,1,?,NULL,1,'READY')",
                       ("# Result\n\nVerified fixture output.\n",))
        with self.db("effects.sqlite") as db:
            db.execute("CREATE TABLE IF NOT EXISTS effect ("
                       "invocation INTEGER PRIMARY KEY, operation TEXT, digest TEXT)")

    def state(self):
        with self.db() as db:
            return dict(db.execute("SELECT * FROM task WHERE id=1").fetchone())

    def live(self, epoch, expected_digest):
        state = self.state()
        if epoch != state["epoch"]:
            raise ValueError("STALE_EPOCH")
        if digest(state["payload"]) != expected_digest:
            raise ValueError("STALE_CONTENT")
        if state["control"]:
            raise ValueError("CONTROL_PENDING")
        if not state["permitted"]:
            raise ValueError("PERMISSION_REVOKED")

    def fault(self, point):
        # A fresh process simulates a hard crash. Trigger each named fault once.
        marker = self.root / ("fault-" + point)
        if os.environ.get("POC_CRASH") == point and not marker.exists():
            marker.write_text(point, encoding="utf-8")
            os._exit(77)

    def publish(self, epoch, payload):
        content_hash = digest(payload)
        self.live(epoch, content_hash)
        path = self.root / (content_hash + ".md")
        if not path.exists():
            with path.open("x", encoding="utf-8", newline="") as out:
                out.write(payload)
                out.flush()
                os.fsync(out.fileno())
        if digest(path.read_text(encoding="utf-8")) != content_hash:
            raise ValueError("ARTIFACT_MISMATCH")
        return content_hash

    def approve(self, epoch, content_hash, decision):
        self.live(epoch, content_hash)
        if decision != {"approve": True, "digest": content_hash, "epoch": epoch}:
            raise ValueError("APPROVAL_MISMATCH")
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO operation VALUES('publish',?,'PREPARED')",
                       (content_hash,))
            row = db.execute("SELECT * FROM operation WHERE id='publish'").fetchone()
            if row["digest"] != content_hash:
                raise ValueError("OPERATION_MISMATCH")

    def execute(self, epoch, content_hash):
        self.live(epoch, content_hash)
        with self.db() as db:
            row = db.execute("SELECT * FROM operation WHERE id='publish'").fetchone()
            if row is None or row["digest"] != content_hash:
                raise ValueError("APPROVAL_REQUIRED")
            if row["status"] == "SUCCEEDED":
                return
            unknown = row["status"] in ("DISPATCHING", "UNKNOWN")
            db.execute("UPDATE operation SET status=? WHERE id='publish'",
                       ("UNKNOWN" if unknown else "DISPATCHING",))
        if unknown:
            raise ValueError("RECONCILIATION_REQUIRED")
        self.fault("before_effect")
        # Controlled external tool: different transaction/store, no idempotent
        # INSERT. A duplicate dispatch really adds another effect and fails tests.
        with self.db("effects.sqlite") as db:
            db.execute("INSERT INTO effect(operation,digest) VALUES('publish',?)",
                       (content_hash,))
        self.fault("after_effect")
        with self.db() as db:
            db.execute("UPDATE operation SET status='SUCCEEDED' WHERE id='publish'")

    def reconcile(self):
        with self.db("effects.sqlite") as db:
            receipts = db.execute("SELECT * FROM effect WHERE operation='publish'").fetchall()
        with self.db() as db:
            row = db.execute("SELECT * FROM operation WHERE id='publish'").fetchone()
            if row is None:
                return "NO_OPERATION"
            proven = len(receipts) == 1 and receipts[0]["digest"] == row["digest"]
            status = "SUCCEEDED" if proven else "UNKNOWN"
            db.execute("UPDATE operation SET status=? WHERE id='publish'", (status,))
        return status

    def verify(self, epoch, content_hash):
        self.live(epoch, content_hash)
        text = (self.root / (content_hash + ".md")).read_text(encoding="utf-8")
        if digest(text) != content_hash or not text.startswith("# Result\n"):
            raise ValueError("VERIFICATION_FAILED")
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO verification VALUES(?)", (content_hash,))

    def complete(self, epoch, content_hash):
        self.live(epoch, content_hash)
        self.fault("before_commit")
        with self.db() as db:
            valid = db.execute("SELECT 1 FROM verification WHERE digest=?", (content_hash,)).fetchone()
            success = db.execute("SELECT 1 FROM operation WHERE digest=? AND status='SUCCEEDED'",
                                 (content_hash,)).fetchone()
            if not valid or not success:
                raise ValueError("COMPLETION_NOT_ELIGIBLE")
            db.execute("UPDATE task SET status='DONE' WHERE id=1")
            self.fault("during_commit")
            db.execute("INSERT OR IGNORE INTO completion VALUES(?,?)", (epoch, content_hash))
        self.fault("after_commit")

    def receive_event(self, event_id, epoch, payload):
        # Simulated transport boundary. Events are evidence, never Task DONE.
        encoded = json.dumps(payload, sort_keys=True)
        with self.db() as db:
            previous = db.execute("SELECT * FROM event WHERE id=?", (event_id,)).fetchone()
            if previous:
                if previous["epoch"] != epoch or previous["payload"] != encoded:
                    raise ValueError("EVENT_ID_CONFLICT")
                return "REPLAY"
            if epoch != self.state()["epoch"]:
                raise ValueError("STALE_EPOCH")
            db.execute("INSERT INTO event VALUES(?,?,?)", (event_id, epoch, encoded))
        return "RECORDED"

    def summary(self):
        result = self.state()
        with self.db() as db:
            result["operations"] = [dict(row) for row in db.execute("SELECT * FROM operation")]
            result["completions"] = db.execute("SELECT COUNT(*) FROM completion").fetchone()[0]
            result["events"] = db.execute("SELECT COUNT(*) FROM event").fetchone()[0]
        with self.db("effects.sqlite") as db:
            result["effects"] = db.execute("SELECT COUNT(*) FROM effect").fetchone()[0]
        return result
