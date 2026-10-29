#!/usr/bin/env bash
# doc_process_agent deploy script
# Usage: ./deploy.sh [start|stop|restart|logs|status]
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="doc_process_agent:0.1.0"
CONTAINER="${CONTAINER:-doc_process_agent}"
HOST_PORT="${HOST_PORT:-20001}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
NETWORK="${NETWORK:-llm_net}"

# Ensure data dir exists
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/tasks" "$DATA_DIR/logs" "$DATA_DIR/.claude"

# Detect host UID/GID (use current user to match data dir ownership)
HOST_UID=$(id -u)
HOST_GID=$(id -g)

# Check cfg.yml
if [ ! -f "$DATA_DIR/cfg.yml" ]; then
  echo "[deploy] cfg.yml 不存在，从模板复制..."
  cp "$(pwd)/data/cfg.yml.template" "$DATA_DIR/cfg.yml"
  echo "[deploy] 请编辑 $DATA_DIR/cfg.yml 后再启动"
fi

# Ensure network exists
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "[deploy] Creating network: $NETWORK"
  docker network create "$NETWORK"
fi

# Detect local IP
LOCAL_IP=$(ip -4 addr show scope global | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi

case "${1:-start}" in
  start)
    # Check if image exists
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "[deploy] Image not found. Run ./build/build.sh first."
      exit 1
    fi

    # Stop existing container if running
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      docker stop "$CONTAINER" 2>/dev/null || true
      docker rm "$CONTAINER" 2>/dev/null || true
    fi

    echo "[deploy] Starting container: $CONTAINER"
    docker run -d \
      --name "$CONTAINER" \
      --user "$HOST_UID:$HOST_GID" \
      --network "$NETWORK" \
      -p "$HOST_PORT:20001" \
      -v "$DATA_DIR:/app/data" \
      -v "$DATA_DIR/.claude:/home/agent/.claude" \
      --restart unless-stopped \
      "$IMAGE"
    echo "[deploy] Started on port $HOST_PORT"
    echo ""
    # 检查镜像是否内含证书，决定用 http 还是 https
    PROTO="http"
    if docker run --rm --entrypoint /bin/sh "$IMAGE" -c "test -f /app/deploy/certs/cert.pem && echo yes || echo no" 2>/dev/null | grep -q yes; then
      PROTO="https"
    fi
    if [ -n "$LOCAL_IP" ]; then
      echo "  管理后台:  $PROTO://$LOCAL_IP:$HOST_PORT/admin"
      echo "  健康检查:  $PROTO://$LOCAL_IP:$HOST_PORT/health"
      echo "  业务接口:  POST $PROTO://$LOCAL_IP:$HOST_PORT/api/v1/<path>"
    else
      echo "  管理后台:  $PROTO://localhost:$HOST_PORT/admin"
      echo "  健康检查:  $PROTO://localhost:$HOST_PORT/health"
      echo "  业务接口:  POST $PROTO://localhost:$HOST_PORT/api/v1/<path>"
    fi
    echo ""
    echo "  (自签证书，浏览器访问请点\"高级\"→\"继续\")"
    echo ""
    ;;

  stop)
    echo "[deploy] Stopping container: $CONTAINER"
    docker stop "$CONTAINER" || true
    docker rm "$CONTAINER" || true
    echo "[deploy] Stopped"
    ;;

  restart)
    "$0" stop
    "$0" start
    ;;

  logs)
    docker logs -f --tail=100 "$CONTAINER"
    ;;

  status)
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      echo "Container: $CONTAINER"
      docker inspect "$CONTAINER" --format 'Status: {{.State.Status}} | Port: {{(index .NetworkSettings.Ports "20001/tcp" 0).HostPort}} | Started: {{.State.StartedAt}}'
    else
      echo "Container not running"
    fi
    ;;

  *)
    echo "Usage: $0 [start|stop|restart|logs|status]"
    exit 1
    ;;
esac