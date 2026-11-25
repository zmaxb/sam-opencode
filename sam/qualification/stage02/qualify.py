"""Qualify the C# provider and Plugin against the patched OpenCode binary."""
import argparse
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
from urllib.parse import urlencode
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
Lab = runpy.run_path(str(HERE.parent / "stage00/probe.py"))["Lab"]
NAMESPACE = "stage02-fixture"
CONTROL = "sam.opencode-shell-report-control/v1"
KEY = "opencodeShellReport"


def digest(value):
    return sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def arguments_digest(args):
    directory = digest(args["workdir"]) if "workdir" in args else "-"
    timeout = str(args.get("timeout", "-"))
    background = str(args["background"]).lower() if "background" in args else "-"
    return digest(f'{digest(args["command"])}:{directory}:{timeout}:{background}')


class Suite(Lab):
    def __init__(self, binary, root, driver, managed=False):
        super().__init__(binary, root, False, ROOT / "tools/opencode/context", managed)
        self.driver = driver
        self.proofs = {}
        self.key_path = root / "signer.pem"
        self.key_path.touch(mode=0o600)
        with self.key_path.open("wb") as pem:
            subprocess.run(["openssl", "genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"],
                           stdout=pem, check=True)
        public = subprocess.check_output(["openssl", "pkey", "-in", self.key_path, "-pubout", "-outform", "DER"])
        self.env.update(SAM_OPENCODE_BACKGROUND_AUDIENCE=NAMESPACE,
                        SAM_OPENCODE_BACKGROUND_PUBLIC_KEY=base64.b64encode(public).decode())
        self.target = {"connectionId": str(uuid4())}

    def probe(self, action, **kwargs):
        data = {"action": action, "url": f"http://127.0.0.1:{self.port}/", "directory": str(self.workspace), **kwargs}
        result = subprocess.run(["dotnet", self.driver], input=json.dumps(data), text=True, capture_output=True,
                                env={**os.environ, "PROBE_PASSWORD": self.password, "PROBE_SIGNER": str(self.key_path)})
        if result.returncode:
            raise RuntimeError(result.stderr)
        return json.loads(result.stdout)

    def rpc(self, method, data):
        q = urlencode({"location[directory]": self.workspace})
        return self.api(f"/api/rpc/sam-opencode-context/{method}?{q}", {"input": data})

    def check(self, test, facts):
        self.proofs[test] = facts
        (self.root / "qualification.json").write_text(json.dumps(self.proofs, indent=2) + "\n")
        print(test, flush=True)

    def capability(self):
        capability = self.probe("inspect")
        assert capability and capability["backendNamespace"] == NAMESPACE and capability["directory"] == str(self.workspace)
        self.target["capability"] = capability
        return capability

    def scenario(self, case, *commands, controlled=True):
        message = "msg_" + uuid4().hex
        operation = str(uuid4())
        self.model.cases[case] = commands
        metadata = {"samBackground": {"contract": CONTROL, "inputId": message, "operation": operation}} if controlled else {}
        sid = self.api("/api/session", {"title": case, "location": {"directory": str(self.workspace)},
                                      "metadata": metadata})["data"]["id"]
        result = self.api(f"/api/session/{sid}/prompt", {"id": message, "text": case})
        assert result["data"]["id"] == message
        return sid, message, operation

    def launched(self, case, commands, controlled=True):
        sid, message, operation = self.scenario(case, *commands, controlled=controlled)

        def completed_parts():
            transcript = self.transcript(sid)["data"]
            parts = [(msg["id"], part) for msg in transcript for part in msg.get("content", [])
                     if part.get("name") == "shell" and part.get("state", {}).get("status") == "completed"]
            return parts if len(parts) == len(commands) else None

        jobs = []
        for assistant, part in self.until(completed_parts):
            arguments = part["state"]["input"]
            call = {"target": deepcopy(self.target), "operation": operation, "sessionId": sid, "inputId": message,
                    "assistantMessageId": assistant, "callId": part["id"],
                    "argumentsDigest": arguments_digest(arguments),
                    "commandDigest": digest(arguments["command"])}
            if controlled:
                state = self.probe("launch", call=call)
                if not state or not state["observation"]["launchConfirmed"]:
                    shell_id = part["state"].get("metadata", {}).get("shellID")
                    self.observations.setdefault(case, {})
                    self.record(case, launch_failure={
                        "call": call, "provider": state, "native": self.rpc("background-read", {"shellId": shell_id}),
                        "input": self.api(f"/api/session/{sid}/message/{message}"),
                        "assistant": self.api(f"/api/session/{sid}/message/{assistant}"),
                    })
                    raise AssertionError(f"Launch attribution was not confirmed; see {self.root / 'observations.json'}")
            else:
                result = self.probe("launch", call=call)
                assert result is None
                state = {"call": call, "tool": part, "passiveClassification": result}
            jobs.append(state)
        return sid, jobs

    def state(self, job, expected):
        def readback():
            value = self.probe("read", job=job)
            state = value["process"]["state"]
            if state in ("Unavailable", "ConflictingEvidence"):
                raise AssertionError((value, self.rpc("background-read", {"shellId": job["shellId"]})))
            return value if state == expected else None
        return self.until(readback)

    def held(self, job):
        def readback():
            value = self.probe("reports", job=job)
            if value["state"] == "ConflictingEvidence":
                raise AssertionError(value)
            return value["items"][0] if value["state"] == "Held" else None
        return self.until(readback)

    def grant(self, job, action, notification=None, fence=1, owner="fixture-owner"):
        return {"job": job, "action": action.title(), "ownerId": owner, "ownerFence": fence,
                "expires": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
                "notificationId": notification["id"] if notification else None,
                "notificationDigest": notification["digest"] if notification else None}

    def gate(self, name):
        (self.workspace / (name + ".gate")).touch()


