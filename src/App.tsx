import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import StatsStrip from './components/StatsStrip';
import AlarmCenter from './components/AlarmCenter';
import RecordsView from './components/RecordsView';
import RecordingTimeline from './components/RecordingTimeline';
import AdminPanel from './components/AdminPanel';
import Toast from './components/Toast';
import MonitorView from './app/MonitorView';
import FocusOverlay from './app/FocusOverlay';
import { useAuth } from './context/AuthContext';
import { useCameraPoints } from './hooks/useCameraPoints';
import { useAlarms } from './hooks/useAlarms';
import { EMERGENCY_STEPS, LEVEL_META } from './lib/detection';import { loadPreferences, savePreferences } from './lib/preferences';
import { playAlertSound, primeAlertAudio } from './lib/alertSound';
import { SENSITIVITY_META } from './lib/detector';
import type { FrameAnalysis } from './lib/detector';
import { api } from './lib/api';
import type { ManagedCamera } from './lib/api';
import type {
  Alarm,
  AlarmHandlers,
  AlarmLevel,
  Camera,
  CameraSource,
  CameraStatus,
  DetectionSensitivity,
  ToastKind,
  ToastState,
  ViewKey,
} from './types';

/**
 * 哪些告警等级会改变大屏的「火焰/烟雾」状态并叠加识别框。
 *
 * 采用白名单而非黑名单：`offline` 与 `camera_abnormal` 是设备健康类告警，
 * 不是画面识别结果。旧实现用 `level === 'fire' ? 'fire' : 'smoke'` 的二元
 * 表达式，导致新增的 `camera_abnormal` 被误显示为「烟雾」—— 在消防值守
 * 场景下属于方向性误导。白名单让未来新增等级默认安全（不叠加）。
 */
