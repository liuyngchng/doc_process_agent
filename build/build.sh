#!/usr/bin/env bash
# doc_process_agent Docker 镜像构建脚本
set -euo pipefail

# ---------------------------------------------------------------------------
# Usage:
#   ./build.sh                                    # 无代理构建
#   ./build.sh http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
#   VERSION=0.1.0 ./build.sh                      # 通过环境变量指定版本
# ---------------------------------------------------------------------------

BUILD_START=$SECONDS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_NAME="${IMAGE_NAME:-doc_process_agent}"

# ── Usage ────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
用法: ./build.sh [version] [proxy...]

参数说明:
  version                 镜像版本号（位置参数）
  -h | --help             显示本帮助并退出

代理参数（可选，不带 = 时继承环境变量，仅构建时使用，不写入镜像）:
  http_proxy=<url>        设置 HTTP 代理
  https_proxy=<url>       设置 HTTPS 代理
  no_proxy=<url>          设置不走代理的地址列表

示例:
  ./build.sh 0.1.0 http_proxy=http://127.0.0.1:7890
  VERSION=0.1.0 ./build.sh
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────
TAG_VERSION=""
HTTP_PROXY_VAL=""
HTTPS_PROXY_VAL=""
NO_PROXY_VAL=""

for arg in "$@"; do
  case "$arg" in
    http_proxy=*|HTTP_PROXY=*)        HTTP_PROXY_VAL="${arg#*=}" ;;
    https_proxy=*|HTTPS_PROXY=*)      HTTPS_PROXY_VAL="${arg#*=}" ;;
    no_proxy=*|NO_PROXY=*)            NO_PROXY_VAL="${arg#*=}" ;;
    -h|--help|help)                   usage; exit 0 ;;
    -*)                               echo "WARNING: 未知参数 '$arg'，已忽略（用 -h 查看用法）" ;;
    *)                                TAG_VERSION="$arg" ;;
  esac
done

# Resolve version: $VERSION env > positional arg > package.json > "0.1.0"
if [ -z "$TAG_VERSION" ]; then
  if [ -n "${VERSION:-}" ]; then
    TAG_VERSION="$VERSION"
  else
    PKG_JSON="$PROJECT_ROOT/package.json"
    if [ -f "$PKG_JSON" ] && command -v node &>/dev/null; then
      TAG_VERSION=$(node -e "process.stdout.write(require('$PKG_JSON').version)" 2>/dev/null) || true
    fi
    TAG_VERSION="${TAG_VERSION:-0.1.0}"
  fi
fi

# 不带 = 时继承环境变量
HTTP_PROXY_VAL="${HTTP_PROXY_VAL:-${HTTP_PROXY:-${http_proxy:-}}}"
HTTPS_PROXY_VAL="${HTTPS_PROXY_VAL:-${HTTPS_PROXY:-${https_proxy:-}}}"
NO_PROXY_VAL="${NO_PROXY_VAL:-${NO_PROXY:-${no_proxy:-}}}"

# 自动补全 scheme（裸 IP:端口 → http://IP:端口）
add_scheme() {
  local v="$1"
  [[ -z "$v" || "$v" == *"://"* ]] && { printf '%s' "$v"; return; }
  printf 'http://%s' "$v"
}
HTTP_PROXY_VAL="$(add_scheme "$HTTP_PROXY_VAL")"
HTTPS_PROXY_VAL="$(add_scheme "$HTTPS_PROXY_VAL")"

FULL_TAG="${IMAGE_NAME}:${TAG_VERSION}"

echo "============================================"
echo " Building ${FULL_TAG}"
echo "============================================"
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  echo " 代理 (仅构建时): http=$HTTP_PROXY_VAL https=$HTTPS_PROXY_VAL no_proxy=$NO_PROXY_VAL"
fi
echo ""

# ---- Docker build args (ARG, not ENV — 不写入最终镜像) ----
DOCKER_BUILD_ARGS=()
if [[ -n "$HTTP_PROXY_VAL" || -n "$HTTPS_PROXY_VAL" ]]; then
  DOCKER_BUILD_ARGS=(
    --build-arg "HTTP_PROXY=$HTTP_PROXY_VAL"
    --build-arg "HTTPS_PROXY=$HTTPS_PROXY_VAL"
    --build-arg "NO_PROXY=$NO_PROXY_VAL"
  )
fi

# ---- prepare deploy/ ----
rm -rf "$SCRIPT_DIR/deploy"
mkdir -p "$SCRIPT_DIR/deploy/claude-code" "$SCRIPT_DIR/deploy/certs"

# ---- Node.js tarball ----
NODE_TARBALL="node-v22.23.2-linux-x64.tar.xz"
NODE_TARBALL_PATH="$SCRIPT_DIR/deploy/$NODE_TARBALL"

# 若本地缓存目录已有该 tarball 则复用，否则联网下载
NODE_CACHE_DIR="${NODE_CACHE_DIR:-$HOME/.cache/doc-process-agent}"
if [ -f "$NODE_CACHE_DIR/$NODE_TARBALL" ]; then
  cp "$NODE_CACHE_DIR/$NODE_TARBALL" "$NODE_TARBALL_PATH"
  echo "[build] Node.js 从本地缓存复用"
