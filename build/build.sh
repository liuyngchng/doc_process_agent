#!/usr/bin/env bash
# doc_process_agent build script
# Usage: ./build.sh [pip_download_dir=<dir>]
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="doc_process_agent"
IMAGE="doc_process_agent:latest"

# ---- parse args ----
PIP_DOWNLOAD_DIR=""
for arg in "$@"; do
  case "$arg" in
    pip_download_dir=*) PIP_DOWNLOAD_DIR="${arg#pip_download_dir=}" ;;
  esac
done

# ---- prepare deploy/ ----
rm -rf deploy
mkdir -p deploy/claude-code deploy/certs

# Copy Node.js tarball (reuse from rd_cli if available)
NODE_TARBALL="node-v22.23.2-linux-x64.tar.xz"
if [ -f "/home/rd/workspace/rd_cli/deploy/$NODE_TARBALL" ]; then
  cp "/home/rd/workspace/rd_cli/deploy/$NODE_TARBALL" deploy/
  echo "[build] Node.js tarball copied from rd_cli"
elif [ -f "$HOME/workspace/rd_cli/deploy/$NODE_TARBALL" ]; then
  cp "$HOME/workspace/rd_cli/deploy/$NODE_TARBALL" deploy/
  echo "[build] Node.js tarball copied from rd_cli"
else
  echo "[build] Downloading Node.js v22.23.2..."
  curl -sSL "https://nodejs.org/dist/v22.23.2/$NODE_TARBALL" -o "deploy/$NODE_TARBALL"
fi

# ---- Claude Code CLI offline ----
CLAUDE_CODE_OFFLINE=""
CLAUDE_BIN=""
# Check common locations for claude binary
for candidate in \
  "$HOME/.local/bin/claude" \
  "$HOME/.npm-global/bin/claude" \
  "/usr/local/bin/claude" \
  "/home/rdcli/.npm-global/bin/claude"; do
  if [ -f "$candidate" ] && [ -x "$candidate" ]; then
    CLAUDE_BIN="$candidate"
    break
  fi
done

if [ -n "$CLAUDE_BIN" ]; then
  cp "$CLAUDE_BIN" deploy/claude-code/claude
  CLAUDE_CODE_OFFLINE="1"
  echo "[build] Claude Code CLI copied from $CLAUDE_BIN ($(du -h deploy/claude-code/claude | cut -f1))"
else
  echo "[build] Claude Code CLI not found locally, will install online in Docker build"
fi

# ---- HTTPS certs ----
HTTPS_CERT=""
if [ -f "dist/cert.pem" ] && [ -f "dist/key.pem" ]; then
  cp dist/cert.pem dist/key.pem deploy/certs/
  HTTPS_CERT="1"
  echo "[build] HTTPS certs copied"
fi

# ---- Build TypeScript ----
echo "[build] Compiling TypeScript..."

# Check if node_modules exists, if not run npm install
if [ ! -d "node_modules" ]; then
  echo "[build] Installing npm dependencies..."
  npm ci --no-audit --no-fund
fi

npx tsc
echo "[build] TypeScript compiled"

# ---- Docker build ----
echo "[build] Building Docker image: $IMAGE"
docker build \
  --build-arg CLAUDE_CODE_OFFLINE="$CLAUDE_CODE_OFFLINE" \
  --build-arg HTTPS_CERT="$HTTPS_CERT" \
  -f build/Dockerfile \
  -t "$IMAGE" \
  .

echo "[build] Done: $IMAGE"