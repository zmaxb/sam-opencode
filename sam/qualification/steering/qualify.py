"""Qualify run-bound Steering over native HTTP with the loopback provider."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import io
import sqlite3
from hashlib import sha256
import json
from pathlib import Path
import runpy
import tempfile
from threading import Event
from uuid import uuid4
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
fixture = runpy.run_path(str(HERE.parent / "stage00/probe.py"))
Lab, Model = fixture["Lab"], fixture["Model"]


class Provider(Model):
    def do_POST(self):
        wire = self.rfile.read(int(self.headers["Content-Length"]))
        self.rfile = io.BytesIO(wire)
        messages = json.loads(wire)["messages"]
        index = len(self.server.inputs)
        self.server.inputs.append(messages)
        if index in self.server.barriers:
            started, release = self.server.barriers[index]
            started.set()
            assert release.wait(20), "Provider fixture barrier timed out"
        super().do_POST()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("binary", type=lambda v: str(Path(v).resolve()))
    p.add_argument("--managed", action="store_true")
    args = p.parse_args()
    root = Path(tempfile.mkdtemp(prefix="opencode-bound-steering-"))
    print(root, flush=True)
    lab = Lab(args.binary, root, False, HERE / "fixture-plugin", args.managed)
    lab.env["OPENCODE_STEERING_FIXTURE"] = str(root)
    lab.model.RequestHandlerClass = Provider
    lab.model.inputs = []
    lab.model.barriers = {}
    checks = []

    def mid():
        return "msg_" + uuid4().hex

    def session(authority=None):
        return lab.api("/api/session", {
            "title": "Steering fixture",
            **({"metadata": {"fixtureRoot": authority}} if authority else {}),
            "location": {"directory": str(lab.workspace)},
        })["data"]["id"]

    def state(sid, mid=None):
        query = f"?messageID={mid}" if mid else ""
        value = lab.api(f"/api/session/{sid}/steering{query}")
        assert value["capability"] == "run-bound-steering/v1", value
        return value

    def prompt(sid, text, message_id, expected=None, delivery=None, resume=True, **rest):
        return lab.api(f"/api/session/{sid}/prompt", {
            "id": message_id, "text": text, "resume": resume,
            "delivery": delivery or ("steer" if expected else "queue"),
            **({"expectedExecution": expected} if expected else {}), **rest,
        })

    def barrier(index):
        started, release = Event(), Event()
        lab.model.barriers[index] = started, release
        return started, release

    def start(sid, text, index, root_id=None):
        started, release = barrier(index)
        root_id = root_id or mid()
        assert prompt(sid, text, root_id)["data"]["id"] == root_id
        assert started.wait(15)
        owner = state(sid)["execution"]
        assert owner["rootMessageID"] == root_id
        return owner, release

    def contains(marker, after=0):
        return any(marker in json.dumps(messages) for messages in lab.model.inputs[after:])

    def no_pending(sid, message_id):
        return all(row["id"] != message_id for row in lab.api(f"/api/session/{sid}/inbox")["data"])

    def exact(sid, owner, id, text):
        assert state(sid, id)["receipt"] == {
            "sessionID": sid, "messageID": id, "execution": owner,
            "digest": sha256(text.encode()).hexdigest(),
        }

    try:
        lab.start()
        sid = session()
        lab.model.cases["probe-continue"] = [lab.call("steering-tool", background=False, gated=False)]
        owner, release = start(sid, "probe-continue", 0)
        next_started, next_release = barrier(1)
        id, text = mid(), "BOUND_CONTINUATION"
        first = prompt(sid, text, id, owner)
        assert first["data"]["id"] == id, first
        assert prompt(sid, text, id, owner) == first
        assert prompt(sid, text + "-changed", id, owner)["http"] == 409
        wrong_owner = {**owner, "ownerToken": str(uuid4())}
        assert prompt(sid, text, id, wrong_owner)["http"] == 409
        assert lab.api(f"/api/session/{sid}/inbox/{id}", {"delivery": "queue"}, "PATCH")["http"] == 409
        assert lab.api(f"/api/session/{sid}/inbox/{id}", {"delivery": "steer"}, "PATCH")["http"] == 409
        release.set()
        assert next_started.wait(15)
        assert state(sid)["execution"] == owner
        assert contains(text, 1)
        assert text not in json.dumps(lab.model.inputs[0])
        assert no_pending(sid, id)
        next_release.set()
        lab.until(lambda: lab.idle(sid))
        assert prompt(sid, text, id, owner) == first
        exact(sid, owner, id, text)
        assert len(lab.model.inputs) == 2
        checks.append("next-step provider input, stable root, exact duplicate, no independent wake")
        fork_id = lab.api(f"/api/session/{sid}/fork", {})["data"]["id"]
        assert state(fork_id, id).get("receipt") is None
        assert prompt(fork_id, text, id, owner)["http"] == 409
        checks.append("Session fork cannot prove acceptance for the source Session")

        sid = session()
        index = len(lab.model.inputs)
        owner, release = start(sid, "probe-complete", index)
        stale_id, queued_id = mid(), mid()
        queued_started, queued_release = barrier(index + 1)
        assert "data" in prompt(sid, "STALE_COMPLETE", stale_id, owner)
        assert "data" in prompt(sid, "probe-successor", queued_id, metadata={
            "opencodeBoundSteering": {"execution": owner},
        })
        release.set()
        assert queued_started.wait(15)
        successor = state(sid)["execution"]
        assert successor["rootMessageID"] == queued_id and successor["ownerToken"] != owner["ownerToken"]
        assert prompt(sid, "REJECT_LATE", mid(), owner)["http"] == 409
        assert state(sid, queued_id).get("receipt") is None
        assert prompt(sid, "STALE_COMPLETE", stale_id)["http"] == 409
        exact(sid, owner, stale_id, "STALE_COMPLETE")
        assert no_pending(sid, stale_id) and not contains("STALE_COMPLETE")
        queued_release.set()
        lab.until(lambda: lab.idle(sid))
        checks.append("completion expiry, queued successor identity, late reject and metadata isolation")

        left, right = session(), session()
        left_owner, left_release = start(left, "probe-left", len(lab.model.inputs))
        right_owner, right_release = start(right, "probe-right", len(lab.model.inputs))
        shared_id, text = mid(), "CONTENDED_MESSAGE_ID"
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(prompt, left, text, shared_id, left_owner)
            second = pool.submit(prompt, right, text, shared_id, right_owner)
            left_result, right_result = first.result(timeout=10), second.result(timeout=10)
        assert (left_result.get("http"), right_result.get("http")) in [(None, 409), (409, None)]
        if "data" in left_result:
            exact(left, left_owner, shared_id, text)
            assert state(right, shared_id).get("receipt") is None
        else:
            exact(right, right_owner, shared_id, text)
            assert state(left, shared_id).get("receipt") is None
        left_release.set()
        right_release.set()
        lab.until(lambda: lab.idle(left) and lab.idle(right))
        checks.append("simultaneous cross-Session message ID admits exactly one receipt")

        root_id = mid()
        sid = session(root_id)
        index = len(lab.model.inputs)
        owner, release = start(sid, "probe-hook-race", index, root_id)
        stale_id = mid()
        with ThreadPoolExecutor(max_workers=1) as pool:
            claim = pool.submit(prompt, sid, "STALE_PLUGIN", stale_id, owner, metadata={
                "holdFixtureAdmission": True,
            })
            try:
                checked = root / "prompt-hook-checked"
                lab.until(checked.exists)
                assert json.loads(checked.read_text()) == owner
                release.set()
                lab.until(lambda: lab.idle(sid))
            finally:
                (root / "prompt-hook-release").touch()
            assert claim.result(timeout=10)["http"] == 409
        assert state(sid, stale_id).get("receipt") is None
        assert len(lab.model.inputs) == index + 1 and not contains("STALE_PLUGIN")
        checks.append("typed Plugin authorization can pause without holding the owner mutex")

        sid = session()
        index = len(lab.model.inputs)
        owner, release = start(sid, "probe-stop", index)
        id = mid()
        assert "data" in prompt(sid, "STALE_STOP", id, owner)
        assert lab.api(f"/api/session/{sid}/interrupt?resume=true", {}, "POST")["interrupted"]
        release.set()
        lab.until(lambda: lab.idle(sid))
        assert no_pending(sid, id) and state(sid).get("execution") is None
        assert len(lab.model.inputs) == index + 1 and not contains("STALE_STOP")
        exact(sid, owner, id, "STALE_STOP")
        checks.append("Stop, verified expiry and no idle or resume wake")

        sid = session()
        index = len(lab.model.inputs)
        owner, release = start(sid, "probe-crash", index)
        id = mid()
        assert "data" in prompt(sid, "STALE_CRASH", id, owner)
        lab.process.kill()
        lab.process.wait()
        release.set()
        lab.start()
        exact(sid, owner, id, "STALE_CRASH")
        if args.managed:
            lab.until(lambda: no_pending(sid, id))
            lab.until(lambda: lab.idle(sid))
        assert prompt(sid, "STALE_CRASH", id, owner)["data"]["id"] == id
        assert prompt(sid, "REJECT_OLD_TOKEN", mid(), owner)["http"] == 409
        assert "data" in prompt(sid, "probe-after-crash", mid())
        lab.until(lambda: contains("probe-after-crash"))
        lab.until(lambda: lab.idle(sid))
        assert no_pending(sid, id) and not contains("STALE_CRASH")
        log = f"/api/experimental/session/{sid}/log"
        with urlopen(lab.request(log), timeout=10) as events:
            journal = events.read()
        assert b"log.synced" in journal and b"STALE_CRASH" not in journal
        db_path = root / "data/opencode/opencode.db"
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
            assert db.execute("SELECT count(*) FROM event WHERE aggregate_id=?", (sid,)).fetchone()[0] == 1
        assert lab.api(f"/api/session/{sid}", method="DELETE")["http"] == 204
        assert lab.api(f"/api/session/{sid}/steering?messageID={id}")["http"] == 404
        with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
            assert db.execute("SELECT count(*) FROM event WHERE aggregate_id=?", (sid,)).fetchone()[0] == 0
        checks.append("SIGKILL recovery, durable readback, no stale delivery and Session deletion")
        (root / "qualification.json").write_text(json.dumps(checks, indent=2) + "\n")
        print("\n".join(checks), flush=True)
    finally:
        for _, release in lab.model.barriers.values():
            release.set()
        lab.stop()
        lab.model.shutdown()
        lab.model.server_close()
        (root / "provider-input.json").write_text(json.dumps(lab.model.inputs, indent=2))


if __name__ == "__main__":
    main()
