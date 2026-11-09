import { useEffect, useRef, useState } from 'react';
import type Hls from 'hls.js';
import type { CameraSource } from '../types';

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'error' | 'ended';

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 1500;

export function useVideoPlayback(source: CameraSource | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>(source ? 'loading' : 'idle');
  const [generation, setGeneration] = useState(0);
  const attemptsRef = useRef(0);
  const previousSourceRef = useRef<CameraSource | null>(null);

  useEffect(() => {
    if (!source) {
      setPlayback('idle');
      previousSourceRef.current = null;
      attemptsRef.current = 0;
      return;
    }
    if (previousSourceRef.current !== source) {
      previousSourceRef.current = source;
      attemptsRef.current = 0;
    }
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let retryScheduled = false;
    let retryTimer: number | null = null;
    let hls: Hls | null = null;
    let playRequested = false;
    setPlayback('loading');

    const scheduleRetry = (delay: number) => {
      if (cancelled || retryScheduled) return;
      if (attemptsRef.current >= MAX_RETRIES) {
        setPlayback('error');
        return;
      }
      retryScheduled = true;
      attemptsRef.current += 1;
      setPlayback('loading');
      retryTimer = window.setTimeout(() => {
        if (!cancelled) setGeneration((value) => value + 1);
      }, delay);
    };

    const markReady = () => {
      if (cancelled) return;
      attemptsRef.current = 0;
      setPlayback(video.ended ? 'ended' : 'ready');
    };
    const markEnded = () => {
      if (!cancelled) setPlayback('ended');
    };
    const handleVideoError = () => {
      if (cancelled) return;
      if (source.kind === 'remote') {
        scheduleRetry(RETRY_DELAY_MS);
      } else {
        setPlayback('error');
      }
    };

    video.addEventListener('loadeddata', markReady);
    video.addEventListener('canplay', markReady);
    video.addEventListener('ended', markEnded);
    video.addEventListener('error', handleVideoError);

    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('crossorigin');
    video.srcObject = null;

    const tryPlay = () => {
      if (cancelled || playRequested) return;
      playRequested = true;
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          if (!cancelled) scheduleRetry(RETRY_DELAY_MS);
        });
      }
    };

    if (source.kind === 'file') {
      video.src = source.url;
      tryPlay();
    } else if (source.protocol === 'hls') {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.url;
        tryPlay();
      } else {
        void import('hls.js')
          .then(({ default: HlsPlayer }) => {
            if (cancelled) return;
            if (!HlsPlayer.isSupported()) {
              setPlayback('error');
              return;
            }
            hls = new HlsPlayer({
              lowLatencyMode: true,
              // 1 秒分片下从直播边缘往回 2 片起播，端到端延迟约 2-4 秒。
              liveSyncDurationCount: 2,
              liveMaxLatencyDurationCount: 5,
              backBufferLength: 6,
              maxBufferLength: 6,
              manifestLoadingTimeOut: 12_000,
              levelLoadingTimeOut: 12_000,
              fragLoadingTimeOut: 20_000,
            });
            hls.loadSource(source.url);
            hls.attachMedia(video);
            hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => {
              if (!cancelled) {
                attemptsRef.current = 0;
                tryPlay();
              }
            });
            hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
              if (!data.fatal) return;
              hls?.destroy();
              hls = null;
              scheduleRetry(RETRY_DELAY_MS * Math.max(attemptsRef.current, 1));
            });
          })
          .catch(() => {
            if (!cancelled) scheduleRetry(3000);
          });
      }
    } else {
      video.crossOrigin = 'anonymous';
      video.src = source.url;
      tryPlay();
    }

    const handleVisibility = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (video.error || video.readyState < 2) {
        // 回到前台是明确的恢复时机：重置重试预算，否则耗尽后永久停在 error。
        attemptsRef.current = 0;
        scheduleRetry(0);
        return;
      }
      playRequested = false;
      tryPlay();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      video.pause();
      video.removeEventListener('loadeddata', markReady);
      video.removeEventListener('canplay', markReady);
      video.removeEventListener('ended', markEnded);
      video.removeEventListener('error', handleVideoError);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.removeAttribute('crossorigin');
      video.srcObject = null;
      video.load();
    };
  }, [source, generation]);

  return { videoRef, playback };
}
