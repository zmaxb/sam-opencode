#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'HELP'
Usage:
  install.sh [--config FILE]
  install.sh --inspect URL --directory DIRECTORY [--netrc-file FILE]

Install or update sam-opencode-context in an existing OpenCode 2 configuration.
Config selection: --config, OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, then
XDG_CONFIG_HOME/opencode (default: ~/.config/opencode).
Inspect checks the running server for the contracts required by this package.
HELP
}

fail() { printf 'OpenCode plugin: %s\n' "$*" >&2; exit 1; }
config='' url='' directory='' netrc=''
while (($#)); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --config|--inspect|--directory|--netrc-file)
            (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || fail "missing value for $1"
            case "$1" in
                --config) config=$2 ;;
                --inspect) url=$2 ;;
                --directory) directory=$2 ;;
                --netrc-file) netrc=$2 ;;
            esac
            shift 2 ;;
        *) fail "unknown argument: $1" ;;
    esac
done

command -v python3 >/dev/null || fail 'python3 is required'
if [[ -n "$url" ]]; then
    [[ -z "$config" && -n "$directory" ]] || fail 'use --inspect with --directory'
    command -v curl >/dev/null || fail 'curl is required for inspect'
    address=$(python3 - "$url" "$directory" <<'PY'
import sys
from urllib.parse import quote, urlencode, urlsplit

url = urlsplit(sys.argv[1])
if (url.scheme not in ('https', 'http') or not url.hostname or url.username is not None
        or url.query or url.fragment or any(c.isspace() or ord(c) < 32 for c in sys.argv[1])
        or (url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '::1'))):
    sys.exit('OpenCode plugin: use HTTPS or a loopback HTTP endpoint, without embedded credentials')
print(sys.argv[1].rstrip('/') + '/api/rpc/sam-opencode-context/inspect?' +
      urlencode({'location[directory]': sys.argv[2]}, quote_via=quote))
PY
)
    auth=()
    if [[ -n "$netrc" ]]; then
        [[ -f "$netrc" && -r "$netrc" ]] || fail 'cannot read the netrc file'
        auth=(--netrc-file "$netrc")
    fi
    response=$(curl -q --fail --silent --show-error --max-time 30 "${auth[@]}" -H 'Content-Type: application/json' \
        --data '{"input":{}}' -- "$address")
    python3 -c '
import json
import sys
from uuid import UUID

extensions = {
    "autonomy": "sam.opencode-autonomy/v1",
    "autonomyRules": "sam.opencode-autonomy-rules/v1",
    "nativeTools": "sam.opencode-native-tools/v1",
    "sessionContinuity": "sam.opencode-session-continuity/v1",
    "restartEvidence": "sam.opencode-restart-evidence/v1",
    "compaction": "sam.opencode-compaction/v1",
    "attachments": "sam.opencode-attachments/v1",
}
try:
    contract = json.load(sys.stdin)["output"]
    epoch = UUID(contract["epoch"])
    if contract["contract"] != "sam.opencode-wire/v3" or epoch.int == 0:
        raise ValueError
except (KeyError, TypeError, ValueError, AttributeError):
    sys.exit("OpenCode plugin: inspect did not confirm sam.opencode-wire/v3")
missing = [value for key, value in extensions.items() if contract.get(key) != value]
if missing:
    sys.exit("OpenCode plugin: sam.opencode-wire/v3 confirmed, but inspect did not confirm " + ", ".join(missing))
print(f"sam.opencode-wire/v3 confirmed (epoch {epoch})")
for value in extensions.values():
    print(f"{value} confirmed")
if contract.get("nativeToolsWithPatch") == "sam.opencode-native-tools/v2" and contract.get("patchFullAccessOnly") is True:
    print("sam.opencode-native-tools/v2 confirmed")
' <<< "$response"
    exit
fi

[[ -z "$directory" && -z "$netrc" ]] || fail '--directory and --netrc-file are for inspect'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/context
config=${config:-${OPENCODE_CONFIG:-}}
config_dir=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-"$HOME/.config"}/opencode}

python3 - "$source_dir" "$config" "$config_dir" <<'PY'
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from urllib.parse import unquote, urlsplit

