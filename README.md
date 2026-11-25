# ppk-push-server

Server Node.js sederhana untuk push notification PPK (tanpa Firebase Cloud Functions/Blaze). Mendengarkan perubahan Firestore dan mengirim push via Expo Push API.

## Trigger
- `session_opened`: `sessions/{id}` `scheduled -> open`
- `schedule_changed`: `sessions/{id}` perubahan `startsAt/endAt/lab/labId`
- `leave_decided`: `leave_requests/{id}` `pending -> approved/rejected`

## Setup cepat (WSL/Linux)
```bash
cp .env.example .env
# isi .env: EXPO_PUSH_ACCESS_TOKEN, dan TUNNEL_TOKEN jika pakai Cloudflare
# taruh serviceAccount.json di root repo (jangan commit)
chmod +x scripts/*.sh
./scripts/setup.sh
```

## Script
- `./scripts/setup.sh` — auto setup: buat `.env` jika belum ada, cek file wajib, build+start.
- `./scripts/start.sh` — start server (`--tunnel` untuk ikut jalankan Cloudflare Tunnel).
- `./scripts/stop.sh` — stop semua service termasuk tunnel.

## Manual Docker
```bash
docker compose up -d --build
docker compose logs -f
curl http://localhost:8787/health
docker compose down
```

## Cloudflare Tunnel (opsional)
1. Buat tunnel di Cloudflare Zero Trust > Networks > Tunnels.
2. Ambil token tunnel, isi `TUNNEL_TOKEN=` di `.env`.
3. Di konfigurasi Public Hostname tunnel, arahkan service ke `http://push-server:8787` (karena cloudflared jalan di Docker network yang sama).
4. Jalankan:
   ```bash
   ./scripts/start.sh --tunnel
   ```

## Logs
- Persisten di `logs/server.log` (mounted volume, timestamp ISO).
- Cek cepat:
  ```bash
  tail -f logs/server.log
  docker compose logs -f
  ```
- Log tetap ada di file walau container restart, jadi timestamp terakhir sebelum mati bisa dicek.

## Catatan
- Proses harus selalu berjalan agar real-time.
- Dedupe in-memory (reset saat restart).
- Token device harus ada di `users/{uid}/push_tokens/{installationId}`.
- `serviceAccount.json`, `.env`, `logs/`, credential Cloudflare jangan di-commit.
