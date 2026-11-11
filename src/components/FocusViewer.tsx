import { useEffect, useRef } from 'react';
import type {
  Alarm,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
} from '../types';
import type { FrameAnalysis } from '../lib/detector';
import { LEVEL_META } from '../lib/detection';
import { formatTime } from '../lib/format';
import { useNow } from '../hooks/useNow';
import { useVideoPlayback } from '../hooks/useVideoPlayback';
import { useFrameDetection } from '../hooks/useFrameDetection';

interface Props {
  camera: Camera;
  source: CameraSource;
  status: CameraStatus;
  alarm?: Alarm;
  sensitivity: DetectionSensitivity;
  detectionEnabled: boolean;
  onDetection: (
    cameraId: string,
    detection: FrameAnalysis,
    snapshot: string | null,
  ) => void;
  onClose: () => void;
  onOpenAlarm: (id: string) => void;
  onDisconnect: (cameraId: string) => void;
  /** 自动轮巡控制（仅在轮巡模式下传入）。 */
  tour?: {
    paused: boolean;
    interval: number;
    position: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onTogglePause: () => void;
    onIntervalChange: (seconds: number) => void;
    onStop: () => void;
  };
}

const STATE_LABEL: Record<CameraStatus, string> = {
  normal: '识别中',
  smoke: '烟雾告警',
  fire: '火焰告警',
};

export default function FocusViewer({
  camera,
  source,
  status,
  alarm,
  sensitivity,
  detectionEnabled,
  onDetection,
  onClose,
  onOpenAlarm,
  onDisconnect,
  tour,
}: Props) {
  const { videoRef, playback } = useVideoPlayback(source);
  const { analysisWarning } = useFrameDetection({
    cameraId: camera.id,
    source,
    videoRef,
    enabled: detectionEnabled,
    sensitivity,
    onDetection,
  });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const now = useNow(1000);
  const alarmed = status !== 'normal' && Boolean(alarm);
  const limited = Boolean(analysisWarning) && !alarmed;
  const state =
    playback === 'loading'
      ? '连接中'
      : playback === 'error'
        ? '信号异常'
        : playback === 'ended'
          ? '视频已结束'
          : limited
            ? '仅可观看'
            : !detectionEnabled
              ? '只读查看'
              : STATE_LABEL[status];

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="focus-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="focus-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="focus-title"
      >
        <header className="focus-head">
          <div className="focus-title">
            <span className="channel-code">{camera.code}</span>
            <div>
              <h2 id="focus-title">{camera.name}</h2>
              <p>
                {camera.zone} · {source.label}
              </p>
            </div>
          </div>
          <div className="focus-head-actions">
            <span className={`focus-state state-${playback === 'ready' ? status : playback}`}>
              <i aria-hidden="true" />
              {state}
            </span>
            <button ref={closeRef} type="button" className="focus-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="focus-stage">
          <video
            ref={videoRef}
            className="focus-video"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
          />

          {alarmed && alarm && (
            <>
              <span
                className="tile-alert-glow"
                aria-hidden="true"
                style={{
                  background: `radial-gradient(circle at ${alarm.hotspot.x}% ${alarm.hotspot.y}%, ${
                    status === 'fire' ? 'rgba(255,110,60,0.3)' : 'rgba(251,191,36,0.24)'
                  }, transparent 54%)`,
                }}
              />
              <span
                className={`detect-box detect-box--${alarm.level}`}
                style={{ left: `${alarm.hotspot.x}%`, top: `${alarm.hotspot.y}%` }}
                aria-hidden="true"
              >
                <span className={`detect-label detect-label--${alarm.level}`}>
                  {LEVEL_META[alarm.level]?.label ?? '告警'} {alarm.confidence}%
                </span>
              </span>
            </>
          )}

          {analysisWarning && (
            <span className="focus-analysis-warning" role="status">
              {analysisWarning}
            </span>
          )}
          {playback === 'loading' && (
            <span className="tile-signal-note">正在建立视频信号…</span>
          )}
          {playback === 'error' && (
            <span className="tile-signal-note tile-signal-note--error">
              视频加载失败
              <small>请关闭后断开信号并重新接入</small>
            </span>
          )}

          <span className="focus-clock">{formatTime(now)}</span>
          <span className="focus-watermark">FLAME VISION · LIVE</span>
        </div>

        {tour && (
          <div className="tour-bar" role="group" aria-label="自动轮巡控制">
            <span className="tour-progress">
              轮巡 {tour.position} / {tour.total}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={tour.onPrev}>
              上一路
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={tour.onTogglePause}
              aria-pressed={tour.paused}
            >
              {tour.paused ? '继续轮巡' : '暂停轮巡'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={tour.onNext}>
              下一路
            </button>
            <label className="tour-interval">
              <span>间隔</span>
              <select
                value={tour.interval}
                aria-label="轮巡切换间隔"
                onChange={(event) => tour.onIntervalChange(Number(event.target.value))}
              >
                {[10, 15, 30, 60].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} 秒
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-sm btn-danger" onClick={tour.onStop}>
              退出轮巡
            </button>
          </div>
        )}

        <footer className="focus-foot">
          <div className="focus-foot-info">
            {alarm ? (
              <>
                <span className={`level-tag level-tag--${alarm.level}`}>
                  {LEVEL_META[alarm.level]?.label ?? '告警'}
                </span>
                <span>
                  当前告警编号 {alarm.id} · 置信度 {alarm.confidence}%
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => onOpenAlarm(alarm.id)}
                >
                  查看告警详情
                </button>
              </>
            ) : (
              <span>连续帧检测运行中 · 识别到异常时会自动生成告警</span>
            )}
          </div>
          <div className="focus-foot-actions">
            <span className="focus-hint">ESC 关闭</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onDisconnect(camera.id)}
            >
              断开该通道
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