def capabilities(suite, unsupported):
    if unsupported:
        actual = suite.probe("inspect")
        assert actual is None
        suite.check("P28", {"capability": actual, "native": suite.api("/api/info")})
        return
    capability = suite.capability()
    suite.check("P01", capability)
    sid, (legacy,) = suite.launched("probe-legacy", [suite.call("legacy", background=False, gated=False)], controlled=False)
    suite.until(lambda: suite.idle(sid))
    part = legacy["tool"]
    assert part["state"]["metadata"]["status"] == "completed" and (suite.workspace / "legacy.done").exists()
    suite.check("P02", legacy)
    suite.check("P25", {"foreground": part, "fixture": suite.fixture_files("legacy")})


def paired(suite):
    arguments = suite.call("pair")
    sid, records = suite.launched("probe-active-stop", [arguments, arguments])
    suite.model.blocked.wait()
    jobs = [record["job"] for record in records]
    a, b = jobs
    assert a["shellId"] != b["shellId"] and a["call"]["callId"] != b["call"]["callId"]
    assert a["call"]["argumentsDigest"] == b["call"]["argumentsDigest"] and a["call"]["commandDigest"] == b["call"]["commandDigest"]
    assert suite.probe("launch", call=a["call"], legacyClient=True) is None
    wrong_connection = suite.probe("read", job=a, connectionOverride=str(uuid4()))
    assert wrong_connection["process"]["state"] == "ConflictingEvidence"
    suite.check("P03", {"launches": records, "legacyClientLaunch": None, "wrongConnection": wrong_connection})
    suite.check("P04", jobs)
    states = [suite.state(job, "Running") for job in jobs]
    assert all(state["nativeJobStatus"] == "running" for state in states)
    suite.check("P05", states)
    suite.check("P06", {"process": states[0], "captureWhileRunning": suite.probe("capture", job=a)})
    suite.until(lambda: len(suite.fixture_files("pair").get("starts", "").splitlines()) == 2)
    failed = suite.probe("stop", grant=suite.grant(a, "stop"), unsigned=True)
    fake_delete = suite.shell(a["shellId"], method="DELETE")
    raw_path = f"/api/experimental/shell/{a['shellId']}/stop?" + urlencode({"location[directory]": suite.workspace})
    raw = suite.api(raw_path, {})
    delete_session = suite.api(f"/api/session/{sid}", method="DELETE")
    assert failed.get("error") and fake_delete["http"] == delete_session["http"] == 409 and raw["http"] == 404
    assert suite.state(a, "Running")["launchConfirmed"]

    wrong = deepcopy(a)
    wrong["call"]["callId"] = b["call"]["callId"]
    mismatch = suite.probe("stop", grant=suite.grant(wrong, "stop"))
    assert mismatch.get("error") and suite.probe("read", job=wrong)["process"]["state"] == "ConflictingEvidence"
    grant = suite.grant(a, "stop", fence=2)
    accepted = suite.probe("stop", grant=grant)
    assert accepted["shellId"] == a["shellId"]
    stop = suite.state(a, "Killed")
    assert stop["process"]["signal"] or stop["process"]["exitCode"] is not None
    output = suite.probe("page", job=a, cursor=0, limit=200)
    assert b"pair-out\npair-err\n" in base64.b64decode(output["bytes"])
    suite.check("P19", {"accepted": accepted, "terminal": stop, "page": output})
    remains = suite.state(b, "Running")
    assert remains["launchConfirmed"]
    suite.check("P20", remains)
    repeat = suite.probe("stop", grant=grant)
    stale = suite.probe("stop", grant=suite.grant(a, "stop"))
    assert repeat["process"] == stop["process"] and stale.get("error")
    suite.check("P21", {"idempotent": repeat, "staleFence": stale, "wrongCall": mismatch})
    while_active = suite.held(a)
    assert not any(msg.get("metadata", {}).get("source") == "shell" for msg in suite.transcript(sid)["data"])
    suite.model.release.set()
    suite.until(lambda: suite.idle(sid))
    suite.gate("pair")
    natural = suite.state(b, "Exited")
    assert natural["process"]["exitCode"] == 0
    assert len((suite.workspace / "pair.starts").read_text().splitlines()) == 2
    suite.check("P07", natural)
    return sid, a, b, {"unsignedStop": failed, "rawShellDelete": fake_delete, "rawSessionDelete": delete_session, "rawStop": raw, "heldDuringActiveTurn": while_active}


