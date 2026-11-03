# 持续录像时间线回放 · 设计文档

状态：设计定稿，待真机联调后实施（REVIEW 第三节判定为「暂缓·大」，依赖真机验证磁盘与 FFmpeg 行为）。
关联：`REVIEW.md` 第二节新功能优先级；现有告警短视频（`ALARM_CLIP_SECONDS`）与磁盘水位（`MEDIA_MAX_BYTES`）机制。

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
FFmpeg (copy, 60s/段 .ts) ──> data/recordings/<cameraId>/YYYYMMDD/*.ts
                                    │
                        RecordingIndex（SQLite 表，每段一行）
                                    │
        ┌───────────────────────────┼──────────────────────┐
   时间线 API                  播放 API（按需转码 HLS）     水位清理
/capi/recordings/timeline   /capi/recordings/play      沿用 MEDIA_MAX_BYTES
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

**目录**：`data/recordings/<cameraId>/20261103/143000.ts`（按天分目录，段名=起始时刻）。

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
| `GET /api/recordings/timeline?cameraId&date=YYYYMMDD` | 返回该日段列表（起止+gap），前端渲染时间条 |
| `GET /api/recordings/play?cameraId&from=<epoch>&to=<epoch>` | 校验站点权限 → 选出覆盖时段的段 → 启动按需转码（copy 拼接为 HLS，hls_time 2s）→ 返回 playlist 地址；复用 `MAX_CONCURRENT_STREAMS` 上限与 90s 空闲回收 |
| `GET /api/recordings/export?...` | 拼接为 MP4 下载（ evenings/取证用，复用现有告警短视频的转 MP4 逻辑） |

权限：沿用 `canAccessCameraSite`；跨站点 404 防探测与现有媒体接口一致。

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

## 9. 实施切分（真机验证通过后）

1. 采集与索引（录像 worker、对账、V8 迁移）——1 天
2. 回放 API + 按需转码——1 天
3. 前端时间线组件——1 天
4. 水位/保护段/导出——0.5 天
每步全量测试（`npm test`）+ 构建，遵循既有小步迁移约定。
