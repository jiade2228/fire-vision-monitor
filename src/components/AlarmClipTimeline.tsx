import { useEffect, useMemo, useRef, useState } from 'react';
import type { Alarm } from '../types';
import { confidenceTone, getLevelMeta } from '../lib/detection';
import { formatDateTime } from '../lib/format';

interface Props {
  alarms: Alarm[];
}

/**
 * 告警短视频时间线回放：把所有带抓拍短视频的告警按时间倒序排成一条时间线，
 * 右侧大播放器播放当前选中片段，左侧可前后切换、支持自动连播。
 * 数据是既有告警短视频，无需持续录像，是「完整录像回放」的低成本第一阶段。
 */
export default function AlarmClipTimeline({ alarms }: Props) {
  const clips = useMemo(
    () => alarms.filter((alarm) => alarm.clip).sort((a, b) => b.createdAt - a.createdAt),
    [alarms],
  );
  const [index, setIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const current = clips[index];

  // 切换条目时重新加载；开启自动连播则立即播放。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !current?.clip) return;
    video.load();
    if (autoplay) {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(() => undefined);
    }
  }, [current, autoplay]);

  if (clips.length === 0) {
    return (
      <div className="empty-state">
        <strong>暂无告警短视频</strong>
        <span>
          识别到火情或烟雾并抓拍短视频后，这里会按时间排列为可回放的时间线，便于复盘与演练。
        </span>
      </div>
    );
  }

  const step = (delta: number) => {
    setIndex((prev) => {
      const next = prev + delta;
      if (next < 0) return 0;
      if (next >= clips.length) return clips.length - 1;
      return next;
    });
  };

  const handleEnded = () => {
    if (autoplay && index < clips.length - 1) {
      setIndex((prev) => prev + 1);
    }
  };

  return (
    <div className="clip-timeline">
      <div className="clip-stage">
        <video
          ref={videoRef}
          className="clip-stage-player"
          src={current.clip ?? undefined}
          controls
          onEnded={handleEnded}
          preload="metadata"
        />
        <div className="clip-stage-meta">
          <span className={`level-tag level-tag--${current.level}`}>
            {getLevelMeta(current.level).label}
          </span>
          <strong>{current.cameraName}</strong>
          <span className="clip-stage-zone">{current.zone}</span>
          <span className="clip-stage-time">{formatDateTime(current.createdAt)}</span>
          {current.level !== 'offline' && (
            <span className={`conf-pill conf-pill--${confidenceTone(current.confidence)}`}>
              {current.confidence}%
            </span>
          )}
          {current.clip && (
            <a
              className="clip-download"
              href={current.clip}
              download={`${current.id.slice(-8)}-现场.mp4`}
            >
              下载片段
            </a>
          )}
        </div>
        <div className="clip-controls">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => step(-1)}
            disabled={index === 0}
          >
            ← 上一段
          </button>
          <span className="clip-counter">
            {index + 1} / {clips.length}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => step(1)}
            disabled={index === clips.length - 1}
          >
            下一段 →
          </button>
          <label className="clip-autoplay">
            <input
              type="checkbox"
              checked={autoplay}
              onChange={(event) => setAutoplay(event.target.checked)}
            />
            自动连播
          </label>
        </div>
      </div>

      <div className="clip-rail">
        {clips.map((alarm, railIndex) => (
          <button
            type="button"
            key={alarm.id}
            className={`clip-rail-item ${railIndex === index ? 'is-active' : ''}`}
            onClick={() => setIndex(railIndex)}
          >
            <span className={`level-dot level-dot--${alarm.level}`} aria-hidden="true" />
            <span className="clip-rail-main">
              <strong>{alarm.cameraName}</strong>
              <span className="clip-rail-time">{formatDateTime(alarm.createdAt)}</span>
            </span>
            <span className="clip-rail-level">{getLevelMeta(alarm.level).label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
