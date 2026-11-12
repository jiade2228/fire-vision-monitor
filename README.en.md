# Flame Vision — Fire & Smoke Video Monitoring

[简体中文](./README.md) · **English**

> **Deployment & delivery**: one-command deploy parameters in §4, deliverables and acceptance baseline in [DELIVERY.md](./DELIVERY.md) (Chinese with English summary), macOS support in [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md).

A dual-stack (browser + server) fire and smoke detection platform. It ingests on-site cameras (RTSP / ONVIF / IP cameras / edge gateway), detects fire and smoke 24/7, and on a hit raises an alarm with a snapshot and a short clip, then pushes notifications to WeCom / DingTalk / generic webhooks per site. It supports multi-site isolation, multiple roles, a full alarm-handling workflow, trend dashboards and an audit log.

If you have no real camera, the built-in **demo mode** (FFmpeg-generated synthetic flame stream) exercises the whole pipeline end to end.

---

## 1. Features

| Area | Capability |
|---|---|
| Ingest | RTSP → low-latency HLS; ONVIF auto-discovery and import; WS-Discovery network scan; bulk import from 13+ NVR brands (Hikvision / Dahua / Uniview / Axis, etc.); edge gateway tunnel for sites without a public IP |
| Detection | Server-side 24/7 engine (one FFmpeg frame-grabber per camera, 160×90@1fps, ROI masking, brightness-flicker criterion, per-camera sensitivity); camera-health detection (occlusion / too dark / overexposed, alarms after sustained anomaly, auto-archives on recovery); browser-side detection fallback; automatic de-duplication between the two |
| Alarms | Real-time SSE push; auto-escalation when unacknowledged; camera-offline alarms with automatic archival on recovery; snapshot + H.264 clip; clip timeline playback (click to play, previous/next, autoplay); daily duty summary (rolling 24h) |
| Recording | With `RECORDING=1`, 24/7 substream copy-segmented recording (60s TS segments, UTC day folders); 5-minute reconciliation backfill; 24h timeline showing recorded / alarm-protected / gaps; on-demand HLS playback, or MP4 export; alarm-window protection with day- and size-based retention |
| Notifications | WeCom / DingTalk / generic webhook (HMAC-SHA256 signing); configurable message templates (site / camera / time / confidence / handling link); channel secrets encrypted at rest; per alarm+channel+event de-duplication; auto-disable after consecutive failures with broadcast reminder (channel self-healing) |
| Access control | Global admin / site admin / operator / viewer; site-level data isolation enforced per request; SSE delivery scoped by site |
| Observability | Alarm trend dashboard (by day / site / false-alarm rate); audit log (filter + paginate + export); disk watermark protection (days + capacity) |
| Duty | Auto tour on the wall (full-screen each online camera, 10/15/30/60s, pause, previous/next, skips cameras without a source) |
| Management | Bulk camera operations (enable/disable detection / sensitivity / delete); arming schedule per camera (detection pauses outside armed windows, playback unaffected, cross-midnight supported); false-alarm hotspot hints (7-day hot spots suggest sensitivity or ROI changes); three-step empty-state onboarding |
| Demo | Demo mode: FFmpeg-generated flame stream that exercises playback → detection → alarm → snapshot → push → statistics without hardware; one-click purge |

## 2. Requirements

- **Node.js ≥ 22.5** (uses built-in `node:sqlite`, experimental)
- **FFmpeg** (recommended; add to PATH or set `FFMPEG_PATH`; FFprobe optional, used for stream probing)
  - `libx264` is **not** required: encoders are probed at startup and fall back (`libx264 → h264 → mpeg4`)
  - On macOS the Homebrew locations `/opt/homebrew/bin` and `/usr/local/bin` are probed automatically
- Operating systems: **Windows 10/11**, **Linux**, **macOS 11 (Big Sur) or later**
  - macOS scope and installation (including launchd) — see [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md)
- Memory / CPU: roughly one FFmpeg frame-grabber per camera (160×90@1fps, low CPU); one FFmpeg transcode per concurrent viewer. A demo plus one viewer totals ~3 processes.
- Chrome (optional): only for E2E tests and the contrast scan (paths for macOS/Linux/Windows are all supported)

## 3. Quick start

```bash
npm ci                # install dependencies
npm run build         # type-check + build the frontend into dist/
npm start             # production run, defaults to 0.0.0.0:4173
```

