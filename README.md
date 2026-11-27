# ppk-push-server

Server notifikasi PPK berbasis Node.js (tanpa Firebase Cloud Functions/Blaze dan tanpa FCM SDK). Server mengawasi perubahan Firestore, menulis inbox `users/{uid}/notifications`, mengantre pengiriman di `push_delivery`, lalu mengirim lewat Expo Push Service. Antrean diproses ulang untuk retry dan pengecekan receipt.

## Trigger

| Kejadian | Dokumen | Perubahan |
| --- | --- | --- |
| `session_scheduled` | `sessions/{id}` | dokumen baru dengan status `scheduled` |
| `session_opened` | `sessions/{id}` | `scheduled` → `open` |
| `schedule_changed` | `sessions/{id}` | `startsAt`, `endsAt`, `lab`, atau `labId` berubah |
| `leave_decided` | `leave_requests/{id}` | `pending` → `approved`/`rejected` |
| `fine_issued` | `fines/{id}` | dokumen denda baru dengan status `unpaid` |
| `payment_success` | `payment_transactions/{id}` | status menjadi `success` |
| `payment_failed` | `payment_transactions/{id}` | status menjadi `failed` |

Inbox selalu ditulis untuk semua kejadian di atas, walau push sudah lewat jendela 60 menit atau perangkat tidak punya token. ID dokumen inbox dan antrean deterministik, jadi pemicu yang diulang tidak membuat notifikasi ganda.

## Penyiapan (WSL/Linux)

```bash
cp .env.example .env
# isi .env: EXPO_PUSH_ACCESS_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, dan TUNNEL_TOKEN bila perlu
# taruh serviceAccount.json di root repo (jangan commit)
chmod +x scripts/*.sh
./scripts/setup.sh
```

Variabel lingkungan:

| Nama | Wajib | Keterangan |
| --- | --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | ya | path ke file service account Firebase Admin |
| `EXPO_PUSH_ACCESS_TOKEN` | ya | token akses Expo Push Service |
| `PORT` | tidak | default `8787` untuk endpoint `/health` |
| `LOG_FILE` | tidak | default `./logs/server.log` |
| `QUEUE_INTERVAL_MS` | tidak | interval pemrosesan antrean, default `60000` |
| `TUNNEL_TOKEN` | tidak | dipakai profile Cloudflare Tunnel |

Aktifkan Firestore TTL pada field `expireAt` koleksi `push_delivery` agar riwayat antrean dibersihkan otomatis (7 hari setelah kejadian).

## Script

- `npm run check` — pemeriksaan sintaks sumber.
- `npm test` — tes pembentuk event, inbox, dan pesan push.
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

Endpoint `/health` menampilkan status `ready` tiap koleksi yang dipantau dan waktu terakhir antrean diproses.

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

## Catatan

- Proses harus selalu berjalan agar real-time; antrean yang tertinggal diproses saat server mulai lagi.
- Token device dibaca dari `users/{uid}/push_tokens/{installationId}`. Token yang ditolak Expo (`DeviceNotRegistered`) dihapus hanya jika nilainya masih sama.
- `serviceAccount.json`, `.env`, `logs/`, dan credential Cloudflare jangan di-commit.
