import FocusViewer from '../components/FocusViewer';
import type { FrameAnalysis } from '../lib/detector';
import type {
  Alarm,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
} from '../types';

interface TourState {
  enabled: boolean;
  paused: boolean;
  interval: number;
  index: number;
}

interface FocusOverlayProps {
  camera: Camera;
  source: CameraSource;
  status: CameraStatus;
  alarm: Alarm | undefined;
  sensitivity: DetectionSensitivity;
  detectionEnabled: boolean;
  tour: TourState;
  tourQueue: string[];
  onDetection: (
    cameraId: string,
    detection: FrameAnalysis,
    snapshot: string | null,
  ) => Promise<void>;
  onClose: () => void;
  onOpenAlarm: (id: string) => void;
  onDisconnect: (cameraId: string) => void;
  onStepTour: (delta: number) => void;
  onTogglePause: () => void;
  onIntervalChange: (seconds: number) => void;
  onStop: () => void;
}

export default function FocusOverlay({
  camera,
  source,
  status,
  alarm,
  sensitivity,
  detectionEnabled,
  tour,
  tourQueue,
  onDetection,
  onClose,
  onOpenAlarm,
  onDisconnect,
  onStepTour,
  onTogglePause,
  onIntervalChange,
  onStop,
}: FocusOverlayProps) {
  return (
    <FocusViewer
      camera={camera}
      source={source}
      status={status}
      alarm={alarm}
      sensitivity={sensitivity}
      detectionEnabled={detectionEnabled}
      onDetection={onDetection}
      onClose={onClose}
      onOpenAlarm={onOpenAlarm}
      onDisconnect={onDisconnect}
      tour={
        tour.enabled
          ? {
              paused: tour.paused,
              interval: tour.interval,
              position: Math.max(0, tourQueue.indexOf(camera.id)) + 1,
              total: tourQueue.length,
              onPrev: () => onStepTour(-1),
              onNext: () => onStepTour(1),
              onTogglePause: onTogglePause,
              onIntervalChange: onIntervalChange,
              onStop: onStop,
            }
          : undefined
      }
    />
  );
}
