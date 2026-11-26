"""Exercise native Steering, Status and Stop against Shared Admission and a synthetic backend."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from threading import Event, Lock
from time import monotonic, sleep
from urllib.request import Request, urlopen
from uuid import uuid4

from qualify import Lab, Model

ADMISSION = Path(__file__).resolve().parents[3] / "tools/opencode/admission/server.mjs"


class Backend(Model):
    def do_GET(self):
        assert self.path == "/slots"
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps([{"is_processing": self.server.slot.locked()}]).encode())

    def do_POST(self):
        assert self.server.slot.acquire(blocking=False), "Concurrent physical calls"
        try:
            wire = self.rfile.read(int(self.headers["Content-Length"]))
            messages = json.loads(wire)["messages"]
            role = "processor" if messages[0]["content"] == "processor" else "agent"
            index = len(self.server.inputs)
            self.server.inputs.append((role, messages))
            if index in self.server.barriers:
                started, release = self.server.barriers[index]
                started.set()
                assert release.wait(25)
            self.rfile = io.BytesIO(wire)
            with suppress(BrokenPipeError, ConnectionResetError):
                super().do_POST()
        finally:
            self.server.slot.release()


def until(condition):
    deadline = monotonic() + 12
    while monotonic() < deadline:
        try:
            if result := condition():
                return result
        except ConnectionError:
            pass
        except OSError:
            pass
        sleep(0.1)
    raise TimeoutError("Shared Admission qualification condition did not settle")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda value: str(Path(value).resolve()))
    args = parser.parse_args()
    root = Path(tempfile.mkdtemp(prefix="opencode-shared-resources-"))
    print(root, flush=True)
    lab = Lab(args.binary, root, False, None, True)
    lab.model.RequestHandlerClass = Backend
    lab.model.slot = Lock()
    lab.model.inputs = []
    lab.model.barriers = {i: (Event(), Event()) for i in range(4)}
    token, upstream, observation = [uuid4().hex for _ in range(3)]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    config = json.loads(lab.env["OPENCODE_CONFIG_CONTENT"])
    config["provider"]["fixture"]["options"].update(
        baseURL=url + "/v1", apiKey=token, headers={"x-sam-inference-role": "agent"})
    lab.env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)

    def snapshot():
        request = Request(url + "/resources/v1", headers={"Authorization": f"Bearer {observation}"})
        with urlopen(request, timeout=2) as response:
            return json.load(response)

    def processor():
        request = Request(url + "/v1/chat/completions", json.dumps(
            {"messages": [{"role": "user", "content": "processor"}]}).encode(), headers={
                "Authorization": f"Bearer {token}", "x-sam-inference-role": "processor"})
        with urlopen(request, timeout=20) as response:
            return response.read()

    def start(text):
        sid = lab.api("/api/session", {"title": text, "location": {"directory": str(lab.workspace)}})["data"]["id"]
        root_id = "msg_" + uuid4().hex
        assert lab.api(f"/api/session/{sid}/prompt", {"id": root_id, "text": text, "resume": True})["data"]["id"] == root_id
        return sid, root_id

    with (root / "gateway.log").open("w") as log, ThreadPoolExecutor(max_workers=1) as pool:
        gateway = subprocess.Popen(["node", str(ADMISSION)], env={**os.environ,
            "SAM_INFERENCE_UPSTREAM": f"http://127.0.0.1:{lab.model.server_port}",
            "SAM_INFERENCE_PORT": url.rsplit(":", 1)[1], "SAM_INFERENCE_TOKEN": token,
            "SAM_INFERENCE_UPSTREAM_TOKEN": upstream, "SAM_INFERENCE_RESOURCE_KEY": "fixture",
            "SAM_INFERENCE_OBSERVATION_TOKEN": observation}, stdout=log, stderr=log)
        try:
            until(lambda: snapshot()["appliedMax"] == 1)
            lab.start()
            lab.model.cases["probe-steer"] = [lab.call("fixture", background=False, gated=False)]
            sid, root_id = start("probe-steer")
            assert lab.model.barriers[0][0].wait(12)
            proc = pool.submit(processor)
            until(lambda: any(row["role"] == "processor" for row in snapshot()["waiting"]))
            state = lab.api(f"/api/session/{sid}/steering")
            assert state["execution"]["rootMessageID"] == root_id
            assert snapshot()["physicalBusy"] == 1
            marker = "STEER_ON_FULL_GATE"
            response = lab.api(f"/api/session/{sid}/prompt", {"id": "msg_" + uuid4().hex, "text": marker,
                "delivery": "steer", "expectedExecution": state["execution"], "resume": True})
            assert "data" in response, response
            assert len(lab.model.inputs) == 1
            lab.model.barriers[0][1].set()
            assert lab.model.barriers[1][0].wait(12)
            assert lab.model.inputs[1][0] == "processor"
            lab.model.barriers[1][1].set()
            assert proc.result(timeout=12)
            assert lab.model.barriers[2][0].wait(12)
            assert lab.model.inputs[2][0] == "agent" and marker in json.dumps(lab.model.inputs[2])
            lab.model.barriers[2][1].set()
            lab.until(lambda: lab.idle(sid))

            sid, root_id = start("probe-stop")
            assert lab.model.barriers[3][0].wait(12)
            proc = pool.submit(processor)
            until(lambda: any(row["role"] == "processor" for row in snapshot()["waiting"]))
            assert lab.api(f"/api/session/{sid}/steering")["execution"]["rootMessageID"] == root_id
            assert lab.api(f"/api/session/{sid}/interrupt?resume=true", {}, "POST")["interrupted"]
            until(lambda: snapshot()["blocked"])
            assert len(lab.model.inputs) == 4
            lab.model.barriers[3][1].set()
            assert proc.result(timeout=12)
            lab.until(lambda: lab.idle(sid))
            assert [role for role, _ in lab.model.inputs] == ["agent", "processor", "agent", "agent", "processor"]
            print(json.dumps({"result": "PASS", "backend": "loopback stub", "generationCalls": 0,
                "order": [role for role, _ in lab.model.inputs], "checks": [
                    "Status and Steer while Processor waits for a full gate",
                    "continuation after Steer uses a distinct admit",
                    "Stop completes while backend remains busy",
                    "waiting Processor dispatches only after backend idle"]}))
        finally:
            for _, release in lab.model.barriers.values():
                release.set()
            lab.stop()
            gateway.terminate()
            gateway.wait(timeout=5)
            lab.model.shutdown()
            lab.model.server_close()


if __name__ == "__main__":
    main()
