#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[setup] ppk-push-server"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker tidak ditemukan. Install Docker dulu." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose tidak tersedia." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[setup] .env dibuat dari .env.example - isi EXPO_PUSH_ACCESS_TOKEN dan TUNNEL_TOKEN bila perlu."
fi

mkdir -p logs
chmod 777 logs 2>/dev/null || true

if [ ! -f serviceAccount.json ]; then
  echo "[setup] WARNING: serviceAccount.json belum ada. Taruh file Firebase service account di root repo."
fi

if grep -q '^EXPO_PUSH_ACCESS_TOKEN=$' .env; then
  echo "[setup] WARNING: EXPO_PUSH_ACCESS_TOKEN masih kosong di .env."
fi

docker compose up -d --build
echo "[setup] selesai. Cek: docker compose logs -f"