else
  echo "[build] 下载 Node.js v22.23.2..."
  # 导出代理供 curl 使用（仅本次 shell 进程）
  if [[ -n "$HTTP_PROXY_VAL" ]]; then
    export http_proxy="$HTTP_PROXY_VAL" https_proxy="$HTTPS_PROXY_VAL"
  fi
  mkdir -p "$NODE_CACHE_DIR"
  curl -sSL "https://nodejs.org/dist/v22.23.2/$NODE_TARBALL" -o "$NODE_TARBALL_PATH"
  cp "$NODE_TARBALL_PATH" "$NODE_CACHE_DIR/$NODE_TARBALL"
  echo "[build] Node.js 已缓存到 $NODE_CACHE_DIR"
fi

# ---- Claude Code CLI local binary sync ----
CLAUDE_CODE_STAGING="$SCRIPT_DIR/deploy/claude-code"
CLAUDE_CODE_SRC=""
for candidate in \
  "$(command -v claude 2>/dev/null)" \
  "/home/linuxbrew/.linuxbrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude" \
  "$HOME/.local/bin/claude" \
  "$HOME/.npm-global/bin/claude" \
  "/home/rdcli/.npm-global/bin/claude"; do
  if [[ -n "$candidate" && -f "$candidate" ]]; then
    CLAUDE_CODE_SRC="$candidate"
    break
  fi
done

if [[ -n "$CLAUDE_CODE_SRC" ]]; then
  mkdir -p "$CLAUDE_CODE_STAGING"
  cp -f "$CLAUDE_CODE_SRC" "$CLAUDE_CODE_STAGING/claude"
  chmod +x "$CLAUDE_CODE_STAGING/claude"
  echo "[build] Claude Code CLI 已本地化 ($(du -h "$CLAUDE_CODE_STAGING/claude" | cut -f1))"
  DOCKER_BUILD_ARGS+=(--build-arg "CLAUDE_CODE_OFFLINE=1")
else
  echo "[build] 未找到本地 claude，将回退到镜像内 npm install -g（需联网）"
  mkdir -p "$CLAUDE_CODE_STAGING"
  touch "$CLAUDE_CODE_STAGING/.gitkeep"
fi

# ---- HTTPS certs ----
CERTS_DIR="$SCRIPT_DIR/deploy/certs"
CERT_FILE="$CERTS_DIR/cert.pem"
KEY_FILE="$CERTS_DIR/key.pem"

if [ -f "$PROJECT_ROOT/dist/cert.pem" ] && [ -f "$PROJECT_ROOT/dist/key.pem" ]; then
  cp "$PROJECT_ROOT/dist/cert.pem" "$CERT_FILE"
  cp "$PROJECT_ROOT/dist/key.pem" "$KEY_FILE"
  DOCKER_BUILD_ARGS+=(--build-arg "HTTPS_CERT=1")
  echo "[build] HTTPS 证书已复制"
fi

# ---- Install dependencies + compile TypeScript ----
echo "[build] 安装 npm 依赖..."
cd "$PROJECT_ROOT"
# 导出代理供 npm 使用（仅本次 shell 进程）
if [[ -n "$HTTP_PROXY_VAL" ]]; then
  export http_proxy="$HTTP_PROXY_VAL" https_proxy="$HTTPS_PROXY_VAL" no_proxy="$NO_PROXY_VAL"
fi

if [ ! -d "node_modules" ]; then
  npm install --no-audit --no-fund
fi

echo "[build] 编译 TypeScript..."
npx tsc
echo "[build] TypeScript 编译完成"

# ---- Docker build ----
echo ""
echo "=== Docker build ==="

# 检查 buildx 是否可用
if ! docker buildx version &>/dev/null; then
  echo "ERROR: 未检测到 docker buildx，请安装后重试。"
  echo ""
  echo "安装方式:"
  echo "  Ubuntu/Debian: sudo apt-get install docker-buildx-plugin"
  echo "  或从 GitHub 下载: https://github.com/docker/buildx/releases"
  echo "  安装文档: https://docs.docker.com/buildx/install/"
  exit 1
fi

# 确保存在一个 docker-container driver 的 buildx builder，以支持跨构建持久化缓存。
# docker driver 的 --mount=type=cache 只在单次构建中有效。
BUILDER_NAME="${BUILDER:-doc-agent-builder}"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  echo "[build] 创建 buildx builder: $BUILDER_NAME (docker-container driver)"
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
  docker buildx use "$BUILDER_NAME" &>/dev/null || true
fi

docker buildx build \
    --builder "$BUILDER_NAME" \
    "${DOCKER_BUILD_ARGS[@]+"${DOCKER_BUILD_ARGS[@]}"}" \
    -t "${FULL_TAG}" \
    -t "${IMAGE_NAME}:latest" \
    -f "$SCRIPT_DIR/Dockerfile" \
    --load \
    "$PROJECT_ROOT"

# Remove dangling images
echo ""
echo "=== 清理 dangling 镜像 ==="
docker image prune -f --filter "dangling=true" || true

BUILD_ELAPSED=$(( SECONDS - BUILD_START ))
echo "============================================"
echo " Build complete: ${FULL_TAG}"
printf " 总耗时: %dm %ds\n" $(( BUILD_ELAPSED / 60 )) $(( BUILD_ELAPSED % 60 ))
echo "============================================"
echo ""
echo "Run with:"
echo ""
echo "  ./deploy.sh"
echo ""