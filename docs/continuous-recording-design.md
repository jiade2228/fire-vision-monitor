# 持续录像时间线回放 · 设计文档

状态：**全部功能已实施（索引、采集、回放、导出、保护段联动、配额淘汰、前端播放器）；§8 真机验收清单仍需在有真实设备的现场执行**。
关联：`DELIVERY.md` 已知限制；现有告警短视频（`ALARM_CLIP_SECONDS`）与磁盘水位（`MEDIA_MAX_BYTES`）机制。

> 2026-11-06 实施记录（第一阶段）
> - 录像段目录改为 **`data/continuous/<cameraId>/<YYYYMMDD>/<HHmmss>.ts`**（全部按 UTC 解释）。
>   原因：`data/recordings/` 已被告警短视频 mp4 与媒体水位扫描占用，混放会被误清理。
> - 已落地：schema V8 `recording_segments` 表、`server/recording-index.mjs`（扫描/时长校准/对账/时间线）、
>   `store/methods/recordings.mjs`、`GET /api/recordings/timeline` 与 `POST /api/recordings/reconcile`（超管）、
>   5 分钟自动对账、`src/components/RecordingTimeline.tsx`（24h 时间条 + 缺口 + 保护段）。

> 2026-11-09 实施记录（第二阶段，本次收口）
> - `server/recording-capture.mjs`：每个点位一个 FFmpeg copy 分段进程，指数退避重启、
>   布防时间表生效、并发上限；子进程显式注入 `TZ=UTC`，跨 UTC 日自动重建目录与进程。
>   真实 FFmpeg 端到端验证通过（段名 `055051.ts` 等，UTC 05 时 / 本地 13 时）。
> - `server/recording-playback.mjs`：选段/路径穿越校验/concat 列表/HLS 会话/MP4 导出。
>   会话绑定 userId 与点位，分片请求实时复核站点权限；空闲 90s 回收、并发上限复用
>   `MAX_CONCURRENT_STREAMS`。单次窗口上限 4 小时（`MAX_PLAYBACK_WINDOW_MS`）。
> - 新增接口：`GET /api/recordings/status`、`GET /api/recordings/play`、
>   `GET /api/recordings/play/:sessionId/:file`、`GET /api/recordings/export`。
> - `store/methods/recordings.mjs`：`protectSegmentsAround` / `unprotectExpiredSegments` /
>   `recordingUsage`；`onAlarm` 时自动把告警前 120s 至「短视频时长 + 60s」的段置保护。
> - 配额淘汰：`RECORDING_RETENTION_DAYS`(14) + `RECORDING_MAX_BYTES`(50GB) 双保险，
>   每小时淘汰最旧非保护段并删文件；保护段 `RECORDING_PROTECT_DAYS`(30) 后解除。
> - 前端 `RecordingTimeline.tsx` 接入 hls.js 播放与 MP4 导出，点击时间块自动裁剪到 4 小时。
> - `RECORDING=1` 现在会真正启动采集进程；不开启时索引/对账/回放/导出仍可正常使用已有段。
> - 新增 18 条回归测试（`recording-capture.test.mjs` / `recording-playback.test.mjs` /
>   `recording-store.test.mjs`），均为可注入 spawnImpl/clock 的离线夹具，不依赖真机。

---

## 1. 目标与非目标

**目标**
- 点位 7×24（或按布防时间表）持续录像，事后可按时间轴回放、跳转、导出。
- 与现有告警体系联动：告警时刻前后一段录像永久保护，不被水位淘汰。
- CPU 开销接近零：录像不转码（stream copy），播放按需转码。

**非目标（本期不做）**
- 多节点分布式存储、云存储直写。
- 音频（多数现场 RTSP 子码流无声，后续按需开启）。
- 4K 主码流直存（默认子码流，见 §3）。

## 2. 总体架构

```
FFmpeg (copy, 60s/段 .ts) ──> data/continuous/<cameraId>/YYYYMMDD/*.ts
                                    │
                        RecordingIndex（SQLite 表，每段一行）
                                    │
        ┌───────────────────────────┼──────────────────────┐
   时间线 API                  播放 API（按需转码 HLS）     水位清理
/api/recordings/timeline    /api/recordings/play       沿用 MEDIA_MAX_BYTES
```

与现有 `streams.mjs`（观看转码，8 路上限、90s 空闲停流）完全分离：录像进程独立生命周期，
观看转码只在用户拖动时间线时启动。

## 3. 采集层

- **码流选择**：默认取子码流（与检测观看一致，D1/720p），`-c:v copy -c:a copy`（无音轨自动跳过）。
  不转码意味着 CPU 仅解封装开销，24 路并发可承受；若需主码流按点位显式开启。
- **分段**：`-f segment -segment_time 60 -segment_format mpegts -reset_timestamps 1`。
  选 TS 而非 fMP4 的理由：断电/断流后单段损坏不影响其余段，且可无缝拼接。
- **进程管理**：复用 `CameraWorker` 的退避重启模式；录像 worker 与检测 worker 独立开关
  （`record_enabled` 点位列 + 全局 `RECORDING=0` 总闸），布防时间表同样生效。
- **断流补洞**：进程重启产生的时间缝隙在索引层标记 `gap`，时间线上以「无录像」呈现，不造数据。

## 4. 存储与索引

**目录**：`data/continuous/<cameraId>/20261103/143000.ts`（按天分目录，段名=起始时刻，均按 UTC 解释）。
独立于 `data/recordings/`：后者存放告警短视频 mp4 且受媒体水位扫描，混放会被误清理。

