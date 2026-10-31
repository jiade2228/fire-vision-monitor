import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { CameraSource, DetectionSensitivity } from '../types';
import { FlameDetector } from '../lib/detector';
import type { FrameAnalysis } from '../lib/detector';

const SAMPLE_WIDTH = 96;

function captureSnapshot(video: HTMLVideoElement): string | null {
  try {
    const width = 360;
    const ratio = video.videoHeight / video.videoWidth;
    const height = Math.max(
      1,
      Math.round(width * (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.5625)),
    );
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

export function useFrameDetection({
  cameraId,
  source,
  videoRef,
  enabled,
  sensitivity,
  onDetection,
}: {
  cameraId: string;
  source: CameraSource | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
  sensitivity: DetectionSensitivity;
  onDetection: (
    cameraId: string,
    detection: FrameAnalysis,
    snapshot: string | null,
  ) => void;
}) {
  const detectorRef = useRef<FlameDetector | null>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const detectionCallbackRef = useRef(onDetection);
  const warningRef = useRef(false);
  const [analysisWarning, setAnalysisWarning] = useState('');

  useEffect(() => {
    detectionCallbackRef.current = onDetection;
  }, [onDetection]);

  useEffect(() => {
    if (!source || !enabled) {
      setAnalysisWarning('');
      warningRef.current = false;
      return;
    }
    detectorRef.current = new FlameDetector(sensitivity);
    setAnalysisWarning('');
    warningRef.current = false;
    let timer: number | null = null;
    let cancelled = false;

    const setWarning = (message: string) => {
      if (warningRef.current) return;
      warningRef.current = true;
      setAnalysisWarning(message);
    };

    const tick = () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      const video = videoRef.current;
      const detector = detectorRef.current;
      if (!video || !detector || video.paused || video.ended) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

      const sample =
        sampleRef.current ?? (sampleRef.current = document.createElement('canvas'));
      const width = SAMPLE_WIDTH;
      const height = Math.max(
        1,
        Math.round((video.videoHeight / video.videoWidth) * width),
      );
      sample.width = width;
      sample.height = height;
      const ctx = sample.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      let frame: ImageData;
      try {
        ctx.drawImage(video, 0, 0, width, height);
        frame = ctx.getImageData(0, 0, width, height);
      } catch (error) {
        setWarning(
          error instanceof DOMException && error.name === 'SecurityError'
            ? '视频源未允许跨域读取，画面可播放但无法进行识别'
            : '浏览器无法读取视频帧，识别已暂停',
        );
        return;
      }
      if (warningRef.current) {
        warningRef.current = false;
        setAnalysisWarning('');
      }

      const hit = detector.analyze(frame.data, width, height);
      if (hit) {
        detectionCallbackRef.current(cameraId, hit, captureSnapshot(video));
      }
    };

    const start = () => {
      if (cancelled || timer !== null || document.visibilityState !== 'visible') return;
      tick();
      timer = window.setInterval(tick, 500);
    };

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    const video = videoRef.current;
    video?.addEventListener('loadeddata', start);
    video?.addEventListener('playing', start);
    document.addEventListener('visibilitychange', handleVisibility);
    if (video && video.readyState >= 2) start();

    return () => {
      cancelled = true;
      video?.removeEventListener('loadeddata', start);
      video?.removeEventListener('playing', start);
      document.removeEventListener('visibilitychange', handleVisibility);
      stop();
      detectorRef.current?.reset();
      detectorRef.current = null;
    };
  }, [cameraId, enabled, sensitivity, source, videoRef]);

  return { analysisWarning };
}
