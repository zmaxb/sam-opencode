"""Package a locally built Linux x64 executable with pinned SAM Plugin inputs."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_PATH = Path("tools/opencode")
ZEN_POLICY = Path("src/SAM.Runtime.Contracts/AiModels/OpenCodeZenModelRequests.json")
NATIVE_BINARY = ROOT / "packages/cli/dist/cli-linux-x64/bin/opencode"


def digest(path):
    with path.open("rb") as stream:
        result = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
        return result.hexdigest()


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def main():
    out = Path(sys.argv[1]).resolve()
    if out.is_relative_to(ROOT) or git("status", "--porcelain"):
        raise SystemExit("Use a clean checkout and an output directory outside it.")
    version = sys.argv[2]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise SystemExit("Expected a distribution version such as 0.2.0.")
    manifest = json.loads((ROOT / "releases" / version / "manifest.json").read_text())
    if manifest["version"] != version:
        raise SystemExit(f"Manifest version does not match {version}.")
    out.mkdir(parents=True, exist_ok=True)
    name = f"sam-opencode-{manifest['version']}-linux-x64"
    epoch = git("show", "-s", "--format=%ct")
    manifest["source"] = {"commit": git("rev-parse", "HEAD"), "tree": git("rev-parse", "HEAD^{tree}")}
    manifest["build"] = {"target": "linux-x64", "bun": "1.4.4", "lock_sha256": digest(ROOT / "bun.lock")}
    actual_version = subprocess.check_output([NATIVE_BINARY, "--version"], text=True).strip()
    if actual_version.removeprefix("opencode v") != manifest["upstream"]["version"]:
        raise SystemExit(f"Unexpected OpenCode version: {actual_version}")
    with tempfile.TemporaryDirectory(dir=out) as scratch:
        work = Path(scratch)
        bundle = work / name
        bundle.mkdir()
        for relative in manifest["package_files"]:
            target = bundle / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
            target.chmod(0o755 if (ROOT / relative).stat().st_mode & 0o111 else 0o644)
        shutil.copyfile(NATIVE_BINARY, bundle / "opencode")
        (bundle / "opencode").chmod(0o755)
        manifest["files"] = {
            str(path.relative_to(bundle)): digest(path)
            for path in sorted(bundle.rglob("*")) if path.is_file()
        }
        manifest["installed_plugin"] = {
            file: manifest["files"][str(PLUGIN_PATH / "context" / file)]
            for file in ("background.mjs", "index.mjs", "package.json", "processor.mjs")
        }
        manifest["installed_plugin"]["zen-model-requests.json"] = manifest["files"][str(ZEN_POLICY)]
        (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        artifact = out / f"{name}.tar.gz"
        archive = work / "bundle.tar"
        subprocess.run(
            ["tar", "--format=gnu", "--sort=name", f"--mtime=@{epoch}", "--owner=0", "--group=0",
             "--numeric-owner", "-cf", archive, "-C", work, name],
            check=True,
        )
        with artifact.open("wb") as stream:
            subprocess.run(["gzip", "-n", "-c", archive], stdout=stream, check=True)
        manifest["artifact"] = {"file": artifact.name, "sha256": digest(artifact)}
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (out / "SHA256SUMS").write_text(
            f"{manifest['artifact']['sha256']}  {artifact.name}\n"
            f"{digest(out / 'manifest.json')}  manifest.json\n"
        )


if __name__ == "__main__":
    main()
