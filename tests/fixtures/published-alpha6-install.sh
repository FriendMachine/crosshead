#!/usr/bin/env bash
set -euo pipefail

BASE_URL="https://crosshead.sh"
RELEASE_ID="0.5.0-alpha.6-b82fbb2e5e85"
RELEASE_URL="https://crosshead.sh/install/releases/onlybots-runtime.tgz"
CROSSHEAD_RELEASE_URL="https://crosshead.sh/install/releases/crosshead-runtime.tgz"
RELEASE_SHA256="b82fbb2e5e85674f975c9f4d6fdf530ba29b8b1d9a5114f520384c194003532c"
RELEASE_CHECKSUMS_URL="https://github.com/FriendMachine/crosshead/releases/download/v0.5.0-alpha.6/SHA256SUMS"
RELEASE_SOURCE_URL="https://github.com/FriendMachine/crosshead/tree/f48a7feabcb63447e36f511279b62798e59d983c"
RELEASE_ATTESTATION_REPOSITORY="FriendMachine/crosshead"
ADD_TO_PATH=0
for ARG in "$@"; do
  case "$ARG" in
    --add-to-path) ADD_TO_PATH=1 ;;
    *) echo "Unknown installer option: $ARG" >&2; exit 1 ;;
  esac
done
INSTALL_ROOT="${CROSSHEAD_HOME:-${CROSSHEAD_RUNTIME_HOME:-${ONLYBOTS_HOME:-${ONLYBOTS_RUNTIME_HOME:-}}}}"
if [ -z "$INSTALL_ROOT" ]; then
  if [ -e "$HOME/.crosshead" ] && [ -e "$HOME/.onlybots" ] && ! [ "$HOME/.crosshead" -ef "$HOME/.onlybots" ]; then
    echo "Separate ~/.crosshead and ~/.onlybots installations found. Set CROSSHEAD_HOME to choose; no state was moved." >&2
    exit 1
  fi
  if [ ! -e "$HOME/.crosshead" ] && [ ! -L "$HOME/.crosshead" ] && [ -d "$HOME/.onlybots" ]; then
    ln -s "$HOME/.onlybots" "$HOME/.crosshead"
  fi
  INSTALL_ROOT="$HOME/.crosshead"
  if [ -L "$INSTALL_ROOT" ] && [ ! -e "$INSTALL_ROOT" ]; then
    echo "Runtime home is a broken symlink: $INSTALL_ROOT" >&2; exit 1
  fi
fi
BIN_DIR="$INSTALL_ROOT/bin"
LIB_DIR="$INSTALL_ROOT/lib/runtime/$RELEASE_ID"
TMP_DIR="$(mktemp -d)"
STAGE_DIR="$TMP_DIR/release"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Crosshead installer requires '$1' on PATH" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar
need_cmd node
need_cmd npm

if ! node -e 'const version=process.argv[1]||process.versions.node;const parts=version.split(".").map(Number);const [major,minor,patch]=parts;const minimum=major===22?[23,4]:major===24?[22,1]:major===26?[12,1]:null;const valid=parts.length===3&&parts.every(Number.isInteger);const safe=valid&&(major>26||(minimum!==null&&(minor>minimum[0]||(minor===minimum[0]&&patch>=minimum[1]))));process.exit(safe?0:1)'; then
  echo "Crosshead installer requires Node 22.23.4+, 24.22.1+, or 26.12.1+" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$STAGE_DIR" "$(dirname "$LIB_DIR")"

echo "Downloading Crosshead runtime release $RELEASE_ID from $CROSSHEAD_RELEASE_URL"
curl -fsSL --proto '=https' --proto-redir '=https' --max-redirs 3 --max-time 120 --max-filesize 67108864 "$CROSSHEAD_RELEASE_URL" -o "$TMP_DIR/crosshead-runtime.tgz"
ACTUAL_SHA256="$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP_DIR/crosshead-runtime.tgz")"
if [ "$ACTUAL_SHA256" != "$RELEASE_SHA256" ]; then
  echo "Crosshead runtime release checksum verification failed" >&2
  exit 1
