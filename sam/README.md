# SAM OpenCode distribution

SAM OpenCode tracks [OpenCode upstream](https://github.com/anomalyco/opencode) with a small, separately reviewable native patch series. Core provides native lifecycle, execution and evidence primitives. The SAM Plugin maintains the managed OpenCode wire contract. The SAM platform owns connections, model profiles, Clone assignments, History, Queue, Steering and user interaction.

- `packages/` contains upstream and separately committed native changes.
- `tools/opencode/context/` contains the SAM Plugin. `tools/opencode/admission/` contains shared inference admission for installations configured to use it.
- `src/SAM.Runtime.Contracts/AiModels/OpenCodeZenModelRequests.json` is the versioned SAM wire-policy input used by Plugin packaging. SAM owns the corresponding model-request policy.
- `sam/qualification/` and `tests/OpenCode/` contain Native and Plugin qualification. SAM retains its Runtime integration harness and database scenarios.
- `releases/` contains the release specification and distribution changelog.

## Build and verify

From a clean tagged checkout on Linux x86-64, use Bun 1.4.4, Python 3.10+, GNU tar and gzip.

```sh
./sam/build-release.sh /absolute/output-directory
cd /absolute/output-directory
sha256sum -c SHA256SUMS
```

The build uses the upstream CLI, frozen Bun lockfile and a Linux x64 profile without the Web UI. The archive includes the executable, Plugin, existing Plugin installer, inference admission sources, policy data, license and manifest. The external manifest records the source commit and tree, archive hash, artifact hashes, upstream version and Plugin distribution revision. The executable retains its upstream `--version` output. A clean rebuild uses the same pinned inputs. Compare actual hashes when reusing a build. The versioned source manifest and the release qualification result are separate.

Run the existing synthetic fixtures with Node.js 24 and Python 3.

```sh
node tests/OpenCode/contract.mjs
node tests/OpenCode/continuation.mjs
node tests/OpenCode/background_continuation.mjs
node tests/OpenCode/zen.mjs
node --test tests/OpenCode/processor.test.mjs tests/OpenCode/admission.test.mjs
export SAM_TEST_OPENCODE_NATIVE_BINARY="$PWD/packages/cli/dist/cli-linux-x64/bin/opencode"
node tests/OpenCode/processor_native.mjs
python3 sam/qualification/stage01/qualify.py "$SAM_TEST_OPENCODE_NATIVE_BINARY" --plain
python3 sam/qualification/stage02/qualify.py "$SAM_TEST_OPENCODE_NATIVE_BINARY" "$SAM_PROVIDER_PROBE" --mode plain
python3 sam/qualification/stage02/qualify.py "$SAM_TEST_OPENCODE_NATIVE_BINARY" "$SAM_PROVIDER_PROBE" --mode managed
```

`SAM_PROVIDER_PROBE` is the executable built from the existing SAM `artifacts/opencode-background-jobs/stage02/fixture/ProviderProbe.csproj` fixture. Use a loopback synthetic provider, distinct XDG directories and disposable native and SAM storage.

## Installation and update

The archive uses the existing installation layout. `tools/opencode/install.sh --config FILE` installs all Plugin files into the configured directory and leaves the service process running. Use the existing operator procedure for binary activation, restart, storage preservation and rollback. First verify the archive, installed files, all consuming runtimes, outstanding work, native storage and the authorized recovery artifact. Reconcile any active root executions or background work before the cutover. Compare live readiness, catalog, Plugin negotiation, binary and Plugin SHA-256 and existing Session bindings after startup. Preserve the effective operator configuration, provider settings, gateway and service identity.

## Upstream updates

Select an exact upstream release commit and compare the affected native areas. Replay the small native commits in manifest order onto the selected upstream source without rewriting released tags. Identify equivalent upstream changes and retire them after qualification. Check conflicts and new lifecycle behavior, build with the pinned toolchain, run native fixtures and the SAM integration checks, and issue the next distribution release with a new manifest and changelog entry. Keep runtime compatibility controlled by the negotiated wire and capabilities.

Stateless Completion is included in the first distribution because it is part of the adopted production baseline. Its managed Processor path remains opt-in through existing Plugin target configuration. The published 0.1.0 release keeps the existing Steering behavior.

## Native run-bound steering

A native client can read `GET /api/session/{sessionID}/steering` to discover `run-bound-steering/v1` and the current ordinary root execution, when available. Submit a text-only `POST /api/session/{sessionID}/prompt` with an explicit message `id`, `delivery: "steer"` and `expectedExecution` containing the returned `rootMessageID` and opaque `ownerToken`. Keep both values together. A stale binding returns HTTP 409 unless the exact request was already accepted.

Read `GET /api/session/{sessionID}/steering?messageID={id}` to recover the admission receipt. It includes the Session ID, steering message ID, original execution identity and SHA-256 of the accepted UTF-8 text. The receipt confirms admission. Consumption happens on a subsequent step of the same root if it continues. An exact repeat reads the original admission without adding work. Completion and Stop expire undelivered inputs. Receipts survive restart for the lifetime of the Session. The managed server expires stranded inputs during restart recovery. A plain server expires them when the affected Session next starts, before it consumes input. Ordinary unbound prompts use the existing API behavior.

This native opt-in capability leaves the production SAM Plugin, Wire v3 and SAM Runtime capability advertisement unchanged. Qualify it against an isolated synthetic provider.

```sh
python3 sam/qualification/steering/qualify.py "$SAM_TEST_OPENCODE_NATIVE_BINARY"
python3 sam/qualification/steering/qualify.py "$SAM_TEST_OPENCODE_NATIVE_BINARY" --managed
```
