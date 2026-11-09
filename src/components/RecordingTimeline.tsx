import { useCallback, useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { Camera } from '../types';
import {
  api,
  type RecordingTimelineResponse,
  type RecordingPlayResponse,
  type RecordingStatus,
} from '../lib/api';
import { formatDateTime } from '../lib/format';

interface Props {
  cameras: Camera[];
}

/** 本地日历日的 [00:00, 次日 00:00) 转 epoch ms，服务端文件名按 UTC 解释。 */
function localDayRange(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const from = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  const to = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
  return { from, to };
}

function todayValue() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 持续录像时间线（设计文档 §7）。
 * 展示有录像的连续块、告警保护段与无录像缺口，点击块可定位时刻；
 * 选定时段后通过按需回放会话（HLS）播放，或导出该时段的 MP4。
 */
export default function RecordingTimeline({ cameras }: Props) {
  const [cameraId, setCameraId] = useState(cameras[0]?.id ?? '');
  const [date, setDate] = useState(todayValue());
  const [data, setData] = useState<RecordingTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedRange, setSelectedRange] = useState<{ from: number; to: number } | null>(null);
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [session, setSession] = useState<RecordingPlayResponse | null>(null);
  const [playLoading, setPlayLoading] = useState(false);
  const [playerError, setPlayerError] = useState('');
  const [exportLoading, setExportLoading] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  // 每次播放/刷新/停止/卸载自增，用于丢弃在途请求与异步回调，避免卸载后 setState。
  const generationRef = useRef(0);
  const exportTimerRef = useRef<number | null>(null);

  /**
   * 幂等地销毁 HLS 实例并释放 <video> 资源。
   * target 用于在 effect cleanup 中传入闭包捕获的元素（ref 可能已被 React 置空）。
   */
  const cleanupPlayback = useCallback((target?: HTMLVideoElement | null) => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = target ?? videoRef.current;
    if (video) {
      video.pause();
      video.src = '';
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  const load = useCallback(async () => {
    if (!cameraId) return;
    // 点位/日期变化或刷新：让在途播放请求失效并释放播放器。
    generationRef.current += 1;
    cleanupPlayback();
    setSession(null);
    setPlayerError('');
    setPlayLoading(false);
    setSelected(null);
    setSelectedRange(null);
    setLoading(true);
    setError('');
    try {
      const { from, to } = localDayRange(date);
      setData(await api.recordingsTimeline({ cameraId, from, to }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '时间线加载失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [cameraId, date, cleanupPlayback]);

  useEffect(() => {
    void load();
  }, [load]);

  // 采集状态：挂载时拉取一次，失败静默降级，不影响时间线。
  useEffect(() => {
    let cancelled = false;
    void api
      .recordingsStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        /* 状态接口不可用时静默降级 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载：失效在途请求、销毁播放器、清理导出计时器。
  useEffect(
    () => () => {
      generationRef.current += 1;
      cleanupPlayback();
      if (exportTimerRef.current !== null) {
        window.clearTimeout(exportTimerRef.current);
        exportTimerRef.current = null;
      }
    },
    [cleanupPlayback],
  );

  // 会话就绪后附着 hls.js（或回退到原生 HLS）；cleanup 成对释放。
  useEffect(() => {
    if (!session) return;
    const video = videoRef.current;
    if (!video) return;
    const generation = generationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const { default: HlsPlayer } = await import('hls.js');
        if (cancelled || generationRef.current !== generation) return;
        if (HlsPlayer.isSupported()) {
          const hls = new HlsPlayer();
          hlsRef.current = hls;
          hls.loadSource(session.playlist);
          hls.attachMedia(video);
          hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
            if (!cancelled && generationRef.current === generation) {
              void video.play().catch(() => {});
            }
          });
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (data.fatal && !cancelled && generationRef.current === generation) {
              setPlayerError('回放流加载失败，请点击重试');
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = session.playlist;
          void video.play().catch(() => {});
        } else {
          setPlayerError('当前浏览器不支持 HLS 回放');
        }
      } catch {
        if (!cancelled) setPlayerError('播放器加载失败，请点击重试');
      }
    })();
    return () => {
      cancelled = true;
      cleanupPlayback(video);
    };
  }, [session, cleanupPlayback]);

  const handlePlay = useCallback(async () => {
    if (!selectedRange) return;
    generationRef.current += 1;
    cleanupPlayback();
    const generation = generationRef.current;
    setSession(null);
    setPlayerError('');
    setPlayLoading(true);
    try {
      const result = await api.recordingsPlay({
        cameraId,
        from: selectedRange.from,
        to: selectedRange.to,
      });
      if (generationRef.current !== generation) return;
      setSession(result);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setPlayerError(`回放请求失败：${cause instanceof Error ? cause.message : '未知错误'}`);
    } finally {
      if (generationRef.current === generation) setPlayLoading(false);
    }
  }, [cameraId, selectedRange, cleanupPlayback]);

  const handleStop = useCallback(() => {
    generationRef.current += 1;
    cleanupPlayback();
    setSession(null);
    setPlayerError('');
    setPlayLoading(false);
  }, [cleanupPlayback]);

  const handleExport = useCallback(() => {
    if (!selectedRange || exportLoading) return;
    setExportLoading(true);
    const { from, to } = selectedRange;
    const url = api.recordingsExportUrl({ cameraId, from, to });
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `recording-${cameraId}-${from}-${to}.mp4`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // 浏览器下载不会回调，用短计时器复位 loading 防重复点击。
    if (exportTimerRef.current !== null) window.clearTimeout(exportTimerRef.current);
    exportTimerRef.current = window.setTimeout(() => {
      exportTimerRef.current = null;
      setExportLoading(false);
    }, 1500);
  }, [cameraId, selectedRange, exportLoading]);

  const timeline = data?.timeline;
  const span = timeline ? timeline.to - timeline.from : 1;
  const percent = (value: number) => ((value - (timeline?.from ?? 0)) / span) * 100;
  const width = (startedAt: number, endedAt: number) =>
    Math.max(((endedAt - startedAt) / span) * 100, 0.15);

  const canAct = !!timeline && timeline.blocks.length > 0 && selectedRange !== null;
  const statusText = status
    ? [
        status.enabled ? `采集运行中 ${status.active}/${status.total} 路` : '采集未启用',
        status.skipped > 0 ? `跳过 ${status.skipped} 路` : '',
        status.ffmpegAvailable ? '' : 'FFmpeg 不可用',
        `保留 ${status.retentionDays} 天`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <section className="panel recording-panel">
      <div className="panel-head">
        <div>
          <h2>持续录像回放</h2>
          <p className="panel-sub">按时间轴查看录像段与缺口；点选时段即可回放或导出 MP4</p>
        </div>
        <div className="recording-controls">
          <select
            aria-label="选择点位"
            value={cameraId}
            onChange={(event) => setCameraId(event.target.value)}
          >
            {cameras.length === 0 && <option value="">暂无点位</option>}
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </select>
          <input
            aria-label="选择日期"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="recording-error">{error}</div>}
      {statusText && <div className="recording-status">{statusText}</div>}

      {timeline && (
        <>
          <div className="recording-track" role="img" aria-label="当日录像覆盖时间线">
            {[0, 6, 12, 18].map((hour) => (
              <span key={hour} className="recording-tick" style={{ left: `${(hour / 24) * 100}%` }} />
            ))}
            {timeline.gaps.map((gap) => (
              <span
                key={`gap-${gap.startedAt}`}
                className="recording-gap"
                style={{ left: `${percent(gap.startedAt)}%`, width: `${width(gap.startedAt, gap.endedAt)}%` }}
              />
            ))}
            {timeline.blocks.map((block) => (
              <button
                type="button"
                key={`block-${block.startedAt}`}
                className={`recording-block${block.protected ? ' is-protected' : ''}`}
                style={{ left: `${percent(block.startedAt)}%`, width: `${width(block.startedAt, block.endedAt)}%` }}
                title={`${formatDateTime(block.startedAt)} 起，${block.segmentCount} 段，${formatBytes(block.bytes)}${block.protected ? '（告警保护）' : ''}`}
                onClick={() => {
                  setSelected(block.startedAt);
                  // 服务端单次回放/导出窗口上限 4 小时；长连续块从起点截断，避免请求被拒。
                  setSelectedRange({
                    from: block.startedAt,
                    to: Math.min(block.endedAt, block.startedAt + 4 * 60 * 60 * 1000),
                  });
                }}
              />
            ))}
          </div>
          <div className="recording-scale">
            {['00:00', '06:00', '12:00', '18:00', '24:00'].map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className="recording-legend">
            <span><i className="recording-swatch is-recorded" />有录像</span>
            <span><i className="recording-swatch is-protected" />告警保护</span>
            <span><i className="recording-swatch is-gap" />无录像</span>
            <span className="recording-summary">
              {timeline.segmentCount} 段 · 覆盖 {(timeline.coverageMs / 3600000).toFixed(1)} 小时
            </span>
          </div>

          <div className="recording-actions">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void handlePlay()}
              disabled={!canAct || playLoading}
            >
              {playLoading ? '准备中…' : '播放该时段'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleExport}
              disabled={!canAct || exportLoading}
            >
              {exportLoading ? '导出中…' : '导出该时段'}
            </button>
            {session && (
              <button type="button" className="btn btn-sm" onClick={handleStop}>
                停止播放
              </button>
            )}
          </div>

          {playerError && (
            <div className="recording-action-error">
              <span>{playerError}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void handlePlay()}
                disabled={!canAct || playLoading}
              >
                重试
              </button>
            </div>
          )}

          {session && (
            <div className="recording-player">
              <video ref={videoRef} className="recording-video" controls playsInline />
              <p className="recording-player-meta">
                回放时段 {formatDateTime(session.from)} — {formatDateTime(session.to)} · {session.segmentCount} 段
              </p>
            </div>
          )}

          {timeline.blocks.length === 0 ? (
            <div className="empty-state">
              <strong>该日暂无录像段</strong>
              <p>持续录像采集启用后，段文件会每 5 分钟自动对账并出现在此处。</p>
            </div>
          ) : (
            <p className="recording-hint">
              {selected === null
                ? '点击时间条上的蓝色/红色区块可定位到该时刻。'
                : `已定位 ${formatDateTime(selected)}；可播放该时段或导出 MP4（单次最多 4 小时）。`}
            </p>
          )}
          {!data?.enabled && (
            <p className="recording-hint">
              当前未启用持续录像采集（RECORDING=1 后生效）；索引、对账与回放/导出链路已可用。
            </p>
          )}
        </>
      )}
    </section>
  );
}
