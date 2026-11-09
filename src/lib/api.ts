import type { Alarm, AlarmLevel, AlarmStatus, DetectionSensitivity } from '../types';

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  siteAdmin?: boolean;
  disabled?: boolean;
  createdAt: number;
}

export interface RoiRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 与 types.ts 的 DetectionSensitivity 同源，保留 api 层既有导出名。 */
export type CameraSensitivity = DetectionSensitivity;

/** 布防时间表：按星期 + 时段启用检测；null 表示 7×24 全天候布防。 */
export interface CameraSchedule {
  windows: Array<{ days: number[]; start: string; end: string }>;
}

export interface ManagedCamera {
  id: string;
  code: string;
  name: string;
  zone: string;
  enabled: boolean;
  protocol: 'none' | 'hls' | 'http' | 'rtsp' | 'edge';
  sourceUrl: string;
  hasSource: boolean;
  streamUrl: string;
  siteId: string | null;
  detectEnabled: boolean;
  detectSensitivity: CameraSensitivity | null;
  detectRoi: RoiRect[];
  schedule: CameraSchedule | null;
  createdAt: number;
  updatedAt: number;
}

export interface CameraInput {
  name: string;
  zone: string;
  protocol: ManagedCamera['protocol'];
  sourceUrl: string;
  enabled: boolean;
  siteId?: string | null;
  detectEnabled?: boolean;
  detectSensitivity?: CameraSensitivity | null;
  detectRoi?: RoiRect[];
  schedule?: CameraSchedule | null;
}

export interface UserInput {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
  siteAdmin?: boolean;
}

export interface VendorPreset {
  id: string;
  name: string;
  group: string;
  defaultPort: number;
  singleChannel: boolean;
  supportsSubstream: boolean;
  custom?: boolean;
  hint: string;
}

export interface BrandImportInput {
  vendorId: string;
  host: string;
  rtspPort: number;
  username: string;
  password: string;
  startChannel: number;
  count: number;
  stream: 'main' | 'sub';
  zone: string;
  namePrefix: string;
  template?: string;
  siteId?: string | null;
}

export interface OnvifProfile {
  token: string;
  name: string;
  rtspUri: string;
  snapshotUri: string;
}

export interface OnvifDevice {
  host: string;
  port: number;
  manufacturer: string;
  model: string;
  firmware: string;
  profiles: OnvifProfile[];
}

export interface OnvifDiscoverResult {
  results: Array<{
    ok: boolean;
    error?: string;
    target: { host: string; port: number };
    device?: OnvifDevice;
  }>;
}

export interface OnvifScanDevice {
  host: string;
  port: number;
  xaddrs: string[];
  name: string;
  manufacturer: string;
  types: string;
  endpoint: string;
  scopes: string[];
}

export interface OnvifScanResult {
  devices: OnvifScanDevice[];
  durationMs: number;
}

export interface OnvifImportInput {
  devices: Array<{
    label: string;
    zone: string;
    host: string;
    siteId?: string | null;
    profiles: OnvifProfile[];
  }>;
}

export interface Site {
  id: string;
  name: string;
  code: string;
  createdAt: number;
}

export interface SitesResult {
  sites: Site[];
  defaultSiteId: string;
  mySiteIds: string[];
}

export interface UserSitesResult {
  siteIds: string[];
  sites: Site[];
}

export type NotifyKind = 'webhook' | 'wecom' | 'dingtalk';