PACKAGE = 'sam-opencode-context'
PLUGIN_FILES = ('index.mjs', 'background.mjs', 'processor.mjs', 'zen-model-requests.json', 'package.json')
TRAILING_COMMAS = re.compile(r'"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])')
COMMENTS = re.compile(r'"(?:[^"\\]|\\.)*"|//[^\r\n]*|/\*[\s\S]*?\*/')
WHITESPACE = re.compile(r'\s*')


def mask(text):
    # Keep offsets so edits preserve comments, formatting and all unrelated values.
    comments = COMMENTS.sub(lambda m: m[0] if m[0].startswith('"') else
                            re.sub(r'[^\r\n]', ' ', m[0]), text)
    def trailing(match):
        if match[0] == ',' and comments[:match.start()].rstrip()[-1:] not in ('', '[', '{', ','):
            return ' '
        return match[0]

    return TRAILING_COMMAS.sub(trailing, comments)


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('configuration has duplicate object keys')
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError('configuration has a non-JSON number')


decoder = json.JSONDecoder(object_pairs_hook=unique_pairs, parse_constant=reject_constant)


def read_config(text):
    value = decoder.decode(mask(text))
    if not isinstance(value, dict) or not isinstance(value.get('plugins', []), list):
        raise ValueError('configuration must be an object with an optional plugins array')
    for entry in value.get('plugins', []):
        if isinstance(entry, str):
            continue
        if (not isinstance(entry, dict) or not isinstance(entry.get('package'), str)
                or ('options' in entry and not isinstance(entry['options'], dict))):
            raise ValueError('plugins entries must be strings or objects with package and optional options')
    return value


def with_plugin(text, value, spec):
    masked = mask(text)
    spec = json.dumps(spec)
    last = WHITESPACE.match(masked).end() + 1
    while True:
        cursor = WHITESPACE.match(masked, last).end()
        if masked[cursor] == '}':
            break
        if masked[cursor] == ',':
            cursor = WHITESPACE.match(masked, cursor + 1).end()
        key, end = decoder.raw_decode(masked, cursor)
        colon = WHITESPACE.match(masked, end).end()
        start = WHITESPACE.match(masked, colon + 1).end()
        _, last = decoder.raw_decode(masked, start)
        if key == 'plugins':
            end = start + 1
            if value['plugins']:
                while True:
                    _, end = decoder.raw_decode(masked, WHITESPACE.match(masked, end).end())
                    comma = WHITESPACE.match(masked, end).end()
                    if masked[comma] == ']':
                        break
                    end = comma + 1
            insertion = (', ' if value['plugins'] else '') + spec
            return text[:end] + insertion + text[end:]
    insertion = (', ' if value else '') + '"plugins": [' + spec + ']'
    return text[:last] + insertion + text[last:]


def config_path(explicit, directory):
    if explicit:
        return Path(explicit).expanduser().absolute()
    candidates = [directory / name for name in ('opencode.json', 'opencode.jsonc')]
    found = [item for item in candidates if item.exists() or item.is_symlink()]
    if len(found) != 1:
        raise ValueError('select an existing OpenCode configuration explicitly with --config FILE')
    return found[0]


