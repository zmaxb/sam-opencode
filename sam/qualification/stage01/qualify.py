"""Exercise Stage 01 in disposable OpenCode directories using the Stage 00 fixture model."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import runpy
import tempfile
from threading import Barrier, Thread
from urllib.parse import urlencode
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
Lab = runpy.run_path(str(HERE.parent / "stage00/probe.py"))["Lab"]
CONTROL = "sam.opencode-shell-report-control/v1"
KEY = "opencodeShellReport"


def digest(text):
    return sha256(text.encode()).hexdigest()


class Study(Lab):
    def start(self, handoff=None):
        super().start(handoff)
        self.record("engine", info=self.api("/api/info"), serverPID=self.process.pid)

    def launch_controlled(self, marker, *calls):
        self.model.cases[marker] = calls
        created = self.api("/api/session", {
            "title": marker, "location": {"directory": str(self.workspace)},
            "metadata": {"sam": {"shellReportControl": CONTROL}},
        })
        sid = created["data"]["id"]
        accepted = self.api(f"/api/session/{sid}/prompt", {"text": marker})
        assert "data" in accepted, accepted
        self.record(marker, session=sid, accepted=accepted)
        return sid

    def record(self, name, **values):
        self.observations.setdefault(name, {}).update(values)
        (self.root / "stage01.json").write_text(json.dumps({
            "observations": self.observations,
            "modelRequests": [{k: v for k, v in request.items() if k != "shell"} for request in self.model.requests],
        }, indent=2) + "\n")

    def inbox(self, sid):
        return self.api(f"/api/session/{sid}/inbox")["data"]

    def messages(self, sid):
        return self.transcript(sid)["data"]

    def reports(self, sid):
        return [msg for msg in self.messages(sid) if msg.get("metadata", {}).get("source") == "shell"]

    def held(self, sid, count):
        def read():
            assert not self.reports(sid), "Unreleased shell report was promoted"
            items = [msg for msg in self.inbox(sid) if msg.get("payload", {}).get("metadata", {}).get(KEY, {}).get("held")]
            return items if len(items) == count else None
        return self.until(read)

    def launch_record(self, sid, count):
        def read():
            jobs = self.jobs(sid)
            messages = self.messages(sid)
            calls = [(msg["id"], part) for msg in messages for part in msg.get("content", [])
                     if part.get("name") == "shell" and part.get("state", {}).get("metadata", {}).get("shellID")]
            if len(jobs) != count or len(calls) != count:
                return None
            result = {}
            for mid, part in calls:
                state = part["state"]
                shell_id = state["metadata"]["shellID"]
                shell = self.shell(shell_id)["data"]
                assert any(job["id"] == job["shellID"] == shell_id for job in jobs)
                result[shell["command"].split(".starts")[0].split()[-1]] = {
                    "shell": shell, "part": part, "request": {
                        "sessionID": sid, "assistantMessageID": mid, "callID": part["id"],
                        "commandDigest": digest(shell["command"]),
                    }
                }
            return result
        return self.until(read)

    def stop_route(self, shell_id):
        return f"/api/experimental/shell/{shell_id}/stop?" + urlencode({"location[directory]": self.workspace})

    def request_stop(self, launch):
        return self.api(self.stop_route(launch["shell"]["id"]), launch["request"])

    def terminal(self, launch):
        def read():
            data = self.shell(launch["shell"]["id"]).get("data")
            return data if data and data["status"] != "running" else None
        return self.until(read)

    def release(self, sid, notification_id):
        return self.api(f"/api/experimental/session/{sid}/shell-report/{notification_id}/release", method="POST")

    def bind(self, sid, notification_id, content_digest):
        return self.api(f"/api/session/{sid}", {"metadata": {"sam": {
            "shellReportControl": CONTROL, "operation": "fixture-accepted-run",
            "inputId": notification_id, "inputDigest": content_digest,
        }}}, method="PATCH")

    def open_gate(self, name):
        (self.workspace / f"{name}.gate").touch()

    def file_facts(self, name):
        return self.fixture_files(name)


def process_state(pid):
    try:
        return (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()[0]
    except FileNotFoundError:
        return "absent"


def guard_only(lab):
    case = "probe-plugin-only"
    sid = lab.launch_controlled(case, lab.call("guard"))
    launch = lab.launch_record(sid, 1)["guard"]
    lab.until(lambda: lab.idle(sid))
    before = len(lab.model.requests)
    lab.open_gate("guard")
    terminal = lab.terminal(launch)
    report = lab.until(lambda: lab.reports(sid))[0]
    route = "/api/rpc/stage01-shell-fixture/inspect?" + urlencode({"location[directory]": lab.workspace})
    blocked = lab.until(lambda: (value if (value := lab.api(route, {"input": {}})).get("output", {}).get("blockedRequests") else None))
    assert len(lab.model.requests) == before
    lab.record(case, launch=launch, terminal=terminal, delivered=report, guard=blocked,
               requests_before=before, requests_after=len(lab.model.requests), transcript=lab.messages(sid))


def controlled_notifications(lab):
    # The provider continuation is blocked after the original tool result. Finish a process at that boundary.
    case = "probe-active-stop"
    sid = lab.launch_controlled(case, lab.call("noticeone"), lab.call("noticetwo", exit_code=7))
    launches = lab.launch_record(sid, 2)
    lab.model.blocked.wait()
    lab.open_gate("noticeone")
    first = lab.held(sid, 1)[0]
    before_unblock = len(lab.model.requests)
    lab.model.release.set()
    lab.until(lambda: lab.idle(sid))
    lab.open_gate("noticetwo")
    reports = lab.held(sid, 2)
    assert before_unblock <= len(lab.model.requests)
    before = len(lab.model.requests)
    for report in reports:
        payload = report["payload"]
        proof = payload["metadata"][KEY]
        name = next(name for name, launch in launches.items() if launch["shell"]["id"] == payload["metadata"]["jobID"])
        assert report["delivery"] == "queue" and report["id"] == proof["notificationID"]
        assert proof["origin"] == {k: v for k, v in launches[name]["request"].items() if k != "commandDigest"}
        assert proof["commandDigest"] == launches[name]["request"]["commandDigest"]
        assert proof["sha256"] == digest(payload["text"])
    assert len({item["id"] for item in reports}) == 2 and first in reports
    denied = lab.release(sid, first["id"])
    steer = lab.api(f"/api/session/{sid}/inbox/{first['id']}", {"delivery": "steer"}, "PATCH")
    assert denied.get("http") == steer.get("http") == 409
    assert lab.bind(sid, first["id"], "0" * 64)["http"] == 204
    wrong_hash = lab.release(sid, first["id"])
    assert wrong_hash["http"] == 409
    # A normal model turn is an ordering barrier. It must not promote either held item.
    assert "data" in lab.api(f"/api/session/{sid}/prompt", {"text": "probe-ordinary-before"})
    lab.until(lambda: any(m.get("text") == "probe-ordinary-before" for m in lab.messages(sid)))
    lab.until(lambda: lab.idle(sid))
    assert lab.held(sid, 2) == reports and len(lab.model.requests) == before + 1
    previous = lab.process.pid
    lab.stop()
    lab.start()
    assert lab.held(sid, 2) == reports
    proof = first["payload"]["metadata"][KEY]
    assert lab.bind(sid, first["id"], proof["sha256"])["http"] == 204
    other = next(item for item in reports if item["id"] != first["id"])
    wrong_id = lab.release(sid, other["id"])
    assert wrong_id["http"] == 409

    # Public synthetic routes may admit ordinary input. They must not mint a releasable proof.
    forged = lab.api(f"/api/session/{sid}/synthetic", {
        "text": first["payload"]["text"], "metadata": first["payload"]["metadata"], "resume": False,
    })["data"]
    assert "origin" not in forged["payload"]["metadata"][KEY]
    assert lab.bind(sid, forged["id"], digest(forged["payload"]["text"]))["http"] == 204
    forged_release = lab.release(sid, forged["id"])
    assert forged_release["http"] == 409
    assert lab.bind(sid, first["id"], proof["sha256"])["http"] == 204

    before_release = len(lab.model.requests)
    released = lab.release(sid, first["id"])
    assert released["http"] == 204
    lab.until(lambda: len(lab.model.requests) > before_release and lab.reports(sid))
    lab.until(lambda: lab.idle(sid))
    repeated = lab.release(sid, first["id"])
    assert repeated["http"] == 204
    assert "data" in lab.api(f"/api/session/{sid}/prompt", {"text": "probe-ordinary-after"})
    lab.until(lambda: any(m.get("text") == "probe-ordinary-after" for m in lab.messages(sid)))
    lab.until(lambda: lab.idle(sid))
    assert [msg["id"] for msg in lab.reports(sid)] == [first["id"]]
    assert len(lab.model.requests) == before_release + 2
    assert other in lab.inbox(sid) and forged in lab.inbox(sid)
    lab.record("notifications", session=sid, launches=launches, held=reports,
               first_during_active_request=first, priorPID=previous, newPID=lab.process.pid,
               denied=denied, raw_steer=steer, wrong_digest=wrong_hash, wrong_id=wrong_id,
               forged=forged, forged_release=forged_release,
               exact_release=released, repeated_release=repeated,
               requests_after_hold=before, requests_before_release=before_release,
               requests_after_repeat_and_user_turn=len(lab.model.requests), inbox=lab.inbox(sid), transcript=lab.messages(sid))


def targeted_stop(lab):
    case = "probe-stop-pair"
    sid = lab.launch_controlled(case, lab.call("stopped"), lab.call("survivor"))
    launches = lab.launch_record(sid, 2)
    first, other = launches["stopped"], launches["survivor"]
    lab.until(lambda: lab.idle(sid))
    bad = lab.api(lab.stop_route(first["shell"]["id"]), other["request"])
    assert bad["http"] == 409
    assert lab.shell(first["shell"]["id"])["data"]["status"] == "running"
    ack = lab.request_stop(first)
    end = lab.terminal(first)
    assert ack["data"]["id"] == end["id"] and end["status"] == "killed"
    assert end.get("signal") or "exit" in end
    stopped_pid = lab.until(lambda: (state if (state := process_state(end["pid"])) in ("absent", "Z") else None))
    assert "done" not in lab.file_facts("stopped")
    assert lab.shell(other["shell"]["id"])["data"]["status"] == "running"
    repeated = lab.request_stop(first)
    assert repeated["data"] == end
    lab.open_gate("stopped")
    lab.open_gate("survivor")
    natural = lab.terminal(other)
    late = lab.request_stop(other)
    assert natural["status"] == "exited" and natural["exit"] == 0 and late["data"] == natural
    inbox = lab.held(sid, 2)
    facts = {"stopped": lab.file_facts("stopped"), "survivor": lab.file_facts("survivor")}
    assert "gate" in facts["stopped"] and "done" not in facts["stopped"]
    for label, launch in launches.items():
        assert facts[label]["starts"].splitlines() == [str(launch["shell"]["pid"])]
    capture = lab.shell(end["id"], output=True)
    assert "stopped-out\nstopped-err" in capture["data"]["output"]
    assert lab.shell(end["id"], method="DELETE")["http"] == 204
    missing = lab.request_stop(first)
    assert missing["http"] == 409 and lab.shell(end["id"])["http"] == 404
    assert lab.inbox(sid) == inbox
    lab.record(case, launches=launches, wrong_call=bad, ack=ack, stopped=end, stopped_pid_state=stopped_pid, repeated=repeated,
               naturally_exited=natural, stop_after_exit=late, retained_output=capture, missing=missing,
               read_missing=lab.shell(end["id"]), held=inbox, files=facts)


def launch_window(lab):
    case = "probe-stop-launch-window"
    sid = lab.launch_controlled(case, lab.call("startwindow"))
    lab.until(lambda: (lab.workspace / "startwindow.entered").exists())
    try:
        assert not lab.jobs(sid) and not lab.file_facts("startwindow").get("starts")
        cut = lab.api(f"/api/session/{sid}/interrupt?resume=false", method="POST")
        assert cut["interrupted"] is True
    finally:
        (lab.workspace / "startwindow.release").touch()
    lab.until(lambda: lab.idle(sid))
    files = lab.file_facts("startwindow")
    assert "done" not in files and len(files.get("starts", "").splitlines()) <= 1
    lab.record(case, stop_before_job_binding=cut, files=files, jobs=lab.jobs(sid), transcript=lab.messages(sid))


def finish_race(lab):
    case = "probe-stop-finish-race"
    sid = lab.launch_controlled(case, lab.call("finishrace", exit_code=7))
    row = lab.launch_record(sid, 1)["finishrace"]
    lab.until(lambda: lab.idle(sid))
    ready = Barrier(2)

    def release_gate():
        ready.wait()
        lab.open_gate("finishrace")

    worker = Thread(target=release_gate)
    worker.start()
    ready.wait()
    ack = lab.request_stop(row)
    worker.join()
    outcome = lab.terminal(row)
    assert outcome["status"] in ("killed", "exited")
    if outcome["status"] == "exited":
        assert outcome["exit"] == 7 and lab.file_facts("finishrace")["done"] == "finishrace-done\n"
    assert lab.request_stop(row)["data"] == outcome
    lab.record(case, launch=row, ack=ack, terminal=outcome, held=lab.held(sid, 1), files=lab.file_facts("finishrace"))


def disconnect_and_restart(lab):
    case = "probe-stop-restart"
    call = lab.call("restartstop")
    call["command"] = "trap '' TERM; " + call["command"]
    sid = lab.launch_controlled(case, call)
    row = lab.launch_record(sid, 1)["restartstop"]
    lab.until(lambda: "starts" in lab.file_facts("restartstop"))
    lab.until(lambda: lab.idle(sid))
    shell_id = row["shell"]["id"]
    with urlopen(lab.request(lab.stop_route(shell_id), row["request"])) as response:
        headers_seen = response.status
    before = lab.shell(shell_id)
    handoff = lab.api("/api/experimental/persistent-pty/handoff", method="POST").get("handoff")
    assert handoff
    previous = lab.process.pid
    lab.stop()
    lab.start(handoff)
    readback = lab.terminal(row)
    inbox = lab.held(sid, 1)
    assert before["data"]["status"] == "running" and readback["status"] == "killed"
    assert row["shell"]["pid"] == readback["pid"]
    stopped_pid = lab.until(lambda: (state if (state := process_state(readback["pid"])) in ("absent", "Z") else None))
    assert len(lab.file_facts("restartstop")["starts"].splitlines()) == 1
    assert "done" not in lab.file_facts("restartstop")
    lab.record(case, launch=row, disconnected_after_response_headers=headers_seen, before=before,
               priorPID=previous, newPID=lab.process.pid, terminal=readback, stopped_pid_state=stopped_pid,
               held=inbox, files=lab.file_facts("restartstop"))


def missing_after_restart(lab):
    case = "probe-missing-restart"
    sid = lab.launch_controlled(case, lab.call("missing"))
    row = lab.launch_record(sid, 1)["missing"]
    before = lab.process.pid
    lab.until(lambda: lab.idle(sid))
    lab.stop()
    lab.start()
    missing = lab.shell(row["shell"]["id"])
    report = lab.held(sid, 1)[0]
    proof = report["payload"]["metadata"][KEY]
    assert missing["http"] == 404 and proof.get("terminal") is None
    assert lab.bind(sid, report["id"], proof["sha256"])["http"] == 204
    release = lab.release(sid, report["id"])
    assert release["http"] == 409
    assert lab.request_stop(row)["http"] == 409
    lab.record(case, launch=row, priorPID=before, newPID=lab.process.pid, missing_shell=missing,
               held=report, denied_release=release, files=lab.file_facts("missing"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--plugin-only", action="store_true", help="Exercise the unmodified engine and request guard")
    parser.add_argument("--plain", action="store_true", help="Exercise the candidate in ordinary serve mode")
    args = parser.parse_args()
    if args.plain and args.plugin_only:
        parser.error("--plain applies to the candidate only")
    root = Path(tempfile.mkdtemp(prefix="opencode-stage01-"))
    print(root, flush=True)
    lab = Study(args.binary, root, False, HERE / "fixture-plugin", not (args.plugin_only or args.plain))
    try:
        lab.start()
        if args.plugin_only:
            guard_only(lab)
        else:
            controlled_notifications(lab)
            targeted_stop(lab)
            launch_window(lab)
            finish_race(lab)
            if not args.plain:
                disconnect_and_restart(lab)
                missing_after_restart(lab)
    finally:
        lab.model.release.set()
        (lab.workspace / "startwindow.release").touch()
        if lab.process and lab.process.poll() is None:
            for observation in lab.observations.values():
                if sid := observation.get("session"):
                    lab.api(f"/api/session/{sid}", method="DELETE")
        lab.stop()
        lab.model.shutdown()
        lab.model.server_close()


if __name__ == "__main__":
    main()
