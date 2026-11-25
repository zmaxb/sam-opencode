"""Exercise the remaining native run-bound Steering lifecycle boundaries."""
import argparse
from hashlib import sha256
import io
import json
from pathlib import Path
import runpy
import sqlite3
import tempfile
from threading import Event
from urllib.request import urlopen
from uuid import uuid4

base = runpy.run_path(str(Path(__file__).with_name("qualify.py")))
Lab, Model = base["Lab"], base["Model"]


class Provider(Model):
    def do_POST(self):
        wire = self.rfile.read(int(self.headers["Content-Length"]))
        messages = json.loads(wire)["messages"]
        index = len(self.server.inputs)
        self.server.inputs.append(messages)
        if index in self.server.barriers:
            entered, release = self.server.barriers[index]
            entered.set()
            assert release.wait(25), "Provider barrier timed out"
        if index in self.server.rate_limits:
            body = b'{"error":{"message":"fixture rate limit","type":"rate_limit_error"}}'
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Retry-After", "0")
            self.end_headers()
            self.wfile.write(body)
            return
        if "You MUST summarize" in json.dumps(messages):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.respond({"content": "## Objective\nPreserve the fixture root."}, "stop")
            return
        self.rfile = io.BytesIO(wire)
        super().do_POST()


def qualify_controlled_background(binary, root):
    stage = Path(__file__).resolve().parents[1] / "stage01"
    Study = runpy.run_path(str(stage / "qualify.py"))["Study"]
    lab = Study(binary, root, False, stage / "fixture-plugin", False)
    lab.model.RequestHandlerClass = Provider
    lab.model.inputs, lab.model.rate_limits = [], set()
    first, release = Event(), Event()
    next_step, finish_step = Event(), Event()
    lab.model.barriers = {0: (first, release), 1: (next_step, finish_step)}
    try:
        lab.start()
        marker = "probe-steering-shell"
        root_id = "msg_" + uuid4().hex
        lab.model.cases[marker] = [lab.call("steering-shell")]
        sid = lab.api("/api/session", {
            "title": marker,
            "location": {"directory": str(lab.workspace)},
            "metadata": {"samBackground": {
                "contract": "sam.opencode-shell-report-control/v1", "inputId": root_id, "operation": str(uuid4()),
            }},
        })["data"]["id"]
        assert lab.api(f"/api/session/{sid}/prompt", {"id": root_id, "text": marker})["data"]["id"] == root_id
        assert first.wait(15)
        owner = lab.api(f"/api/session/{sid}/steering")["execution"]
        assert owner["rootMessageID"] == root_id
        message = "msg_" + uuid4().hex
        accepted = lab.api(f"/api/session/{sid}/prompt", {
            "id": message, "text": "BOUND_DURING_SHELL", "expectedExecution": owner, "delivery": "steer",
        })
        assert accepted.get("data", {}).get("id") == message, accepted
        release.set()
        assert next_step.wait(15)
        assert lab.api(f"/api/session/{sid}/steering")["execution"] == owner
        assert "BOUND_DURING_SHELL" in json.dumps(lab.model.inputs[1])
        shell = lab.launch_record(sid, 1)["steering-shell"]
        assert lab.shell(shell["shell"]["id"])["data"]["status"] == "running"
        lab.open_gate("steering-shell")
        terminal = lab.terminal(shell)
        assert terminal["status"] == "exited" and terminal["exit"] == 0
        assert lab.api(f"/api/session/{sid}/steering")["execution"] == owner
        finish_step.set()
        lab.until(lambda: lab.idle(sid))
        assert len(lab.held(sid, 1)) == 1
        assert lab.api(f"/api/session/{sid}/steering?messageID={message}")["receipt"]["execution"] == owner
    finally:
        release.set()
        finish_step.set()
        lab.open_gate("steering-shell")
        lab.stop()
        lab.model.shutdown()
        lab.model.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda value: str(Path(value).resolve()))
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="opencode-steering-closeout-"))
    print(root, flush=True)
    lab = Lab(args.binary, root, False, None, False)
    lab.model.RequestHandlerClass = Provider
    lab.model.inputs, lab.model.barriers, lab.model.rate_limits = [], {}, set()
    checks = []

    def record(message):
        checks.append(message)
        (root / "qualification.json").write_text(json.dumps(checks, indent=2) + "\n")
        print(message, flush=True)

    def session():
        return lab.api("/api/session", {
            "title": "Closeout fixture",
            "location": {"directory": str(lab.workspace)},
        })["data"]["id"]

    def state(sid, message=None):
        query = f"?messageID={message}" if message else ""
        return lab.api(f"/api/session/{sid}/steering{query}")

    def mid():
        return "msg_" + uuid4().hex

    def send(sid, text, owner=None, delivery="steer", resume=True):
        message = mid()
        result = lab.api(f"/api/session/{sid}/prompt", {
            "id": message, "text": text, "delivery": delivery, "resume": resume,
            **({"expectedExecution": owner} if owner else {}),
        })
        assert result.get("data", {}).get("id") == message, result
        return message

    def barrier(index):
        entered, release = Event(), Event()
        lab.model.barriers[index] = entered, release
        return entered, release

    def begin(sid, marker):
        index = len(lab.model.inputs)
        entered, release = barrier(index)
        root_id = send(sid, marker, delivery="queue")
        assert entered.wait(15), marker
        owner = state(sid)["execution"]
        assert owner["rootMessageID"] == root_id
        return index, owner, release

    def seen(index, text):
        return text in json.dumps(lab.model.inputs[index])

    def receipt(sid, owner, message, payload):
        assert state(sid, message).get("receipt") == {
            "sessionID": sid, "messageID": message, "execution": owner,
            "digest": sha256(payload.encode()).hexdigest(),
        }

    def pending(sid):
        return [item["id"] for item in lab.api(f"/api/session/{sid}/inbox")["data"]]

    try:
        lab.start()
        sid = session()
        lab.model.cases["probe-retry-root"] = [lab.call("retry-root", background=False, gated=False)]
        index, owner, release = begin(sid, "probe-retry-root")
        lab.model.rate_limits.add(index)
        retried, finish_retry = barrier(index + 1)
        continued, finish_continuation = barrier(index + 2)
        release.set()
        assert retried.wait(15), "429 did not retry"
        assert state(sid)["execution"] == owner
        message = send(sid, "RETRY_BOUND", owner)
        finish_retry.set()
        assert continued.wait(15), "original root did not continue"
        assert state(sid)["execution"] == owner and seen(index + 2, "RETRY_BOUND")
        assert not seen(index + 1, "RETRY_BOUND")
        receipt(sid, owner, message, "RETRY_BOUND")
        finish_continuation.set()
        lab.until(lambda: lab.idle(sid))
        record("Step Retry: same owner before and after HTTP 429, delivered on the original continuation")

        sid = session()
        send(sid, "probe-compaction-history", delivery="queue")
        lab.until(lambda: lab.idle(sid))
        lab.model.cases["probe-compact-root"] = [lab.call("compact-root", background=False, gated=False)]
        index, owner, release = begin(sid, "probe-compact-root")
        summarizing, finish_summary = barrier(index + 1)
        continued, finish_continuation = barrier(index + 2)
        compaction = lab.api(f"/api/session/{sid}/compact", {})
        assert "data" in compaction, compaction
        release.set()
        assert summarizing.wait(15), "compaction did not call the provider"
        assert seen(index + 1, "You MUST summarize") and state(sid)["execution"] == owner
        message = send(sid, "COMPACTION_BOUND", owner)
        finish_summary.set()
        assert continued.wait(15), "root did not continue after compaction"
        assert state(sid)["execution"] == owner and seen(index + 2, "COMPACTION_BOUND")
        receipt(sid, owner, message, "COMPACTION_BOUND")
        finish_continuation.set()
        lab.until(lambda: lab.idle(sid))
        assert any(row.get("type") == "compaction" and row.get("status") == "completed"
                   for row in lab.transcript(sid)["data"])
        record("Compaction: provider summary completed, same owner continued and consumed the bound input")

        sid = session()
        lab.model.cases["probe-stock-root"] = [lab.call("stock-root", background=False, gated=False)]
        index, owner, release = begin(sid, "probe-stock-root")
        busy = lab.session(sid)["time"]["busy"]
        continued, finish_continuation = barrier(index + 1)
        successor, finish_successor = barrier(index + 2)
        ordinary = send(sid, "UNBOUND_NATIVE_STEER")
        queued = send(sid, "probe-stock-queued", delivery="queue")
        release.set()
        assert continued.wait(15)
        assert seen(index + 1, "UNBOUND_NATIVE_STEER") and not seen(index + 1, "probe-stock-queued")
        assert state(sid)["execution"] == owner and queued in pending(sid)
        assert state(sid, ordinary).get("receipt") is None
        finish_continuation.set()
        assert successor.wait(15)
        new_owner = state(sid)["execution"]
        assert new_owner["rootMessageID"] == queued and new_owner["ownerToken"] != owner["ownerToken"]
        assert lab.session(sid)["time"]["busy"] == busy and not lab.idle(sid)
        assert seen(index + 2, "probe-stock-queued")
        cancelled = send(sid, "CANCELLED_BOUND", new_owner)
        assert lab.api(f"/api/session/{sid}/inbox/{cancelled}", method="DELETE")["http"] == 204
        assert cancelled not in pending(sid)
        receipt(sid, new_owner, cancelled, "CANCELLED_BOUND")
        finish_successor.set()
        lab.until(lambda: lab.idle(sid))
        receipt(sid, new_owner, cancelled, "CANCELLED_BOUND")
        assert all(not seen(i, "CANCELLED_BOUND") for i in range(index, len(lab.model.inputs)))
        record("Stock unbound Steering and Native Queue: new root token within the same busy period")
        record("Inbox cancellation removes pending delivery and preserves exact receipt")

        sid = session()
        index, owner, release = begin(sid, "probe-crash-deferred")
        message = send(sid, "DEFERRED_BOUND", owner)
        lab.process.kill()
        lab.process.wait()
        release.set()
        lab.start()
        assert message in pending(sid) and state(sid).get("execution") is None
        receipt(sid, owner, message, "DEFERRED_BOUND")
        assert len(lab.model.inputs) == index + 1
        next_index, _, finish_successor = begin(sid, "probe-restart-successor")
        assert message not in pending(sid) and not seen(next_index, "DEFERRED_BOUND")
        finish_successor.set()
        lab.until(lambda: lab.idle(sid))
        db_path = root / "data/opencode/opencode.db"
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
            assert db.execute("SELECT type FROM event WHERE aggregate_id=?", (sid,)).fetchall() == [
                ("local-retained:session.inbox.enqueued.1",),
            ]
        with urlopen(lab.request(f"/api/experimental/session/{sid}/log"), timeout=10) as stream:
            journal = stream.read()
        assert journal.count(b"data: ") == 1 and b"log.synced" in journal and b"DEFERRED_BOUND" not in journal, journal
        assert lab.api(f"/api/session/{sid}", method="DELETE")["http"] == 204
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
            assert db.execute("SELECT count(*) FROM event WHERE aggregate_id=?", (sid,)).fetchone() == (0,)
        assert state(sid, message)["http"] == 404
        record("Plain restart: pending is visible before successor and excluded from its first input")
        record("Selective retention: sparse record is excluded from replay and deleted with the Session")
    finally:
        for _, release in lab.model.barriers.values():
            release.set()
        lab.stop()
        lab.model.shutdown()
        lab.model.server_close()
    qualify_controlled_background(args.binary, root / "controlled-background")
    record("Controlled Background Shell: bound input and shell completion coexist, report remains held")


if __name__ == "__main__":
    main()