def manifest(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sam_package(directory):
    path = directory / 'package.json'
    return path.is_file() and manifest(path).get('name') == PACKAGE


def existing_package(entry, parent):
    spec = entry if isinstance(entry, str) else entry['package']
    if spec == PACKAGE or spec.startswith(PACKAGE + '@'):
        raise ValueError('select the local SAM package in plugins before updating this configuration')
    if spec.startswith('file://'):
        uri = urlsplit(spec)
        if uri.netloc not in ('', 'localhost'):
            return None
        candidate = Path(unquote(uri.path))
    elif spec.startswith(('./', '../', '/')):
        candidate = parent / Path(spec)
    else:
        return None
    if sam_package(candidate):
        return candidate.absolute()
    if candidate.name == PACKAGE and not candidate.exists() and not candidate.is_symlink():
        return candidate.absolute()
    if candidate.name == PACKAGE:
        raise ValueError(f'SAM plugin entry has no readable package manifest: {candidate}')
    return None


def check_target(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f'expected a regular file: {path}')
    if path.exists() and not os.access(path, os.W_OK):
        raise PermissionError(f'file is not writable: {path}')


def stage(target, content, pending):
    if target.exists() and target.read_bytes() == content:
        return
    previous = target.stat() if target.exists() else None
    mode = stat.S_IMODE(previous.st_mode) if previous else 0o644
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.sam-opencode-', delete=False) as output:
        pending.append((Path(output.name), target))
        if previous:
            os.fchown(output.fileno(), previous.st_uid, previous.st_gid)
        os.fchmod(output.fileno(), mode)
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def install(source, config):
    package_manifest = manifest(source / 'package.json')
    if (package_manifest.get('name') != PACKAGE or package_manifest.get('type') != 'module'
            or package_manifest.get('exports', {}).get('./server') != './index.mjs'
            or not (source / 'index.mjs').stat().st_size):
        raise ValueError('invalid source package; keep the installer and context directory together')
    zen_manifest = source.parents[2] / 'src/SAM.Runtime.Contracts/AiModels/OpenCodeZenModelRequests.json'
    package = {name: (zen_manifest if name == 'zen-model-requests.json' else source / name).read_bytes()
               for name in PLUGIN_FILES}
    if config.is_symlink() or not config.is_file():
        raise ValueError('select an existing regular config file; use the actual file path for a symlink')

    parent = config.parent.resolve()
    config = parent / config.name
    lock = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    pending = []
    created = None
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        original = config.read_bytes()
        text = original.decode('utf-8-sig')
        settings = read_config(text)
        existing = [folder for entry in settings.get('plugins', [])
                    if (folder := existing_package(entry, parent)) is not None]
        if len(existing) > 1:
            raise ValueError('multiple SAM plugin entries; keep one entry before installing')
        target = existing[0] if existing else parent / PACKAGE
        if target.is_symlink() or (target.exists() and not sam_package(target)):
            raise ValueError(f'plugin destination is occupied: {target}')
        if source.resolve() == target.resolve():
            if existing:
                print(f'Already current: {target}')
                return
            raise ValueError('copy or run the installer from a separate source checkout')

        if not existing:
            check_target(config)
            registration = './' + PACKAGE
            updated = with_plugin(text, settings, registration)
            registered = read_config(updated)
            expected = dict(settings, plugins=[*settings.get('plugins', []), registration])
            if registered != expected:
                raise ValueError('could not preserve existing OpenCode configuration')
            encoded = updated.encode('utf-8-sig' if original.startswith(b'\xef\xbb\xbf') else 'utf-8')
            stage(config, encoded, pending)

        if not target.exists():
            created = Path(tempfile.mkdtemp(dir=target.parent, prefix='.sam-opencode-'))
        for name in reversed(PLUGIN_FILES):  # Publish the manifest first for a recoverable update.
            path = (created or target) / name
            check_target(path)
            stage(path, package[name], pending)
        if config.read_bytes() != original:
            raise ValueError('OpenCode configuration changed during this installation; run again')
        # Publish a complete package before exposing the initial config entry.
        for temporary, destination in pending:
            if destination != config:
                os.replace(temporary, destination)
        if created is not None:
            os.rename(created, target)
        for temporary, destination in pending:
            if destination == config:
                os.replace(temporary, destination)
        print(f'{"Updated" if pending else "Already current"}: {target}')
        print('OpenCode process left running as-is. Verify the intended instance with --inspect.')
    finally:
        for temporary, _ in pending:
            temporary.unlink(missing_ok=True)
        if created is not None and created.exists():
            for name in PLUGIN_FILES:
                (created / name).unlink(missing_ok=True)
            created.rmdir()
        os.close(lock)


try:
    source, explicit, directory = sys.argv[1:]
    install(Path(source), config_path(explicit, Path(directory).expanduser()))
except json.JSONDecodeError as error:
    sys.exit(f'OpenCode plugin: invalid JSON/JSONC at line {error.lineno}, column {error.colno}')
except (OSError, ValueError, AttributeError) as error:
    sys.exit(f'OpenCode plugin: {error}')
PY
