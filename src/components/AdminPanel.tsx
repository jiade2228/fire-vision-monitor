import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type {
  CameraInput,
  CameraSensitivity,
  DemoStatus,
  EdgeGatewayStatus,
  ManagedCamera,
  NotificationLog,
  NotifyChannel,
  NotifyKind,
  AlarmStats,
  AlarmStatsDay,
  OnvifDiscoverResult,
  OnvifProfile,
  OnvifScanDevice,
  ProbeResult,
  SessionUser,
  Site,
  StreamHealth,
  SystemInfo,
  UserRole,
  VendorPreset,
} from '../lib/api';
import type { ToastKind } from '../types';
import { formatDateTime } from '../lib/format';
import RoiEditor from './RoiEditor';

interface Props {
  cameras: ManagedCamera[];
  currentUser: SessionUser;
  onClose: () => void;
  onCamerasChanged: () => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
}

type TabKey = 'cameras' | 'users' | 'sites' | 'stats' | 'notify';

const NOTIFY_KIND_LABELS: Record<NotifyKind, string> = {
  webhook: 'Webhook',
  wecom: '企业微信',
  dingtalk: '钉钉',
};

const NOTIFY_EVENT_LABELS: Record<string, string> = {
  created: '告警产生',
  confirmed: '确认处置',
  false: '判定误报',
  recovered: '设备恢复',
  summary: '每日摘要',
  'channel.disabled': '渠道停用',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function StatsChart({ days }: { days: AlarmStatsDay[] }) {
  const width = 560;
  const height = 168;
  const pad = { left: 30, right: 8, top: 10, bottom: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...days.map((day) => day.total));
  const slot = innerW / Math.max(days.length, 1);
  const barW = Math.max(2, slot * 0.62);
  return (
    <svg
      className="stats-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`近${days.length}天告警趋势`}
    >
      {[0, 0.5, 1].map((ratio) => {
        const y = pad.top + innerH * (1 - ratio);
        return (
          <g key={ratio}>
            <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} className="stats-grid" />
            <text x={pad.left - 5} y={y + 3} className="stats-axis" textAnchor="end">
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}
      {days.map((day, index) => {
        const fireH = innerH * (day.fire / max);
        const smokeH = innerH * (day.smoke / max);
        const offlineH = innerH * (day.offline / max);
        const x = pad.left + index * slot + (slot - barW) / 2;
        const totalH = fireH + smokeH + offlineH;
        const yFire = pad.top + innerH - totalH;
        const ySmoke = yFire + fireH;
        const yOffline = ySmoke + smokeH;
        return (
          <g key={day.date}>
            <title>{`${day.date} 共 ${day.total} 条（火焰 ${day.fire} · 烟雾 ${day.smoke} · 离线 ${day.offline}）`}</title>
            {day.offline > 0 && (
              <rect x={x} y={yOffline} width={barW} height={offlineH} rx="1" fill="rgba(148,163,184,0.72)" />
            )}
            {day.smoke > 0 && (
              <rect x={x} y={ySmoke} width={barW} height={smokeH} rx="1" fill="rgba(255,170,70,0.9)" />
            )}
            {day.fire > 0 && (
              <rect x={x} y={yFire} width={barW} height={fireH} rx="1" fill="rgba(255,75,62,0.9)" />
            )}
          </g>
        );
      })}
      {days.map((day, index) =>
        index % 5 === 0 || index === days.length - 1 ? (
          <text
            key={day.date}
            x={pad.left + index * slot + slot / 2}
            y={height - 5}
            className="stats-axis"
            textAnchor="middle"
          >
            {day.date.slice(5)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

const PROTOCOL_LABELS: Record<ManagedCamera['protocol'], string> = {
  none: '未配置',
  hls: 'HLS',
  http: 'HTTP 视频',
  rtsp: 'RTSP / NVR',
  edge: '现场边缘网关',
};

const EMPTY_CAMERA: CameraInput = {
  name: '',
  zone: '',
  protocol: 'none',
  sourceUrl: '',
  enabled: true,
  siteId: '',
  detectEnabled: true,
  detectSensitivity: null,
  detectRoi: [],
};

export default function AdminPanel({
  cameras,
  currentUser,
  onClose,
  onCamerasChanged,
  onNotify,
}: Props) {
  const isSuperAdmin = currentUser.role === 'admin';
  const [tab, setTab] = useState<TabKey>('cameras');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [cameraForm, setCameraForm] = useState<CameraInput>(EMPTY_CAMERA);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCameraForm, setShowCameraForm] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [showNvrForm, setShowNvrForm] = useState(false);
  const [nvrBusy, setNvrBusy] = useState(false);
  const [vendors, setVendors] = useState<VendorPreset[]>([]);
  const [health, setHealth] = useState<Record<string, StreamHealth>>({});
  const [edgeGateways, setEdgeGateways] = useState<EdgeGatewayStatus[]>([]);
  const [edgeEnabled, setEdgeEnabled] = useState(false);
  const [edgeToken, setEdgeToken] = useState('');
  const [probeAvailable, setProbeAvailable] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult>>({});
  const [nvrForm, setNvrForm] = useState({
    vendorId: 'hikvision',
    host: '',
    rtspPort: 554,
    username: '',
    password: '',
    startChannel: 1,
    count: 4,
    stream: 'sub' as 'main' | 'sub',
    zone: '',
    namePrefix: '海康点位',
    template: '',
    siteId: '',
  });
  const [showOnvifForm, setShowOnvifForm] = useState(false);
  const [onvifBusy, setOnvifBusy] = useState(false);
  const [onvifScanBusy, setOnvifScanBusy] = useState(false);
  const [onvifScanDevices, setOnvifScanDevices] = useState<OnvifScanDevice[]>([]);
  const [onvifImporting, setOnvifImporting] = useState(false);
  const [onvifForm, setOnvifForm] = useState({
    hosts: '',
    port: 80,
    username: '',
    password: '',
    zone: '',
    siteId: '',
  });
  const [onvifResults, setOnvifResults] = useState<OnvifDiscoverResult['results']>([]);
  const [onvifSelected, setOnvifSelected] = useState<string[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [defaultSiteId, setDefaultSiteId] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [siteForm, setSiteForm] = useState({ name: '', code: '' });
  const [siteBusy, setSiteBusy] = useState(false);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editingSiteName, setEditingSiteName] = useState('');
  const [assigningUser, setAssigningUser] = useState<SessionUser | null>(null);
  const [assignSiteIds, setAssignSiteIds] = useState<string[]>([]);
  const [assignBusy, setAssignBusy] = useState(false);
  const [notifyChannels, setNotifyChannels] = useState<NotifyChannel[]>([]);
  const [notifyLogs, setNotifyLogs] = useState<NotificationLog[]>([]);
  const [alarmStats, setAlarmStats] = useState<AlarmStats | null>(null);
  const [statsDays, setStatsDays] = useState(30);
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [demoStatus, setDemoStatus] = useState<DemoStatus | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [notifyForm, setNotifyForm] = useState<{
    name: string;
    kind: NotifyKind;
    url: string;
    secret: string;
    siteId: string;
    enabled: boolean;
  }>({
    name: '',
    kind: 'wecom',
    url: '',
    secret: '',
    siteId: '',
    enabled: true,
  });
  const selectedVendor = vendors.find((vendor) => vendor.id === nvrForm.vendorId);
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [userForm, setUserForm] = useState({
    username: '',
    displayName: '',
    password: '',
    role: 'operator' as UserRole,
    siteAdmin: false,
  });
  const [userBusy, setUserBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const result = await api.users();
      setUsers(result.users);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '账号列表加载失败',
      );
    } finally {
      setUsersLoading(false);
    }
  };

  const loadSites = async () => {
    try {
      const result = await api.sites();
      setSites(result.sites);
      setDefaultSiteId(result.defaultSiteId);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点列表加载失败',
      );
    }
  };

  const siteKey = (id: string | null | undefined) => id || defaultSiteId || '';
  const siteName = (id: string | null | undefined) =>
    sites.find((site) => site.id === id)?.name ?? '默认站点';

  const loadNotify = async () => {
    try {
      const result = await api.notifyChannels();
      setNotifyChannels(result.channels);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道加载失败',
      );
    }
  };

  const loadNotifyLogs = async () => {
    try {
      const result = await api.notificationLogs(30);
      setNotifyLogs(result.logs);
    } catch {
      // 推送记录失败不阻塞页面。
    }
  };

  const loadAlarmStats = async (days = 30) => {
    try {
      const result = await api.alarmStats(days);
      setAlarmStats(result);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '统计数据加载失败',
      );
    }
  };

  const loadDemoStatus = async () => {
    if (!isSuperAdmin) return;
    try {
      const result = await api.demoStatus();
      setDemoStatus(result);
    } catch {
      // 演示状态非关键，失败静默
    }
  };

  const toggleDemo = async (action: 'start' | 'stop') => {
    setDemoBusy(true);
    try {
      const result =
        action === 'start' ? await api.startDemo() : await api.stopDemo();
      setDemoStatus(result);
      await onCamerasChanged();
      // 告警是异步产生的，重新拉一次状态拿最新的可清除数量。
      void loadDemoStatus();
      onNotify(
        action === 'start' ? '演示视频源已启动，几秒内将自动产生火焰告警' : '演示视频源已停止',
        action === 'start' ? 'ok' : 'info',
      );
    } catch (requestError) {
      onNotify(
        requestError instanceof ApiError
          ? requestError.message
          : action === 'start'
            ? '演示视频源启动失败'
            : '演示视频源停止失败',
        'danger',
      );
    } finally {
      setDemoBusy(false);
    }
  };

  const purgeDemoData = async () => {
    const purgeable = demoStatus?.purgeable;
    const summary = purgeable
      ? `将清除 ${purgeable.alarms} 条演示告警（含 ${purgeable.snapshots} 张抓拍、${purgeable.clips} 段短视频）及其处置记录与推送日志。\n真实告警与点位不受影响，审计日志保留。确定继续？`
      : '当前没有可清除的演示数据。';
    if (!purgeable?.alarms) {
      onNotify('当前没有可清除的演示数据', 'info');
      return;
    }
    if (!window.confirm(summary)) return;
    setDemoBusy(true);
    try {
      const result = await api.purgeDemoData();
      setDemoStatus((prev) => (prev ? { ...prev, purgeable: result.purgeable } : prev));
      onNotify(
        result.removed
          ? `已清除 ${result.removed} 条演示告警、${result.filesRemoved} 个媒体文件`
          : '没有需要清除的演示数据',
        'ok',
      );
    } catch (requestError) {
      onNotify(
        requestError instanceof ApiError ? requestError.message : '清除演示数据失败',
        'danger',
      );
    } finally {
      setDemoBusy(false);
    }
  };

  useEffect(() => {
    const loadHealth = async () => {
      try {
        const result = await api.streamHealth();
        setHealth(
          Object.fromEntries(
            result.cameras.map((camera) => [camera.cameraId, camera]),
          ),
        );
        setProbeAvailable(result.probeAvailable);
        const edge = await api.edgeStatus();
        setEdgeGateways(edge.gateways);
        setEdgeEnabled(edge.enabled);
        setEdgeToken(edge.pairingToken);
      } catch {
        // 健康状态轮询失败不影响配置操作。
      }
    };
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadSystem = () => {
      void api
        .system()
        .then((info) => {
          if (!cancelled) setSystem(info);
        })
        .catch(() => undefined);
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    if (isSuperAdmin) {
      loadSystem();
      // 轮询服务端巡检统计，面板打开时能看到帧数与告警数的变化。
      timer = setInterval(() => {
        loadSystem();
        // 演示运行中告警持续产生，同步刷新可清除数量。
        void loadDemoStatus();
      }, 10_000);
      void loadUsers();
      void loadDemoStatus();
    }
    void api
      .vendors()
      .then((result) => setVendors(result.vendors))
      .catch(() => undefined);
    void loadSites();
    void loadNotify();
    void loadNotifyLogs();
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [isSuperAdmin]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

  const openCreateCamera = () => {
    setEditingId(null);
    setCameraForm({ ...EMPTY_CAMERA, siteId: siteFilter || defaultSiteId || '' });
    setShowCameraForm(true);
    setError('');
  };

  const openEditCamera = (camera: ManagedCamera) => {
    setEditingId(camera.id);
    setCameraForm({
      name: camera.name,
      zone: camera.zone,
      protocol: camera.protocol,
      sourceUrl: camera.sourceUrl,
      enabled: camera.enabled,
      siteId: camera.siteId || defaultSiteId || '',
      detectEnabled: camera.detectEnabled !== false,
      detectSensitivity: camera.detectSensitivity ?? null,
      detectRoi: camera.detectRoi ?? [],
    });
    setShowCameraForm(true);
    setError('');
  };

  const submitCamera = async (event: FormEvent) => {
    event.preventDefault();
    setCameraBusy(true);
    setError('');
    try {
      if (editingId) {
        await api.updateCamera(editingId, cameraForm);
      } else {
        await api.createCamera(cameraForm);
      }
      try {
        await onCamerasChanged();
      } catch {
        onNotify('点位已保存，但列表刷新失败，请刷新页面', 'info');
      }
      setShowCameraForm(false);
      setEditingId(null);
      setCameraForm(EMPTY_CAMERA);
      onNotify(editingId ? '点位配置已更新' : '新点位已创建', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '点位保存失败',
      );
    } finally {
      setCameraBusy(false);
    }
  };

  const changeVendor = (vendorId: string) => {
    const vendor = vendors.find((item) => item.id === vendorId);
    setNvrForm((prev) => ({
      ...prev,
      vendorId,
      rtspPort: vendor?.defaultPort ?? 554,
      stream: vendor?.supportsSubstream === false ? 'main' : 'sub',
      startChannel: 1,
      count: vendor?.singleChannel ? 1 : Math.max(1, prev.count),
      namePrefix:
        vendorId === 'custom'
          ? '监控点位'
          : `${vendor?.name.split(' / ')[0] ?? '监控'}点位`,
      template: vendorId === 'custom' ? prev.template : '',
    }));
  };

  const submitNvr = async (event: FormEvent) => {
    event.preventDefault();
    setNvrBusy(true);
    setError('');
    try {
      const result = await api.importBrandCameras({
        ...nvrForm,
        siteId: nvrForm.siteId || defaultSiteId || null,
      });
      try {
        await onCamerasChanged();
      } catch {
        onNotify('点位已导入，但列表刷新失败，请刷新页面', 'info');
      }
      setShowNvrForm(false);
      setNvrForm((prev) => ({ ...prev, password: '' }));
      onNotify(
        `已导入 ${result.created} 个${result.vendor.singleChannel ? '' : '通道'}点位${
          result.skipped ? `，跳过 ${result.skipped} 个重复地址` : ''
        }`,
        'ok',
      );
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '设备批量导入失败',
      );
    } finally {
      setNvrBusy(false);
    }
  };

  const runOnvifScan = async () => {
    setOnvifScanBusy(true);
    setError('');
    setOnvifResults([]);
    setOnvifSelected([]);
    try {
      const result = await api.scanOnvif({ timeoutMs: 4000 });
      setOnvifScanDevices(result.devices);
      const discoveredHosts = result.devices.map((device) => device.host);
      const commonPort =
        result.devices.length > 0 &&
        result.devices.every((device) => device.port === result.devices[0].port)
          ? result.devices[0].port
          : null;
      setOnvifForm((prev) => {
        const existingHosts = prev.hosts
          .split(/[\s,，;；]+/)
          .map((item) => item.trim())
          .filter(Boolean);
        const merged = [...new Set([...existingHosts, ...discoveredHosts])].slice(0, 256);
        return {
          ...prev,
          hosts: merged.join(', '),
          ...(existingHosts.length === 0 && commonPort ? { port: commonPort } : {}),
        };
      });
      onNotify(
        result.devices.length
          ? `扫描到 ${result.devices.length} 台 ONVIF 设备，已填入地址；请核对凭据后点击“开始发现”`
          : '未扫描到 ONVIF 设备，请确认服务器与摄像头在同一网段且组播未被禁用',
        result.devices.length ? 'ok' : 'info',
      );
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : 'ONVIF 网段扫描失败',
      );
    } finally {
      setOnvifScanBusy(false);
    }
  };

  const runOnvifDiscover = async (event: FormEvent) => {
    event.preventDefault();
    setOnvifBusy(true);
    setError('');
    setOnvifResults([]);
    setOnvifSelected([]);
    try {
      const result = await api.discoverOnvif(onvifForm);
      setOnvifResults(result.results);
      const auto: string[] = [];
      for (const item of result.results) {
        if (item.ok && item.device) {
          for (const profile of item.device.profiles) {
            if (profile.rtspUri) auto.push(`${item.device.host}:${profile.token}`);
          }
        }
      }
      setOnvifSelected(auto);
      const okCount = result.results.filter(
        (entry) => entry.ok && (entry.device?.profiles.length ?? 0) > 0,
      ).length;
      onNotify(
        okCount
          ? `已发现 ${okCount} 台设备，已自动勾选可导入通道`
          : '未发现可用设备，请检查地址、端口与凭据',
        okCount ? 'ok' : 'info',
      );
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'ONVIF 探测失败');
    } finally {
      setOnvifBusy(false);
    }
  };

  const toggleOnvifProfile = (key: string) => {
    setOnvifSelected((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  };

  const importOnvifSelected = async () => {
    setOnvifImporting(true);
    setError('');
    try {
      const byHost = new Map<
        string,
        { label: string; zone: string; host: string; profiles: OnvifProfile[] }
      >();
      for (const item of onvifResults) {
        if (!item.ok || !item.device) continue;
        for (const profile of item.device.profiles) {
          const key = `${item.device.host}:${profile.token}`;
          if (!onvifSelected.includes(key)) continue;
          const existing =
            byHost.get(item.device.host) ??
            {
              label: item.device.host,
              zone: onvifForm.zone || 'ONVIF',
              host: item.device.host,
              siteId: onvifForm.siteId || defaultSiteId || null,
              profiles: [] as OnvifProfile[],
            };
          existing.profiles.push(profile);
          byHost.set(item.device.host, existing);
        }
      }
      if (byHost.size === 0) {
        setError('请至少勾选一个通道');
        setOnvifImporting(false);
        return;
      }
      const result = await api.importOnvif({ devices: Array.from(byHost.values()) });
      try {
        await onCamerasChanged();
      } catch {
        onNotify('点位已导入，但列表刷新失败，请刷新页面', 'info');
      }
      onNotify(
        `已导入 ${result.created} 个通道${
          result.skipped ? `，跳过 ${result.skipped} 个重复地址` : ''
        }`,
        'ok',
      );
      setShowOnvifForm(false);
      setOnvifResults([]);
      setOnvifSelected([]);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'ONVIF 导入失败');
    } finally {
      setOnvifImporting(false);
    }
  };

  const deleteCamera = async (camera: ManagedCamera) => {
    if (!window.confirm(`确定删除点位「${camera.name}」？该操作不可撤销。`)) return;
    try {
      await api.deleteCamera(camera.id);
      await onCamerasChanged();
      onNotify('点位已删除', 'info');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '删除点位失败',
      );
    }
  };

  const runProbe = async (camera: ManagedCamera) => {
    setTestingId(camera.id);
    setError('');
    try {
      const result = await api.testCamera(camera.id);
      setProbeResults((prev) => ({ ...prev, [camera.id]: result }));
      onNotify(
        result.ok
          ? `测流成功：${result.codec ?? '视频'} ${
              result.width && result.height ? `${result.width}×${result.height}` : ''
            } · ${result.latencyMs}ms`
          : `测流失败：${result.error ?? '未知错误'}`,
        result.ok ? 'ok' : 'info',
      );
    } catch (requestError) {
      const message =
        requestError instanceof ApiError ? requestError.message : '测流请求失败';
      setProbeResults((prev) => ({
        ...prev,
        [camera.id]: { ok: false, latencyMs: 0, error: message },
      }));
      onNotify(message, 'danger');
    } finally {
      setTestingId(null);
    }
  };

  const healthText = (item?: StreamHealth) => {
    if (!item) return '状态未知';
    const labels: Record<StreamHealth['status'], string> = {
      disabled: '已停用',
      unconfigured: '未配置',
      external: '外部流',
      starting: '转码启动中',
      running: '转码运行中',
      gateway: '网关在线',
      error: '转码异常',
      idle: '待机',
    };
    return labels[item.status];
  };

  const copyEdgeToken = async () => {
    if (!edgeToken) return;
    try {
      await navigator.clipboard.writeText(edgeToken);
      onNotify('网关配对令牌已复制，请填入现场网关配置', 'ok');
    } catch {
      onNotify('复制失败，请在安全环境中手动查看 edge.token 文件', 'danger');
    }
  };

  const submitUser = async (event: FormEvent) => {
    event.preventDefault();
    setUserBusy(true);
    setError('');
    try {
      const result = await api.createUser(userForm);
      setUsers((prev) => [...prev, result.user]);
      setUserForm({
        username: '',
        displayName: '',
        password: '',
        role: 'operator',
        siteAdmin: false,
      });
      onNotify('新账号已创建', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '账号创建失败',
      );
    } finally {
      setUserBusy(false);
    }
  };

  const updateUser = async (
    user: SessionUser,
    patch: Partial<Pick<SessionUser, 'displayName' | 'role' | 'disabled' | 'siteAdmin'>>,
  ) => {
    setError('');
    try {
      const result = await api.updateUser(user.id, patch);
      setUsers((prev) => prev.map((item) => (item.id === user.id ? result.user : item)));
      onNotify('账号设置已更新', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '账号更新失败',
      );
    }
  };

  const resetPassword = async (user: SessionUser) => {
    const password = window.prompt(`为「${user.displayName}」设置新密码（至少 8 位）`);
    if (!password) return;
    if (password.length < 8) {
      setError('新密码至少需要 8 位');
      return;
    }
    try {
      await api.updateUser(user.id, { password });
      onNotify('密码已重置', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '密码重置失败',
      );
    }
  };

  const deleteUser = async (user: SessionUser) => {
    if (!window.confirm(`确定删除账号「${user.displayName}」？`)) return;
    try {
      await api.deleteUser(user.id);
      setUsers((prev) => prev.filter((item) => item.id !== user.id));
      onNotify('账号已删除', 'info');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '账号删除失败',
      );
    }
  };

  const submitSite = async (event: FormEvent) => {
    event.preventDefault();
    setSiteBusy(true);
    setError('');
    try {
      const result = await api.createSite({
        name: siteForm.name.trim(),
        code: siteForm.code.trim() || undefined,
      });
      setSites((prev) => [...prev, result.site]);
      setSiteForm({ name: '', code: '' });
      onNotify('站点已创建', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点创建失败',
      );
    } finally {
      setSiteBusy(false);
    }
  };

  const startEditSite = (site: Site) => {
    setEditingSiteId(site.id);
    setEditingSiteName(site.name);
    setError('');
  };

  const cancelEditSite = () => {
    setEditingSiteId(null);
    setEditingSiteName('');
  };

  const saveEditSite = async (site: Site) => {
    setSiteBusy(true);
    setError('');
    try {
      const result = await api.updateSite(site.id, { name: editingSiteName.trim() });
      setSites((prev) => prev.map((item) => (item.id === site.id ? result.site : item)));
      setEditingSiteId(null);
      setEditingSiteName('');
      onNotify('站点名称已更新', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点更新失败',
      );
    } finally {
      setSiteBusy(false);
    }
  };

  const removeSite = async (site: Site) => {
    const count = cameras.filter((camera) => siteKey(camera.siteId) === site.id).length;
    const message = count
      ? `站点「${site.name}」下还有 ${count} 个点位，删除前请先将这些点位移动到其他站点或默认站点。`
      : `确定删除站点「${site.name}」？该操作不可撤销。`;
    if (!window.confirm(message)) return;
    setSiteBusy(true);
    setError('');
    try {
      await api.deleteSite(site.id);
      setSites((prev) => prev.filter((item) => item.id !== site.id));
      setSiteFilter((prev) => (prev === site.id ? '' : prev));
      onNotify('站点已删除', 'info');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点删除失败',
      );
    } finally {
      setSiteBusy(false);
    }
  };

  const openAssignUser = async (user: SessionUser) => {
    setError('');
    setAssigningUser(user);
    setAssignBusy(true);
    try {
      const result = await api.userSites(user.id);
      setAssignSiteIds(result.siteIds);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点授权加载失败',
      );
      setAssignSiteIds([]);
    } finally {
      setAssignBusy(false);
    }
  };

  const toggleAssignSite = (siteId: string) => {
    setAssignSiteIds((prev) =>
      prev.includes(siteId) ? prev.filter((id) => id !== siteId) : [...prev, siteId],
    );
  };

  const saveAssignUser = async () => {
    if (!assigningUser) return;
    setAssignBusy(true);
    setError('');
    try {
      await api.setUserSites(assigningUser.id, assignSiteIds);
      onNotify(
        `已为「${assigningUser.displayName}」授权 ${assignSiteIds.length} 个站点`,
        'ok',
      );
      setAssigningUser(null);
      setAssignSiteIds([]);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '站点授权失败',
      );
    } finally {
      setAssignBusy(false);
    }
  };

  const submitNotify = async (event: FormEvent) => {
    event.preventDefault();
    if (!isSuperAdmin && !notifyForm.siteId) {
      setError('请选择通知渠道生效的站点');
      return;
    }
    setNotifyBusy(true);
    setError('');
    try {
      const result = await api.createNotifyChannel({
        name: notifyForm.name.trim(),
        kind: notifyForm.kind,
        url: notifyForm.url.trim(),
        secret: notifyForm.secret.trim() || undefined,
        siteId: notifyForm.siteId || null,
        enabled: notifyForm.enabled,
      });
      setNotifyChannels((prev) => [...prev, result.channel]);
      setNotifyForm((prev) => ({ ...prev, name: '', url: '', secret: '' }));
      onNotify('通知渠道已创建', 'ok');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道创建失败',
      );
    } finally {
      setNotifyBusy(false);
    }
  };

  const toggleNotifyChannel = async (channel: NotifyChannel) => {
    setError('');
    try {
      const result = await api.updateNotifyChannel(channel.id, {
        enabled: !channel.enabled,
      });
      setNotifyChannels((prev) =>
        prev.map((item) => (item.id === channel.id ? result.channel : item)),
      );
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道更新失败',
      );
    }
  };

  const removeNotifyChannel = async (channel: NotifyChannel) => {
    if (!window.confirm(`确定删除通知渠道「${channel.name}」？`)) return;
    setError('');
    try {
      await api.deleteNotifyChannel(channel.id);
      setNotifyChannels((prev) => prev.filter((item) => item.id !== channel.id));
      onNotify('通知渠道已删除', 'info');
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道删除失败',
      );
    }
  };

  const testNotifyChannel = async (channel: NotifyChannel) => {
    setTestingChannel(channel.id);
    setError('');
    try {
      await api.testNotifyChannel(channel.id);
      onNotify(`测试消息已发送到「${channel.name}」`, 'ok');
      void loadNotifyLogs();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '测试发送失败',
      );
    } finally {
      setTestingChannel(null);
    }
  };

  return (
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-shell admin-shell"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-title"
      >
        <header className="settings-head">
          <div>
            <h2 id="admin-title">系统管理</h2>
            <p>管理远程点位、视频流和访问账号</p>
          </div>
          <button ref={closeRef} type="button" className="settings-close" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="admin-tabs" role="tablist" aria-label="系统管理分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'cameras'}
            className={`admin-tab ${tab === 'cameras' ? 'is-active' : ''}`}
            onClick={() => setTab('cameras')}
          >
            点位与视频流
          </button>
          {isSuperAdmin && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'users'}
              className={`admin-tab ${tab === 'users' ? 'is-active' : ''}`}
              onClick={() => setTab('users')}
            >
              账号与权限
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sites'}
            className={`admin-tab ${tab === 'sites' ? 'is-active' : ''}`}
            onClick={() => setTab('sites')}
          >
            站点与分组
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'stats'}
            className={`admin-tab ${tab === 'stats' ? 'is-active' : ''}`}
            onClick={() => {
              setTab('stats');
              void loadAlarmStats(statsDays);
            }}
          >
            数据统计
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notify'}
            className={`admin-tab ${tab === 'notify' ? 'is-active' : ''}`}
            onClick={() => {
              setTab('notify');
              if (!isSuperAdmin) {
                setNotifyForm((prev) => ({
                  ...prev,
                  siteId: prev.siteId || sites[0]?.id || '',
                }));
              }
            }}
          >
            告警通知
          </button>
          {isSuperAdmin && system && (
            <span className={`admin-system ${system.ffmpegAvailable ? 'is-ok' : 'is-warn'}`}>
              FFmpeg {system.ffmpegAvailable ? '可用' : '未安装'}
            </span>
          )}
          {!isSuperAdmin && <span className="admin-system is-ok">站点管理员</span>}
        </div>

        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}

        <div className="admin-body">
          {tab === 'cameras' ? (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>已接入点位</h3>
                  <p>点位保存在服务器，所有账号登录后看到同一份配置。</p>
                </div>
                <div className="admin-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setShowOnvifForm((visible) => !visible);
                      setShowNvrForm(false);
                      setShowCameraForm(false);
                      setError('');
                    }}
                  >
                    ONVIF 自动发现
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setShowNvrForm((visible) => !visible);
                      setShowOnvifForm(false);
                      setShowCameraForm(false);
                      setError('');
                    }}
                  >
                    品牌设备批量接入
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" onClick={openCreateCamera}>
                    新增单个点位
                  </button>
                </div>
              </div>

              {isSuperAdmin && edgeEnabled && (
                <div className="edge-status-strip">
                  <strong>现场边缘网关</strong>
                  {edgeGateways.length === 0 && (
                    <span className="edge-off">已启用，等待现场网关主动连接…</span>
                  )}
                  {edgeGateways.map((gateway) => (
                    <span key={gateway.gatewayId}>
                      {gateway.name}（{gateway.gatewayId}）：
                      {gateway.cameras.length
                        ? gateway.cameras
                            .map((camera) => `${camera.label}=${camera.key}`)
                            .join('、')
                        : '未上报摄像头'}
                    </span>
                  ))}
                  <div className="edge-pairing">
                    <span>配对令牌（仅用于现场网关配置，不会展示给普通用户）：</span>
                    <code className="edge-token">{edgeToken || '（未生成）'}</code>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => void copyEdgeToken()}
                    >
                      复制令牌
                    </button>
                  </div>
                </div>
              )}
              {isSuperAdmin && !edgeEnabled && (
                <div className="edge-status-strip edge-off">
                  现场边缘网关未启用：服务端需配置 <code>EDGE_GATEWAY_TOKEN</code> 环境变量后才接受现场网关主动连接。
                </div>
              )}

              {isSuperAdmin && system?.detection && (
                <div
                  className={`edge-status-strip ${
                    system.detection.active ? '' : 'edge-off'
                  }`}
                >
                  <strong>服务端识别</strong>
                  {!system.detection.enabled && (
                    <span>已通过 SERVER_DETECTION=0 停用</span>
                  )}
                  {system.detection.enabled && !system.detection.ffmpegAvailable && (
                    <span>未找到 FFmpeg，服务端识别不可用</span>
                  )}
                  {system.detection.active && (
                    <>
                      <span>
                        {system.detection.width}×{system.detection.height} @
                        {system.detection.fps}fps · 灵敏度{' '}
                        {system.detection.sensitivity}
                      </span>
                      <span>
                        巡检{' '}
                        {
                          system.detection.cameras.filter((camera) => camera.running)
                            .length
                        }{' '}
                        路 · 已处理 {system.detection.stats.frames} 帧 · 告警{' '}
                        {system.detection.stats.alarms} 条
                      </span>
                    </>
                  )}
                </div>
              )}

              {isSuperAdmin && system?.storage && (
                <div className="edge-status-strip">
                  <strong>存储占用</strong>
                  <span>
                    数据库 {formatBytes(system.storage.dbBytes)} · 抓拍{' '}
                    {system.storage.snapshots.files} 张 /{' '}
                    {formatBytes(system.storage.snapshots.bytes)} · 短视频{' '}
                    {system.storage.recordings.files} 段 /{' '}
                    {formatBytes(system.storage.recordings.bytes)}
                  </span>
                  <span>
                    媒体合计 {formatBytes(system.storage.mediaBytes)} / 上限{' '}
                    {formatBytes(system.storage.mediaMaxBytes)}
                    （超出自动清理最老的已关闭告警媒体）
                  </span>
                </div>
              )}

              {isSuperAdmin && (
                <div className="admin-demo-card">
                  <div className="admin-demo-head">
                    <div>
                      <h4>演示模式</h4>
                      <p>
                        没有真实摄像头时，用 FFmpeg 合成一段会闪烁的火焰直播流，
                        自动注册「演示点位」，几秒内即可在监控大屏看到完整闭环：
                        播放 → 识别 → 告警 → 抓拍/短视频 → 推送 → 统计。
                      </p>
                    </div>
                    <div className="admin-demo-actions">
                      {demoStatus?.running ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={demoBusy}
                          onClick={() => void toggleDemo('stop')}
                        >
                          {demoBusy ? '停止中…' : '停止演示'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={demoBusy || !demoStatus?.ffmpegAvailable}
                          onClick={() => void toggleDemo('start')}
                          title={
                            demoStatus && !demoStatus.ffmpegAvailable
                              ? '服务器未安装 FFmpeg'
                              : ''
                          }
                        >
                          {demoBusy ? '启动中…' : '启动演示'}
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={demoBusy || !demoStatus?.purgeable?.alarms}
                        onClick={() => void purgeDemoData()}
                        title="清除演示产生的告警、抓拍、短视频与推送日志（真实数据不受影响）"
                      >
                        清除演示数据
                        {demoStatus?.purgeable?.alarms
                          ? `（${demoStatus.purgeable.alarms}）`
                          : ''}
                      </button>
                    </div>
                  </div>
                  {demoStatus?.lastError && (
                    <p className="admin-error">{demoStatus.lastError}</p>
                  )}
                  {demoStatus?.running && (
                    <p className="admin-demo-status">
                      正在播放合成火焰流（{demoStatus.width}×{demoStatus.height}@
                      {demoStatus.fps}fps · {demoStatus.segmentSeconds}s 分片）。
                      演示点位代码 <code>{demoStatus.camera?.code ?? 'DEMO-01'}</code>，
                      播放地址 <code>{demoStatus.playlistUrl}</code>。
                    </p>
                  )}
                  {demoStatus && demoStatus.purgeable && demoStatus.purgeable.alarms > 0 && (
                    <p className="admin-demo-status">
                      演示已产生 {demoStatus.purgeable.alarms} 条告警
                      （抓拍 {demoStatus.purgeable.snapshots} 张、短视频{' '}
                      {demoStatus.purgeable.clips} 段）。这些数据会计入趋势看板与每日摘要，
                      可用「清除演示数据」一键清理。
                    </p>
                  )}
                  {demoStatus &&
                    !demoStatus.running &&
                    !demoStatus.ffmpegAvailable && (
                      <p className="admin-demo-status">
                        服务器未检测到 FFmpeg，演示模式不可用。
                      </p>
                    )}
                </div>
              )}

              {showNvrForm && (
                <form className="admin-form admin-nvr-form" onSubmit={submitNvr}>
                  <div className="admin-form-title">
                    <h4>品牌 NVR / 摄像机批量接入</h4>
                    <button
                      type="button"
                      className="admin-form-close"
                      onClick={() => setShowNvrForm(false)}
                    >
                      取消
                    </button>
                  </div>
                  <p className="admin-form-hint admin-nvr-intro">
                    {selectedVendor?.hint ??
                      '服务器需能直接访问设备。选择品牌后按标准 RTSP 规则生成地址，导入后由服务端转 HLS。'}
                  </p>
                  <div className="admin-nvr-grid">
                    <label className="admin-nvr-vendor">
                      <span>设备品牌 / 接入方式</span>
                      <select
                        className="settings-input"
                        value={nvrForm.vendorId}
                        onChange={(event) => changeVendor(event.target.value)}
                      >
                        {vendors.length === 0 && (
                          <option value="hikvision">海康威视 / 海康兼容</option>
                        )}
                        {vendors.map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>
                            {vendor.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{selectedVendor?.singleChannel ? '设备地址' : 'NVR 地址'}</span>
                      <input
                        className="settings-input"
                        value={nvrForm.host}
                        placeholder="192.168.1.64"
                        required
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, host: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>RTSP 端口</span>
                      <input
                        type="number"
                        className="settings-input"
                        value={nvrForm.rtspPort}
                        min={1}
                        max={65535}
                        required
                        onChange={(event) =>
                          setNvrForm((prev) => ({
                            ...prev,
                            rtspPort: Number(event.target.value),
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{selectedVendor?.singleChannel ? '设备用户名' : 'NVR 用户名'}</span>
                      <input
                        className="settings-input"
                        value={nvrForm.username}
                        autoComplete="off"
                        required
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, username: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>{selectedVendor?.singleChannel ? '设备密码' : 'NVR 密码'}</span>
                      <input
                        type="password"
                        className="settings-input"
                        value={nvrForm.password}
                        autoComplete="new-password"
                        required
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, password: event.target.value }))
                        }
                      />
                    </label>
                    {!selectedVendor?.singleChannel && (
                      <>
                        <label>
                          <span>起始通道</span>
                          <input
                            type="number"
                            className="settings-input"
                            value={nvrForm.startChannel}
                            min={1}
                            max={256}
                            required
                            onChange={(event) =>
                              setNvrForm((prev) => ({
                                ...prev,
                                startChannel: Number(event.target.value),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>导入通道数</span>
                          <input
                            type="number"
                            className="settings-input"
                            value={nvrForm.count}
                            min={1}
                            max={64}
                            required
                            onChange={(event) =>
                              setNvrForm((prev) => ({
                                ...prev,
                                count: Number(event.target.value),
                              }))
                            }
                          />
                        </label>
                      </>
                    )}
                    {selectedVendor && selectedVendor.supportsSubstream !== false && (
                      <label>
                        <span>码流</span>
                        <select
                          className="settings-input"
                          value={nvrForm.stream}
                          onChange={(event) =>
                            setNvrForm((prev) => ({
                              ...prev,
                              stream: event.target.value as 'main' | 'sub',
                            }))
                          }
                        >
                          <option value="sub">子码流（推荐）</option>
                          <option value="main">主码流</option>
                        </select>
                      </label>
                    )}
                    {selectedVendor?.custom && (
                      <label className="admin-nvr-template">
                        <span>RTSP 地址模板</span>
                        <input
                          className="settings-input"
                          value={nvrForm.template}
                          placeholder="rtsp://{user}:{password}@{host}:{port}/live/{channel}"
                          required
                          onChange={(event) =>
                            setNvrForm((prev) => ({ ...prev, template: event.target.value }))
                          }
                        />
                      </label>
                    )}
                    <label>
                      <span>所属区域</span>
                      <input
                        className="settings-input"
                        value={nvrForm.zone}
                        placeholder="例如：园区 A 区"
                        required
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, zone: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>点位名前缀</span>
                      <input
                        className="settings-input"
                        value={nvrForm.namePrefix}
                        maxLength={20}
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, namePrefix: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>所属站点</span>
                      <select
                        className="settings-input"
                        value={nvrForm.siteId || defaultSiteId || ''}
                        onChange={(event) =>
                          setNvrForm((prev) => ({ ...prev, siteId: event.target.value }))
                        }
                      >
                        {sites.length === 0 && <option value={defaultSiteId}>默认站点</option>}
                        {sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <p className="admin-form-hint">
                    {selectedVendor?.custom
                      ? '模板占位符：{user}、{password}、{host}、{port}、{channel}、{stream}、{streamNum}。仅适用于支持标准 RTSP 的设备；仅厂商云内出流的型号需走厂商开放平台或现场网关。'
                      : selectedVendor?.singleChannel
                        ? '该品牌按单机位接入，一台设备创建一个点位；多台摄像机请分别填写各自 IP。相同地址会跳过。'
                        : '系统按所选品牌的通道规则批量生成 RTSP 地址，相同地址会自动跳过；子码流可降低多路查看压力。'}
                  </p>
                  <div className="admin-form-actions">
                    <button type="submit" className="btn btn-sm btn-danger" disabled={nvrBusy}>
                      {nvrBusy ? '导入中…' : '批量导入点位'}
                    </button>
                  </div>
                </form>
              )}

              {showOnvifForm && (
                <div className="admin-form admin-onvif-form">
                  <div className="admin-form-title">
                    <h4>ONVIF 自动发现</h4>
                    <button
                      type="button"
                      className="admin-form-close"
                      onClick={() => setShowOnvifForm(false)}
                    >
                      取消
                    </button>
                  </div>
                  <p className="admin-form-hint admin-nvr-intro">
                    可直接点击「扫描全网段」自动发现设备 IP，或手工填写（多个用逗号分隔）及 ONVIF
                    端口与凭据。服务端将通过 SOAP/WS-Security 探测取流地址，免手工填写 RTSP。
                  </p>
                  <form onSubmit={runOnvifDiscover}>
                    <div className="admin-nvr-grid">
                      <label className="admin-nvr-vendor">
                        <span>设备地址（IP 或主机，逗号分隔）</span>
                        <input
                          className="settings-input"
                          value={onvifForm.hosts}
                          placeholder="192.168.1.64, 192.168.1.65"
                          required
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, hosts: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        <span>ONVIF 端口</span>
                        <input
                          type="number"
                          className="settings-input"
                          value={onvifForm.port}
                          min={1}
                          max={65535}
                          required
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, port: Number(event.target.value) }))
                          }
                        />
                      </label>
                      <label>
                        <span>用户名</span>
                        <input
                          className="settings-input"
                          value={onvifForm.username}
                          autoComplete="off"
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, username: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        <span>密码</span>
                        <input
                          type="password"
                          className="settings-input"
                          value={onvifForm.password}
                          autoComplete="new-password"
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, password: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        <span>所属区域</span>
                        <input
                          className="settings-input"
                          value={onvifForm.zone}
                          placeholder="例如：园区 A 区"
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, zone: event.target.value }))
                          }
                        />
                      </label>
                      <label>
                        <span>所属站点</span>
                        <select
                          className="settings-input"
                          value={onvifForm.siteId || defaultSiteId || ''}
                          onChange={(event) =>
                            setOnvifForm((prev) => ({ ...prev, siteId: event.target.value }))
                          }
                        >
                          {sites.length === 0 && <option value={defaultSiteId}>默认站点</option>}
                          {sites.map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="admin-form-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={onvifScanBusy || onvifBusy}
                        onClick={() => void runOnvifScan()}
                      >
                        {onvifScanBusy ? '扫描中…' : '扫描全网段'}
                      </button>
                      <button type="submit" className="btn btn-sm btn-danger" disabled={onvifBusy}>
                        {onvifBusy ? '探测中…' : '开始发现'}
                      </button>
                    </div>
                  </form>

                  {onvifScanDevices.length > 0 && (
                    <p className="admin-form-hint">
                      已扫描到 {onvifScanDevices.length} 台设备：
                      {onvifScanDevices
                        .slice(0, 4)
                        .map(
                          (device) =>
                            `${device.host}${device.name ? `（${device.name}）` : ''}`,
                        )
                        .join('、')}
                      {onvifScanDevices.length > 4
                        ? ` 等 ${onvifScanDevices.length} 台`
                        : ''}
                      。请核对端口与凭据后点击「开始发现」。
                    </p>
                  )}

                  {onvifResults.length > 0 && (
                    <div className="onvif-results">
                      {onvifResults.map((entry) => (
                        <div
                          key={`${entry.target.host}:${entry.target.port}`}
                          className={`onvif-device ${entry.ok ? 'is-ok' : 'is-error'}`}
                        >
                          <div className="onvif-device-head">
                            <strong>{entry.target.host}:{entry.target.port}</strong>
                            <span>
                              {entry.ok && entry.device
                                ? `${entry.device.manufacturer || '未知厂商'} ${
                                    entry.device.model || ''
                                  }`.trim()
                                : entry.error ?? '探测失败'}
                            </span>
                          </div>
                          {entry.ok && entry.device && (
                            <div className="onvif-profiles">
                              {entry.device.profiles.length === 0 && (
                                <span className="onvif-profile-empty">无可用通道</span>
                              )}
                              {entry.device.profiles.map((profile) => {
                                const key = `${entry.device!.host}:${profile.token}`;
                                return (
                                  <label
                                    key={key}
                                    className={`onvif-profile ${
                                      profile.rtspUri ? '' : 'is-disabled'
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={onvifSelected.includes(key)}
                                      disabled={!profile.rtspUri}
                                      onChange={() => toggleOnvifProfile(key)}
                                    />
                                    <span>
                                      {profile.name || profile.token}
                                      {profile.rtspUri ? (
                                        <code className="onvif-uri">{profile.rtspUri}</code>
                                      ) : (
                                        <span className="onvif-no-uri">（无 RTSP 流）</span>
                                      )}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                      <div className="admin-form-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={onvifImporting || onvifSelected.length === 0}
                          onClick={() => void importOnvifSelected()}
                        >
                          {onvifImporting
                            ? '导入中…'
                            : `导入选中通道（${onvifSelected.length}）`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {cameras.length === 0 ? (
                <p className="admin-empty">还没有点位，请先新增一个网络监控点位。</p>
              ) : (
                <>
                  {sites.length > 0 && (
                    <div className="admin-filter-row">
                      <label className="admin-filter">
                        <span>按站点筛选</span>
                        <select
                          className="settings-input"
                          value={siteFilter}
                          onChange={(event) => setSiteFilter(event.target.value)}
                        >
                          <option value="">全部站点</option>
                          {sites.map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span className="admin-filter-count">
                        共 {siteFilter ? cameras.filter((camera) => siteKey(camera.siteId) === siteFilter).length : cameras.length} 个点位
                      </span>
                    </div>
                  )}
                  <div className="point-list">
                    {cameras
                      .filter((camera) =>
                        siteFilter ? siteKey(camera.siteId) === siteFilter : true,
                      )
                      .map((camera) => {
                    const item = health[camera.id];
                    const probe = probeResults[camera.id];
                    return (
                      <Fragment key={camera.id}>
                        <div className="point-row">
                          <span className="point-code">{camera.code}</span>
                          <div className="point-main">
                            <strong>{camera.name}</strong>
                            <span>
                              {camera.zone} · {PROTOCOL_LABELS[camera.protocol]}
                              {!camera.hasSource && ' · 待配置视频流'}
                            </span>
                          </div>
                          <span className="point-site" title="所属站点">
                            {siteName(camera.siteId)}
                          </span>
                          <span
                            className={`point-state ${
                              item?.status === 'running' ||
                              item?.status === 'gateway' ||
                              item?.status === 'external'
                                ? 'is-on'
                                : item?.status === 'error'
                                  ? 'is-error'
                                  : ''
                            }`}
                            title={item?.lastError ?? undefined}
                          >
                            {healthText(item)}
                          </span>
                          <div className="point-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              disabled={!probeAvailable || !camera.hasSource || testingId === camera.id}
                              title={
                                probeAvailable
                                  ? '让服务器实际拉流并读取编码、分辨率和首帧耗时'
                                  : '服务器未安装 FFprobe'
                              }
                              onClick={() => void runProbe(camera)}
                            >
                              {testingId === camera.id ? '测流中…' : '测试'}
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEditCamera(camera)}>
                              编辑
                            </button>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void deleteCamera(camera)}>
                              删除
                            </button>
                          </div>
                        </div>
                        {probe && (
                          <div className={`stream-test-result ${probe.ok ? 'is-ok' : 'is-error'}`}>
                            {probe.ok
                              ? `${probe.codec ?? '视频'} ${
                                  probe.width && probe.height
                                    ? `${probe.width}×${probe.height}`
                                    : ''
                                } · ${probe.fps ?? ''} · ${probe.latencyMs}ms`
                              : probe.error}
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                  </div>
                </>
              )}

              {showCameraForm && (
                <form className="admin-form" onSubmit={submitCamera}>
                  <div className="admin-form-title">
                    <h4>{editingId ? '编辑点位' : '新增点位'}</h4>
                    <button type="button" className="admin-form-close" onClick={() => setShowCameraForm(false)}>
                      取消
                    </button>
                  </div>
                  <div className="admin-form-grid">
                    <label>
                      <span>点位名称</span>
                      <input
                        className="settings-input"
                        value={cameraForm.name}
                        maxLength={24}
                        required
                        onChange={(event) =>
                          setCameraForm((prev) => ({ ...prev, name: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>所属区域</span>
                      <input
                        className="settings-input"
                        value={cameraForm.zone}
                        maxLength={32}
                        required
                        onChange={(event) =>
                          setCameraForm((prev) => ({ ...prev, zone: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>视频流类型</span>
                      <select
                        className="settings-input"
                        value={cameraForm.protocol}
                        onChange={(event) =>
                          setCameraForm((prev) => ({
                            ...prev,
                            protocol: event.target.value as CameraInput['protocol'],
                          }))
                        }
                      >
                        <option value="none">暂不配置</option>
                        <option value="hls">HLS（.m3u8）</option>
                        <option value="http">HTTP 视频</option>
                        <option value="rtsp">RTSP / NVR</option>
                        <option value="edge">现场边缘网关</option>
                      </select>
                    </label>
                    <label>
                      <span>所属站点</span>
                      <select
                        className="settings-input"
                        value={cameraForm.siteId || defaultSiteId || ''}
                        onChange={(event) =>
                          setCameraForm((prev) => ({ ...prev, siteId: event.target.value }))
                        }
                      >
                        {sites.length === 0 && <option value={defaultSiteId}>默认站点</option>}
                        {sites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="admin-form-url">
                      <span>视频流地址</span>
                      <input
                        className="settings-input"
                        value={cameraForm.sourceUrl}
                        disabled={cameraForm.protocol === 'none'}
                        placeholder={
                          cameraForm.protocol === 'rtsp'
                            ? 'rtsp://用户名:密码@192.168.1.10:554/Streaming/Channels/101'
                            : cameraForm.protocol === 'edge'
                              ? 'edge://site-a/ch01'
                              : 'https://example.com/live/stream.m3u8'
                        }
                        required={cameraForm.protocol !== 'none'}
                        onChange={(event) =>
                          setCameraForm((prev) => ({ ...prev, sourceUrl: event.target.value }))
                        }
                      />
                    </label>
                    <div className="admin-form-detect-group">
                      <label>
                        <span>服务端检测</span>
                        <select
                          className="settings-input"
                          value={cameraForm.detectEnabled === false ? 'off' : 'on'}
                          onChange={(event) =>
                            setCameraForm((prev) => ({
                              ...prev,
                              detectEnabled: event.target.value === 'on',
                            }))
                          }
                        >
                          <option value="on">启用</option>
                          <option value="off">停用</option>
                        </select>
                      </label>
                      <label>
                        <span>识别灵敏度</span>
                        <select
                          className="settings-input"
                          value={cameraForm.detectSensitivity ?? ''}
                          onChange={(event) =>
                            setCameraForm((prev) => ({
                              ...prev,
                              detectSensitivity:
                                (event.target.value as CameraSensitivity) || null,
                            }))
                          }
                        >
                          <option value="">跟随全局（标准）</option>
                          <option value="low">稳健</option>
                          <option value="standard">标准</option>
                          <option value="high">灵敏</option>
                        </select>
                      </label>
                    </div>
                    {(cameraForm.protocol === 'rtsp' ||
                      cameraForm.protocol === 'hls' ||
                      cameraForm.protocol === 'http') && (
                      <label className="admin-form-roi">
                        <span>
                          屏蔽区（拖拽框选不需要检测的区域，如天空、路灯、屏幕）
                        </span>
                        <RoiEditor
                          value={cameraForm.detectRoi ?? []}
                          onChange={(next) =>
                            setCameraForm((prev) => ({ ...prev, detectRoi: next }))
                          }
                          previewUrl={
                            editingId
                              ? `/api/cameras/${editingId}/preview?refresh=1`
                              : null
                          }
                        />
                      </label>
                    )}
                  </div>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={cameraForm.enabled}
                      onChange={(event) =>
                        setCameraForm((prev) => ({ ...prev, enabled: event.target.checked }))
                      }
                    />
                    启用该点位
                  </label>
                  <p className="admin-form-hint">
                    RTSP 地址保存在服务器，由服务端 FFmpeg 转为浏览器可播放的 HLS；HLS/HTTP
                    地址直接由浏览器播放，跨域视频源需允许 CORS，浏览器才能播放并做帧识别。
                    现场边缘网关使用 edge://网关ID/摄像头标识，由现场设备主动连中心，不需要公网 IP。
                  </p>
                  <div className="admin-form-actions">
                    <button type="submit" className="btn btn-sm btn-danger" disabled={cameraBusy}>
                      {cameraBusy ? '保存中…' : '保存点位'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : tab === 'sites' ? (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>站点与分组</h3>
                  <p>将摄像头按园区、楼宇或客户分组，并为值班员 / 只读账号分配可见站点。</p>
                </div>
              </div>

              {isSuperAdmin && (
                <form className="admin-site-form" onSubmit={submitSite}>
                  <input
                    className="settings-input"
                    value={siteForm.name}
                    placeholder="新站点名称（如：园区 A 区）"
                    maxLength={48}
                    required
                    aria-label="新站点名称"
                    onChange={(event) =>
                      setSiteForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                  />
                  <input
                    className="settings-input"
                    value={siteForm.code}
                    placeholder="编码（可选，如 A1）"
                    maxLength={24}
                    aria-label="新站点编码"
                    onChange={(event) =>
                      setSiteForm((prev) => ({ ...prev, code: event.target.value }))
                    }
                  />
                  <button type="submit" className="btn btn-sm btn-danger" disabled={siteBusy}>
                    {siteBusy ? '创建中…' : '新增站点'}
                  </button>
                </form>
              )}

              {sites.length === 0 ? (
                <p className="admin-empty">
                  还没有自定义站点，系统已有一个默认站点用于归类未分配的点位。
                </p>
              ) : (
                <div className="site-list">
                  {sites.map((site) => {
                    const count = cameras.filter(
                      (camera) => siteKey(camera.siteId) === site.id,
                    ).length;
                    const isDefault = site.id === defaultSiteId;
                    return (
                      <div className="site-row" key={site.id}>
                        <div className="site-main">
                          {editingSiteId === site.id ? (
                            <input
                              className="settings-input"
                              value={editingSiteName}
                              maxLength={48}
                              aria-label="编辑站点名称"
                              onChange={(event) => setEditingSiteName(event.target.value)}
                            />
                          ) : (
                            <strong>{site.name}</strong>
                          )}
                          <span>
                            {site.code}
                            {isDefault && ' · 默认站点'}
                            {` · ${count} 个点位`}
                          </span>
                        </div>
                        <div className="point-actions">
                          {editingSiteId === site.id ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={siteBusy}
                                onClick={() => void saveEditSite(site)}
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={cancelEditSite}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => startEditSite(site)}
                              >
                                改名
                              </button>
                              {isSuperAdmin && !isDefault && (
                                <button
                                  type="button"
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => void removeSite(site)}
                                >
                                  删除
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {assigningUser && (
                <div className="user-site-assign">
                  <div className="admin-form-title">
                    <h4>{`为「${assigningUser.displayName}」分配可见站点`}</h4>
                    <button
                      type="button"
                      className="admin-form-close"
                      onClick={() => setAssigningUser(null)}
                    >
                      关闭
                    </button>
                  </div>
                  <p className="admin-form-hint">
                    未勾选任何站点时，该账号将看不到任何点位；管理员默认可见全部站点。
                  </p>
                  {assignBusy ? (
                    <p className="admin-empty">正在加载授权…</p>
                  ) : (
                    <div className="assign-sites">
                      {sites.map((site) => (
                        <label key={site.id} className="assign-site">
                          <input
                            type="checkbox"
                            checked={assignSiteIds.includes(site.id)}
                            onChange={() => toggleAssignSite(site.id)}
                          />
                          <span>{site.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="admin-form-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={assignBusy}
                      onClick={() => void saveAssignUser()}
                    >
                      保存授权
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'stats' ? (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>告警趋势</h3>
                  <p>
                    近 {statsDays} 天 · 误报率 = 判定误报 ÷（火焰 + 烟雾告警数），设备离线不计入分母。
                  </p>
                </div>
                <div className="filter-row" role="group" aria-label="统计周期">
                  {[7, 30, 90].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip ${statsDays === value ? 'is-active' : ''}`}
                      onClick={() => {
                        setStatsDays(value);
                        void loadAlarmStats(value);
                      }}
                    >
                      {value} 天
                    </button>
                  ))}
                </div>
              </div>
              {alarmStats ? (
                <>
                  <div className="stats-kpis">
                    <div className="stats-kpi">
                      <span>告警总数</span>
                      <strong>{alarmStats.totals.total}</strong>
                    </div>
                    <div className="stats-kpi">
                      <span>火焰 / 烟雾</span>
                      <strong>
                        {alarmStats.totals.fire} / {alarmStats.totals.smoke}
                      </strong>
                    </div>
                    <div className="stats-kpi">
                      <span>误报率</span>
                      <strong>{alarmStats.falseRate}%</strong>
                    </div>
                    <div className="stats-kpi">
                      <span>仍待处置</span>
                      <strong>{alarmStats.totals.pending}</strong>
                    </div>
                  </div>
                  <StatsChart days={alarmStats.days} />
                  <div className="stats-legend">
                    <span>
                      <i className="legend-dot legend-fire" /> 火焰
                    </span>
                    <span>
                      <i className="legend-dot legend-smoke" /> 烟雾
                    </span>
                    <span>
                      <i className="legend-dot legend-offline" /> 设备离线
                    </span>
                    <span className="stats-legend-hint">悬停柱体查看当日明细</span>
                  </div>
                  {alarmStats.bySite.length > 0 && (
                    <div className="stats-site-table">
                      <table>
                        <thead>
                          <tr>
                            <th>站点</th>
                            <th>总数</th>
                            <th>火焰</th>
                            <th>烟雾</th>
                            <th>离线</th>
                            <th>误报</th>
                          </tr>
                        </thead>
                        <tbody>
                          {alarmStats.bySite.map((site) => (
                            <tr key={site.siteId}>
                              <td>{site.name}</td>
                              <td>{site.total}</td>
                              <td>{site.fire}</td>
                              <td>{site.smoke}</td>
                              <td>{site.offline}</td>
                              <td>{site.false}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              ) : (
                <p className="admin-empty">正在加载统计数据…</p>
              )}
            </div>
          ) : tab === 'notify' ? (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>告警通知</h3>
                  <p>
                    告警产生、确认、判定误报或设备离线时，按站点推送到企业微信、钉钉或自建
                    Webhook。
                  </p>
                </div>
                <div className="admin-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void loadNotifyLogs()}
                  >
                    刷新推送记录
                  </button>
                </div>
              </div>

              <form className="admin-form admin-notify-form" onSubmit={submitNotify}>
                <div className="admin-form-title">
                  <h4>新增通知渠道</h4>
                </div>
                <div className="admin-nvr-grid">
                  <label>
                    <span>渠道名称</span>
                    <input
                      className="settings-input"
                      value={notifyForm.name}
                      placeholder="例如：消防值班群"
                      maxLength={32}
                      required
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>类型</span>
                    <select
                      className="settings-input"
                      value={notifyForm.kind}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({
                          ...prev,
                          kind: event.target.value as NotifyKind,
                        }))
                      }
                    >
                      <option value="wecom">企业微信机器人</option>
                      <option value="dingtalk">钉钉机器人</option>
                      <option value="webhook">通用 Webhook</option>
                    </select>
                  </label>
                  <label>
                    <span>生效站点</span>
                    <select
                      className="settings-input"
                      value={notifyForm.siteId}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, siteId: event.target.value }))
                      }
                    >
                      {isSuperAdmin && <option value="">全部站点（全局）</option>}
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="admin-nvr-template">
                    <span>推送地址</span>
                    <input
                      className="settings-input"
                      value={notifyForm.url}
                      placeholder="企业微信/钉钉机器人 Webhook 地址，或自建接收地址"
                      maxLength={2048}
                      required
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, url: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>签名密钥（Webhook 可选）</span>
                    <input
                      type="password"
                      className="settings-input"
                      value={notifyForm.secret}
                      autoComplete="new-password"
                      placeholder="配置后请求头带 X-Fire-Signature"
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, secret: event.target.value }))
                      }
                    />
                  </label>
                  <label className="admin-notify-enable">
                    <span>启用</span>
                    <input
                      type="checkbox"
                      checked={notifyForm.enabled}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({
                          ...prev,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="admin-form-actions">
                  <button type="submit" className="btn btn-sm btn-danger" disabled={notifyBusy}>
                    {notifyBusy ? '保存中…' : '新增渠道'}
                  </button>
                </div>
              </form>

              {notifyChannels.length === 0 ? (
                <p className="admin-empty">
                  还没有通知渠道。创建后，告警会按站点自动推送，不再依赖有人盯屏。
                </p>
              ) : (
                <div className="site-list">
                  {notifyChannels.map((channel) => (
                    <div className="site-row" key={channel.id}>
                      <div className="site-main">
                        <strong>{channel.name}</strong>
                        <span>
                          {NOTIFY_KIND_LABELS[channel.kind]} ·{' '}
                          {channel.siteName ?? '全部站点'} · {channel.urlHint}
                          {channel.hasSecret ? ' · 已配置签名' : ''}
                        </span>
                      </div>
                      <div className="point-actions">
                        <span className={`point-state ${channel.enabled ? 'is-on' : ''}`}>
                          {channel.enabled ? '启用' : '停用'}
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={testingChannel === channel.id}
                          onClick={() => void testNotifyChannel(channel)}
                        >
                          {testingChannel === channel.id ? '发送中…' : '测试'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void toggleNotifyChannel(channel)}
                        >
                          {channel.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void removeNotifyChannel(channel)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="admin-subhead">
                <h4>最近推送</h4>
                <span>最多 30 条</span>
              </div>
              {notifyLogs.length === 0 ? (
                <p className="admin-empty">暂无推送记录。</p>
              ) : (
                <div className="notify-log-list">
                  {notifyLogs.map((log) => (
                    <div className="notify-log" key={log.id}>
                      <span className={`notify-log-status is-${log.status}`}>
                        {log.status === 'sent'
                          ? '成功'
                          : log.status === 'failed'
                            ? '失败'
                            : '待发送'}
                      </span>
                      <span className="notify-log-event">
                        {NOTIFY_EVENT_LABELS[log.event] ?? log.event}
                      </span>
                      <span className="notify-log-channel">
                        {log.channelName ?? '已删除渠道'}
                      </span>
                      <span className="notify-log-time">
                        {formatDateTime(log.createdAt)}
                      </span>
                      {log.error && <span className="notify-log-error">{log.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>访问账号</h3>
                  <p>管理员可配置点位；值班员可处置告警；只读账号仅查看。</p>
                </div>
              </div>

              <form className="admin-user-form" onSubmit={submitUser}>
                <input
                  className="settings-input"
                  value={userForm.username}
                  placeholder="用户名"
                  required
                  aria-label="新账号用户名"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                />
                <input
                  className="settings-input"
                  value={userForm.displayName}
                  placeholder="显示名称"
                  aria-label="新账号显示名称"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, displayName: event.target.value }))
                  }
                />
                <select
                  className="settings-input"
                  value={userForm.role}
                  aria-label="新账号角色"
                  onChange={(event) =>
                    setUserForm((prev) => ({
                      ...prev,
                      role: event.target.value as UserRole,
                      siteAdmin:
                        event.target.value === 'admin' ? false : prev.siteAdmin,
                    }))
                  }
                >
                  <option value="operator">值班员</option>
                  <option value="viewer">只读</option>
                  <option value="admin">管理员</option>
                </select>
                <input
                  type="password"
                  className="settings-input"
                  value={userForm.password}
                  placeholder="初始密码（至少 8 位）"
                  minLength={8}
                  required
                  aria-label="新账号初始密码"
                  onChange={(event) =>
                    setUserForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                />
                <label className="admin-check admin-user-siteadmin">
                  <input
                    type="checkbox"
                    checked={userForm.siteAdmin}
                    disabled={userForm.role === 'admin'}
                    onChange={(event) =>
                      setUserForm((prev) => ({
                        ...prev,
                        siteAdmin: event.target.checked,
                      }))
                    }
                  />
                  站点管理员（仅管理被授权站点）
                </label>
                <button type="submit" className="btn btn-sm btn-danger" disabled={userBusy}>
                  {userBusy ? '创建中…' : '新增账号'}
                </button>
              </form>

              <div className="user-list">
                {usersLoading && users.length === 0 ? (
                  <p className="admin-empty">正在加载账号…</p>
                ) : (
                  users.map((user) => (
                    <div className="user-row" key={user.id}>
                      <div className="user-main">
                        <strong>{user.displayName}</strong>
                        <span>
                          @{user.username}
                          {user.siteAdmin ? ' · 站点管理员' : ''}
                          {user.id === currentUser.id ? ' · 当前账号' : ''}
                        </span>
                      </div>
                      <select
                        className="settings-input user-role-select"
                        value={user.role}
                        disabled={user.id === currentUser.id}
                        aria-label={`${user.displayName} 角色`}
                        onChange={(event) =>
                          void updateUser(user, { role: event.target.value as UserRole })
                        }
                      >
                        <option value="admin">管理员</option>
                        <option value="operator">值班员</option>
                        <option value="viewer">只读</option>
                      </select>
                      <span className={`point-state ${user.disabled ? '' : 'is-on'}`}>
                        {user.disabled ? '已停用' : '正常'}
                      </span>
                      <div className="point-actions">
                        {user.role !== 'admin' && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() =>
                              void updateUser(user, { siteAdmin: !user.siteAdmin })
                            }
                          >
                            {user.siteAdmin ? '取消站点管理员' : '设为站点管理员'}
                          </button>
                        )}
                        {user.role !== 'admin' && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => void openAssignUser(user)}
                          >
                            管理可见站点
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void resetPassword(user)}>
                          重置密码
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={user.id === currentUser.id}
                          onClick={() => void updateUser(user, { disabled: !user.disabled })}
                        >
                          {user.disabled ? '启用' : '停用'}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={user.id === currentUser.id}
                          onClick={() => void deleteUser(user)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