Opening `http://<server-ip>:4173` for the first time walks you through creating the admin account (one-time; `/api/setup` closes afterwards).

Development mode (Vite HMR + API):

```bash
npm run dev           # Vite 5173 + API 8787
```

## 4. Deployment

### 4.0 One-command deploy (recommended)

The repository ships an idempotent deploy script. It is **safe to re-run**, keeps a database backup, and prints rollback steps on failure.

| Platform | Script |
|---|---|
| Windows | `scripts\deploy.ps1` |
| Linux / macOS | `scripts/deploy.sh` |

Common parameters (same names on both): `-DryRun/--dry-run` (checks only), `-NoRestart/--no-restart`, `-SkipInstall/--skip-install` (offline), `-SkipBuild`, `-SkipTests`, `-SkipBackup`, `-DataDir`, `-Port`.

Order: **preflight → database backup (`VACUUM INTO` + `integrity_check`) → install → build → test → restart → health check**. Logs go to `data/logs/deploy-<timestamp>.log`.

Exit codes: `0` success, `1` preflight, `2` backup, `3` install/build/test, `4` restart, `5` health check.

Requirements: Node ≥ 22.5 and npm. FFmpeg/ffprobe are recommended; without them RTSP transcoding, recording and snapshots are unavailable, while HLS sources still play.

### 4.1 Bare metal + watchdog (optional)

`scripts/fire-watchdog.ps1` probes `/healthz` every 30 seconds and restarts the instance when unhealthy; after 5 consecutive start failures it backs off for 10 minutes and writes `data/startup-failed.marker`. `scripts/start-fire-watchdog.cmd` can be placed in the startup folder. On Linux, wrap the same command with systemd:

```ini
[Unit]
Description=Flame Vision
After=network.target

[Service]
WorkingDirectory=/opt/fire-vision
ExecStart=/usr/bin/node server/boot.mjs --port 4173
Restart=always
Environment=DATA_DIR=/var/lib/fire-vision

[Install]
WantedBy=multi-user.target
```

On macOS use `scripts/launchd/com.flamevision.monitor.plist` (see the macOS guide).

> Single-instance constraint: SQLite is single-writer; **only one server process may run per `DATA_DIR`** (guarded by an instance lock).

### 4.2 Docker

Build and run with the provided `Dockerfile`; mount persistent storage for `/data` and keep `DATA_DIR=/data`.

### 4.3 Public access

If the site has no public IP, use the **edge gateway**: run `npm run edge -- --config edge-gateway.json` on site; it dials out to the central server, and phones only talk to the central server. See `edge-gateway.example.json`.

## 5. Connecting cameras

| Method | Where | Use when |
|---|---|---|
| Manual RTSP | Admin → Cameras & streams → Add camera | Address known |
| ONVIF auto-discovery | ONVIF discovery → enter IP / credentials → discover → import channels | Device supports ONVIF |
| WS-Discovery scan | ONVIF form → "Scan subnet" → fills IPs → continue with ONVIF | Finding devices on the LAN (multicast not blocked) |
| Brand NVR bulk import | Brand import → pick brand / NVR and channel range | Hikvision, Dahua and 13+ brands |
| Edge gateway | Protocol "edge gateway", address `edge://<gatewayId>/<cameraKey>` | No public IP on site |

After adding a camera: run **Probe stream** to confirm decodability → use **Snapshot preview** to configure ROI masking (street lights, always-on displays) → choose a sensitivity preset (robust / standard / sensitive).

**Extra requirement for http/https sources**: the origin must support Range requests (206). FFmpeg needs seeking; `python -m http.server` does not support Range, so the detection worker fails to start and offline alarms appear.

### 5.1 Auto tour on the video wall

The **Auto tour** button at the top-right of the live view cycles through cameras that have a playable source, full-screen, 15 seconds each by default (10/30/60s selectable). The overlay supports pause, previous/next and exit. Cameras without a source are skipped; detection and alarms keep running during the tour. Pressing ESC exits.

## 6. Demo mode (acceptance without hardware / training / demos)

Admin → Cameras & streams → Demo card → **Start demo**. Within seconds a "Demo camera (synthetic flame)" appears on the wall and raises a fire alarm (confidence 90+), with snapshot and clip, so the full handling workflow can be exercised. **Stop demo** cleans up the camera, stream and directory.

