import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import StatsStrip from './components/StatsStrip';
import VideoWall from './components/VideoWall';
import AlarmCard from './components/AlarmCard';
import AlarmCenter from './components/AlarmCenter';
import RecordsView from './components/RecordsView';
import FocusViewer from './components/FocusViewer';
import AdminPanel from './components/AdminPanel';
import OnboardingGuide from './components/OnboardingGuide';
import Toast from './components/Toast';
import { useAuth } from './context/AuthContext';
import { useCameraPoints } from './hooks/useCameraPoints';
import { useAlarms } from './hooks/useAlarms';
import { EMERGENCY_STEPS, levelLabel } from './lib/detection';
import { loadPreferences, savePreferences } from './lib/preferences';
import { playAlertSound, primeAlertAudio } from './lib/alertSound';
import { SENSITIVITY_META } from './lib/detector';
import type { FrameAnalysis } from './lib/detector';
import { api } from './lib/api';
import type { ManagedCamera } from './lib/api';
import type {
  Alarm,
  AlarmHandlers,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
  ToastKind,
  ToastState,
  ViewKey,
} from './types';

type RemoteSource = Extract<CameraSource, { kind: 'remote' }>;

function remoteSourceFor(point: ManagedCamera): RemoteSource | null {
  if (!point.enabled || !point.streamUrl || point.protocol === 'none') return null;
  return {
    kind: 'remote',
    url: point.streamUrl,
    protocol: point.protocol === 'http' ? 'http' : 'hls',
    label: point.protocol === 'rtsp' ? 'RTSP 转 HLS' : point.protocol.toUpperCase(),
  };
}