def notifications(suite, sid, a, b, authority_checks):
    held = suite.held(b)
    other = suite.held(a)
    transcript = suite.transcript(sid)["data"]
    assert not any(msg.get("metadata", {}).get("source") == "shell" for msg in transcript)
    suite.until(lambda: suite.idle(sid))
    provider_count = len(suite.model.requests)
    assert held["id"] != other["id"] and held["process"]["exitCode"] == 0
    suite.check("P12", {"held": held, "other": other, "requests": provider_count,
                        "heldDuringActiveTurn": authority_checks.pop("heldDuringActiveTurn")})
    release = suite.grant(b, "release", held, fence=2)
    unsigned = suite.probe("release", grant=release, unsigned=True)
    steer = suite.api(f"/api/session/{sid}/inbox/{held['id']}", {"delivery": "steer"}, "PATCH")
    raw = suite.api(f"/api/experimental/session/{sid}/shell-report/{held['id']}/release", method="POST")
    assert unsigned.get("error") and steer["http"] == 409 and raw["http"] == 404
    suite.check("P13", {**authority_checks, "unsignedRelease": unsigned, "rawSteer": steer, "rawRelease": raw})

    crossed = suite.probe("release", grant=suite.grant(b, "release", other, fence=2))
    missing = suite.probe("reports", job=b, notificationId="msg_" + uuid4().hex)
    wrong_session_grant = deepcopy(release)
    wrong_session_grant["job"]["call"]["sessionId"] = "ses_" + uuid4().hex
    wrong_session = suite.probe("release", grant=wrong_session_grant)
    assert crossed.get("error") and wrong_session.get("error") and missing["state"] == "Missing"
    suite.check("P14", {"crossed": crossed, "wrongSession": wrong_session, "missing": missing})
    wrong = deepcopy(release)
    wrong["notificationDigest"] = "0" * 64
    mismatch = suite.probe("release", grant=wrong)
    assert mismatch.get("error")
    suite.check("P15", mismatch)

    stored = next(item for item in suite.api(f"/api/session/{sid}/inbox")["data"] if item["id"] == held["id"])
    forged = suite.api(f"/api/session/{sid}/synthetic", {
        "text": stored["payload"]["text"], "metadata": stored["payload"]["metadata"], "resume": False,
    })["data"]
    proof = forged["payload"]["metadata"][KEY]
    forged_reply = suite.probe("release", grant=suite.grant(b, "release",
                               {"id": forged["id"], "digest": proof["sha256"]}, fence=2))
    assert "origin" not in proof and forged_reply.get("error")
    suite.check("P16", {"id": forged["id"], "metadata": forged["payload"]["metadata"], "rejected": forged_reply})

    # A native credential can write Session metadata but cannot turn that write into a release grant.
    patched_metadata = {"samBackground": {"contract": CONTROL, "inputId": held["id"],
                                "inputDigest": held["digest"], "operation": "fabricated"}}
    assert suite.api(f"/api/session/{sid}", {"metadata": patched_metadata}, "PATCH")["http"] == 204
    exact = suite.probe("reports", job=b, notificationId=held["id"])
    ambiguous = suite.probe("reports", job=b)
    assert exact["state"] == "Held" and ambiguous["state"] == "ConflictingEvidence"
    assert len(suite.model.requests) == provider_count
    accepted = suite.probe("release", grant=release)
    assert accepted["notificationId"] == held["id"]
    suite.until(lambda: len(suite.model.requests) > provider_count)
    suite.until(lambda: suite.idle(sid))
    consumed = suite.probe("reports", job=b, notificationId=held["id"])
    assert consumed["state"] == "Consumed" and len(suite.model.requests) == provider_count + 1
    suite.check("P17", {"accepted": accepted, "consumed": consumed, "requests": len(suite.model.requests)})
    repeat = suite.probe("release", grant=release)
    assert repeat["notificationId"] == held["id"]
    assert "data" in suite.api(f"/api/session/{sid}/prompt", {"text": "probe-duplicate-barrier"})
    suite.until(lambda: any(msg.get("text") == "probe-duplicate-barrier" for msg in suite.transcript(sid)["data"]))
    suite.until(lambda: suite.idle(sid))
    transcript = suite.transcript(sid)["data"]
    assert len(suite.model.requests) == provider_count + 2
    assert [msg["id"] for msg in transcript if msg.get("metadata", {}).get("source") == "shell"] == [held["id"]]
    suite.check("P18", {"repeat": repeat, "requestDeltaWithUserBarrier": len(suite.model.requests)-provider_count,
                        "projected": held["id"]})

    claimed_id = "msg_" + uuid4().hex
    claimed_metadata = deepcopy(stored["payload"]["metadata"])
    claimed_metadata[KEY]["notificationID"] = claimed_id
    claimed_metadata[KEY]["sha256"] = digest("probe-user-evidence-copy")
    ordinary = suite.api(f"/api/session/{sid}/prompt", {
        "id": claimed_id, "text": "probe-user-evidence-copy", "metadata": claimed_metadata,
    })
    assert "data" in ordinary
    suite.until(lambda: any(m["id"] == claimed_id for m in suite.transcript(sid)["data"]))
    typed_user = suite.probe("reports", job=b, notificationId=claimed_id)
    assert typed_user == {"state": "ConflictingEvidence", "items": []}
    suite.check("P16", {**suite.proofs["P16"], "forgedUserEvidence": typed_user})