Demo alarms **are really pushed** to configured channels and count toward dashboards and the daily summary — use **Purge demo data** before formal reporting (it only removes demo alarms and their media / events / push logs; real data and audit logs are untouched).

## 7. Day-to-day operations

| Task | How |
|---|---|
| Forgot admin password | `npm run reset-password -- --username admin` (omit `--password` to generate a strong random one; all devices must sign in again) |
| Database backup | Automatic daily into `data/backups/`; also Admin → System backup, or `POST /api/admin/backup` |
| Logs | Single-line JSON on stdout (`event`/`level`/`time`); redirect to a file. Key events: `demo_*`, `camera_offline`, `media_watermark_pruned`, `daily_summary_sent`, `recording_index_reconciled`, `recording_retention_applied`, `disk_low`, `disk_full` |
| Media watermark | Snapshots + clips above `MEDIA_MAX_BYTES` (default 2GB) evict the oldest closed alarms' media; current usage via `/api/system` |
| Recording retention | Hourly eviction by `RECORDING_RETENTION_DAYS` / `RECORDING_MAX_BYTES`; protected segments release after `RECORDING_PROTECT_DAYS`; `GET /api/recordings/status`, `POST /api/recordings/reconcile` (admin) |
| Recording playback | Records page → pick a range on the timeline → play (on-demand HLS) or export MP4; max 4 hours per request, sessions reclaimed after 90s idle |
| Data retention | Alarms 180 days (`ALARM_RETENTION_DAYS`), push logs 30 days; cleaned daily |
| Upgrade | `git pull` → `npm ci` → `npm run build` → restart. Schema migrates automatically (currently **V10**: V9 performance indexes, V10 `auth_sessions`; V1→V10 paths are covered by tests, V7 rebuilds the alarms table) |
| Health check | `GET /healthz` (database / FFmpeg / disk / liveness) |

**Data directory** (`data/`, git-ignored; contains the SQLite DB, credential key, backups, media): copy it as a whole when migrating. `credentials.key` and `app.db` must travel together, otherwise encrypted channel settings cannot be decrypted.

## 8. Tests and CI

```bash
npm test        # 289 unit / integration tests (serial, ~1-2 min)
npm run e2e     # 25+ end-to-end assertions (includes failed login and anonymous 401; skips without Chrome)
npm run build   # tsc --noEmit + vite build
```

CI (`.github/workflows/ci.yml`) runs on push / PR: install FFmpeg → `npm test` → `npm run build` → `npm run e2e` (ubuntu ships Chrome, `CHROME_PATH=/usr/bin/google-chrome`).

Single-file detection pre-check (same parameters as the server engine):

```bash
node scripts/detect-file.mjs test-videos/fire.webm standard
```

