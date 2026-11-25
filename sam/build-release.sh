#!/usr/bin/env bash
set -euo pipefail

if (($# < 1 || $# > 2)); then
    echo "Usage: $0 /absolute/output-directory [distribution-version]" >&2
    exit 2
fi
out=$(realpath -m "$1")
cd -- "$(dirname -- "$0")/.."
root=$PWD
version=${2:-0.2.0}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! -f "releases/$version/manifest.json" ]]; then
    echo "Unknown distribution version: $version" >&2
    exit 2
fi
if [[ "$out/" == "$root/"* || -n $(git status --porcelain) ]]; then
    echo 'Use a clean checkout and an output directory outside it.' >&2
    exit 2
fi
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]]
[[ "$(bun --version)" == 1.4.4 ]]
command -v python3 >/dev/null
umask 022
export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH
SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
bun install --frozen-lockfile
(
    cd packages/cli
    OPENCODE_VERSION=2.3.0 OPENCODE_CHANNEL=latest bun run script/build.ts --single --skip-install --skip-web-ui
)
python3 sam/package-release.py "$out" "$version"
