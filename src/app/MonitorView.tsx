import VideoWall from '../components/VideoWall';

/** 共享的空 Set 常量：FFmpeg 可用时不再创建新 Set 引发子组件重渲染。 */
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
import AlarmCard from '../components/AlarmCard';
import OnboardingGuide from '../components/OnboardingGuide';
import { SENSITIVITY_META } from '../lib/detector';
import { levelLabel } from '../lib/detection';
import type { AppPreferences } from '../lib/preferences';
import type { SessionUser } from '../lib/api';
import type {
  Alarm,
  AlarmHandlers,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
} from '../types';
import type { FrameAnalysis } from '../lib/detector';

interface MonitorViewProps {
  cameras: Camera[];
  statusMap: Record<string, CameraStatus>;
  activeAlarms: Record<string, Alarm>;
  sources: Record<string, CameraSource>;
  remoteStreams: Record<string, Extract<CameraSource, { kind: 'remote' }>>;
  selectedCameraId: string;
  focusedCameraId: string | null;
  localDetectionIds: Set<string>;
  preferences: AppPreferences;
  serverDetection: boolean;
  screenAwake: boolean;
  tourEnabled: boolean;
  tourQueueLength: number;
  demoBusy: boolean;
  user: SessionUser;
  pointsLoading: boolean;
  /** RTSP 点位在服务器缺 FFmpeg 时的标记集合。 */
  ffmpegMissingIds?: ReadonlySet<string>;
  pointsError: string | null;
  alarmsError: string | null;
  alarmsLoading: boolean;
  queue: Alarm[];
  pendingCount: number;
  expandedId: string | null;
  handlers: AlarmHandlers;
  readOnly: boolean;
  selectedCamera: Camera;
  selectedSource: CameraSource | undefined;
  selectedAlarm: Alarm | undefined;
  onSensitivityChange: (sensitivity: DetectionSensitivity) => void;
  onLocalDetectionChange: (value: 'auto' | 'on' | 'off') => void;
  onToggleSound: () => void;
  onToggleWakeLock: () => void;
  onToggleTour: () => void;
  onSelectCamera: (id: string) => void;
  onFocus: (id: string | null) => void;
  onConnectFile: (cameraId: string, file: File) => void;
  onReconnectNetwork: (cameraId: string) => void;
  onDisconnect: (cameraId: string) => void;
  onDetection: (
    cameraId: string,
    detection: FrameAnalysis,
    snapshot: string | null,
  ) => Promise<void>;
  onStartDemo: () => Promise<void>;
  onOpenAdminCameras: () => void;
  onOpenAdminNotify: () => void;
  onOpenAlarmFromChannel: (id: string) => void;
}