**索引表**（schema V8 迁移新增）：

```sql
CREATE TABLE recording_segments (
  id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL,
  file TEXT NOT NULL,          -- 相对 recordingsDir 路径
  started_at INTEGER NOT NULL, -- 段起始 epoch ms
  ended_at INTEGER NOT NULL,   -- 起始 + 实际时长（由 ffprobe 或 segment 回调校准）
  bytes INTEGER NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0  -- 告警保护段（水位不淘汰）
);
CREATE INDEX idx_recording_cam_start ON recording_segments(camera_id, started_at);
```

索引写入：每 5 分钟对账一次（扫描目录 vs 表），崩溃/重启后自动补录缺失段——
文件系统是事实源，表只是加速查询的缓存，对账逻辑可独立测试。

**告警保护段**：`createAlarm` 时将 `created_at - 120s` 至 `+ ALARM_CLIP_SECONDS + 60s`
范围内的段置 `protected=1`；告警归档后保护保留 30 天（`RECORDING_PROTECT_DAYS`）。

## 5. 水位与保留

- 沿用双保险：`RECORDING_RETENTION_DAYS`（默认 14 天，远短于告警 180 天）+ `MEDIA_MAX_BYTES`
  中为录像单独划一个配额（建议默认 50GB 或磁盘 70%，取小者）。
- 淘汰顺序：非保护段的最旧优先；单次清理循环上限 500 段，避免 IO 尖峰。
- `/api/system` 存储扫描把 `recordings/` 明细单列，与抓拍/告警短视频区分。

## 6. 回放 API

| 接口 | 说明 |
|---|---|
| `GET /api/recordings/timeline?cameraId&date=YYYY-MM-DD` | 返回该日段列表（起止+gap），前端渲染时间条；也支持 `from`/`to`（≤48h） |
| `GET /api/recordings/status` | 采集状态：`enabled / active / total / skipped / ffmpegAvailable / retentionDays` |
| `GET /api/recordings/play?cameraId&from=<epoch>&to=<epoch>` | 校验站点权限 → 选出覆盖时段的段 → concat demuxer + `-c copy` 生成 VOD HLS（2s 分片、`ENDLIST`）→ 返回 `{sessionId, playlist, from, to, segmentCount, expiresAt}`；窗口 ≤4h，并发复用 `MAX_CONCURRENT_STREAMS`，空闲 90s 回收 |
| `GET /api/recordings/play/:sessionId/:file` | 会话内 `index.m3u8` / `segment-NNNNN.ts`；`private, no-store`；按 userId 归属 + 实时站点鉴权，文件白名单防穿越 |
| `GET /api/recordings/export?cameraId&from=<epoch>&to=<epoch>` | concat demuxer + `-c copy -movflags +faststart` 拼接 MP4 下载，响应后删除临时文件；窗口 ≤4h |
| `POST /api/recordings/reconcile` | 超管手动触发文件系统→索引对账（定时每 5 分钟自动执行） |

权限：沿用 `canAccessCameraSite`；跨站点 404 防探测与现有媒体接口一致。回放会话额外实时复核点位站点权限，撤权后立即失效。

## 7. 前端时间线

- 新组件 `RecordingTimeline.tsx`：24h 时间条（有录像=蓝、告警保护=红、gap=灰），
  支持滚轮缩放到分钟级、拖动定位；点击 → 调 play API → 复用 `useVideoPlayback` 的 HLS 播放。
- 入口：FocusViewer 点位聚焦页加「回放」页签；告警卡片跳转到 `created_at - 2min` 时刻。
- 交互对齐现有 `AlarmClipTimeline`（告警短视频时间线）的快捷键与连播习惯。

## 8. 真机验证清单（实施前置）

- [ ] 24 路子码流 copy 录像：磁盘写入速率（预估 24 × 0.5-2 Mbps ≈ 1.5-6 MB/s）与 CPU 占用
- [ ] 断电恢复：kill -9 后重启，对账补录正确、TS 段可播
- [ ] 水位淘汰：制造超配额，验证保护段豁免与 IO 平滑
- [ ] 时间戳连续性：跨 NTP 校时/夏令时无跳变坑（段名用 UTC 或单调时钟，展示层转本地时区）
- [ ] Windows 现场路径（项目当前跑在 Windows）：文件名合法性与 fsync 行为
- [ ] 按需转码并发上限与 90s 回收在时间线拖拽场景下的体验

## 9. 实施切分（全部完成）

1. ✅ 索引层（V8 迁移、目录扫描、时长校准、5 分钟对账、时间线/对账 API、前端时间条）
2. ✅ 采集 worker（录像进程、断流退避、布防联动、跨 UTC 日切目录、`TZ=UTC` 段名）
3. ✅ 回放 API + 按需 HLS 转码（会话归属/续期/回收、路径白名单）
4. ✅ 导出（concat → MP4 下载、临时文件清理）
5. ✅ 前端播放器联动（hls.js、导出按钮、采集状态、卸载清理、4h 窗口裁剪）
6. ✅ 保护段自动联动 + 保留天数/容量双淘汰
7. ⬜ §8 真机验收清单（需真实设备，属验收动作而非实现前置）

全量基线：`npm test` 109/109、`npm run build`、`npm run e2e` 13/13；另有真实 FFmpeg + 独立实例冒烟验证。