## 9. Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` / `DATA_DIR` | 4173 / `./data` | Server port and data directory |
| `SERVER_DETECTION` | on (`0` disables) | Master switch for the 24/7 server-side engine |
| `DETECTION_FPS` / `DETECTION_WIDTH` / `DETECTION_HEIGHT` | 1 / 160 / 90 | Frame rate and canvas |
| `DETECTION_SENSITIVITY` / `DETECTION_COOLDOWN_MS` | standard / 12000 | Default sensitivity and cooldown |
| `DETECTION_KEYFRAMES_ONLY` | off | Decode keyframes only, much lower CPU (dozens of cameras) |
| `MAX_DETECTION_CAMERAS` | 24 | Concurrent inspected cameras; excess is counted as `skipped` |
| `CAMERA_QUALITY_CHECK` | on (`0` disables) | Camera-health detection (occlusion / dark / overexposed; alarm after 45s, auto-archive after 10s of normal frames) |
| `MAX_CONCURRENT_STREAMS` | 8 | Concurrent transcoded viewers |
| `HLS_SEGMENT_SECONDS` / `HLS_PLAYLIST_SIZE` | 1 / 4 | Segment length (1-6) and playlist size (3-12); end-to-end latency 2-4s |
| `FFMPEG_PATH` / `FFMPEG_PRESET` / `FFMPEG_VIDEO_CODEC` | ffmpeg / veryfast / libx264 | Transcoding settings |
| `OFFLINE_TIMEOUT_MS` / `OFFLINE_CHECK_INTERVAL_MS` | 60000 / 15000 | Offline threshold and check interval |
| `ESCALATION_MINUTES` / `ESCALATION_CHECK_INTERVAL_MS` | 5 / 60000 | Alarm escalation (≤0 disables) |
| `ALARM_CLIP_SECONDS` | 10 | Alarm clip length (2-60) |
| `RECORDING` | off (`1` enables) | Recording master switch; copy-segmented processes follow each camera's arming schedule. When off, index / reconcile / playback / export still work |
| `RECORDING_SEGMENT_SECONDS` | 60 | Segment length (10-600) |
| `RECORDING_RETENTION_DAYS` | 14 | Retention days (protected segments exempt; still subject to capacity eviction after protection) |
| `RECORDING_PROTECT_DAYS` | 30 | Protection window for alarm segments; released immediately when the alarm is marked as a false positive and no other open alarm shares the window |
| `RECORDING_MAX_BYTES` | 50GB (`0` disables) | Recording quota, separate from clip media watermark |
| `RECORDING_MAX_CAMERAS` | 24 | Concurrent recording cameras; excess is `skipped` |
| `RECORDING_SHARED_SOURCE` | off (`1` enables) | Experimental: share one FFmpeg input between detection and recording |
| `ALARM_RETENTION_DAYS` / `NOTIFY_RETENTION_DAYS` / `AUDIT_RETENTION_DAYS` | 180 / 30 / 180 | Retention (alarms / push logs / audit logs) |
| `MEDIA_MAX_BYTES` | 2GB (`0` disables) | Media disk watermark |
| `DAILY_SUMMARY_AT` / `DAILY_SUMMARY_FORCE` | 08:00 Asia/Shanghai / off | Daily summary time; `FORCE=1` runs once at startup |
| `NOTIFY_MAX_FAILURES` | 5 (`0` disables) | Consecutive failures before auto-disabling a channel |
| `NOTIFY_BLOCK_PRIVATE` | off (`1` enables) | Recommended on public deployments: block loopback / private / `.local` webhook targets (SSRF hardening) |
| `DEMO_WIDTH` / `DEMO_HEIGHT` / `DEMO_FPS` | 640 / 360 / 15 | Demo stream format |
| `DEMO_SEGMENT_SECONDS` / `DEMO_PLAYLIST_SIZE` | 2 / 6 | Demo stream segmentation |
| `EDGE_GATEWAY_TOKEN` | empty (disabled) | ≥16 chars; enables the central server to accept edge gateways |
| `EDGE_GATEWAY_CONFIG` | — | Config path for `npm run edge` |
| `SESSION_SECRET` / `CREDENTIALS_KEY` | generated and persisted | Session signing key / credential encryption key; external values must match existing data |
| `TRUST_PROXY` | off | Trust `X-Forwarded-For` behind a reverse proxy |
| `CHROME_PATH` / `E2E_PORT` / `E2E_HEADED` | — | E2E only |
| `E2E_ADMIN_PASSWORD` | built-in test default | Overrides the admin password of the temporary E2E instance (tests only) |
| `BACKUP_RETAIN` / `BACKUP_MAX_BYTES` | 14 / 0 (unlimited) | Backup count and total size limits |
| `CAMERA_BLOCK_PRIVATE` | off (`1` enables) | Block private/loopback camera proxy targets (default allows them; cameras are usually on the LAN) |
| `PUBLIC_BASE_URL` | empty | External base URL used in notification links |
| `FFPROBE_PATH` / `PROBE_TIMEOUT_MS` | ffprobe / 12000 | Probe tool path and timeout |
| `FFMPEG_MAX_PROCESSES` / `FFMPEG_WAIT_TIMEOUT_MS` | 8 / 30000 | Global FFmpeg process budget and queue timeout |
| `ONVIF_DISCOVERY_ADDRESS` / `ONVIF_DISCOVERY_PORT` | 239.255.255.250 / 3702 | ONVIF multicast discovery |

> **Configuration robustness**: all numeric settings go through `server/config.mjs` — non-numeric/`NaN`/out-of-range values fall back to defaults and log a `config_invalid` warning; negatives are clamped to the lower bound (a negative retention would otherwise delete history); `0` only takes effect on options documented as "0 disables". Booleans accept `1/true/yes/on` and `0/false/no/off`. `PORT` must be an integer 1-65535; `--port` overrides the environment variable.

## 10. Directory layout