def results(suite):
    _, (failed,) = suite.launched("probe-nonzero", [suite.call("nonzero", exit_code=7)])
    job = failed["job"]
    suite.gate("nonzero")
    terminal = suite.state(job, "Exited")
    assert terminal["process"]["exitCode"] == 7
    suite.check("P08", terminal)

    _, (timed,) = suite.launched("probe-timeout", [suite.call("timed", timeout=3000)])
    timeout = suite.state(timed["job"], "TimedOut")
    assert "signal" in timeout["process"] and "done" not in suite.fixture_files("timed")
    suite.check("P09", {"timeout": timeout, "killed": suite.proofs["P19"]["terminal"]})

    raw = suite.call("capture")
    raw["command"] = raw["command"].replace("echo capture-out; echo capture-err >&2;",
        r"printf '\360\237\230\200'; head -c 74000 /dev/zero | tr '\000' x; printf end >&2;")
    _, (large,) = suite.launched("probe-capture", [raw])
    job = large["job"]
    suite.gate("capture")
    suite.state(job, "Exited")
    first = suite.probe("page", job=job, cursor=0, limit=1)
    second = suite.probe("page", job=job, cursor=1, limit=3)
    expected = "😀".encode() + b"x" * 74000 + b"end"
    assert base64.b64decode(first["bytes"]) + base64.b64decode(second["bytes"]) == expected[:4]
    capture = suite.probe("capture", job=job)
    assert capture == {"size": len(expected), "sha256": digest(expected)}
    suite.check("P10", {"first": first, "second": second, "capture": capture})
    held = suite.held(job)
    assert held["previewTruncated"] and held["digest"] != capture["sha256"]
    suite.check("P11", {"previewTruncated": held["previewTruncated"], "notificationDigest": held["digest"], "capture": capture})
    assert suite.proofs["P06"]["captureWhileRunning"]["sha256"] is None
    assert set(terminal) == {"process", "nativeJobStatus", "launchConfirmed"}
    suite.check("P30", {"observedFields": list(terminal), "runningCapture": suite.proofs["P06"]["captureWhileRunning"],
                         "binding": job["call"], "capture": capture})