export default function App() {
  const { user, logout } = useAuth();
  const {
    cameras: cameraPoints,
    loading: pointsLoading,
    error: pointsError,
    refresh: refreshPoints,
  } = useCameraPoints();
  const {
    alarms,
    loading: alarmsLoading,
    error: alarmsError,
    createAlarm,
    patchAlarm,
  } = useAlarms();
  const [view, setView] = useState<ViewKey>('monitor');
  const [sources, setSources] = useState<Record<string, CameraSource>>({});
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null);
  // 大屏自动轮巡：按「有视频源的点位」顺序逐路全屏播放，可暂停 / 上下一路 / 改间隔。
  const [tour, setTour] = useState({
    enabled: false,
    paused: false,
    interval: 15,
    index: 0,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<'cameras' | 'notify'>('cameras');
  const [demoBusy, setDemoBusy] = useState(false);
  const [preferences, setPreferences] = useState(loadPreferences);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [screenAwake, setScreenAwake] = useState(false);
  const [serverDetection, setServerDetection] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const wakeLockDesiredRef = useRef(false);
  const wakeLockRef = useRef<{
    release: () => Promise<void>;
    addEventListener: (event: 'release', listener: () => void) => void;
  } | null>(null);
  const alarmsRef = useRef<Alarm[]>(alarms);
  const sourcesRef = useRef<Record<string, CameraSource>>({});
  const soundEnabledRef = useRef(preferences.soundEnabled);

  useEffect(() => {
    alarmsRef.current = alarms;
  }, [alarms]);

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    soundEnabledRef.current = preferences.soundEnabled;
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    // 服务端 7×24 识别开启后，浏览器端可暂停本地识别以节省 CPU。
    void api
      .capabilities()
      .then((result) => setServerDetection(result.serverDetection))
      .catch(() => undefined);
  }, []);

  const showToast = useCallback((text: string, kind: ToastKind = 'info') => {
    setToast({ text, kind });
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const openAdmin = useCallback((tab: 'cameras' | 'notify') => {
    setAdminTab(tab);
    setAdminOpen(true);
  }, []);

  const startDemoWalkthrough = useCallback(async () => {
    if (demoBusy) return;
    setDemoBusy(true);
    try {
      const result = await api.startDemo();
      await refreshPoints();
      showToast(
        result.running
          ? '演示已启动，几秒内监控大屏将出现火焰告警'
          : '演示视频源已启动',
        'ok',
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : '演示启动失败',
        'danger',
      );
    } finally {
      setDemoBusy(false);
    }
  }, [demoBusy, refreshPoints, showToast]);

  const requestScreenWakeLock = useCallback(async () => {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: {
          request: (type: 'screen') => Promise<{
            release: () => Promise<void>;
            addEventListener: (event: 'release', listener: () => void) => void;
          }>;
        };
      }
    ).wakeLock;
    if (!wakeLock) {
      showToast('当前浏览器不支持屏幕常亮，请保持页面在前台', 'info');
      return;
    }
    try {
      const lock = await wakeLock.request('screen');
      wakeLockRef.current = lock;
      lock.addEventListener('release', () => {
        wakeLockRef.current = null;
        setScreenAwake(false);
      });
      setScreenAwake(true);
      showToast('屏幕常亮已开启，减少后台休眠导致的中断', 'ok');
    } catch {
      wakeLockDesiredRef.current = false;
      showToast('屏幕常亮授权失败，请检查浏览器权限', 'info');
    }
  }, [showToast]);

  const handleToggleWakeLock = useCallback(async () => {
    if (wakeLockDesiredRef.current) {
      wakeLockDesiredRef.current = false;
      await wakeLockRef.current?.release().catch(() => undefined);
      wakeLockRef.current = null;
      setScreenAwake(false);
      showToast('屏幕常亮已关闭', 'info');
      return;
    }
    wakeLockDesiredRef.current = true;
    await requestScreenWakeLock();
  }, [requestScreenWakeLock, showToast]);

  useEffect(() => {
    const reacquire = () => {
      if (
        document.visibilityState === 'visible' &&
        wakeLockDesiredRef.current &&
        !wakeLockRef.current
      ) {
        void requestScreenWakeLock();
      }
    };
    document.addEventListener('visibilitychange', reacquire);
    return () => document.removeEventListener('visibilitychange', reacquire);
  }, [requestScreenWakeLock]);

  useEffect(() => {
    return () => {
      wakeLockDesiredRef.current = false;
      void wakeLockRef.current?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      const current = sourcesRef.current;
      Object.values(current).forEach((source) => {
        if (source.kind === 'file') {
          URL.revokeObjectURL(source.url);
        }
      });
    };
  }, []);

  const cameras = useMemo<Camera[]>(
    () =>
      cameraPoints.map((point) => ({
        id: point.id,
        code: point.code,
        name: point.name,
        zone: point.zone,
      })),
    [cameraPoints],
  );

  const cameraMap = useMemo(
    () =>
      Object.fromEntries(cameras.map((camera) => [camera.id, camera])) as Record<
        string,
        Camera
      >,
    [cameras],
  );

  const remoteStreams = useMemo(() => {
    const result: Record<string, Extract<CameraSource, { kind: 'remote' }>> = {};
    cameraPoints.forEach((point) => {
      const source = remoteSourceFor(point);
      if (source) result[point.id] = source;
    });
    return result;
  }, [cameraPoints]);

  useEffect(() => {
    if (!cameras.length) {
      setSelectedCameraId('');
      return;
    }
    setSelectedCameraId((current) =>
      cameras.some((camera) => camera.id === current) ? current : cameras[0].id,
    );
  }, [cameras]);

  useEffect(() => {
    const pointMap = new Map(cameraPoints.map((point) => [point.id, point]));
    setSources((prev) => {
      let changed = false;
      const next: Record<string, CameraSource> = { ...prev };
      cameraPoints.forEach((point) => {
        const existing = next[point.id];
        if (existing && existing.kind !== 'remote') return;
        const desired = remoteStreams[point.id];
        if (!desired) {
          if (existing) {
            delete next[point.id];
            changed = true;
          }
          return;
        }
        const currentRemote =
          existing?.kind === 'remote'
            ? (existing as Extract<CameraSource, { kind: 'remote' }>)
            : null;
        if (
          !currentRemote ||
          currentRemote.url !== desired.url ||
          currentRemote.protocol !== desired.protocol
        ) {
          next[point.id] = desired;
          changed = true;
        }
      });
      Object.keys(next).forEach((cameraId) => {
        if (pointMap.has(cameraId)) return;
        const source = next[cameraId];
        if (source?.kind === 'file') URL.revokeObjectURL(source.url);
        delete next[cameraId];
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [cameraPoints, remoteStreams]);

  useEffect(() => {
    document.title = preferences.platformName;
  }, [preferences.platformName]);

  useEffect(() => {
    let hiddenAt = 0;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt && Date.now() - hiddenAt > 2000) {
        showToast('页面在后台期间识别可能暂停，请确认各通道已恢复画面', 'info');
      }
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [showToast]);

  const statusMap = useMemo(() => {
    const map: Record<string, CameraStatus> = {};
    cameras.forEach((camera) => {
      map[camera.id] = 'normal';
    });
    alarms.forEach((alarm) => {
      if (alarm.status !== 'pending' && alarm.status !== 'confirmed') return;
      // 离线不是画面识别结果，不改变大屏上的火焰/烟雾状态。
      if (alarm.level === 'offline') return;
      const next: CameraStatus = alarm.level === 'fire' ? 'fire' : 'smoke';
      if (map[alarm.cameraId] === 'fire') return;
      map[alarm.cameraId] = next;
    });
    return map;
  }, [alarms, cameras]);

  const activeAlarms = useMemo(() => {
    const map: Record<string, Alarm> = {};
    alarms.forEach((alarm) => {
      if (alarm.status !== 'pending' && alarm.status !== 'confirmed') return;
      // 离线告警只进告警中心，不在画面上叠加识别框。
      if (alarm.level === 'offline') return;
      const existing = map[alarm.cameraId];
      if (!existing || alarm.level === 'fire') {
        map[alarm.cameraId] = alarm;
      }
    });
    return map;
  }, [alarms]);

  const pendingCount = alarms.filter((alarm) => alarm.status === 'pending').length;
  const latestPendingId = alarms.find((alarm) => alarm.status === 'pending')?.id ?? null;

  useEffect(() => {
    if (!latestPendingId) return;
    setExpandedId((current) => current ?? latestPendingId);
  }, [latestPendingId]);

  const handleDetection = useCallback(
    async (cameraId: string, detection: FrameAnalysis, snapshot: string | null) => {
      const camera = cameraMap[cameraId];
      if (!camera || user.role === 'viewer') return;
      const busy = alarmsRef.current.some(
        (alarm) =>
          alarm.cameraId === cameraId &&
          (alarm.status === 'pending' || alarm.status === 'confirmed'),
      );
      if (busy) return;
      try {
        await createAlarm({
          cameraId,
          level: detection.level,
          confidence: detection.confidence,
          hotspot: detection.hotspot,
          snapshot,
        });
        if (soundEnabledRef.current) {
          playAlertSound(detection.level);
        }
        showToast(
          `${camera.name} 识别到${detection.level === 'fire' ? '火焰' : '烟雾'}（置信度 ${
            detection.confidence
          }%），请核实画面`,
          'danger',
        );
      } catch (error) {
        showToast(
          error instanceof Error ? `告警上报失败：${error.message}` : '告警上报失败',
          'danger',
        );
      }
    },
    [cameraMap, createAlarm, showToast, user.role],
  );

  const handleConnectFile = useCallback(
    (cameraId: string, file: File) => {
      const looksLikeVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
      if (!looksLikeVideo || file.size === 0) {
        showToast('请选择有效且非空的视频文件', 'danger');
        return;
      }
      primeAlertAudio();
      const url = URL.createObjectURL(file);
      setSources((prev) => {
        const existing = prev[cameraId];
        if (existing?.kind === 'file') URL.revokeObjectURL(existing.url);
        return { ...prev, [cameraId]: { kind: 'file', url, label: file.name } };
      });
      setSelectedCameraId(cameraId);
      showToast(`已接入视频文件：${file.name}`, 'ok');
    },
    [showToast],
  );

  const handleReconnectRemote = useCallback(
    (cameraId: string) => {
      const source = remoteStreams[cameraId];
      if (!source) {
        showToast('该点位尚未配置视频流，请管理员在系统管理中配置', 'info');
        return;
      }
      setSources((prev) => ({
        ...prev,
        [cameraId]: { ...source, label: `${source.label} · 重连` },
      }));
      setSelectedCameraId(cameraId);
      showToast('正在重新接入网络监控流', 'info');
    },
    [remoteStreams, showToast],
  );

  const handleDisconnect = useCallback(
    (cameraId: string) => {
      const existing = sources[cameraId];
      if (!existing) return;
      if (existing.kind === 'file') {
        URL.revokeObjectURL(existing.url);
      }
      setSources((prev) => {
        const next = { ...prev };
        delete next[cameraId];
        return next;
      });
      setFocusedCameraId((prev) => (prev === cameraId ? null : prev));
      showToast('已断开该通道视频信号', 'info');
    },
    [sources, showToast],
  );

  const handleConfirm = useCallback(
    async (id: string) => {
      const alarm = alarms.find((item) => item.id === id);
      if (!alarm) return;
      try {
        await patchAlarm(id, {
          status: 'confirmed',
          steps: alarm.steps.length
            ? alarm.steps
            : EMERGENCY_STEPS.map(() => false),
        });
        showToast('已确认火情，应急预案已启动', 'danger');
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '确认火情失败',
          'danger',
        );
      }
    },
    [alarms, patchAlarm, showToast],
  );

  const handleFalse = useCallback(
    async (id: string) => {
      try {
        await patchAlarm(id, { status: 'false' });
        showToast('已标记为误报，通道恢复正常监测', 'ok');
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '标记误报失败',
          'danger',
        );
      }
    },
    [patchAlarm, showToast],
  );

  const handleToggleStep = useCallback(
    async (id: string, index: number) => {
      const alarm = alarms.find((item) => item.id === id);
      if (!alarm) return;
      try {
        await patchAlarm(id, {
          steps: alarm.steps.map((done, i) => (i === index ? !done : done)),
        });
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '更新处置步骤失败',
          'danger',
        );
      }
    },
    [alarms, patchAlarm, showToast],
  );

  const handleArchive = useCallback(
    async (id: string) => {
      try {
        await patchAlarm(id, { status: 'archived' });
        showToast('处置完成，告警已归档至处置记录', 'ok');
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '归档告警失败',
          'danger',
        );
      }
    },
    [patchAlarm, showToast],
  );

  const handleNoteChange = useCallback(
    async (id: string, note: string) => {
      try {
        await patchAlarm(id, { note: note.slice(0, 300) });
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '保存值守备注失败',
          'danger',
        );
      }
    },
    [patchAlarm, showToast],
  );

  const handleToggle = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseFocus = useCallback(() => {
    setFocusedCameraId(null);
    // 关闭大屏即退出轮巡，避免后台继续空转。
    setTour((prev) => (prev.enabled ? { ...prev, enabled: false, paused: false } : prev));
  }, []);

  const handleOpenFocusedAlarm = useCallback((id: string) => {
    setFocusedCameraId(null);
    setExpandedId(id);
    setView('alarms');
  }, []);

  const handleSensitivityChange = useCallback(
    (sensitivity: DetectionSensitivity) => {
      setPreferences((prev) => ({ ...prev, sensitivity }));
      showToast(`识别灵敏度已切换为「${SENSITIVITY_META[sensitivity].label}」`, 'info');
    },
    [showToast],
  );

  const handleToggleSound = useCallback(() => {
    const nextEnabled = !preferences.soundEnabled;
    if (nextEnabled) primeAlertAudio();
    setPreferences((prev) => ({ ...prev, soundEnabled: nextEnabled }));
    showToast(nextEnabled ? '告警提示音已开启' : '告警提示音已关闭', nextEnabled ? 'ok' : 'info');
  }, [preferences.soundEnabled, showToast]);

  const handlers: AlarmHandlers = useMemo(
    () => ({
      onToggle: handleToggle,
      onConfirm: handleConfirm,
      onFalse: handleFalse,
      onToggleStep: handleToggleStep,
      onArchive: handleArchive,
      onNoteChange: handleNoteChange,
    }),
    [handleToggle, handleConfirm, handleFalse, handleToggleStep, handleArchive, handleNoteChange],
  );

  const queue = useMemo(
    () =>
      alarms
        .filter((alarm) => alarm.status === 'pending' || alarm.status === 'confirmed')
        .sort((a, b) => b.createdAt - a.createdAt),
    [alarms],
  );

  const readOnly = user.role === 'viewer';

  const localDetectionFor = useCallback(
    (camera: Camera) => {
      if (readOnly) return false;
      if (preferences.localDetection === 'off') return false;
      // 本地文件测试：文件只在浏览器里播放，服务端无从识别，必须由本地兜底，
      // 不受 auto 策略（服务端接管即暂停本地）影响。
      if (sources[camera.id]?.kind === 'file') return true;
      if (preferences.localDetection === 'on') return true;
      // auto：服务端识别已接管时暂停浏览器识别；边缘网关点位服务端不识别，仍由本地兜底。
      const point = cameraPoints.find((item) => item.id === camera.id);
      return !serverDetection || point?.protocol === 'edge';
    },
    [readOnly, preferences.localDetection, serverDetection, cameraPoints, sources],
  );

  const localDetectionIds = useMemo(
    () =>
      new Set(
        cameras.filter((camera) => localDetectionFor(camera)).map((camera) => camera.id),
      ),
    [cameras, localDetectionFor, sources],
  );

  const onlineCount = cameras.filter((camera) => Boolean(sources[camera.id])).length;
  const selectedCamera: Camera =
    cameras.find((camera) => camera.id === selectedCameraId) ??
    cameras[0] ?? {
      id: '',
      code: '--',
      name: '暂无点位',
      zone: '等待管理员配置',
    };
  const selectedSource = sources[selectedCamera.id];
  const selectedAlarm = activeAlarms[selectedCamera.id];
  const focusedCamera = focusedCameraId ? cameraMap[focusedCameraId] : null;
  const focusedSource = focusedCamera ? sources[focusedCamera.id] : undefined;

  // 轮巡队列：只包含当前已接入视频源的点位（无源的跳过，避免大屏出现空窗）。
  const tourQueue = useMemo(
    () => cameras.filter((camera) => Boolean(sources[camera.id])).map((camera) => camera.id),
    [cameras, sources],
  );

  const startTour = useCallback(() => {
    if (tourQueue.length === 0) {
      showToast('先接入至少一路视频源再开启自动轮巡', 'info');
      return;
    }
    setTour({ enabled: true, paused: false, interval: 15, index: 0 });
    setFocusedCameraId(tourQueue[0]);
  }, [tourQueue, showToast]);

  const stopTour = useCallback(() => {
    setTour((prev) => ({ ...prev, enabled: false, paused: false }));
  }, []);

  const stepTour = useCallback(
    (delta: number) => {
      if (tourQueue.length === 0) return;
      const next = (tour.index + delta + tourQueue.length) % tourQueue.length;
      setTour((prev) => ({ ...prev, index: next }));
      setFocusedCameraId(tourQueue[next]);
    },
    [tour.index, tourQueue],
  );

  // 定时推进：暂停或只有一路时不切换（仍保持全屏播放）。
  useEffect(() => {
    if (!tour.enabled || tour.paused) return;
    if (tourQueue.length <= 1) return;
    const timer = window.setTimeout(() => {
      const next = (tour.index + 1) % tourQueue.length;
      setTour((prev) => ({ ...prev, index: next }));
      setFocusedCameraId(tourQueue[next]);
    }, tour.interval * 1000);
    return () => window.clearTimeout(timer);
  }, [tour.enabled, tour.paused, tour.interval, tour.index, tourQueue]);

  return (
    <div className={`app-shell view-${view}`}>
      <div className="app-inner">
        <TopBar
          view={view}
          onViewChange={setView}
          pendingCount={pendingCount}
          onlineCount={onlineCount}
          totalCount={cameras.length}
          platformName={preferences.platformName}
          user={user}
          onManage={() => {
            setAdminTab('cameras');
            setAdminOpen(true);
          }}
          onLogout={() => {
            void logout();
          }}
        />

        <StatsStrip alarms={alarms} onlineCount={onlineCount} totalCount={cameras.length} />

        <main className="app-main">
          {view === 'monitor' && (
            <div className="monitor-layout">
              <section className="panel video-panel">
                <div className="panel-head">
                  <div>
                    <h2>实时视频墙</h2>
                    <p className="panel-sub">
                      {cameras.length} 路通道 · 已接入 {onlineCount} 路 · 当前选中{' '}
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
                          handleSensitivityChange(event.target.value as DetectionSensitivity)
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
                          setPreferences((prev) => ({
                            ...prev,
                            localDetection: event.target.value as 'auto' | 'on' | 'off',
                          }))
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
                      onClick={handleToggleSound}
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
                      onClick={() => void handleToggleWakeLock()}
                    >
                      屏幕常亮{screenAwake ? '开' : '关'}
                    </button>
                    <button
                      type="button"
                      className={`tour-toggle ${tour.enabled ? 'is-on' : ''}`}
                      aria-pressed={tour.enabled}
                      title={
                        tour.enabled
                          ? '退出自动轮巡'
                          : `大屏轮巡已接入的 ${tourQueue.length} 路点位，默认每 15 秒切换`
                      }
                      onClick={() => {
                        if (tour.enabled) {
                          stopTour();
                          setFocusedCameraId(null);
                          showToast('已退出自动轮巡', 'info');
                        } else {
                          startTour();
                        }
                      }}
                    >
                      自动轮巡{tour.enabled ? '中' : ''}
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
                    onStartDemo={startDemoWalkthrough}
                    onAddCamera={() => openAdmin('cameras')}
                    onConfigureNotify={() => openAdmin('notify')}
                  />
                )}
                <VideoWall
                  cameras={cameras}
                  statusMap={statusMap}
                  activeAlarms={activeAlarms}
                  sources={sources}
                  remoteSources={remoteStreams}
                  selectedId={selectedCameraId}
                  focusedId={focusedCameraId}
                  sensitivity={preferences.sensitivity}
                  detectionEnabledIds={localDetectionIds}
                  onSelect={setSelectedCameraId}
                  onFocus={setFocusedCameraId}
                  onConnectFile={handleConnectFile}
                  onReconnectNetwork={handleReconnectRemote}
                  onDisconnect={handleDisconnect}
                  onDetection={handleDetection}
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
                      onClick={() => {
                        setExpandedId(selectedAlarm.id);
                        setView('alarms');
                      }}
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
                    <strong>{onlineCount > 0 ? '全部通道状态正常' : '尚无识别事件'}</strong>
                    <span>
                      {onlineCount > 0
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
          )}

          {view === 'alarms' && (
            <AlarmCenter
              alarms={alarms}
              expandedId={expandedId}
              handlers={handlers}
              readOnly={readOnly}
            />
          )}

          {view === 'records' && <RecordsView alarms={alarms} />}
        </main>
      </div>

      {focusedCamera && focusedSource && (
        <FocusViewer
          camera={focusedCamera}
          source={focusedSource}
          status={statusMap[focusedCamera.id] ?? 'normal'}
          alarm={activeAlarms[focusedCamera.id]}
          sensitivity={preferences.sensitivity}
          detectionEnabled={localDetectionFor(focusedCamera)}
          onDetection={handleDetection}
          onClose={handleCloseFocus}
          onOpenAlarm={handleOpenFocusedAlarm}
          onDisconnect={handleDisconnect}
          tour={
            tour.enabled
              ? {
                  paused: tour.paused,
                  interval: tour.interval,
                  position:
                    Math.max(0, tourQueue.indexOf(focusedCamera.id)) + 1,
                  total: tourQueue.length,
                  onPrev: () => stepTour(-1),
                  onNext: () => stepTour(1),
                  onTogglePause: () =>
                    setTour((prev) => ({ ...prev, paused: !prev.paused })),
                  onIntervalChange: (seconds: number) =>
                    setTour((prev) => ({ ...prev, interval: seconds })),
                  onStop: () => {
                    stopTour();
                    setFocusedCameraId(null);
                    showToast('已退出自动轮巡', 'info');
                  },
                }
              : undefined
          }
        />
      )}

      {adminOpen && (user.role === 'admin' || user.siteAdmin) && (
        <AdminPanel
          cameras={cameraPoints}
          currentUser={user}
          initialTab={adminTab}
          onClose={() => setAdminOpen(false)}
          onCamerasChanged={async () => {
            await refreshPoints();
          }}
          onNotify={showToast}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}