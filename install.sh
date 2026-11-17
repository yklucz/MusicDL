#!/usr/bin/env bash
set -euo pipefail
MUSICDL_NODE_STAGE_CREATED=0
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      cat <<'HELP'
MusicDL installer: bash ./install.sh [--check | --dry-run] [--no-system]
--check / --dry-run: read-only prerequisite and doctor checks; missing tools fail.
--no-system: refuse system package changes; isolated project downloads are allowed.
System package commands require interactive confirmation. No privileged changes run silently.
Installation configures PATH for new terminals. Reopen your terminal after setup.
HELP
      exit 0 ;;
    --check|--dry-run|--no-system) ;;
    *) printf 'Unknown installer option: %s\nUse --help.\n' "$arg" >&2; exit 2 ;;
  esac
done
compatible() {
  "$1" --eval 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(process.arch===process.argv[1]&&(a>24||(a===24&&b>=12))?0:1)' "$ARCH" >/dev/null 2>&1
}
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) printf 'Unsupported OS. Native Windows users should run .\\install.ps1.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) printf 'Unsupported CPU architecture. Node requires x64 or ARM64.\n' >&2; exit 1 ;;
esac
if [[ "$OS" == darwin ]] && [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == 1 ]]; then ARCH=arm64; fi
NODE="$(command -v node || true)"
if [[ -n "$NODE" ]] && compatible "$NODE"; then
  exec "$NODE" "$ROOT/scripts/install.mjs" "$@"
fi
VERSION=24.22.3
NAME="node-v$VERSION-$OS-$ARCH"
NODE="$ROOT/.tools/$NAME/bin/node"
if ! compatible "$NODE"; then
  for arg in "$@"; do
    if [[ "$arg" == --check || "$arg" == --dry-run ]]; then
      printf 'Missing prerequisite: Node.js >=24.12. Read-only check will not download it. Run bash ./install.sh.\n' >&2
      exit 1
    fi
  done
  for command in curl tar awk; do
    if ! command -v "$command" >/dev/null 2>&1; then
      printf 'Node bootstrap requires %s. Install it or provide Node.js >=24.12, then retry.\n' "$command" >&2; exit 1
    fi
  done
  mkdir -p "$ROOT/.tools"
  MUSICDL_CREATED_NODE_STAGE="$(mktemp -d "$ROOT/.tools/node-bootstrap.XXXXXX")"
  MUSICDL_NODE_STAGE_CREATED=1
  trap 'if [[ "$MUSICDL_NODE_STAGE_CREATED" == 1 ]]; then rm -rf -- "$MUSICDL_CREATED_NODE_STAGE"; fi' EXIT
  BASE="https://nodejs.org/dist/v$VERSION"
  printf 'Downloading official portable Node.js %s for %s/%s into this project.\n' "$VERSION" "$OS" "$ARCH"
  curl --proto '=https' --tlsv1.2 --fail --location --show-error "$BASE/SHASUMS256.txt" -o "$MUSICDL_CREATED_NODE_STAGE/SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 --fail --location --show-error "$BASE/$NAME.tar.gz" -o "$MUSICDL_CREATED_NODE_STAGE/$NAME.tar.gz"
  EXPECTED="$(awk -v f="$NAME.tar.gz" '$2 == f {print $1}' "$MUSICDL_CREATED_NODE_STAGE/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "$MUSICDL_CREATED_NODE_STAGE/$NAME.tar.gz" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$MUSICDL_CREATED_NODE_STAGE/$NAME.tar.gz" | awk '{print $1}')"
  else
    printf 'No SHA256 verifier available; refusing unverified Node archive.\n' >&2; exit 1
  fi
  if [[ ${#EXPECTED} != 64 || "$EXPECTED" != "$ACTUAL" ]]; then
    printf 'Node SHA256 verification failed; archive was not installed.\n' >&2; exit 1
  fi
  tar -xzf "$MUSICDL_CREATED_NODE_STAGE/$NAME.tar.gz" -C "$MUSICDL_CREATED_NODE_STAGE"
  if [[ -e "$ROOT/.tools/$NAME" ]]; then
    printf 'An incompatible directory already exists at %s. Inspect it before retrying.\n' "$ROOT/.tools/$NAME" >&2; exit 1
  fi
  mv "$MUSICDL_CREATED_NODE_STAGE/$NAME" "$ROOT/.tools/$NAME"
  if ! compatible "$NODE"; then
    printf 'Downloaded Node cannot run here. Linux needs a Node-supported glibc distribution; use a compatible system Node.\n' >&2; exit 1
  fi
fi
if [[ "$MUSICDL_NODE_STAGE_CREATED" == 1 ]]; then
  rm -rf -- "$MUSICDL_CREATED_NODE_STAGE"
  MUSICDL_NODE_STAGE_CREATED=0
  trap - EXIT
fi
exec "$NODE" "$ROOT/scripts/install.mjs" "$@"
