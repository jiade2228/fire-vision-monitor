import type { ChangeEvent } from 'react';
import type {
  Alarm,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
} from '../types';
import { formatTime } from '../lib/format';
import { useNow } from '../hooks/useNow';
import { useVideoPlayback } from '../hooks/useVideoPlayback';
import { useFrameDetection } from '../hooks/useFrameDetection';
import type { FrameAnalysis } from '../lib/detector';

interface Props {
  camera: Camera;
  status: CameraStatus;
  alarm?: Alarm;
  selected: boolean;
  source: CameraSource | null;
  sensitivity: DetectionSensitivity;
  detectionEnabled: boolean;
  suspended: boolean;
  hasNetworkSource: boolean;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onConnectFile: (cameraId: string, file: File) => void;
  onReconnectNetwork: (cameraId: string) => void;
  onDisconnect: (cameraId: string) => void;
  onDetection: (cameraId: string, detection: FrameAnalysis, snapshot: string | null) => void;
}

const STATE_LABEL: Record<CameraStatus, string> = {
  normal: '识别中',
  smoke: '烟雾告警',
  fire: '火焰告警',
};

function TileClock() {
  const now = useNow(1000);
  return <span className="tile-hud tile-hud--time">{formatTime(now)}</span>;
}

export default function CameraTile({
  camera,
  status,
  alarm,
  selected,
  source,
  sensitivity,
  detectionEnabled,
  suspended,
  hasNetworkSource,
  onSelect,
  onFocus,
  onConnectFile,
  onReconnectNetwork,
  onDisconnect,
  onDetection,
}: Props) {
  const { videoRef, playback } = useVideoPlayback(suspended ? null : source);
  const { analysisWarning } = useFrameDetection({
    cameraId: camera.id,
    source,
    videoRef,
    enabled: detectionEnabled && !suspended,
    sensitivity,
    onDetection,
  });

  const alarmed = status !== 'normal' && Boolean(alarm);
  const limited = Boolean(analysisWarning) && !alarmed;
  const displayState = suspended
    ? 'loading'
    : !source
    ? 'offline'
    : playback === 'loading'
      ? 'loading'
      : playback === 'error'
        ? 'error'
        : playback === 'ended'
          ? 'ended'
          : limited
            ? 'loading'
            : status;
  const displayLabel = suspended
    ? '放大查看中'
    : !source
    ? '未接入'
    : playback === 'loading'
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
  const glowColor =
    status === 'fire' ? 'rgba(255,110,60,0.34)' : 'rgba(251,191,36,0.26)';

  const tileClass = [
    'camera-tile',
    selected ? 'is-selected' : '',
    status === 'fire' ? 'is-alarm-fire' : '',
    status === 'smoke' ? 'is-alarm-smoke' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onConnectFile(camera.id, file);
  };

  return (
    <div className={tileClass}>
      <div
        className="tile-surface"
        role="button"
        tabIndex={0}
        onClick={() => onSelect(camera.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(camera.id);
          }
        }}
        aria-pressed={selected}
        title={`${camera.name} · ${camera.zone}`}
      >
        {source ? (
          <video
            ref={videoRef}
            className="tile-video"
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
          />
        ) : (
          <span className="tile-empty">
            <span className="tile-empty-title">未接入视频信号</span>
            <span className="tile-empty-sub">
              {hasNetworkSource
                ? '网络流已暂停，可重新接入'
                : '等待管理员配置 RTSP / HLS 视频流'}
            </span>
          </span>
        )}

        {source && <span className="tile-scan" aria-hidden="true" />}

        {source && playback === 'loading' && (
          <span className="tile-signal-note">正在建立视频信号…</span>
        )}
        {source && playback === 'error' && (
          <span className="tile-signal-note tile-signal-note--error">
            视频加载失败
            <small>请断开后重新接入</small>
          </span>
        )}
        {source && analysisWarning && (
          <span className="tile-analysis-warning" role="status">
            {analysisWarning}
          </span>
        )}
        {suspended && (
          <span className="tile-signal-note">已在放大窗口播放，本瓦片暂停拉流</span>
        )}

        {alarmed && alarm && (
          <>
            <span
              className="tile-alert-glow"
              aria-hidden="true"
              style={{
                background: `radial-gradient(circle at ${alarm.hotspot.x}% ${alarm.hotspot.y}%, ${glowColor}, transparent 58%)`,
              }}
            />
            <span
              className={`detect-box detect-box--${alarm.level}`}
              style={{ left: `${alarm.hotspot.x}%`, top: `${alarm.hotspot.y}%` }}
              aria-hidden="true"
            >
              <span className={`detect-label detect-label--${alarm.level}`}>
                {alarm.level === 'fire' ? '火焰' : '烟雾'} {alarm.confidence}%
              </span>
            </span>
          </>
        )}

        <span className="tile-hud tile-hud--name">
          <span className="tile-code">{camera.code}</span>
          <span className="tile-name">{camera.name}</span>
        </span>

        <span className={`tile-hud tile-hud--state state-${displayState}`}>
          <i className="state-dot" aria-hidden="true" />
          {displayLabel}
        </span>

        {source && <TileClock />}
      </div>

      {source ? (
        <div className="tile-view-actions">
          <button
            type="button"
            className="tile-action"
            onClick={() => onFocus(camera.id)}
            title={`放大查看${camera.name}`}
          >
            放大
          </button>
          <button
            type="button"
            className="tile-action tile-action--danger"
            onClick={() => onDisconnect(camera.id)}
          >
            断开
          </button>
        </div>
      ) : (
        <div className="tile-connect">
          {hasNetworkSource && (
            <button
              type="button"
              className="tile-connect-btn"
              onClick={() => onReconnectNetwork(camera.id)}
            >
              接入网络流
            </button>
          )}
          <label className="tile-connect-btn">
            {hasNetworkSource ? '本地测试' : '本地视频测试'}
            <input type="file" accept="video/*" onChange={handleFileChange} hidden />
          </label>
        </div>
      )}
    </div>
  );
}