export interface NotifyChannel {
  id: string;
  siteId: string | null;
  siteName: string | null;
  kind: NotifyKind;
  name: string;
  urlHint: string;
  hasSecret: boolean;
  enabled: boolean;
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NotifyChannelInput {
  siteId?: string | null;
  kind: NotifyKind;
  name: string;
  url: string;
  secret?: string;
  enabled?: boolean;
  templateId?: string | null;
}

export interface NotifyTemplate {
  id: string;
  name: string;
  body: string;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BatchCameraResult {
  updated?: number;
  deleted?: number;
  errors: Array<{ id: string; error: string }>;
  cameras?: ManagedCamera[];
}

export interface NotificationLog {
  id: string;
  alarmId: string | null;
  channelId: string | null;
  channelName: string | null;
  channelKind: string | null;
  event: string;
  status: string;
  error: string | null;
  createdAt: number;
}

export interface OnvifImportResult {
  created: ManagedCamera[];
  skipped: number;
}

export interface AlarmStatsDay {
  date: string;
  fire: number;
  smoke: number;
  offline: number;
  total: number;
  false: number;
  confirmed: number;
  pending: number;
  archived: number;
}

export interface AlarmStats {
  days: AlarmStatsDay[];
  totals: AlarmStatsDay;
  falseRate: number;
  bySite: Array<{
    siteId: string;
    name: string;
    total: number;
    fire: number;
    smoke: number;
    offline: number;
    false: number;
  }>;
}

export interface AlarmCreateInput {
  cameraId: string;
  level: AlarmLevel;
  confidence: number;
  hotspot: { x: number; y: number };
  snapshot: string | null;
}

export interface AlarmPatchInput {
  status?: AlarmStatus;
  note?: string;
  steps?: boolean[];
}

export interface AlarmEvent {
  id: string;
  alarmId: string;
  userId: string | null;
  username: string | null;
  action: string;
  detail: string;
  createdAt: number;
}

export interface DetectionCameraStatus {
  cameraId: string;
  code: string;
  name: string;
  siteId: string | null;
  running: boolean;
  frames: number;
  lastFrameAt: number | null;
  lastError: string | null;
}

export interface DetectionStatus {
  enabled: boolean;
  ffmpegAvailable: boolean;
  active: boolean;
  width: number;
  height: number;
  fps: number;
  sensitivity: string;
  cooldownMs: number;
  stats: { frames: number; alarms: number; duplicates: number; errors: number };
  cameras: DetectionCameraStatus[];
}

export interface StorageUsage {
  dbBytes: number;
  snapshots: { files: number; bytes: number };
  recordings: { files: number; bytes: number };
  mediaBytes: number;
  mediaMaxBytes: number;
}

export interface SystemInfo {
  ffmpegAvailable: boolean;
  ffprobeAvailable?: boolean;
  nodeVersion: string;
  maxStreamIdleSeconds: number;
  detection?: DetectionStatus;
  storage?: StorageUsage;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  username: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string;
  ip: string;
  createdAt: number;
}

export interface AuditLogPage {
  logs: AuditLog[];
  total: number;
}

export interface DemoStatus {
  running: boolean;
  ffmpegAvailable: boolean;
  width: number;
  height: number;
  fps: number;
  segmentSeconds: number;
  playlistSize: number;
  startedAt: number | null;
  lastError: string | null;
  playlistUrl: string | null;
  purgeable?: { alarms: number; snapshots: number; clips: number };
  camera: {
    id: string;
    code: string;
    name: string;
    streamUrl: string;
  } | null;
}

export interface StreamHealth {
  cameraId: string;
  code: string;
  name: string;
  protocol: ManagedCamera['protocol'];
  enabled: boolean;
  hasSource: boolean;
  status:
    | 'disabled'
    | 'unconfigured'
    | 'external'
    | 'starting'
    | 'running'
    | 'gateway'
    | 'error'
    | 'idle';
  attempts: number;
  lastAccess: number | null;
  lastError: string | null;
}

export interface EdgeGatewayStatus {
  gatewayId: string;
  name: string;
  connectedAt: number;
  cameras: Array<{ key: string; label: string }>;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  fps?: string | null;
  format?: string | null;
  error?: string;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// 单个请求的最长等待：避免网络黑洞让 useAlarms 的防重入标志永不复位。
const REQUEST_TIMEOUT_MS = 60_000;

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('X-Requested-With', 'flame-vision');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    ) {
      throw new ApiError('请求超时，请稍后重试', 0);
    }
    throw new ApiError('无法连接服务器，请检查网络或服务是否运行', 0);
  }
  const text = await response.text();
  let payload: unknown = null;
  let parseFailed = false;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      !url.startsWith('/api/auth/login') &&
      !url.startsWith('/api/auth/status')
    ) {
      window.dispatchEvent(new CustomEvent('flame-vision:unauthorized'));
    }
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  // 合法的 JSON `null` 是有效响应，只有解析失败才报错。
  if (parseFailed) {
    throw new ApiError('服务器返回了无法解析的响应', response.status);
  }
  return payload as T;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  operator: '值班员',
  viewer: '只读',
};

/** 持续录像时间线（schema V8 索引；回放与导出见 recordingsPlay / recordingsExportUrl）。 */
export interface RecordingTimelineBlock {
  startedAt: number;
  endedAt: number;
  bytes: number;
  protected: boolean;
  segmentCount: number;
}

export interface RecordingGap {
  startedAt: number;
  endedAt: number;
}

