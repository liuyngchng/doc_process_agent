#!/usr/bin/env bash
# doc_process_agent deploy script
# Usage: ./deploy.sh [start|stop|restart|logs|status]
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="doc_process_agent:latest"
CONTAINER="${CONTAINER:-doc_process_agent}"
HOST_PORT="${HOST_PORT:-20001}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
NETWORK="${NETWORK:-llm_net}"

# Ensure data dir exists
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/tasks" "$DATA_DIR/logs"

# Ensure network exists
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "[deploy] Creating network: $NETWORK"
  docker network create "$NETWORK"
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
      --network "$NETWORK" \
      -p "$HOST_PORT:20001" \
      -v "$DATA_DIR:/app/data" \
      --restart unless-stopped \
      "$IMAGE"
    echo "[deploy] Started on port $HOST_PORT"
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