fi
tar -xzf "$TMP_DIR/crosshead-runtime.tgz" -C "$STAGE_DIR" --no-same-owner --no-same-permissions

if [ ! -f "$STAGE_DIR/package.json" ] || [ ! -f "$STAGE_DIR/package-lock.json" ] || [ ! -f "$STAGE_DIR/dist/runtime/cli.js" ] || [ ! -f "$STAGE_DIR/dist/runtime/daemon.js" ]; then
  echo "Crosshead runtime release is missing required files" >&2
  exit 1
fi

echo "Installing runtime dependencies"
(
  cd "$STAGE_DIR"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)

rm -rf "$LIB_DIR"
mv "$STAGE_DIR" "$LIB_DIR"

# Generate shell wrappers with literal, safely quoted paths.
node - "$INSTALL_ROOT" "$LIB_DIR" "$BIN_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [root, lib, bin] = process.argv.slice(2);
const q = value => "'" + value.split("'").join("'" + String.fromCharCode(34) + "'" + String.fromCharCode(34) + "'") + "'";
for (const name of ['crosshead', 'xhd', 'onlybotsctl', 'crossheadd', 'onlybotsd']) {
  const entry = ['crossheadd', 'onlybotsd'].includes(name) ? 'daemon.js' : 'cli.js';
  const body = '#!/usr/bin/env bash\nset -euo pipefail\nexport CROSSHEAD_HOME=' + q(root) + '\nnode ' + q(path.join(lib, 'dist/runtime', entry)) + ' "$@"\n';
  fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  fs.chmodSync(path.join(bin, name), 0o755);
}
NODE

echo
echo "Crosshead CLI installed."
echo "Add this to your shell if needed:"
printf '  export PATH=%q:$PATH\n' "$BIN_DIR"
echo
if [ "$ADD_TO_PATH" = 1 ]; then
  case "${SHELL:-}" in
    */zsh) PROFILE_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    */bash)
      if [ "$(uname -s)" = Darwin ]; then
    PROFILE_FILE="$HOME/.bash_profile"
      else
    PROFILE_FILE="$HOME/.bashrc"
      fi
      ;;
    *) echo "Automatic PATH setup supports bash and zsh. Use the PATH command above." >&2; exit 1 ;;
  esac
  # Node quotes the literal path safely and avoids duplicate entries. Never eval paths.
  node - "$PROFILE_FILE" "$BIN_DIR" <<'NODE'
const fs = require('fs');
const [profile, bin] = process.argv.slice(2);
const quoted = "'" + bin.split("'").join("'" + String.fromCharCode(34) + "'" + String.fromCharCode(34) + "'") + "'";
const line = 'export PATH=' + quoted + ':"$PATH"';
const prior = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
if (!prior.split('\n').includes(line)) fs.appendFileSync(profile, '\n# Crosshead CLI\n' + line + '\n');
console.log('PATH entry saved in ' + profile + '. Open a new shell or use the command above.');
NODE
fi

echo "Next steps (choose your tool):"
echo "  crosshead quickstart --api-base $BASE_URL --adapter claude-code --workspace-root ."
echo "  crosshead quickstart --api-base $BASE_URL --adapter codex"
echo "  crosshead quickstart --api-base $BASE_URL --adapter hermes"
echo "  crosshead quickstart --api-base $BASE_URL --adapter opencode"
echo "  crosshead status"
echo "  crosshead doctor"
echo "  crosshead update --pin   # optional: disable automatic updates"
echo "Setup and data controls: $BASE_URL/getting-started"
echo "Release source: $RELEASE_SOURCE_URL"
echo "Independent checksums: $RELEASE_CHECKSUMS_URL"
echo "Provenance: gh attestation verify <downloaded-tarball> --repo $RELEASE_ATTESTATION_REPOSITORY"
