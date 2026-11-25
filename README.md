# ppk-push-server

Server Node.js sederhana untuk push notification PPK (tanpa Firebase Cloud Functions/Blaze). Server ini mendengarkan perubahan Firestore dan mengirim push via Expo Push API.

## Trigger
- `session_opened`: `sessions/{id}` berubah `scheduled -> open`
- `schedule_changed`: `sessions/{id}` berubah `startsAt/endAt/lab/labId`
- `leave_decided`: `leave_requests/{id}` berubah `pending -> approved/rejected`

## Setup
1. Copy env:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Isi `.env`:
   ```env
   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json
   EXPO_PUSH_ACCESS_TOKEN=<token dari expo.dev>
   PORT=8787
   ```
3. Taruh Firebase service account JSON sebagai `serviceAccount.json` di root repo. **Jangan commit file ini.**

## Jalankan dengan Docker (disarankan untuk deploy/WSL)
```bash
docker compose up -d --build
```
Cek:
```bash
docker compose logs -f
curl http://localhost:8787/health
```
Stop:
```bash
docker compose down
```

## Jalankan tanpa Docker
```powershell
npm install
npm start
```
atau one-click:
- Windows CMD: `scripts\start.cmd`
- PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\start.ps1`

## Catatan
- Proses harus selalu berjalan agar real-time.
- Dedupe saat ini in-memory (reset saat restart).
- Butuh token device tersimpan di `users/{uid}/push_tokens/{installationId}`.
- `serviceAccount.json` dan `.env` jangan di-commit; di Docker dimount sebagai secret/read-only.
