"""Disposable OpenCode shell experiment. Run with Python 3 and an absolute binary path."""
import argparse
from base64 import b64encode
from contextlib import suppress
from secrets import token_urlsafe
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
from threading import Event, Thread
from time import sleep
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        markers = [m["content"] for m in request["messages"]
                   if m["role"] == "user" and isinstance(m.get("content"), str) and m["content"].startswith("probe-")]
        case = markers[-1].split()[0] if markers else ""
        if case == "probe-active-stop" and any(m["role"] == "tool" for m in request["messages"]):
            self.server.blocked.set()
            self.server.release.wait()
        calls = self.server.cases.get(case)
        has_result = any(m["role"] == "tool" for m in request["messages"])
        shell = next((t for t in request.get("tools", []) if t["function"]["name"] == "shell"), None)
        self.server.requests.append({"case": case, "has_result": has_result, "shell": shell,
                                     "roles": [m["role"] for m in request["messages"]]})
        delta = {"content": "Fixture turn complete."}
        finish = "stop"
        if calls and shell and not has_result:
            delta = {"tool_calls": [
                {"index": i, "id": f"call_{case}_{i}", "type": "function",
                 "function": {"name": "shell", "arguments": json.dumps(args)}}
                for i, args in enumerate(calls)
            ]}
            finish = "tool_calls"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        with suppress(BrokenPipeError, ConnectionResetError):
            self.respond(delta, finish)

    def respond(self, delta, finish):
        self.end_headers()
        for choice in ({"delta": {"role": "assistant", **delta}, "finish_reason": None},
                       {"delta": {}, "finish_reason": finish}):
            event = {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "fixture", "choices": [{"index": 0, **choice}]}
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


