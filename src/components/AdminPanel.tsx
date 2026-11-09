import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type {
  AuditLog,
  AuditLogPage,
  CameraInput,
  CameraSchedule,
  CameraSensitivity,
  DemoStatus,
  EdgeGatewayStatus,
  ManagedCamera,
  NotificationLog,
  NotifyChannel,
  NotifyKind,
  NotifyTemplate,
  AlarmStats,
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
import { downloadAuditCsv } from '../lib/export';
import RoiEditor from './RoiEditor';
import StatsOverview from './StatsOverview';
import AuditLogTable from './AuditLogTable';
import UserList from './admin/UserList';
import NotifyTemplateList from './admin/NotifyTemplateList';
import NotifyChannelList from './admin/NotifyChannelList';
import NotifyLogList from './admin/NotifyLogList';
import AuditPager from './admin/AuditPager';

interface Props {
  cameras: ManagedCamera[];
  currentUser: SessionUser;
  initialTab?: TabKey;
  onClose: () => void;
  onCamerasChanged: () => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
}

type TabKey = 'cameras' | 'users' | 'sites' | 'stats' | 'notify' | 'audit';

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

/** 审计动作中文标签：后端 action 为「对象.动作」的点分格式。 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login': '账号登录',
  'system.setup': '系统初始化',
  'system.backup': '数据库备份',
  'camera.create': '新增点位',
  'camera.update': '修改点位',
  'camera.delete': '删除点位',
  'camera.test': '测流',
  'camera.import': '批量导入点位',
  'alarm.create': '告警产生',
  'alarm.update': '告警处置',
  'alarm.clip': '告警短视频',
  'notify.create': '新增通知渠道',
  'notify.update': '修改通知渠道',
  'notify.delete': '删除通知渠道',
  'notify.template.create': '新增通知模板',
  'notify.template.update': '修改通知模板',
  'notify.template.delete': '删除通知模板',
  'camera.batch_update': '批量更新点位',
  'camera.batch_delete': '批量删除点位',
  'site.create': '新增站点',
  'site.update': '修改站点',
  'site.delete': '删除站点',
  'user.create': '新增账号',
  'user.update': '修改账号',
  'user.delete': '删除账号',
  'user.sites': '账号站点授权',
  'demo.start': '启动演示',
  'demo.stop': '停止演示',
  'demo.purge': '清除演示数据',
};

const AUDIT_ACTION_GROUPS: { value: string; label: string }[] = [
  { value: '', label: '全部动作' },
  { value: 'auth', label: '登录认证' },
  { value: 'camera', label: '点位变更' },
  { value: 'alarm', label: '告警相关' },
  { value: 'notify', label: '通知配置' },
  { value: 'site', label: '站点管理' },
  { value: 'user', label: '账号管理' },
  { value: 'demo', label: '演示模式' },
  { value: 'system', label: '系统操作' },
];

const AUDIT_RANGE_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: 'all', label: '全部时间', ms: 0 },
  { value: '1h', label: '近 1 小时', ms: 60 * 60 * 1000 },
  { value: 'today', label: '今天', ms: -1 },
  { value: '7d', label: '近 7 天', ms: 7 * 24 * 60 * 60 * 1000 },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
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
  schedule: null,
};

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const FALSE_ALARM_HOTSPOT_THRESHOLD = 5;

export default function AdminPanel({
  cameras,
  currentUser,
  initialTab,
  onClose,
  onCamerasChanged,
  onNotify,
}: Props) {
  const isSuperAdmin = currentUser.role === 'admin';
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'cameras');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [cameraForm, setCameraForm] = useState<CameraInput>(EMPTY_CAMERA);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCameraForm, setShowCameraForm] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [falseHotspots, setFalseHotspots] = useState<Record<string, number>>({});
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
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditFilter, setAuditFilter] = useState({ action: '', q: '', range: 'all' });
  const [auditBusy, setAuditBusy] = useState(false);
  const AUDIT_PAGE_SIZE = 50;
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [notifyForm, setNotifyForm] = useState<{
    name: string;
    kind: NotifyKind;
    url: string;
    secret: string;
    siteId: string;
    enabled: boolean;
    templateId: string;
  }>({
    name: '',
    kind: 'wecom',
    url: '',
    secret: '',
    siteId: '',
    enabled: true,
    templateId: '',
  });
  const [notifyTemplates, setNotifyTemplates] = useState<NotifyTemplate[]>([]);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState({ name: '', body: '' });
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchSensitivity, setBatchSensitivity] = useState<'' | CameraSensitivity>('');
  const [batchSiteId, setBatchSiteId] = useState('');
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
      const [channelsResult, templatesResult] = await Promise.all([
        api.notifyChannels(),
        api.notifyTemplates(),
      ]);
      setNotifyChannels(channelsResult.channels);
      setNotifyTemplates(templatesResult.templates);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道加载失败',
      );
    }
  };

  const loadNotifyTemplates = async () => {
    try {
      const result = await api.notifyTemplates();
      setNotifyTemplates(result.templates);
    } catch {
      // 模板加载失败不阻塞通知页。
    }
  };

  const openTemplateEditor = (tpl?: NotifyTemplate) => {
    setEditingTemplateId(tpl?.id ?? null);
    setTemplateDraft({ name: tpl?.name ?? '', body: tpl?.body ?? '' });
    setShowTemplateEditor(true);
  };

  const closeTemplateEditor = () => {
    setShowTemplateEditor(false);
    setEditingTemplateId(null);
    setTemplateDraft({ name: '', body: '' });
  };

  const insertTemplateVar = (v: string) => {
    setTemplateDraft((prev) => ({ ...prev, body: `${prev.body}{${v}}` }));
  };

  const saveTemplate = async () => {
    if (!templateDraft.name.trim() || !templateDraft.body.trim()) {
      setError('请填写模板名称与内容');
      return;
    }
    setTemplateBusy(true);
    try {
      if (editingTemplateId) {
        await api.updateNotifyTemplate(editingTemplateId, {
          name: templateDraft.name.trim(),
          body: templateDraft.body,
        });
      } else {
        await api.createNotifyTemplate({
          name: templateDraft.name.trim(),
          body: templateDraft.body,
        });
      }
      await loadNotifyTemplates();
      closeTemplateEditor();
      onNotify('通知模板已保存', 'ok');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '保存模板失败');
    } finally {
      setTemplateBusy(false);
    }
  };

  const removeTemplate = async (tpl: NotifyTemplate) => {
    if (!window.confirm(`删除模板「${tpl.name}」？引用它的渠道将回退为默认文案。`)) return;
    try {
      await api.deleteNotifyTemplate(tpl.id);
      await loadNotifyTemplates();
      onNotify('通知模板已删除', 'info');
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '删除模板失败');
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

  // 慢的旧响应不得覆盖新请求结果（快速切天数/翻页/切 Tab 时会出现数据与筛选错位）。
  const statsRequestRef = useRef(0);
  const auditRequestRef = useRef(0);

  const loadAlarmStats = async (days = 30) => {
    const seq = ++statsRequestRef.current;
    try {
      const result = await api.alarmStats(days);
      if (seq !== statsRequestRef.current) return;
      setAlarmStats(result);
    } catch (requestError) {
      if (seq !== statsRequestRef.current) return;
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

  const loadAuditLogs = async (
    overrides: Partial<{ action: string; q: string; range: string; offset: number }> = {},
  ) => {
    const filter = { ...auditFilter, offset: auditOffset, ...overrides };
    const rangeOption =
      AUDIT_RANGE_OPTIONS.find((option) => option.value === filter.range) ??
      AUDIT_RANGE_OPTIONS[0];
    const from =
      rangeOption.ms === 0
        ? null
        : rangeOption.ms === -1
          ? new Date(new Date().toDateString()).getTime()
          : Date.now() - rangeOption.ms;
    setAuditBusy(true);
    const seq = ++auditRequestRef.current;
    try {
      const result: AuditLogPage = await api.auditLogs({
        limit: AUDIT_PAGE_SIZE,
        offset: filter.offset,
        action: filter.action,
        q: filter.q,
        from,
      });
      if (seq !== auditRequestRef.current) return;
      setAuditLogs(result.logs);
      setAuditTotal(result.total);
      setAuditFilter({
        action: filter.action,
        q: filter.q,
        range: filter.range,
      });
      setAuditOffset(filter.offset);
    } catch (requestError) {
      if (seq !== auditRequestRef.current) return;
      onNotify(
        requestError instanceof ApiError ? requestError.message : '审计日志加载失败',
        'danger',
      );
    } finally {
      if (seq === auditRequestRef.current) setAuditBusy(false);
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
    // 误报热点：面板打开时取一次近 7 天聚合，用于点位列表的调优提示徽标。
    void api
      .falseHotspots(7)
      .then((result) =>
        setFalseHotspots(
          Object.fromEntries(result.hotspots.map((row) => [row.cameraId, row.count])),
        ),
      )
      .catch(() => undefined);
  }, []);

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
      schedule: camera.schedule ?? null,
    });
    setShowCameraForm(true);
    setError('');
  };

  const updateScheduleWindow = (
    index: number,
    patch: Partial<CameraSchedule['windows'][number]>,
  ) => {
    setCameraForm((prev) => {
      if (!prev.schedule) return prev;
      const windows = prev.schedule.windows.map((win, i) =>
        i === index ? { ...win, ...patch } : win,
      );
      return { ...prev, schedule: { windows } };
    });
  };

  const toggleScheduleDay = (index: number, day: number) => {
    setCameraForm((prev) => {
      if (!prev.schedule) return prev;
      const windows = prev.schedule.windows.map((win, i) => {
        if (i !== index) return win;
        const days = win.days.includes(day)
          ? win.days.filter((d) => d !== day)
          : [...win.days, day].sort();
        return { ...win, days };
      });
      return { ...prev, schedule: { windows } };
    });
  };

  const addScheduleWindow = () => {
    setCameraForm((prev) => {
      if (!prev.schedule) return prev;
      return {
        ...prev,
        schedule: {
          windows: [
            ...prev.schedule.windows,
            { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' },
          ],
        },
      };
    });
  };

  const removeScheduleWindow = (index: number) => {
    setCameraForm((prev) => {
      if (!prev.schedule) return prev;
      const windows = prev.schedule.windows.filter((_, i) => i !== index);
      return { ...prev, schedule: windows.length ? { windows } : null };
    });
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

  const visibleCameraIds = cameras
    .filter((camera) => (siteFilter ? siteKey(camera.siteId) === siteFilter : true))
    .map((camera) => camera.id);

  const toggleSelectAll = () => {
    setSelectedIds((prev) =>
      prev.length === visibleCameraIds.length && visibleCameraIds.length > 0
        ? []
        : [...visibleCameraIds],
    );
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds([]);
  };

  const runBatchUpdate = async (
    patch: {
      detectEnabled?: boolean;
      detectSensitivity?: CameraSensitivity | null;
      siteId?: string | null;
    },
    label: string,
  ) => {
    if (selectedIds.length === 0) return;
    setCameraBusy(true);
    try {
      const result = await api.batchUpdateCameras({ ids: selectedIds, ...patch });
      await onCamerasChanged();
      setSelectedIds([]);
      onNotify(`已${label} ${result.updated ?? 0} 个点位`, 'ok');
      if (result.errors.length) {
        onNotify(`${result.errors.length} 个点位操作失败`, 'danger');
      }
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '批量操作失败');
    } finally {
      setCameraBusy(false);
    }
  };

  const runBatchDelete = async () => {
    if (selectedIds.length === 0) return;
    if (
      !window.confirm(`确定批量删除选中的 ${selectedIds.length} 个点位？此操作不可撤销。`)
    ) {
      return;
    }
    setCameraBusy(true);
    try {
      const result = await api.batchDeleteCameras(selectedIds);
      await onCamerasChanged();
      setSelectedIds([]);
      onNotify(`已删除 ${result.deleted ?? 0} 个点位`, 'info');
      if (result.errors.length) {
        onNotify(`${result.errors.length} 个点位删除失败`, 'danger');
      }
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : '批量删除失败');
    } finally {
      setCameraBusy(false);
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
        templateId: notifyForm.templateId || null,
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
          {isSuperAdmin && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'audit'}
              className={`admin-tab ${tab === 'audit' ? 'is-active' : ''}`}
              onClick={() => {
                setTab('audit');
                void loadAuditLogs({ offset: 0 });
              }}
            >
              审计日志
            </button>
          )}
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
                  <button type="button" className="btn btn-sm btn-danger" onClick={openCreateCamera} data-testid="point-add-single">
                    新增单个点位
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm btn-ghost ${selectionMode ? 'is-active' : ''}`}
                    onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                  >
                    {selectionMode ? '取消批量' : '批量管理'}
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
                  {selectionMode && (
                    <div className="batch-bar">
                      <label className="batch-select-all">
                        <input
                          type="checkbox"
                          checked={
                            selectedIds.length === visibleCameraIds.length &&
                            visibleCameraIds.length > 0
                          }
                          onChange={toggleSelectAll}
                        />
                        全选（{selectedIds.length}/{visibleCameraIds.length}）
                      </label>
                      <div className="batch-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={selectedIds.length === 0 || cameraBusy}
                          onClick={() => void runBatchUpdate({ detectEnabled: true }, '启用检测')}
                        >
                          启用检测
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={selectedIds.length === 0 || cameraBusy}
                          onClick={() => void runBatchUpdate({ detectEnabled: false }, '停用检测')}
                        >
                          停用检测
                        </button>
                        <select
                          className="settings-input batch-select"
                          value={batchSensitivity}
                          disabled={selectedIds.length === 0 || cameraBusy}
                          onChange={(event) => {
                            const value = event.target.value as '' | CameraSensitivity;
                            setBatchSensitivity(value);
                            if (value) {
                              void runBatchUpdate(
                                { detectSensitivity: value },
                                `设为${value === 'low' ? '低' : value === 'high' ? '高' : '标准'}灵敏度`,
                              );
                            }
                          }}
                        >
                          <option value="">灵敏度…</option>
                          <option value="low">低</option>
                          <option value="standard">标准</option>
                          <option value="high">高</option>
                        </select>
                        <select
                          className="settings-input batch-select"
                          value={batchSiteId}
                          disabled={selectedIds.length === 0 || cameraBusy}
                          onChange={(event) => {
                            const value = event.target.value;
                            setBatchSiteId(value);
                            if (value) void runBatchUpdate({ siteId: value }, '调整所属站点');
                          }}
                        >
                          <option value="">移动到站点…</option>
                          {sites.map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={selectedIds.length === 0 || cameraBusy}
                          onClick={() => void runBatchDelete()}
                        >
                          删除选中
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={exitSelectionMode}
                        >
                          退出
                        </button>
                      </div>
                    </div>
                  )}
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
                          {selectionMode && (
                            <input
                              type="checkbox"
                              className="point-select"
                              checked={selectedIds.includes(camera.id)}
                              onChange={() => toggleSelect(camera.id)}
                            />
                          )}
                          <span className="point-code">{camera.code}</span>
                          <div className="point-main">
                            <strong>{camera.name}</strong>
                            <span>
                              {camera.zone} · {PROTOCOL_LABELS[camera.protocol]}
                              {!camera.hasSource && ' · 待配置视频流'}
                            </span>
                            {(falseHotspots[camera.id] ?? 0) >= FALSE_ALARM_HOTSPOT_THRESHOLD && (
                              <span
                                className="false-alarm-badge"
                                title="近 7 天误报偏多，建议调整识别灵敏度或在屏蔽区中排除常亮干扰源"
                              >
                                7 天误报 {falseHotspots[camera.id]} 次 · 建议调优
                              </span>
                            )}
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
                        data-testid="point-name-input"
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
                        data-testid="point-zone-input"
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
                    <label className="admin-form-roi">
                      <span>布防时间表（撤防时段仅暂停火情检测，播放与画面异常监测不受影响）</span>
                      <select
                        className="settings-input"
                        value={cameraForm.schedule ? 'custom' : 'always'}
                        onChange={(event) =>
                          setCameraForm((prev) => ({
                            ...prev,
                            schedule:
                              event.target.value === 'custom'
                                ? {
                                    windows: [
                                      { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00' },
                                    ],
                                  }
                                : null,
                          }))
                        }
                      >
                        <option value="always">全天候布防（7×24 检测）</option>
                        <option value="custom">按时段布防</option>
                      </select>
                      {cameraForm.schedule && (
                        <div className="schedule-editor">
                          {cameraForm.schedule.windows.map((win, index) => (
                            <div key={index} className="schedule-row">
                              <div className="schedule-days">
                                {DAY_LABELS.map((label, day) => (
                                  <button
                                    type="button"
                                    key={day}
                                    className={`schedule-day ${win.days.includes(day) ? 'is-on' : ''}`}
                                    onClick={() => toggleScheduleDay(index, day)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                              <input
                                type="time"
                                className="settings-input schedule-time"
                                value={win.start}
                                onChange={(event) =>
                                  updateScheduleWindow(index, { start: event.target.value })
                                }
                              />
                              <span className="schedule-sep">至</span>
                              <input
                                type="time"
                                className="settings-input schedule-time"
                                value={win.end}
                                onChange={(event) =>
                                  updateScheduleWindow(index, { end: event.target.value })
                                }
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                onClick={() => removeScheduleWindow(index)}
                              >
                                删除
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={addScheduleWindow}
                          >
                            + 添加时段
                          </button>
                          <span className="schedule-hint">
                            结束时间早于开始时间表示跨零点（如 22:00 至 06:00）。
                          </span>
                        </div>
                      )}
                    </label>
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
                    <button type="submit" className="btn btn-sm btn-danger" disabled={cameraBusy} data-testid="point-save">
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
                <StatsOverview stats={alarmStats} />
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

              <div className="template-card">
                <div className="admin-subhead">
                  <h4>告警通知文案模板</h4>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => openTemplateEditor()}
                  >
                    新建模板
                  </button>
                </div>
                <p className="admin-form-hint">
                  可用变量：{'{site}'} 站点 · {'{camera}'} 点位 · {'{zone}'} 区域 · {'{level}'} 类型 ·
                  {'{confidence}'} 置信度 · {'{time}'} 时间 · {'{hotspot}'} 热区 · {'{link}'} 处置入口。
                  仅作用于「告警产生」通知，其余事件沿用内置文案。
                </p>
                {showTemplateEditor && (
                  <div className="template-editor">
                    <input
                      className="settings-input"
                      placeholder="模板名称"
                      value={templateDraft.name}
                      maxLength={32}
                      onChange={(event) =>
                        setTemplateDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                    <textarea
                      className="settings-input template-body"
                      rows={3}
                      placeholder="例如：{time} {site}/{camera} 触发{level}（{confidence}%），请核实：{link}"
                      value={templateDraft.body}
                      onChange={(event) =>
                        setTemplateDraft((prev) => ({ ...prev, body: event.target.value }))
                      }
                    />
                    <div className="template-var-row">
                      {[
                        'site',
                        'camera',
                        'zone',
                        'level',
                        'confidence',
                        'time',
                        'hotspot',
                        'link',
                      ].map((variable) => (
                        <button
                          type="button"
                          key={variable}
                          className="chip"
                          onClick={() => insertTemplateVar(variable)}
                        >
                          {`{${variable}}`}
                        </button>
                      ))}
                    </div>
                    <div className="admin-form-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={templateBusy}
                        onClick={() => void saveTemplate()}
                      >
                        {templateBusy ? '保存中…' : '保存模板'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={closeTemplateEditor}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
                <NotifyTemplateList
                  notifyTemplates={notifyTemplates}
                  showTemplateEditor={showTemplateEditor}
                  openTemplateEditor={openTemplateEditor}
                  removeTemplate={removeTemplate}
                />
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
                  <label>
                    <span>消息模板</span>
                    <select
                      className="settings-input"
                      value={notifyForm.templateId}
                      onChange={(event) =>
                        setNotifyForm((prev) => ({ ...prev, templateId: event.target.value }))
                      }
                    >
                      <option value="">默认文案</option>
                      {notifyTemplates.map((tpl) => (
                        <option key={tpl.id} value={tpl.id}>
                          {tpl.name}
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

              <NotifyChannelList
                notifyChannels={notifyChannels}
                notifyTemplates={notifyTemplates}
                testingChannel={testingChannel}
                kindLabels={NOTIFY_KIND_LABELS}
                testNotifyChannel={testNotifyChannel}
                toggleNotifyChannel={toggleNotifyChannel}
                removeNotifyChannel={removeNotifyChannel}
              />

              <NotifyLogList
                notifyLogs={notifyLogs}
                eventLabels={NOTIFY_EVENT_LABELS}
                formatDateTime={formatDateTime}
              />
            </div>
          ) : tab === 'audit' ? (
            <div className="admin-section">
              <div className="admin-section-head">
                <div>
                  <h3>审计日志</h3>
                  <p>
                    记录所有账号的关键操作（登录、点位变更、告警处置、通知与系统操作），
                    共 {auditTotal} 条，按时间倒序。
                  </p>
                </div>
                <div className="admin-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={auditBusy || auditLogs.length === 0}
                    onClick={() =>
                      downloadAuditCsv(auditLogs, AUDIT_ACTION_LABELS, '审计日志')
                    }
                  >
                    导出当前页 CSV
                  </button>
                </div>
              </div>

              <div className="audit-filters">
                <select
                  className="settings-input"
                  aria-label="按动作类型筛选"
                  value={auditFilter.action}
                  onChange={(event) =>
                    void loadAuditLogs({ action: event.target.value, offset: 0 })
                  }
                >
                  {AUDIT_ACTION_GROUPS.map((group) => (
                    <option key={group.value} value={group.value}>
                      {group.label}
                    </option>
                  ))}
                </select>
                <select
                  className="settings-input"
                  aria-label="按时间范围筛选"
                  value={auditFilter.range}
                  onChange={(event) =>
                    void loadAuditLogs({ range: event.target.value, offset: 0 })
                  }
                >
                  {AUDIT_RANGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  className="settings-input"
                  value={auditFilter.q}
                  placeholder="搜索账号 / 详情 / 对象 ID"
                  aria-label="搜索审计日志"
                  onChange={(event) => setAuditFilter((prev) => ({ ...prev, q: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void loadAuditLogs({ offset: 0 });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={auditBusy}
                  onClick={() => void loadAuditLogs({ offset: 0 })}
                >
                  {auditBusy ? '查询中…' : '查询'}
                </button>
              </div>

              {auditLogs.length === 0 ? (
                <p className="admin-empty">没有符合条件的审计记录。</p>
              ) : (
                <AuditLogTable logs={auditLogs} actionLabels={AUDIT_ACTION_LABELS} />
              )}

              <AuditPager
                auditBusy={auditBusy}
                auditOffset={auditOffset}
                auditTotal={auditTotal}
                pageSize={AUDIT_PAGE_SIZE}
                loadAuditLogs={loadAuditLogs}
              />
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

              <UserList
                users={users}
                usersLoading={usersLoading}
                currentUser={currentUser}
                updateUser={updateUser}
                openAssignUser={openAssignUser}
                resetPassword={resetPassword}
                deleteUser={deleteUser}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
