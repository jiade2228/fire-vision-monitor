import { useCallback, useEffect, useRef, useState } from 'react';
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
import CamerasTab from './admin/CamerasTab';
import SitesTab from './admin/SitesTab';
import StatsTab from './admin/StatsTab';
import NotifyTab from './admin/NotifyTab';
import AuditTab from './admin/AuditTab';
import UsersTab from './admin/UsersTab';

interface Props {
  cameras: ManagedCamera[];
  currentUser: SessionUser;
  initialTab?: TabKey;
  onClose: () => void;
  onCamerasChanged: () => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
}

type TabKey = 'cameras' | 'users' | 'sites' | 'stats' | 'notify' | 'audit';

export const NOTIFY_KIND_LABELS: Record<NotifyKind, string> = {
  webhook: 'Webhook',
  wecom: '企业微信',
  dingtalk: '钉钉',
};

export const NOTIFY_EVENT_LABELS: Record<string, string> = {
  created: '告警产生',
  confirmed: '确认处置',
  false: '判定误报',
  recovered: '设备恢复',
  summary: '每日摘要',
  'channel.disabled': '渠道停用',
};

/** 审计动作中文标签：后端 action 为「对象.动作」的点分格式。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
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

export const AUDIT_ACTION_GROUPS: { value: string; label: string }[] = [
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

export const AUDIT_RANGE_OPTIONS: { value: string; label: string; ms: number }[] = [
  { value: 'all', label: '全部时间', ms: 0 },
  { value: '1h', label: '近 1 小时', ms: 60 * 60 * 1000 },
  { value: 'today', label: '今天', ms: -1 },
  { value: '7d', label: '近 7 天', ms: 7 * 24 * 60 * 60 * 1000 },
];

// 实现收敛到 lib/format.ts；此处 re-export 保持 CamerasTab 等既有导入路径不变。
export { formatBytes } from '../lib/format';

export const PROTOCOL_LABELS: Record<ManagedCamera['protocol'], string> = {
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

export const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
export const FALSE_ALARM_HOTSPOT_THRESHOLD = 5;

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
  // 服务端对关键词搜索自动收敛了默认时间窗时为 true（结果只覆盖最近 N 天）。
  const [auditSearchWindowed, setAuditSearchWindowed] = useState(false);
  const [auditSearchWindowDays, setAuditSearchWindowDays] = useState(0);
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
  // 全局只有一条 error，切 Tab 不清会让「点位保存失败」一直挂在
  // 「站点与分组」等无关页面顶部。集中一个切换函数保证所有入口都清理。
  const switchTab = useCallback((next: TabKey) => {
    setError('');
    setTab(next);
  }, []);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // 卸载守卫：面板关闭后仍在途的请求回来时写 state 会造成状态错写与内存泄漏。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const result = await api.users();
      if (!mountedRef.current) return;
      setUsers(result.users);
    } catch (requestError) {
      if (!mountedRef.current) return;
      setError(
        requestError instanceof ApiError ? requestError.message : '账号列表加载失败',
      );
    } finally {
      if (mountedRef.current) setUsersLoading(false);
    }
  };

  const loadSites = async () => {
    try {
      const result = await api.sites();
      if (!mountedRef.current) return;
      setSites(result.sites);
      setDefaultSiteId(result.defaultSiteId);
    } catch (requestError) {
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
      setNotifyChannels(channelsResult.channels);
      setNotifyTemplates(templatesResult.templates);
    } catch (requestError) {
      if (!mountedRef.current) return;
      setError(
        requestError instanceof ApiError ? requestError.message : '通知渠道加载失败',
      );
    }
  };

  const loadNotifyTemplates = async () => {
    try {
      const result = await api.notifyTemplates();
      if (!mountedRef.current) return;
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
      if (!mountedRef.current) return;
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
      setAuditSearchWindowed(Boolean(result.searchWindowed));
      setAuditSearchWindowDays(Number(result.searchWindowDays ?? 0));
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

  // health/edge* 只在「点位管理」Tab 消费。此前 5s 轮询在审计日志等 Tab 下
  // 也照常发请求并 setState（新对象引用），每 5 秒重渲染整棵面板树。
  // 用 ref 读取当前 Tab，避免把 tab 加进依赖数组导致切 Tab 时重建定时器。
  const tabRef = useRef<TabKey>(tab);
  tabRef.current = tab;
  useEffect(() => {
    const loadHealth = async () => {
      if (tabRef.current !== 'cameras') return;
      try {
        const result = await api.streamHealth();
        if (tabRef.current !== 'cameras') return;
        setHealth(
          Object.fromEntries(
            result.cameras.map((camera) => [camera.cameraId, camera]),
          ),
        );
        setProbeAvailable(result.probeAvailable);
        const edge = await api.edgeStatus();
        if (tabRef.current !== 'cameras') return;
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

  // 重置密码：改用受控表单弹窗。
  // 原实现用 window.prompt 收集明文密码——密码明文显示在系统对话框里
  // （可被录屏/肩窥获取），无强度校验与二次确认。
  const [passwordTarget, setPasswordTarget] = useState<SessionUser | null>(null);
  const [passwordDraft, setPasswordDraft] = useState({ password: '', confirm: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);

  const resetPassword = (user: SessionUser) => {
    setPasswordTarget(user);
    setPasswordDraft({ password: '', confirm: '' });
  };

  const closePasswordDialog = () => {
    if (passwordBusy) return;
    setPasswordTarget(null);
    setPasswordDraft({ password: '', confirm: '' });
  };

  const submitPasswordReset = async () => {
    if (!passwordTarget || passwordBusy) return;
    const { password, confirm } = passwordDraft;
    if (password.length < 8) {
      setError('新密码至少需要 8 位');
      return;
    }
    if (password.length > 128) {
      setError('新密码长度不能超过 128 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setPasswordBusy(true);
    try {
      await api.updateUser(passwordTarget.id, { password });
      onNotify('密码已重置', 'ok');
      setPasswordTarget(null);
      setPasswordDraft({ password: '', confirm: '' });
    } catch (requestError) {
      setError(
        requestError instanceof ApiError ? requestError.message : '密码重置失败',
      );
    } finally {
      setPasswordBusy(false);
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
            onClick={() => switchTab('cameras')}
          >
            点位与视频流
          </button>
          {isSuperAdmin && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'users'}
              className={`admin-tab ${tab === 'users' ? 'is-active' : ''}`}
              onClick={() => switchTab('users')}
            >
              账号与权限
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sites'}
            className={`admin-tab ${tab === 'sites' ? 'is-active' : ''}`}
            onClick={() => switchTab('sites')}
          >
            站点与分组
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'stats'}
            className={`admin-tab ${tab === 'stats' ? 'is-active' : ''}`}
            onClick={() => {
              switchTab('stats');
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
              switchTab('notify');
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
                switchTab('audit');
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
            <CamerasTab
              isSuperAdmin={isSuperAdmin}
              selectionMode={selectionMode}
              edgeEnabled={edgeEnabled}
              edgeGateways={edgeGateways}
              edgeToken={edgeToken}
              system={system}
              demoStatus={demoStatus}
              demoBusy={demoBusy}
              showNvrForm={showNvrForm}
              nvrBusy={nvrBusy}
              showOnvifForm={showOnvifForm}
              onvifScanBusy={onvifScanBusy}
              onvifBusy={onvifBusy}
              onvifScanDevices={onvifScanDevices}
              onvifResults={onvifResults}
              onvifSelected={onvifSelected}
              onvifImporting={onvifImporting}
              cameras={cameras}
              siteFilter={siteFilter}
              selectedIds={selectedIds}
              cameraBusy={cameraBusy}
              batchSensitivity={batchSensitivity}
              batchSiteId={batchSiteId}
              sites={sites}
              health={health}
              probeResults={probeResults}
              falseHotspots={falseHotspots}
              testingId={testingId}
              probeAvailable={probeAvailable}
              showCameraForm={showCameraForm}
              editingId={editingId}
              cameraForm={cameraForm}
              vendors={vendors}
              nvrForm={nvrForm}
              onvifForm={onvifForm}
              selectedVendor={selectedVendor}
              visibleCameraIds={visibleCameraIds}
              defaultSiteId={defaultSiteId}
              siteKey={siteKey}
              siteName={siteName}
              healthText={healthText}
              setShowOnvifForm={setShowOnvifForm}
              setShowNvrForm={setShowNvrForm}
              setShowCameraForm={setShowCameraForm}
              setError={setError}
              setSelectionMode={setSelectionMode}
              setNvrForm={setNvrForm}
              setOnvifForm={setOnvifForm}
              setBatchSensitivity={setBatchSensitivity}
              setBatchSiteId={setBatchSiteId}
              setSiteFilter={setSiteFilter}
              setCameraForm={setCameraForm}
              openCreateCamera={openCreateCamera}
              exitSelectionMode={exitSelectionMode}
              copyEdgeToken={copyEdgeToken}
              toggleDemo={toggleDemo}
              purgeDemoData={purgeDemoData}
              submitNvr={submitNvr}
              changeVendor={changeVendor}
              runOnvifScan={runOnvifScan}
              runOnvifDiscover={runOnvifDiscover}
              toggleOnvifProfile={toggleOnvifProfile}
              importOnvifSelected={importOnvifSelected}
              toggleSelectAll={toggleSelectAll}
              toggleSelect={toggleSelect}
              runBatchUpdate={runBatchUpdate}
              runBatchDelete={runBatchDelete}
              runProbe={runProbe}
              openEditCamera={openEditCamera}
              deleteCamera={deleteCamera}
              submitCamera={submitCamera}
              updateScheduleWindow={updateScheduleWindow}
              toggleScheduleDay={toggleScheduleDay}
              removeScheduleWindow={removeScheduleWindow}
              addScheduleWindow={addScheduleWindow}
            />
          ) : tab === 'sites' ? (
            <SitesTab
              isSuperAdmin={isSuperAdmin}
              sites={sites}
              cameras={cameras}
              siteForm={siteForm}
              siteBusy={siteBusy}
              editingSiteId={editingSiteId}
              editingSiteName={editingSiteName}
              defaultSiteId={defaultSiteId}
              assigningUser={assigningUser}
              assignBusy={assignBusy}
              assignSiteIds={assignSiteIds}
              setSiteForm={setSiteForm}
              setEditingSiteName={setEditingSiteName}
              setAssigningUser={setAssigningUser}
              siteKey={siteKey}
              submitSite={submitSite}
              saveEditSite={saveEditSite}
              cancelEditSite={cancelEditSite}
              startEditSite={startEditSite}
              removeSite={removeSite}
              toggleAssignSite={toggleAssignSite}
              saveAssignUser={saveAssignUser}
            />
          ) : tab === 'stats' ? (
            <StatsTab
              statsDays={statsDays}
              setStatsDays={setStatsDays}
              alarmStats={alarmStats}
              loadAlarmStats={loadAlarmStats}
            />
          ) : tab === 'notify' ? (
            <NotifyTab
              isSuperAdmin={isSuperAdmin}
              sites={sites}
              notifyTemplates={notifyTemplates}
              showTemplateEditor={showTemplateEditor}
              templateDraft={templateDraft}
              templateBusy={templateBusy}
              notifyForm={notifyForm}
              notifyBusy={notifyBusy}
              notifyChannels={notifyChannels}
              testingChannel={testingChannel}
              notifyLogs={notifyLogs}
              setTemplateDraft={setTemplateDraft}
              setNotifyForm={setNotifyForm}
              loadNotifyLogs={loadNotifyLogs}
              openTemplateEditor={openTemplateEditor}
              insertTemplateVar={insertTemplateVar}
              saveTemplate={saveTemplate}
              closeTemplateEditor={closeTemplateEditor}
              removeTemplate={removeTemplate}
              submitNotify={submitNotify}
              testNotifyChannel={testNotifyChannel}
              toggleNotifyChannel={toggleNotifyChannel}
              removeNotifyChannel={removeNotifyChannel}
            />
          ) : tab === 'audit' ? (
            <AuditTab
              auditTotal={auditTotal}
              auditBusy={auditBusy}
              auditFilter={auditFilter}
              auditLogs={auditLogs}
              auditOffset={auditOffset}
              AUDIT_PAGE_SIZE={AUDIT_PAGE_SIZE}
              auditSearchWindowed={auditSearchWindowed}
              auditSearchWindowDays={auditSearchWindowDays}
              setAuditFilter={setAuditFilter}
              loadAuditLogs={loadAuditLogs}
            />
          ) : (
            <UsersTab
              currentUser={currentUser}
              userForm={userForm}
              userBusy={userBusy}
              users={users}
              usersLoading={usersLoading}
              setUserForm={setUserForm}
              submitUser={submitUser}
              updateUser={updateUser}
              openAssignUser={openAssignUser}
              resetPassword={resetPassword}
              deleteUser={deleteUser}
            />
          )}
        </div>
      </div>

      {passwordTarget && (
        <div
          className="settings-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePasswordDialog();
          }}
        >
          <div
            className="settings-shell admin-shell"
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-reset-title"
          >
            <header className="settings-head">
              <div>
                <h2 id="password-reset-title">重置密码</h2>
                <p>为「{passwordTarget.displayName}」设置新的登录密码</p>
              </div>
              <button
                type="button"
                className="settings-close"
                onClick={closePasswordDialog}
                disabled={passwordBusy}
              >
                关闭
              </button>
            </header>
            <div className="admin-form">
              <label>
                <span>新密码</span>
                <input
                  className="settings-input"
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  value={passwordDraft.password}
                  onChange={(event) =>
                    setPasswordDraft((prev) => ({
                      ...prev,
                      password: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                <span>确认新密码</span>
                <input
                  className="settings-input"
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  value={passwordDraft.confirm}
                  onChange={(event) =>
                    setPasswordDraft((prev) => ({
                      ...prev,
                      confirm: event.target.value,
                    }))
                  }
                />
              </label>
              <p className="admin-form-hint">
                密码长度 8-128 位。重置后该账号已登录的其它会话会立即失效。
              </p>
              <div className="admin-form-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={passwordBusy}
                  onClick={() => void submitPasswordReset()}
                >
                  {passwordBusy ? '提交中…' : '确认重置'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={passwordBusy}
                  onClick={closePasswordDialog}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