class Lab:
    def __init__(self, binary, root, flag, plugin, managed):
        self.binary, self.root, self.managed = binary, root, managed
        self.workspace = root / "workspace"
        self.workspace.mkdir(parents=True)
        self.model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        self.model.cases = {}
        self.model.requests = []
        self.model.blocked = Event()
        self.model.release = Event()
        Thread(target=self.model.serve_forever, daemon=True).start()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.env = {key: os.environ[key] for key in ("PATH", "LANG") if key in os.environ}
        self.password = token_urlsafe(24)
        self.env.update(OPENCODE_PASSWORD=self.password, HOME=str(root / "home"), SHELL=shutil.which("bash"),
                        XDG_RUNTIME_DIR=str(root / "runtime"), TMPDIR=str(root / "tmp"),
                        OPENCODE_DISABLE_MODELS_FETCH="1", OPENCODE_DISABLE_AUTOUPDATE="1",
                        OPENCODE_CONFIG_PROJECT_DISABLE="1")
        for key in ("CONFIG", "CACHE", "DATA", "STATE"):
            self.env[f"XDG_{key}_HOME"] = str(root / key.lower())
        for key in ("HOME", "TMPDIR", "XDG_RUNTIME_DIR"):
            Path(self.env[key]).mkdir(mode=0o700)
        config = {
            "model": "fixture/fixture", "small_model": "fixture/fixture", "default_agent": "build",
            "permission": {"shell": "allow"},
            "provider": {"fixture": {"npm": "@ai-sdk/openai-compatible",
                                     "options": {"baseURL": f"http://127.0.0.1:{self.model.server_port}/v1"},
                                     "models": {"fixture": {"name": "Fixture", "tool_call": True,
                                                            "limit": {"context": 65536, "output": 4096}}}}},
            "experimental": {"shell_timeout_background": flag},
        }
        if managed:
            service = Path(self.env["XDG_CONFIG_HOME"]) / "opencode" / "service.json"
            service.parent.mkdir(parents=True, mode=0o700)
            service.touch(mode=0o600)
            service.write_text(json.dumps({"password": self.password}))
        if plugin:
            local_plugin = root / "plugin"
            shutil.copytree(plugin, local_plugin)
            config["plugins"] = [str(local_plugin)]
        self.env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
        self.observations = {}
        self.process = None

    def start(self, handoff=None):
        with (self.root / "server.log").open("ab") as log:
            self.process = subprocess.Popen(
                [self.binary, "serve", "--hostname", "127.0.0.1", "--port", str(self.port),
                 "--log-level", "warn", *(["--service"] if self.managed else [])], cwd=self.workspace,
                env=self.env if handoff is None else {**self.env, "OPENCODE_PTY_HANDOFF": json.dumps(handoff)},
                stdout=log, stderr=log)
        self.until(lambda: self.api("/api/info").get("version"))

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait()

    def api(self, path, payload=None, method=None):
        request = self.request(path, payload, method)
        try:
            with urlopen(request) as response:
                body = response.read()
                return json.loads(body) if body else {"http": response.status}
        except HTTPError as error:
            return {"http": error.code, "body": error.read().decode()}

    def request(self, path, payload=None, method=None):
        return Request(f"http://127.0.0.1:{self.port}{path}",
                          data=None if payload is None else json.dumps(payload).encode(),
                          headers={"Content-Type": "application/json", "Authorization": "Basic " +
                                   b64encode(f"opencode:{self.password}".encode()).decode()}, method=method)

    def until(self, condition):
        while self.process.poll() is None:
            try:
                result = condition()
                if result:
                    return result
            except URLError:
                pass
            sleep(0.12)
        raise RuntimeError(f"OpenCode exited, see {self.root / 'server.log'}")

    def launch(self, case, *calls):
        self.model.cases[case] = calls
        created = self.api("/api/session", {"title": case, "location": {"directory": str(self.workspace)}})
        sid = created["data"]["id"]
        admitted = self.api(f"/api/session/{sid}/prompt", {"text": case})
        self.observations[case] = {"session": sid, "accepted": admitted}
        if "data" not in admitted:
            raise RuntimeError(admitted)
        return sid

    def jobs(self, sid):
        return self.api(f"/api/experimental/job?sessionID={sid}&kind=shell")["data"]

    def shell(self, shell_id, output=False, method=None, **query):
        location = urlencode({"location[directory]": str(self.workspace), **query})
        suffix = "/output" if output else ""
        return self.api(f"/api/shell/{shell_id}{suffix}?{location}", method=method)

    def transcript(self, sid):
        return self.api(f"/api/session/{sid}/message?order=asc&limit=50")

    def call(self, name, exit_code=0, background=True, timeout=None, gated=True):
        command = f'echo "$$" >> {name}.starts; echo {name}-out; echo {name}-err >&2; '
        if gated:
            command += f"while [ ! -f {name}.gate ]; do sleep 0.1; done; "
        command += f"echo {name}-done > {name}.done; exit {exit_code}"
        result = {"command": command, "description": f"Fixture {name}", "background": background}
        if timeout is not None:
            result["timeout"] = timeout
        return result

    def session(self, sid):
        return self.api(f"/api/session/{sid}")["data"]

    def idle(self, sid):
        state = self.session(sid)
        return state if state.get("time", {}).get("idle", 0) >= state.get("time", {}).get("busy", 1) else None

    def notification(self, sid, shell_id):
        return next((msg for msg in self.transcript(sid).get("data", [])
                     if msg.get("metadata", {}).get("shellID") == shell_id), None)

    def fixture_files(self, name):
        return {p.suffix[1:]: p.read_text() for p in self.workspace.glob(f"{name}.*")}

    def record(self, case, **values):
        self.observations[case].update(values)
        (self.root / "observations.json").write_text(
            json.dumps({"scenarios": self.observations, "model": self.model.requests}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda value: str(Path(value).resolve()))
    parser.add_argument("--timeout-background", action="store_true")
    parser.add_argument("--plugin", type=Path, help="Only inspect a staged copy of the SAM plugin")
    parser.add_argument("--managed", action="store_true", help="Use the isolated OpenCode service lifecycle")
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="opencode-stage00-"))
    print(root, flush=True)
    lab = Lab(args.binary, root, args.timeout_background, args.plugin, args.managed)
    try:
        lab.start()
        info = lab.api("/api/info")
        (root / "info.json").write_text(json.dumps(info, indent=2) + "\n")
        if args.plugin:
            route = "/api/rpc/sam-opencode-context/inspect?" + urlencode({"location[directory]": str(lab.workspace)})
            inspection = lab.until(lambda: lab.api(route, {"input": {}}).get("output"))
            if not inspection.get("nativeTools"):
                sid = lab.launch("probe-plugin-readiness")
                lab.until(lambda: lab.idle(sid))
                after_turn = lab.api(route, {"input": {}}).get("output")
                (root / "inspect-after-turn.json").write_text(json.dumps(after_turn, indent=2) + "\n")
            (root / "inspect.json").write_text(json.dumps(inspection, indent=2) + "\n")
            return

        def running(case, *calls):
            sid = lab.launch(case, *calls)
            jobs = lab.until(lambda: (items if len(items := lab.jobs(sid)) == len(calls) else None))
            assert all(job["status"] == "running" and job["id"] == job["shellID"] for job in jobs)
            lab.record(case, running_jobs=jobs)
            return sid, [job["shellID"] for job in jobs]

        def finish(case, sid, shell_id, filename, code):
            (lab.workspace / f"{filename}.gate").touch()
            shell = lab.until(lambda: (value if (value := lab.shell(shell_id))["data"]["status"] == "exited" else None))
            assert shell["data"]["exit"] == code
            activity = lab.until(lambda: lab.notification(sid, shell_id))
            lab.until(lambda: lab.idle(sid))
            output = lab.shell(shell_id, output=True)
            files = lab.fixture_files(filename)
            assert files["starts"].splitlines() == [str(shell["data"]["pid"])]
            assert files["done"] == f"{filename}-done\n"
            assert f"{filename}-out\n{filename}-err" in output["data"]["output"]
            assert activity["metadata"]["jobID"] == shell_id
            assert activity["metadata"]["exit"] == code
            lab.record(case, terminal=shell, output=output, notification=activity,
                       transcript=lab.transcript(sid), terminal_jobs=lab.jobs(sid),
                       reread=lab.shell(shell_id), files=files)

        if args.timeout_background:
            case = "probe-auto"
            sid, (shell_id,) = running(case, lab.call("auto", background=False, timeout=250))
            lab.until(lambda: lab.idle(sid))
            lab.record(case, transcript_running=lab.transcript(sid), shell_running=lab.shell(shell_id))
            finish(case, sid, shell_id, "auto", 0)
            case = "probe-explicit-deadline"
            sid, (shell_id,) = running(case, lab.call("deadline", timeout=1000))
            notice = lab.until(lambda: lab.notification(sid, shell_id))
            lab.record(case, shell=lab.shell(shell_id), notification=notice, files=lab.fixture_files("deadline"))
        else:
            case = "probe-basic"
            sid, (shell_id,) = running(case, lab.call("basic"))
            idle = lab.until(lambda: lab.idle(sid))
            lab.record(case, transcript_running=lab.transcript(sid), idle=idle,
                       shell_running=lab.shell(shell_id), files_running=lab.fixture_files("basic"))
            interrupt = lab.api(f"/api/session/{sid}/interrupt?resume=false", method="POST")
            lab.record(case, idle_interrupt=interrupt, after_interrupt=lab.shell(shell_id))
            with urlopen(lab.request("/api/event")) as stream:
                event = stream.readline().decode().strip()
            lab.record(case, disconnected_sse=event, after_disconnect=lab.shell(shell_id))
            followup = lab.api(f"/api/session/{sid}/prompt", {"text": "probe-followup"})
            lab.until(lambda: any(msg.get("text") == "probe-followup" for msg in
                                  lab.transcript(sid)["data"]))
            lab.until(lambda: lab.idle(sid))
            lab.record(case, followup=followup, after_followup=lab.shell(shell_id))
            finish(case, sid, shell_id, "basic", 0)
            with urlopen(lab.request("/api/event")) as stream:
                event = stream.readline().decode().strip()
            lab.record(case, reconnected_sse=event)

            for mode in ("restart", "handoff"):
                case = f"probe-{mode}"
                sid, (shell_id,) = running(case, lab.call(mode, exit_code=7))
                lab.until(lambda: lab.idle(sid))
                lab.record(case, transcript_running=lab.transcript(sid), shell_before_restart=lab.shell(shell_id),
                           prior_server_pid=lab.process.pid)
                handoff = None
                if mode == "handoff":
                    handoff = lab.api("/api/experimental/persistent-pty/handoff", method="POST").get("handoff")
                    lab.record(case, handoff_returned=bool(handoff))
                lab.stop()
                lab.start(handoff)
                shell = lab.shell(shell_id)
                lab.record(case, new_server_pid=lab.process.pid, shell_after_restart=shell,
                           jobs_after_restart=lab.jobs(sid), transcript_after_restart=lab.transcript(sid))
                if shell.get("data", {}).get("status") == "running":
                    assert shell["data"]["pid"] == lab.observations[case]["shell_before_restart"]["data"]["pid"]
                    (lab.workspace / f"{mode}.gate").touch()
                    lab.until(lambda: lab.shell(shell_id).get("data", {}).get("status") == "exited")
                    lab.record(case, terminal=lab.shell(shell_id), output=lab.shell(shell_id, output=True))
                lab.record(case, files=lab.fixture_files(mode), jobs_after_process=lab.jobs(sid),
                           inbox_after_process=lab.api(f"/api/session/{sid}/inbox"),
                           transcript_after_process=lab.transcript(sid))

            case = "probe-parallel"
            sid, ids = running(case, lab.call("one"), lab.call("two"))
            lab.until(lambda: lab.idle(sid))
            shells = [lab.shell(shell_id) for shell_id in ids]
            chosen = next(item["data"]["id"] for item in shells if "one.starts" in item["data"]["command"])
            other = next(shell_id for shell_id in ids if shell_id != chosen)
            cancel = lab.api(f"/api/experimental/job/{chosen}/cancel", method="POST")
            proc = Path("/proc") / str(next(item["data"]["pid"] for item in shells if item["data"]["id"] == chosen))
            if cancel.get("http") == 204:
                lab.until(lambda: lab.shell(chosen).get("data", {}).get("status") == "killed")
                removed = None
            else:
                removed = lab.shell(chosen, method="DELETE")
            missing = lab.shell(chosen)
            gone = lab.until(lambda: not proc.exists() or ") Z " in (proc / "stat").read_text())
            assert gone and "done" not in lab.fixture_files("one")
            lab.record(case, shells=shells, job_cancel=cancel, shell_delete=removed, cancelled_shell_read=missing, chosen_pid_stopped=gone,
                       surviving_shell=lab.shell(other), deleted_files=lab.fixture_files("one"))
            finish(case, sid, other, "two", 0)

            case = "probe-active-stop"
            sid, (shell_id,) = running(case, lab.call("active"))
            lab.model.blocked.wait()
            stop = lab.api(f"/api/session/{sid}/interrupt?resume=false", method="POST")
            lab.model.release.set()
            state = lab.until(lambda: lab.idle(sid))
            lab.record(case, stop=stop, idle=state, shell_after_stop=lab.shell(shell_id))
            if lab.shell(shell_id).get("data", {}).get("status") == "running":
                finish(case, sid, shell_id, "active", 0)

            case = "probe-exit-seven"
            sid, (shell_id,) = running(case, lab.call("nonzero", exit_code=7))
            finish(case, sid, shell_id, "nonzero", 7)

            case = "probe-large"
            large = lab.call("large")
            large["command"] = large["command"].replace("echo large-out;", "seq 1 3000; echo large-out;")
            sid, (shell_id,) = running(case, large)
            finish(case, sid, shell_id, "large", 0)
            full = lab.shell(shell_id, output=True)["data"]
            page = lab.shell(shell_id, output=True, cursor=0, limit=64)["data"]
            assert page["cursor"] == 64 < full["size"]
            lab.record(case, first_page=page, output_size=full["size"])

            case = "probe-delete"
            sid, (shell_id,) = running(case, lab.call("delete"))
            lab.until(lambda: lab.idle(sid))
            shell = lab.shell(shell_id)
            removed = lab.api(f"/api/session/{sid}", method="DELETE")
            stopped = lab.until(lambda: (item if (item := lab.shell(shell_id)).get("data", {}).get("status") != "running" else None))
            lab.record(case, shell_running=shell, deleted=removed, read_after_delete=lab.api(f"/api/session/{sid}"),
                       shell_after_delete=stopped, files=lab.fixture_files("delete"))

            case = "probe-flag-off"
            sid = lab.launch(case, lab.call("flagoff", background=False, timeout=500))
            lab.until(lambda: (lab.workspace / "flagoff.starts").exists())
            if info["version"] != "2.3.0":
                jobs = lab.until(lambda: lab.jobs(sid))
                lab.record(case, running_jobs=jobs)
                finish(case, sid, jobs[0]["shellID"], "flagoff", 0)
            lab.until(lambda: lab.idle(sid))
            lab.record(case, transcript=lab.transcript(sid), jobs=lab.jobs(sid), files=lab.fixture_files("flagoff"))
            for case in ("probe-restart", "probe-handoff"):
                prior = lab.observations[case]
                shell_id = prior["running_jobs"][0]["shellID"]
                lab.record(case, final_observation=lab.shell(shell_id), final_jobs=lab.jobs(prior["session"]),
                           final_transcript=lab.transcript(prior["session"]),
                           final_inbox=lab.api(f"/api/session/{prior['session']}/inbox"))
    finally:
        lab.model.release.set()
        if lab.process and lab.process.poll() is None:
            for observation in lab.observations.values():
                lab.api(f"/api/session/{observation['session']}", method="DELETE")
        lab.stop()
        lab.model.shutdown()


if __name__ == "__main__":
    main()