export default function MonitorView({
  cameras,
  statusMap,
  activeAlarms,
  sources,
  remoteStreams,
  selectedCameraId,
  focusedCameraId,
  localDetectionIds,
  preferences,
  serverDetection,
  screenAwake,
  tourEnabled,
  tourQueueLength,
  demoBusy,
  user,
  pointsLoading,
  ffmpegMissingIds = EMPTY_STRING_SET,
  pointsError,
  alarmsError,
  alarmsLoading,
  queue,
  pendingCount,
  expandedId,
  handlers,
  readOnly,
  selectedCamera,
  selectedSource,
  selectedAlarm,
  onSensitivityChange,
  onLocalDetectionChange,
  onToggleSound,
  onToggleWakeLock,
  onToggleTour,
  onSelectCamera,
  onFocus,
  onConnectFile,
  onReconnectNetwork,
  onDisconnect,
  onDetection,
  onStartDemo,
  onOpenAdminCameras,
  onOpenAdminNotify,
  onOpenAlarmFromChannel,
}: MonitorViewProps) {
  return (
    <div className="monitor-layout">
      <section className="panel video-panel">
        <div className="panel-head">
          <div>
            <h2>实时视频墙</h2>
            <p className="panel-sub">
              {cameras.length} 路通道 · 已接入 {cameras.filter((camera) => Boolean(sources[camera.id])).length} 路 · 当前选中{' '}
              {selectedCamera.name}
            </p>
          </div>
          <div className="panel-actions engine-controls">
            <label
              className="engine-select"
              title={SENSITIVITY_META[preferences.sensitivity].hint}
            >
              <span>灵敏度</span>
              <select
                value={preferences.sensitivity}
                aria-label="识别灵敏度"
                onChange={(event) =>
                  onSensitivityChange(event.target.value as DetectionSensitivity)
                }
              >
                {(Object.keys(SENSITIVITY_META) as DetectionSensitivity[]).map((key) => (
                  <option key={key} value={key}>
                    {SENSITIVITY_META[key].label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="engine-select"
              title={
                serverDetection
                  ? '服务端识别已接管：自动模式下浏览器不再重复识别，节省 CPU；边缘网关点位仍由浏览器识别。'
                  : '服务端识别未开启时，自动模式会使用浏览器本地识别。'
              }
            >
              <span>本地识别</span>
              <select
                value={preferences.localDetection}
                aria-label="浏览器本地识别策略"
                onChange={(event) =>
                  onLocalDetectionChange(event.target.value as 'auto' | 'on' | 'off')
                }
              >
                <option value="auto">自动</option>
                <option value="on">始终</option>
                <option value="off">关闭</option>
              </select>
            </label>
            <button
              type="button"
              className={`sound-toggle ${preferences.soundEnabled ? 'is-on' : ''}`}
              aria-pressed={preferences.soundEnabled}
              title={preferences.soundEnabled ? '关闭告警提示音' : '开启告警提示音'}
              onClick={onToggleSound}
            >
              <span className="sound-bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              提示音{preferences.soundEnabled ? '开' : '关'}
            </button>
            <button
              type="button"
              className={`wake-toggle ${screenAwake ? 'is-on' : ''}`}
              aria-pressed={screenAwake}
              title="防止屏幕休眠；切到其他页面仍可能暂停检测"
              onClick={() => void onToggleWakeLock()}
            >
              屏幕常亮{screenAwake ? '开' : '关'}
            </button>
            <button
              type="button"
              className={`tour-toggle ${tourEnabled ? 'is-on' : ''}`}
              aria-pressed={tourEnabled}
              title={
                tourEnabled
                  ? '退出自动轮巡'
                  : `大屏轮巡已接入的 ${tourQueueLength} 路点位，默认每 15 秒切换`
              }
              onClick={onToggleTour}
            >
              自动轮巡{tourEnabled ? '中' : ''}
            </button>
          </div>
        </div>
        {pointsLoading && <p className="panel-status">正在加载远程点位…</p>}
        {pointsError && (
          <p className="panel-status panel-status--error">{pointsError}</p>
        )}
        {!pointsLoading && !pointsError && cameras.length === 0 && (
          <OnboardingGuide
            canDemo={user.role === 'admin'}
            canManage={user.role === 'admin' || Boolean(user.siteAdmin)}
            demoBusy={demoBusy}
            onStartDemo={onStartDemo}
            onAddCamera={onOpenAdminCameras}
            onConfigureNotify={onOpenAdminNotify}
          />
        )}
        <VideoWall
          cameras={cameras}
          ffmpegMissingIds={ffmpegMissingIds}
          statusMap={statusMap}
          activeAlarms={activeAlarms}
          sources={sources}
          remoteSources={remoteStreams}
          selectedId={selectedCameraId}
          focusedId={focusedCameraId}
          sensitivity={preferences.sensitivity}
          detectionEnabledIds={localDetectionIds}
          onSelect={onSelectCamera}
          onFocus={onFocus}
          onConnectFile={onConnectFile}
          onReconnectNetwork={onReconnectNetwork}
          onDisconnect={onDisconnect}
          onDetection={onDetection}
        />

        {cameras.length > 0 && (
          <div className="channel-summary">
            <div className="channel-identity">
              <span className="channel-code">{selectedCamera.code}</span>
              <strong>{selectedCamera.name}</strong>
              <span className="channel-zone">{selectedCamera.zone}</span>
            </div>
            <span className={`channel-source ${selectedSource ? 'is-online' : ''}`}>
              <i aria-hidden="true" />
              {selectedSource ? `视频源：${selectedSource.label}` : '当前通道未接入视频源'}
            </span>
            {selectedAlarm ? (
              <button
                type="button"
                className="btn btn-sm channel-alarm"
                onClick={() => onOpenAlarmFromChannel(selectedAlarm.id)}
              >
                查看{levelLabel(selectedAlarm.level)}告警
              </button>
            ) : (
              <span className="channel-engine">
                {selectedSource ? '连续帧检测运行中' : '接入信号后自动开始检测'}
              </span>
            )}
          </div>
        )}

        <p className="panel-foot">
          提示：识别基于浏览器端火焰色彩与运动特征，适合辅助值守，不能替代经认证的消防探测设备。
          网络点位由管理员在“系统管理”中配置；RTSP 流由服务器转成 HLS 后播放和逐帧分析。
          灵敏度越高越早触发，也更容易产生误报；镜头持续移动时烟雾识别会暂缓，固定机位效果最佳。
          浏览器切到后台会暂停本地识别，正式值守请保持页面常亮或使用独立大屏。
        </p>
      </section>

      <aside className="panel dock-panel">
        <div className="panel-head">
          <div>
            <h2>告警队列</h2>
            <p className="panel-sub">进行中的告警，按触发时间倒序</p>
          </div>
          <span className={`dock-badge ${pendingCount > 0 ? 'is-danger' : ''}`}>
            待处置 {pendingCount}
          </span>
        </div>

        {alarmsError && (
          <p className="panel-status panel-status--error">{alarmsError}</p>
        )}
        {alarmsLoading && queue.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <strong>正在同步告警队列…</strong>
          </div>
        ) : queue.length === 0 ? (
          <div className="empty-state empty-state--compact">
            <strong>{cameras.filter((camera) => Boolean(sources[camera.id])).length > 0 ? '全部通道状态正常' : '尚无识别事件'}</strong>
            <span>
              {cameras.filter((camera) => Boolean(sources[camera.id])).length > 0
                ? '识别引擎正在分析已接入的视频流，发现异常将自动推送告警。'
                : '等待管理员配置网络视频流；也可在通道上接入本地视频做临时测试。'}
            </span>
          </div>
        ) : (
          <div className="dock-list">
            {queue.map((alarm) => (
              <AlarmCard
                key={alarm.id}
                alarm={alarm}
                expanded={expandedId === alarm.id}
                handlers={handlers}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