const ALARM_TO_CAMERA_STATUS: Partial<Record<AlarmLevel, CameraStatus>> = {
  fire: 'fire',
  smoke: 'smoke',
};

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
    sseDown,
    createAlarm,
    patchAlarm,
  } = useAlarms();
  const [view, setView] = useState<ViewKey>('monitor');
  const [sources, setSources] = useState<Record<string, CameraSource>>({});
  // 用户主动断开的网络流不应被 sources 同步 effect 自动接回。
  const manuallyDisconnected = useRef<Set<string>>(new Set());
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
        if (manuallyDisconnected.current.has(point.id)) return;
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
        manuallyDisconnected.current.delete(cameraId);
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
      // 只有火焰/烟雾会改变大屏状态；设备健康类告警只进告警中心。
      const next = ALARM_TO_CAMERA_STATUS[alarm.level];
      if (!next) return;
      if (map[alarm.cameraId] === 'fire') return;
      map[alarm.cameraId] = next;
    });
    return map;
  }, [alarms, cameras]);

  const activeAlarms = useMemo(() => {
    const map: Record<string, Alarm> = {};
    alarms.forEach((alarm) => {
      if (alarm.status !== 'pending' && alarm.status !== 'confirmed') return;
      // 与 statusMap 同口径：设备健康类告警不在画面上叠加识别框。
      if (!ALARM_TO_CAMERA_STATUS[alarm.level]) return;
      const existing = map[alarm.cameraId];
      if (!existing || alarm.level === 'fire') {
        map[alarm.cameraId] = alarm;
      }
    });
    return map;
  }, [alarms]);

  // 记忆化：alarms 每 3 秒轮询/SSE 都会换新数组引用，
  // 不缓存的话这两项会在每次渲染时重复遍历整个告警列表。
  const pendingCount = useMemo(
    () => alarms.filter((alarm) => alarm.status === 'pending').length,
    [alarms],
  );
  const latestPendingId = useMemo(
    () => alarms.find((alarm) => alarm.status === 'pending')?.id ?? null,
    [alarms],
  );

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
          `${camera.name} 识别到${LEVEL_META[detection.level]?.label ?? '异常'}（置信度 ${
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
      manuallyDisconnected.current.delete(cameraId);
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
      manuallyDisconnected.current.delete(cameraId);
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
      manuallyDisconnected.current.add(cameraId);
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

  // 处置动作按告警 ID 防重入：双击「确认火情」会发两次 PATCH，
  // 产生重复审计日志与两条 toast；归档按钮第二次请求还会 404 报错。
  // 用 Set 而非布尔量，避免不同告警之间互相阻塞。
  const pendingAlarms = useRef<Set<string>>(new Set());
  const withAlarmLock = useCallback(
    async (id: string, run: () => Promise<void>) => {
      if (pendingAlarms.current.has(id)) return;
      pendingAlarms.current.add(id);
      try {
        await run();
      } finally {
        pendingAlarms.current.delete(id);
      }
    },
    [],
  );

  const handleConfirm = useCallback(
    (id: string) =>
      withAlarmLock(id, async () => {
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
      }),
    [alarms, patchAlarm, showToast, withAlarmLock],
  );

  const handleFalse = useCallback(
    (id: string) =>
      withAlarmLock(id, async () => {
        try {
          await patchAlarm(id, { status: 'false' });
          showToast('已标记为误报，通道恢复正常监测', 'ok');
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : '标记误报失败',
            'danger',
          );
        }
      }),
    [patchAlarm, showToast, withAlarmLock],
  );

  const handleToggleStep = useCallback(
    (id: string, index: number) =>
      withAlarmLock(id, async () => {
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
      }),
    [alarms, patchAlarm, showToast, withAlarmLock],
  );

  const handleArchive = useCallback(
    (id: string) =>
      withAlarmLock(id, async () => {
        try {
          await patchAlarm(id, { status: 'archived' });
          showToast('处置完成，告警已归档至处置记录', 'ok');
        } catch (error) {
          showToast(
            error instanceof Error ? error.message : '归档告警失败',
            'danger',
          );
        }
      }),
    [patchAlarm, showToast, withAlarmLock],
  );

  const handleNoteChange = useCallback(
    async (id: string, note: string): Promise<boolean> => {
      try {
        await patchAlarm(id, { note: note.slice(0, 300) });
        return true;
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : '保存值守备注失败',
          'danger',
        );
        // 返回 false：调用方据此保留输入框里的草稿，避免用户输入无声丢失。
        return false;
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

  const handleLocalDetectionChange = useCallback(
    (value: 'auto' | 'on' | 'off') => {
      setPreferences((prev) => ({ ...prev, localDetection: value }));
    },
    [setPreferences],
  );

  const handleToggleTour = useCallback(() => {
    if (tour.enabled) {
      stopTour();
      setFocusedCameraId(null);
      showToast('已退出自动轮巡', 'info');
    } else {
      startTour();
    }
  }, [tour.enabled, stopTour, setFocusedCameraId, showToast, startTour]);

  const handleOpenAlarmFromChannel = useCallback((id: string) => {
    setExpandedId(id);
    setView('alarms');
  }, []);

  const handleFocusStop = useCallback(() => {
    stopTour();
    setFocusedCameraId(null);
    showToast('已退出自动轮巡', 'info');
  }, [stopTour, setFocusedCameraId, showToast]);

  return (
    <div className={`app-shell view-${view}`}>
      <div className="app-inner">
        <TopBar
          view={view}
          onViewChange={setView}
          pendingCount={pendingCount}
          onlineCount={onlineCount}
          totalCount={cameras.length}
          sseDown={sseDown}
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
            <MonitorView
              cameras={cameras}
              statusMap={statusMap}
              activeAlarms={activeAlarms}
              sources={sources}
              remoteStreams={remoteStreams}
              selectedCameraId={selectedCameraId}
              focusedCameraId={focusedCameraId}
              localDetectionIds={localDetectionIds}
              preferences={preferences}
              serverDetection={serverDetection}
              screenAwake={screenAwake}
              tourEnabled={tour.enabled}
              tourQueueLength={tourQueue.length}
              demoBusy={demoBusy}
              user={user}
              pointsLoading={pointsLoading}
              pointsError={pointsError}
              alarmsError={alarmsError}
              alarmsLoading={alarmsLoading}
              queue={queue}
              pendingCount={pendingCount}
              expandedId={expandedId}
              handlers={handlers}
              readOnly={readOnly}
              selectedCamera={selectedCamera}
              selectedSource={selectedSource}
              selectedAlarm={selectedAlarm}
              onSensitivityChange={handleSensitivityChange}
              onLocalDetectionChange={handleLocalDetectionChange}
              onToggleSound={handleToggleSound}
              onToggleWakeLock={handleToggleWakeLock}
              onToggleTour={handleToggleTour}
              onSelectCamera={setSelectedCameraId}
              onFocus={setFocusedCameraId}
              onConnectFile={handleConnectFile}
              onReconnectNetwork={handleReconnectRemote}
              onDisconnect={handleDisconnect}
              onDetection={handleDetection}
              onStartDemo={startDemoWalkthrough}
              onOpenAdminCameras={() => openAdmin('cameras')}
              onOpenAdminNotify={() => openAdmin('notify')}
              onOpenAlarmFromChannel={handleOpenAlarmFromChannel}
            />
          )}

          {view === 'alarms' && (
            <AlarmCenter
              alarms={alarms}
              expandedId={expandedId}
              handlers={handlers}
              readOnly={readOnly}
            />
          )}

          {view === 'records' && (
            <>
              <RecordsView alarms={alarms} />
              <RecordingTimeline cameras={cameras} />
            </>
          )}
        </main>
      </div>

      {focusedCamera && focusedSource && (
        <FocusOverlay
          camera={focusedCamera}
          source={focusedSource}
          status={statusMap[focusedCamera.id] ?? 'normal'}
          alarm={activeAlarms[focusedCamera.id]}
          sensitivity={preferences.sensitivity}
          detectionEnabled={localDetectionFor(focusedCamera)}
          tour={tour}
          tourQueue={tourQueue}
          onDetection={handleDetection}
          onClose={handleCloseFocus}
          onOpenAlarm={handleOpenFocusedAlarm}
          onDisconnect={handleDisconnect}
          onStepTour={stepTour}
          onTogglePause={() => setTour((prev) => ({ ...prev, paused: !prev.paused }))}
          onIntervalChange={(seconds: number) =>
            setTour((prev) => ({ ...prev, interval: seconds }))
          }
          onStop={handleFocusStop}
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