def restart(suite, managed):
    suite.capability()
    _, (running,) = suite.launched("probe-restart", [suite.call("restart")])
    job = running["job"]
    before = suite.state(job, "Running")
    shell_id = job["shellId"]
    original = suite.shell(shell_id)["data"]
    if managed:
        handoff = suite.api("/api/experimental/persistent-pty/handoff", method="POST")["handoff"]
        assert handoff
    else:
        handoff = None
    old_pid = suite.process.pid
    suite.stop()
    suite.start(handoff)
    suite.until(lambda: suite.rpc("inspect", {}).get("output", {}).get("backgroundJobs"))
    changed = suite.probe("read", job=job)
    assert changed["process"]["state"] == "EpochChanged"
    rejected = suite.probe("stop", grant=suite.grant(job, "stop"))
    assert rejected.get("error")
    rebound = deepcopy(job)
    rebound["call"]["target"]["capability"] = suite.capability()
    if managed:
        still_running = suite.state(rebound, "Running")
        same = suite.shell(shell_id)["data"]
        assert original["pid"] == same["pid"]
        suite.gate("restart")
        end = suite.state(rebound, "Exited")
        notice = suite.held(rebound)
        assert end["process"]["exitCode"] == 0 and notice["process"] == end["process"]
        assert (suite.workspace / "restart.starts").read_text().splitlines() == [str(same["pid"])]
        suite.check("P24", {"oldPID": old_pid, "serverPID": suite.process.pid, "shellPID": same["pid"],
                           "oldEpoch": changed, "oldGrantRejected": rejected, "afterHandoff": still_running, "held": notice})
    else:
        missing = suite.probe("read", job=rebound)
        assert missing["process"]["state"] in ("StaleJob", "MissingShell") and not missing["launchConfirmed"]
        assert suite.probe("capture", job=rebound) is None
        raw = suite.shell(shell_id)
        assert raw["http"] == 404
        suite.check("P22", {"raw": raw, "provider": missing})
        suite.check("P23", {"initial": before, "oldPID": old_pid, "serverPID": suite.process.pid,
                           "oldEpoch": changed, "oldGrantRejected": rejected, "freshRead": missing})


def existing_permissions(suite):
    case = "probe-native-denied"
    suite.model.cases[case] = [suite.call("denied", gated=False, background=False)]
    sid = suite.api("/api/session", {
        "location": {"directory": str(suite.workspace)},
        "permissions": [{"action": "shell", "resource": "*", "effect": "deny"}],
    })["data"]["id"]
    suite.api(f"/api/session/{sid}/prompt", {"text": case})
    suite.until(lambda: suite.idle(sid))
    messages = suite.transcript(sid)["data"]
    assert not suite.fixture_files("denied")
    refused = any(part.get("name") == "shell" and part.get("state", {}).get("status") == "error"
                  for message in messages for part in message.get("content", []))
    tools_offered = [r["shell"] is not None for r in suite.model.requests if r["case"] == case]
    assert refused or tools_offered and not any(tools_offered)
    suite.check("P27", {"session": sid, "transcript": messages, "shellOffered": tools_offered, "fixtureFiles": {}})



def native_access_boundary(suite):
    sentinel = Path(suite.env["XDG_STATE_HOME"]) / "background-authority-fixture"
    sentinel.write_text("isolated-native-state\n")
    location = urlencode({"location[directory]": suite.workspace})
    reply = suite.api(f"/api/shell?{location}", {
        "command": "id -u; cat ../state/background-authority-fixture", "cwd": str(suite.workspace)
    })
    shell_id = reply["data"]["id"]
    suite.until(lambda: suite.shell(shell_id).get("data", {}).get("status") == "exited")
    output = suite.shell(shell_id, output=True)["data"]["output"]
    assert output.splitlines() == [str(os.getuid()), "isolated-native-state"]
    suite.check("NativeAccessBoundary", {"basicCredentialNativeShell": True, "sameUid": True, "fixtureStateReadable": True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("driver", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--mode", choices=("plain", "managed", "unsupported"), default="plain")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="opencode-stage02-"))
    print(root, flush=True)
    suite = Suite(args.binary, root, args.driver, args.mode == "managed")
    try:
        suite.start()
        suite.until(lambda: suite.rpc("inspect", {}).get("output"))
        if args.mode == "managed":
            restart(suite, True)
        else:
            unsupported = args.mode == "unsupported"
            capabilities(suite, unsupported)
            if not unsupported:
                notifications(suite, *paired(suite))
                results(suite)
                existing_permissions(suite)
                native_access_boundary(suite)
                restart(suite, False)
    finally:
        suite.model.release.set()
        for name in ("pair", "timed", "restart", "nonzero", "capture"):
            suite.gate(name)
        suite.stop()
        suite.model.shutdown()
        suite.model.server_close()


if __name__ == "__main__":
    main()
