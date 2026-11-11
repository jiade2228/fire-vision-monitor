import { Fragment } from 'react';
import type { Dispatch, SetStateAction, FormEvent } from 'react';
import type {
  CameraInput,
  CameraSchedule,
  CameraSensitivity,
  DemoStatus,
  EdgeGatewayStatus,
  ManagedCamera,
  OnvifDiscoverResult,
  OnvifScanDevice,
  ProbeResult,
  Site,
  StreamHealth,
  SystemInfo,
  VendorPreset,
} from '../../lib/api';
import {
  DAY_LABELS,
  FALSE_ALARM_HOTSPOT_THRESHOLD,
  PROTOCOL_LABELS,
  formatBytes,
} from '../AdminPanel';
import RoiEditor from '../RoiEditor';
import { parseIntInRange, parsePort } from '../../lib/validate';

type NvrForm = {
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
  template: string;
  siteId: string;
};

type OnvifForm = {
  hosts: string;
  port: number;
  username: string;
  password: string;
  zone: string;
  siteId: string;
};

type CameraBatchPatch = {
  detectEnabled?: boolean;
  detectSensitivity?: CameraSensitivity | null;
  siteId?: string | null;
};

interface CamerasTabProps {
  isSuperAdmin: boolean;
  selectionMode: boolean;
  edgeEnabled: boolean;
  edgeGateways: EdgeGatewayStatus[];
  edgeToken: string;
  system: SystemInfo | null;
  demoStatus: DemoStatus | null;
  demoBusy: boolean;
  showNvrForm: boolean;
  nvrBusy: boolean;
  showOnvifForm: boolean;
  onvifScanBusy: boolean;
  onvifBusy: boolean;
  onvifScanDevices: OnvifScanDevice[];
  onvifResults: OnvifDiscoverResult['results'];
  onvifSelected: string[];
  onvifImporting: boolean;
  cameras: ManagedCamera[];
  siteFilter: string;
  selectedIds: string[];
  cameraBusy: boolean;
  batchSensitivity: '' | CameraSensitivity;
  batchSiteId: string;
  sites: Site[];
  health: Record<string, StreamHealth>;
  probeResults: Record<string, ProbeResult>;
  falseHotspots: Record<string, number>;
  testingId: string | null;
  probeAvailable: boolean;
  showCameraForm: boolean;
  editingId: string | null;
  cameraForm: CameraInput;
  vendors: VendorPreset[];
  nvrForm: NvrForm;
  onvifForm: OnvifForm;
  selectedVendor: VendorPreset | undefined;
  visibleCameraIds: string[];
  defaultSiteId: string;
  siteKey: (id: string | null | undefined) => string;
  siteName: (id: string | null | undefined) => string;
  healthText: (item?: StreamHealth) => string;
  setShowOnvifForm: Dispatch<SetStateAction<boolean>>;
  setShowNvrForm: Dispatch<SetStateAction<boolean>>;
  setShowCameraForm: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
  setNvrForm: Dispatch<SetStateAction<NvrForm>>;
  setOnvifForm: Dispatch<SetStateAction<OnvifForm>>;
  setBatchSensitivity: Dispatch<SetStateAction<'' | CameraSensitivity>>;
  setBatchSiteId: Dispatch<SetStateAction<string>>;
  setSiteFilter: Dispatch<SetStateAction<string>>;
  setCameraForm: Dispatch<SetStateAction<CameraInput>>;
  openCreateCamera: () => void;
  exitSelectionMode: () => void;
  copyEdgeToken: () => Promise<void>;
  toggleDemo: (action: 'start' | 'stop') => Promise<void>;
  purgeDemoData: () => Promise<void>;
  submitNvr: (event: FormEvent) => Promise<void>;
  changeVendor: (vendorId: string) => void;
  runOnvifScan: () => Promise<void>;
  runOnvifDiscover: (event: FormEvent) => Promise<void>;
  toggleOnvifProfile: (key: string) => void;
  importOnvifSelected: () => Promise<void>;
  toggleSelectAll: () => void;
  toggleSelect: (id: string) => void;
  runBatchUpdate: (patch: CameraBatchPatch, label: string) => Promise<void>;
  runBatchDelete: () => Promise<void>;
  runProbe: (camera: ManagedCamera) => Promise<void>;
  openEditCamera: (camera: ManagedCamera) => void;
  deleteCamera: (camera: ManagedCamera) => Promise<void>;
  submitCamera: (event: FormEvent) => Promise<void>;
  updateScheduleWindow: (index: number, patch: Partial<CameraSchedule['windows'][number]>) => void;
  toggleScheduleDay: (index: number, day: number) => void;
  removeScheduleWindow: (index: number) => void;
  addScheduleWindow: () => void;
}

export default function CamerasTab(props: CamerasTabProps) {
  const {
    isSuperAdmin,
    selectionMode,
    edgeEnabled,
    edgeGateways,
    edgeToken,
    system,
    demoStatus,
    demoBusy,
    showNvrForm,
    nvrBusy,
    showOnvifForm,
    onvifScanBusy,
    onvifBusy,
    onvifScanDevices,
    onvifResults,
    onvifSelected,
    onvifImporting,
    cameras,
    siteFilter,
    selectedIds,
    cameraBusy,
    batchSensitivity,
    batchSiteId,
    sites,
    health,
    probeResults,
    falseHotspots,
    testingId,
    probeAvailable,
    showCameraForm,
    editingId,
    cameraForm,
    vendors,
    nvrForm,
    onvifForm,
    selectedVendor,
    visibleCameraIds,
    defaultSiteId,
    siteKey,
    siteName,
    healthText,
    setShowOnvifForm,
    setShowNvrForm,
    setShowCameraForm,
    setError,
    setSelectionMode,
    setNvrForm,
    setOnvifForm,
    setBatchSensitivity,
    setBatchSiteId,
    setSiteFilter,
    setCameraForm,
    openCreateCamera,
    exitSelectionMode,
    copyEdgeToken,
    toggleDemo,
    purgeDemoData,
    submitNvr,
    changeVendor,
    runOnvifScan,
    runOnvifDiscover,
    toggleOnvifProfile,
    importOnvifSelected,
    toggleSelectAll,
    toggleSelect,
    runBatchUpdate,
    runBatchDelete,
    runProbe,
    openEditCamera,
    deleteCamera,
    submitCamera,
    updateScheduleWindow,
    toggleScheduleDay,
    removeScheduleWindow,
    addScheduleWindow,
  } = props;
  return (
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
                        onChange={(event) => {
                          const port = parsePort(event.target.value);
                          // 非法输入（清空/越界/非整数）不写入 state：
                          // Number('') 会得到 0 并被当成合法端口提交。
                          if (port === null) return;
                          setNvrForm((prev) => ({ ...prev, rtspPort: port }));
                        }}
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
                            onChange={(event) => {
                              const channel = parseIntInRange(
                                event.target.value,
                                1,
                                256,
                              );
                              if (channel === null) return;
                              setNvrForm((prev) => ({
                                ...prev,
                                startChannel: channel,
                              }));
                            }}
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
                            onChange={(event) => {
                              const count = parseIntInRange(event.target.value, 1, 64);
                              if (count === null) return;
                              setNvrForm((prev) => ({ ...prev, count }));
                            }}
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
                          onChange={(event) => {
                            const port = parsePort(event.target.value);
                            if (port === null) return;
                            setOnvifForm((prev) => ({ ...prev, port }));
                          }}
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
  );
}
