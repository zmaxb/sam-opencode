"""Capture Identity in real OpenCode Chat Completions requests at a loopback receiver."""
import argparse
from hashlib import sha256
import json
from pathlib import Path
import runpy
from urllib.parse import urlencode
from uuid import uuid4

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
fixture = runpy.run_path(str(HERE.parent / "stage00/probe.py"))
Lab, Model = fixture["Lab"], fixture["Model"]
POLICY = "If the two conflict, follow Effective Core."
MARKER = "Original OpenCode Base Fixture"
CATALOGUE = [{"name": "sam_identity_fixture_read", "description": "Read a fixture value.",
              "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]


def digest(value):
    return sha256(value.encode()).hexdigest()


class Receiver(Model):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        sam = self.headers.get("x-opencode-session-id")
        self.server.requests.append({"session": sam, "bodySha256": sha256(raw).hexdigest(), "request": body})
        messages = body["messages"]
        tool = any(item.get("function", {}).get("name") == CATALOGUE[0]["name"] for item in body.get("tools", []))
        loop = any(str(item.get("content")).startswith("probe-loop") for item in messages if item["role"] == "user")
        summary = any("Do not continue the task or call tools." in str(item.get("content")) for item in messages if item["role"] == "user")
        if summary:
            delta = {"content": "## Objective\n- Continue the synthetic fixture."}
            finish = "stop"
        elif tool and loop and not any(item["role"] == "tool" for item in messages):
            delta = {"tool_calls": [{"index": 0, "id": "call_identity_fixture", "type": "function",
                                     "function": {"name": CATALOGUE[0]["name"], "arguments": "{}"}}]}
            finish = "tool_calls"
        else:
            delta = {"content": "Fixture response."}
            finish = "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.respond(delta, finish)


class IdentityLab(Lab):
    def __init__(self, binary, root, zen):
        super().__init__(binary, root, False, ROOT / "tools/opencode/context", False)
        self.model.RequestHandlerClass = Receiver
        self.zen = zen
        provider, name = ("opencode", "big-pickle") if zen else ("fixture", "fixture")
        self.model_ref = {"providerID": provider, "id": name}
        base = f"http://127.0.0.1:{self.model.server_port}/v1"
        endpoint = base + "/chat/completions"
        config = json.loads(self.env["OPENCODE_CONFIG_CONTENT"])
        config.update(model=f"{provider}/{name}", small_model=f"{provider}/{name}",
                      enabled_providers=[provider], agent={"build": {"prompt": MARKER}},
                      compaction={"auto": True, "buffer": 55000, "keep": 1024})
        config["provider"] = {provider: {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": base, "apiKey": "synthetic"},
                                        "models": {name: {"name": "Fixture", "tool_call": True,
                                                          "limit": {"context": 65536, "output": 65536}}}}}
        self.scope = {"providerId": provider, "modelId": name, "variant": "default", "endpoint": endpoint,
                      "apiFamily": "openai.chat-completions" if zen else "sam-local-chat-completions"}
        # The Zen fixture uses its real provider scope and projection with a loopback endpoint.
        policy = {key: value for key, value in self.scope.items() if key != "modelId"}
        (root / "plugin/zen-model-requests.json").write_text(json.dumps({**policy, "modelIds": [name]}))
        config["plugins"] = [{"package": str(root / "plugin"),
                              "options": {"processorTargets": [] if zen else [
                                  {"providerId": provider, "modelId": name, "endpoint": endpoint, "sharedAdmission": True}]}}]
        self.env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)

    def rpc(self, method, value, wait=False):
        location = urlencode({"location[directory]": str(self.workspace)})
        def call():
            return self.api(f"/api/rpc/sam-opencode-context/{method}?{location}", {"input": value})
        reply = self.until(lambda: outcome if "output" in (outcome := call()) else None) if wait else call()
        assert "output" in reply, (method, reply)
        return reply["output"]

    def run_identity(self, base, loop, prior=None, compact=False):
        key = "native-default" if base is None else digest(base)
        text = f"probe-{'loop' if loop else 'plain'}-{uuid4().hex}"
        core, foundation = f"Identity Core {uuid4().hex}", f"Identity Foundation {uuid4().hex}"
        content = json.dumps({"Core": core, "Foundation": foundation, "Policy": POLICY})
        wire = json.dumps({"Base": base, "Context": content})
        catalog = json.dumps(CATALOGUE if loop else [])
        expected = {"epoch": self.rpc("inspect", {})["epoch"], "inputId": "msg_" + uuid4().hex,
                    "model": self.model_ref["id"], "modelRequest": self.scope, "catalogDigest": digest(catalog),
                    "contextDigest": digest(wire), "inputDigest": digest(text), "baseKey": key,
                    "continuity": {"previousInput": None, "previousIdle": None, "transcriptDigest": None}}
        if compact:
            expected["compaction"] = "sam.opencode-compaction/v1"
        self.rpc("configure", {"catalogue": catalog})
        if prior is None:
            session = self.api("/api/session", {"title": text, "model": self.model_ref,
                                               "metadata": {"sam": expected}, "location": {"directory": str(self.workspace)}})
            assert "data" in session, session
            sid = session["data"]["id"]
        else:
            sid, previous, old_core, old_foundation, prior_idle, prior_transcript = prior
            expected["continuity"] = {"previousInput": previous["inputId"], "previousIdle": prior_idle,
                                      "transcriptDigest": digest(json.dumps(prior_transcript))}
            handoff = {"sessionId": sid, "previous": previous, "authority": expected,
                       "history": {"users": [previous["inputDigest"]], "answers": [digest("Fixture response.")], "tools": []}}
            changed = {**handoff, "authority": {**expected, "baseKey": digest("different Base")}}
            path = "/api/rpc/sam-opencode-context/continue?" + urlencode({"location[directory]": str(self.workspace)})
            rejected = self.api(path, {"input": changed})
            assert rejected.get("http", 0) >= 400, rejected
            self.rpc("continue", handoff)
            updated = self.api(f"/api/session/{sid}", {"metadata": {"sam": expected}}, "PATCH")
            assert updated["http"] == 204, updated
        start = len(self.model.requests)
        put = self.api(f"/api/experimental/session/{sid}/instructions/entries/sam-context", {"value": wire}, "PUT")
        assert put["http"] == 204, put
        result = self.api(f"/api/session/{sid}/prompt", {"id": expected["inputId"], "text": text, "delivery": "queue",
                                                        "metadata": {"samInput": expected["inputId"]}})
        assert "data" in result, result
        tool_result = "fixture-tool-result" + (" payload" * 5000 if compact else "")
        def settle():
            for item in self.rpc("poll", {"sessionId": sid, "authority": expected})["work"]:
                result = {"status": "ok"}
                if item["kind"] == "tool":
                    result.update(content=tool_result, success=True)
                reply = self.rpc("settle", {"sessionId": sid, "authority": expected, "ticket": item["ticket"], "result": result})
                assert reply["accepted"], reply
            state = self.api(f"/api/session/{sid}")["data"]
            if state.get("time", {}).get("idle", 0) > state.get("time", {}).get("busy", 0):
                return state
        self.until(settle)
        captures = [record for record in self.model.requests[start:] if record["session"] == sid]
        kinds = ["compaction" if any("Do not continue the task or call tools." in str(item.get("content"))
                 for item in record["request"]["messages"] if item["role"] == "user") else "primary" for record in captures]
        assert kinds == (["primary", "compaction", "primary"] if compact else
                         ["primary"] * (2 if loop else 1)), (self.zen, kinds, self.transcript(sid))
        for kind, capture in zip(kinds, captures):
            body = capture["request"]
            system = [message["content"] for message in body["messages"] if message["role"] == "system"]
            assert len(system) == 1 and body["messages"][0]["role"] == "system", body
            system = system[0]
            assert system.count(core) == system.count(foundation) == system.count(POLICY) == 1, system
            assert system.index(core) < system.index(foundation), system
            assert (MARKER in system) == (base is None and not self.zen), system
            if prior:
                assert old_core not in system and old_foundation not in system, system
                assert all(old_core not in str(item.get("content")) and old_foundation not in str(item.get("content"))
                           for item in body["messages"])
            if base:
                assert system.startswith(base + "\n") and system.count(base) == 1, system
            elif self.zen or base == "":
                assert system.startswith('<context key="sam-context">'), system
            if kind == "primary":
                assert sum(message["content"] == text for message in body["messages"] if message["role"] == "user") == 1, body
            else:
                assert not body.get("tools"), body
        if loop:
            assert any(message["role"] == "tool" and message["content"] == tool_result
                       for message in captures[-1]["request"]["messages"])
        transcript = self.transcript(sid)["data"]
        idle = next((item["id"] for item in reversed(transcript) if item["type"] == "idle"), None)
        proof = {"mode": key, "toolLoop": loop, "continuation": prior is not None, "compaction": compact, "capture": captures}
        return proof, (sid, expected, core, foundation, idle, transcript)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True)
    evidence = {}
    for zen in (False, True):
        name = "zen" if zen else "local"
        lab = IdentityLab(str(args.binary.resolve()), args.output.resolve() / name, zen)
        try:
            lab.start()
            assert lab.rpc("inspect", {}, wait=True)["identity"] == "sam.opencode-identity/v1"
            inherited, prior = lab.run_identity(None, False)
            continued, _ = lab.run_identity(None, False, prior)
            custom, _ = lab.run_identity("Synthetic custom Base Ω\nsecond line", True)
            empty, _ = lab.run_identity("", False)
            large, _ = lab.run_identity("Synthetic large Base " + "identity text " * 400, False)
            def output_limit(case):
                return case["capture"][0]["request"]["max_completion_tokens"]
            assert output_limit(empty) - output_limit(large) > 1000, (output_limit(empty), output_limit(large))
            compacted, _ = lab.run_identity("Synthetic compacted Base", True, compact=True)
            lab.stop()
            lab.start()
            new_epoch = lab.rpc("inspect", {}, wait=True)["epoch"]
            assert new_epoch != prior[1]["epoch"]
            assert lab.transcript(prior[0])["data"]
            restored, _ = lab.run_identity(None, False)
            evidence[name] = [inherited, continued, custom, empty, large, compacted, restored]
        finally:
            lab.stop()
            lab.model.shutdown()
        (args.output / "wire.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
