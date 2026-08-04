#!/bin/sh

set -eu

REPOSITORY="${TOKENOMICS_REPOSITORY:-skuznetsov/tokenomics-viewer}"
INSTALL_ROOT="${TOKENOMICS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tokenomics-viewer}"
BIN_DIR="${TOKENOMICS_BIN_DIR:-$HOME/.local/bin}"
RELEASES_DIR="$INSTALL_ROOT/releases"
RUNTIME_DIR="$INSTALL_ROOT/runtime"
LOCK_DIR="$INSTALL_ROOT/.install-lock"
WORK_DIR=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'tokenomics installer: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

shell_quote() {
  escaped=$(printf '%s' "$1" | sed "s/'/'\\\\''/g")
  printf "'%s'" "$escaped"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

node_major() {
  "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p'
}

download() {
  curl -fL --retry 3 --retry-delay 1 --connect-timeout 15 "$1" -o "$2"
}

verify_sha256() {
  expected=$1
  filename=$2
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$filename" | awk '{print $1}')
  elif command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$filename" | awk '{print $1}')
  else
    fail "cannot verify Node.js: shasum or sha256sum is required"
  fi
  [ "$actual" = "$expected" ] || fail "Node.js archive checksum mismatch"
}

install_node() {
  case "$(uname -s)" in
    Darwin) node_platform=darwin ;;
    Linux) node_platform=linux ;;
    *) fail "automatic Node.js installation supports macOS and Linux only" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) node_arch=arm64 ;;
    x86_64|amd64) node_arch=x64 ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac

  checksums="$WORK_DIR/SHASUMS256.txt"
  download "https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt" "$checksums"
  suffix="-$node_platform-$node_arch.tar.gz"
  archive_name=$(awk -v suffix="$suffix" '
    index($2, suffix) == length($2) - length(suffix) + 1 { print $2; exit }
  ' "$checksums")
  [ -n "$archive_name" ] || fail "no Node.js 26 build found for $node_platform-$node_arch"
  expected=$(awk -v name="$archive_name" '$2 == name { print $1; exit }' "$checksums")
  [ -n "$expected" ] || fail "Node.js checksum entry is missing"

  archive="$WORK_DIR/$archive_name"
  say "Downloading Node.js 26 for $node_platform-$node_arch..."
  download "https://nodejs.org/dist/latest-v26.x/$archive_name" "$archive"
  verify_sha256 "$expected" "$archive"

  extracted="$WORK_DIR/node-extracted"
  mkdir -p "$extracted"
  tar -xzf "$archive" -C "$extracted"
  node_root=$(find "$extracted" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -x "$node_root/bin/node" ] || fail "downloaded Node.js archive has an unexpected layout"
  bundled="$RUNTIME_DIR/${archive_name%.tar.gz}"
  if [ ! -x "$bundled/bin/node" ]; then
    mv "$node_root" "$bundled"
  fi
  NODE_BIN="$bundled/bin/node"
}

select_node() {
  if [ -n "${TOKENOMICS_NODE_BIN:-}" ]; then
    NODE_BIN=$TOKENOMICS_NODE_BIN
    [ -x "$NODE_BIN" ] || fail "TOKENOMICS_NODE_BIN is not executable: $NODE_BIN"
    major=$(node_major "$NODE_BIN")
    [ -n "$major" ] && [ "$major" -ge 26 ] || fail "TOKENOMICS_NODE_BIN must be Node.js 26 or newer"
    return
  fi

  candidate=$(command -v node 2>/dev/null || true)
  if [ -n "$candidate" ]; then
    major=$(node_major "$candidate")
    if [ -n "$major" ] && [ "$major" -ge 26 ]; then
      NODE_BIN=$candidate
      return
    fi
  fi
  install_node
}

copy_application() {
  source_dir=$1
  destination=$2
  for file in app.js launcher.js package.json README.md LICENSE; do
    [ -f "$source_dir/$file" ] || fail "source is missing $file"
    cp "$source_dir/$file" "$destination/$file"
  done
  for directory in lib public; do
    [ -d "$source_dir/$directory" ] || fail "source is missing $directory/"
    cp -R "$source_dir/$directory" "$destination/$directory"
  done
  chmod +x "$destination/app.js" "$destination/launcher.js"
}

write_wrapper() {
  wrapper=$1
  entrypoint=$2
  node_q=$(shell_quote "$NODE_BIN")
  entry_q=$(shell_quote "$INSTALL_ROOT/current/$entrypoint")
  temporary="$wrapper.$$"
  {
    printf '%s\n' '#!/bin/sh'
    printf 'exec %s %s "$@"\n' "$node_q" "$entry_q"
  } > "$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$wrapper"
}

write_macos_launcher_configuration() {
  configuration_path=${TOKENOMICS_MACOS_LAUNCHER_CONFIG:-}
  if [ -z "$configuration_path" ]; then
    [ "$(uname -s)" = "Darwin" ] || return 0
    configuration_path="$HOME/Library/Application Support/Tokenomics Viewer/tokenomics-launch.json"
  fi

  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [configurationPath, command] = process.argv.slice(1);
    const temporary = `${configurationPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(configurationPath), { recursive: true });
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ schema: 1, command, args: [] }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, configurationPath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  ' "$configuration_path" "$BIN_DIR/tokenomics-launch"
}

require_command curl
require_command tar
require_command sed
require_command awk
require_command find

mkdir -p "$INSTALL_ROOT" "$RELEASES_DIR" "$RUNTIME_DIR" "$BIN_DIR"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid=$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)
  case "$lock_pid" in
    ''|*[!0-9]*) lock_pid='' ;;
  esac
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail "another installation is already running (PID $lock_pid)"
  fi
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || fail "cannot recover stale install lock: $LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "another installation started concurrently"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
WORK_DIR=$(mktemp -d "$INSTALL_ROOT/.install.XXXXXX")

select_node
release_dir=$(mktemp -d "$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
rmdir "$release_dir"
staged_release="$WORK_DIR/release"
mkdir -p "$staged_release"

if [ -n "${TOKENOMICS_SOURCE_DIR:-}" ]; then
  copy_application "$TOKENOMICS_SOURCE_DIR" "$staged_release"
else
  source_archive="$WORK_DIR/tokenomics.tar.gz"
  source_extract="$WORK_DIR/source"
  mkdir -p "$source_extract"
  say "Downloading Tokenomics Viewer..."
  download "https://github.com/$REPOSITORY/archive/refs/heads/main.tar.gz" "$source_archive"
  tar -xzf "$source_archive" -C "$source_extract"
  source_root=$(find "$source_extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$source_root" ] || fail "downloaded source archive has an unexpected layout"
  copy_application "$source_root" "$staged_release"
fi

"$NODE_BIN" "$staged_release/launcher.js" --help >/dev/null
mv "$staged_release" "$release_dir"
next_link="$INSTALL_ROOT/.current.$$"
ln -s "$release_dir" "$next_link"
"$NODE_BIN" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
  "$next_link" "$INSTALL_ROOT/current"

write_wrapper "$BIN_DIR/tokenomics" app.js
write_wrapper "$BIN_DIR/tokenomics-viewer" app.js
write_wrapper "$BIN_DIR/tokenomics-launch" launcher.js
write_macos_launcher_configuration

say "Tokenomics Viewer installed in $INSTALL_ROOT"
say "Commands installed in $BIN_DIR"
case ":${PATH:-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "Add the command directory to PATH:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ "${TOKENOMICS_NO_LAUNCH:-0}" != "1" ]; then
  say "Starting Tokenomics Viewer..."
  "$BIN_DIR/tokenomics-launch" "$@"
fi