```
server/            Backend (Express 5 + node:sqlite)
  boot.mjs         Entry point: Node version, data dir, long-path and binary resolution
  index.mjs        Bootstrap, middleware, instance lock, route registration
  config.mjs       Unified parsing for numeric/boolean/port/time settings
  runtime-check.mjs / binary-locate.mjs / ffmpeg-capabilities.mjs
                   Runtime self-check, ffmpeg discovery, encoder probing and fallback
  routes/          HTTP routes by domain (auth/cameras/alarms/notify/
                   sites/users/admin/demo/media/recordings)
  http/            Auth guards, sessions, login rate limiting
  net-guard.mjs    Outbound URL validation (metadata/private blocking, per-hop checks)
  schema.mjs       Table creation and V1→V10 migrations
  store.mjs        Data layer entry (openStore / Store)
  store/           Domain methods (methods/) and row helpers
  detector.mjs      Detection algorithm (shared with the server engine)
  detection-engine.mjs  24/7 detection engine
  frame-quality.mjs / schedule.mjs  Camera-health detection / arming schedule
  streams.mjs      RTSP→HLS transcoding manager
  notify.mjs       Notification delivery, templates, channel self-healing
  vendors.mjs      RTSP URL templates for 13+ NVR brands
  edge-hub/edge-gateway.mjs  Edge gateway (central / on-site side)
  onvif*.mjs       ONVIF discovery and scanning (SOAP 1.1/1.2 adaptive)
src/               Frontend (React 19 + TS + Vite 7)
scripts/           deploy.ps1 / deploy.sh / db-backup.mjs / fire-watchdog.ps1 /
                   launchd/ / e2e-smoke.mjs / contrast-scan.mjs / detect-file.mjs
docs/              Usage and design docs
test-videos/       Test videos (Wikimedia Commons CC, not committed)
data/              Runtime data (not committed): SQLite / keys / backups / media
```

## 11. FAQ

**Q: Local video test produces no alarm?**
A: Make sure "Local detection" in the top bar is not set to "Off". Local files are analysed in the browser (the server cannot see them), and frame grabbing pauses when the page goes to the background.

**Q: RTSP playback stutters / high latency?**
A: Defaults are 1-second segments and 2-4s end-to-end. On slow networks set `HLS_SEGMENT_SECONDS=2`; if it still stutters, check the camera substream bandwidth.

**Q: Demo data appears in the trend dashboard?**
A: Demo alarms count toward statistics. Use Admin → Demo card → "Purge demo data".

**Q: "Server disk space insufficient" (HTTP 507)?**
A: When the disk is full, both database and media writes are rejected. Free space under `data/recordings/` or `data/continuous/`, or expand the disk. The server logs `disk_low` every 15 minutes when free space drops below 1GB; `/healthz` flips `diskOk` to false below 50MB.

**Q: Deleting a camera says "N unhandled alarms remain"?**
A: Intentional: acknowledge or mark them as false positives first, otherwise they become orphan records that cannot be reviewed on the wall. A successful delete also cleans that camera's `streams/`, `continuous/`, playback/export temp dirs and recording index.

**Q: The service keeps restarting; `data/watchdog.log` shows repeated `start attempt failed`?**
A: After 5 consecutive start failures the watchdog backs off for 10 minutes and writes a `FATAL` line plus `data/startup-failed.marker`. Check `data/server.err.log` for the root cause (usually a corrupt database or a port conflict); fix it, delete the marker and restart the watchdog.

**Q: The demo disappeared after a server restart?**
A: By design — demos are not persisted (leftover cameras are cleaned at startup). Just start the demo again.

---

## Documentation

| Document | Content |
|---|---|
| [README.md](./README.md) | Chinese README |
| [DELIVERY.md](./DELIVERY.md) | Delivery checklist, acceptance baseline, backup/restore, upgrades, known limits |
| [SECURITY.md](./SECURITY.md) | Security model and hardening notes |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development and review conventions |
| [docs/MACOS-COMPAT.md](./docs/MACOS-COMPAT.md) | macOS scope, versions, installation, launchd |
| [docs/DISTRIBUTION-PLAN.md](./docs/DISTRIBUTION-PLAN.md) | Deployment assessment and distribution packaging plan |
| [docs/continuous-recording-design.md](./docs/continuous-recording-design.md) | Continuous recording design |
| [docs/REVIEW-CHECKLIST.md](./docs/REVIEW-CHECKLIST.md) | Review checklist (anti-regression) |
