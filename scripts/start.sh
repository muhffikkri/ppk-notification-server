#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p logs
chmod 777 logs 2>/dev/null || true

PROFILE_ARGS=()
if [ "${1:-}" = "--tunnel" ]; then
  if grep -q '^TUNNEL_TOKEN=$' .env 2>/dev/null || ! grep -q '^TUNNEL_TOKEN=' .env 2>/dev/null; then
    echo "TUNNEL_TOKEN belum diisi di .env" >&2
    exit 1
  fi
  PROFILE_ARGS=(--profile tunnel)
fi

docker compose "${PROFILE_ARGS[@]}" up -d --build
docker compose "${PROFILE_ARGS[@]}" ps
