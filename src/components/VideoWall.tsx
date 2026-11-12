import type {
  Alarm,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
} from '../types';
import type { FrameAnalysis } from '../lib/detector';
import CameraTile from './CameraTile';

interface Props {
  cameras: Camera[];
  statusMap: Record<string, CameraStatus>;
  activeAlarms: Record<string, Alarm>;
  sources: Record<string, CameraSource>;
  remoteSources: Record<string, CameraSource>;
  selectedId: string;
  focusedId: string | null;
  sensitivity: DetectionSensitivity;
  detectionEnabledIds: Set<string>;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
  onConnectFile: (cameraId: string, file: File) => void;
  onReconnectNetwork: (cameraId: string) => void;
  onDisconnect: (cameraId: string) => void;
  /** RTSP 点位在服务器缺 FFmpeg 时的标记集合。 */
  ffmpegMissingIds?: ReadonlySet<string>;
  onDetection: (cameraId: string, detection: FrameAnalysis, snapshot: string | null) => void;
}

export default function VideoWall({
  cameras,
  statusMap,
  activeAlarms,
  sources,
  remoteSources,
  selectedId,
  focusedId,
  sensitivity,
  detectionEnabledIds,
  onSelect,
  onFocus,
  onConnectFile,
  onReconnectNetwork,
  onDisconnect,
  onDetection,
  ffmpegMissingIds = new Set<string>(),
}: Props) {
  return (
    <div className="video-wall">
      {cameras.map((camera) => (
        <CameraTile
          key={camera.id}
          camera={camera}
          status={statusMap[camera.id] ?? 'normal'}
          alarm={activeAlarms[camera.id]}
          selected={selectedId === camera.id}
          source={sources[camera.id] ?? null}
          sensitivity={sensitivity}
          detectionEnabled={detectionEnabledIds.has(camera.id)}
          suspended={focusedId === camera.id}
          hasNetworkSource={Boolean(remoteSources[camera.id])}
          onSelect={onSelect}
          onFocus={onFocus}
          onConnectFile={onConnectFile}
          onReconnectNetwork={onReconnectNetwork}
          onDisconnect={onDisconnect}
          onDetection={onDetection}
          ffmpegMissing={ffmpegMissingIds.has(camera.id)}
        />
      ))}
    </div>
  );
}