export interface RecordingTimeline {
  from: number;
  to: number;
  blocks: RecordingTimelineBlock[];
  gaps: RecordingGap[];
  coverageMs: number;
  segmentCount: number;
}

export interface RecordingTimelineResponse {
  cameraId: string;
  enabled: boolean;
  timeline: RecordingTimeline;
}

/** 按需回放会话：playlist 为同源 HLS 相对 URL，服务端窗口上限 4 小时。 */
export interface RecordingPlayResponse {
  sessionId: string;
  playlist: string;
  from: number;
  to: number;
  segmentCount: number;
  expiresAt: number;
}

/** 持续录像采集/转码状态（/api/recordings/status）。 */
export interface RecordingStatus {
  enabled: boolean;
  active: number;
  total: number;
  skipped: number;
  ffmpegAvailable: boolean;
  retentionDays: number;
}

export const api = {
  authStatus: () =>
    request<{ needsSetup: boolean; authenticated: boolean; user: SessionUser | null }>(
      '/api/auth/status',
    ),
  setup: (body: { username: string; displayName: string; password: string }) =>
    request<{ user: SessionUser }>('/api/setup', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { username: string; password: string }) =>
    request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  system: () => request<SystemInfo>('/api/system'),
  capabilities: () =>
    request<{ serverDetection: boolean }>('/api/capabilities'),
  cameras: (siteId?: string | null) =>
    request<{ cameras: ManagedCamera[] }>(
      `/api/cameras${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ''}`,
    ),
  createCamera: (body: CameraInput) =>
    request<{ camera: ManagedCamera }>('/api/cameras', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  streamHealth: () =>
    request<{ cameras: StreamHealth[]; probeAvailable: boolean }>(
      '/api/streams/health',
    ),
  edgeStatus: () =>
    request<{
      enabled: boolean;
      gateways: EdgeGatewayStatus[];
      pairingToken: string;
    }>('/api/edge/status'),
  testCamera: (id: string) =>
    request<ProbeResult>(`/api/cameras/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  vendors: () => request<{ vendors: VendorPreset[] }>('/api/vendors'),
  importBrandCameras: (body: BrandImportInput) =>
    request<{
      created: number;
      skipped: number;
      cameras: ManagedCamera[];
      stream: 'main' | 'sub';
      vendor: { id: string; name: string; singleChannel: boolean };
    }>('/api/cameras/import-brand', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  discoverOnvif: (body: {
    hosts: string;
    port: number;
    username: string;
    password: string;
  }) =>
    request<OnvifDiscoverResult>('/api/onvif/discover', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  scanOnvif: (body: { timeoutMs?: number } = {}) =>
    request<OnvifScanResult>('/api/onvif/scan', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  importOnvif: (body: OnvifImportInput) =>
    request<OnvifImportResult>('/api/onvif/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateCamera: (id: string, body: Partial<CameraInput>) =>
    request<{ camera: ManagedCamera }>(`/api/cameras/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteCamera: (id: string) =>
    request<{ ok: boolean }>(`/api/cameras/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  alarms: (limit = 300) =>
    request<{ alarms: Alarm[] }>(`/api/alarms?limit=${encodeURIComponent(limit)}`),
  alarmStats: (days = 30) =>
    request<AlarmStats>(`/api/alarms/stats?days=${encodeURIComponent(days)}`),
  falseHotspots: (days = 7) =>
    request<{
      days: number;
      hotspots: Array<{ cameraId: string; cameraName: string; zone: string; count: number }>;
    }>(`/api/alarms/false-hotspots?days=${encodeURIComponent(days)}`),
  createAlarm: (body: AlarmCreateInput) =>
    request<{ alarm: Alarm; duplicate?: boolean }>('/api/alarms', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateAlarm: (id: string, body: AlarmPatchInput) =>
    request<{ alarm: Alarm }>(`/api/alarms/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  alarmEvents: (id: string) =>
    request<{ events: AlarmEvent[] }>(
      `/api/alarms/${encodeURIComponent(id)}/events`,
    ),
  users: () => request<{ users: SessionUser[] }>('/api/users'),
  createUser: (body: UserInput) =>
    request<{ user: SessionUser }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (
    id: string,
    body: Partial<Pick<SessionUser, 'displayName' | 'role' | 'disabled' | 'siteAdmin'>> & {
      password?: string;
    },
  ) =>
    request<{ user: SessionUser }>(`/api/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  sites: () => request<SitesResult>('/api/sites'),
  createSite: (body: { name: string; code?: string }) =>
    request<{ site: Site }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSite: (id: string, body: { name: string }) =>
    request<{ site: Site }>(`/api/sites/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteSite: (id: string) =>
    request<{ ok: boolean }>(`/api/sites/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  userSites: (id: string) =>
    request<UserSitesResult>(`/api/users/${encodeURIComponent(id)}/sites`),
  setUserSites: (id: string, siteIds: string[]) =>
    request<{ siteIds: string[] }>(`/api/users/${encodeURIComponent(id)}/sites`, {
      method: 'PUT',
      body: JSON.stringify({ siteIds }),
    }),
  notifyChannels: () =>
    request<{ channels: NotifyChannel[]; sites: Site[] }>('/api/notify/channels'),
  createNotifyChannel: (body: NotifyChannelInput) =>
    request<{ channel: NotifyChannel }>('/api/notify/channels', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateNotifyChannel: (id: string, body: Partial<NotifyChannelInput>) =>
    request<{ channel: NotifyChannel }>(`/api/notify/channels/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteNotifyChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/notify/channels/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  notifyTemplates: () =>
    request<{ templates: NotifyTemplate[] }>('/api/notify/templates'),
  createNotifyTemplate: (body: { name: string; body: string }) =>
    request<{ template: NotifyTemplate }>('/api/notify/templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateNotifyTemplate: (id: string, body: { name?: string; body?: string }) =>
    request<{ template: NotifyTemplate }>(
      `/api/notify/templates/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  deleteNotifyTemplate: (id: string) =>
    request<{ ok: boolean }>(`/api/notify/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  batchUpdateCameras: (body: {
    ids: string[];
    detectEnabled?: boolean;
    detectSensitivity?: CameraSensitivity | null;
    siteId?: string | null;
  }) =>
    request<BatchCameraResult>('/api/cameras/batch-update', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  batchDeleteCameras: (ids: string[]) =>
    request<BatchCameraResult>('/api/cameras/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  testNotifyChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/notify/channels/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  notificationLogs: (limit = 50) =>
    request<{ logs: NotificationLog[] }>(
      `/api/notify/logs?limit=${encodeURIComponent(limit)}`,
    ),
  detectionStatus: () => request<DetectionStatus>('/api/detection/status'),
  demoStatus: () => request<DemoStatus>('/api/demo/status'),
  auditLogs: (params: {
    limit?: number;
    offset?: number;
    action?: string;
    q?: string;
    from?: number | null;
    to?: number | null;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.limit) search.set('limit', String(params.limit));
    if (params.offset) search.set('offset', String(params.offset));
    if (params.action) search.set('action', params.action);
    if (params.q) search.set('q', params.q);
    if (params.from) search.set('from', String(params.from));
    if (params.to) search.set('to', String(params.to));
    const query = search.toString();
    return request<AuditLogPage>(`/api/audit${query ? `?${query}` : ''}`);
  },
  startDemo: (siteId?: string) =>
    request<DemoStatus>('/api/demo/start', {
      method: 'POST',
      body: JSON.stringify(siteId ? { siteId } : {}),
    }),
  stopDemo: () =>
    request<DemoStatus & { removed: boolean }>('/api/demo/stop', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  purgeDemoData: () =>
    request<{
      removed: number;
      filesRemoved: number;
      events: number;
      notifications: number;
      purgeable: { alarms: number; snapshots: number; clips: number };
    }>('/api/demo/purge', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  recordingsTimeline: ({ cameraId, from, to }: { cameraId: string; from: number; to: number }) => {
    const search = new URLSearchParams({
      cameraId,
      from: String(from),
      to: String(to),
    });
    return request<RecordingTimelineResponse>(`/api/recordings/timeline?${search}`);
  },
  reconcileRecordings: () =>
    request<{
      scanned: number;
      inserted: number;
      updated: number;
      orphansRemoved: number;
    }>('/api/recordings/reconcile', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  recordingsPlay: ({ cameraId, from, to }: { cameraId: string; from: number; to: number }) => {
    const search = new URLSearchParams({
      cameraId,
      from: String(from),
      to: String(to),
    });
    return request<RecordingPlayResponse>(`/api/recordings/play?${search}`);
  },
  recordingsExportUrl: ({ cameraId, from, to }: { cameraId: string; from: number; to: number }) => {
    const search = new URLSearchParams({
      cameraId,
      from: String(from),
      to: String(to),
    });
    return `/api/recordings/export?${search}`;
  },
  recordingsStatus: () => request<RecordingStatus>('/api/recordings/status'),
};
