/**
 * 路由注册函数共用的依赖注入对象（deps）类型定义（纯文档，无运行时代码）。
 *
 * 各 registerXxxRoutes(app, deps) 只使用其中的一个子集，故字段统一标注为可选；
 * 字段说明沿用原先各路由 JSDoc 的措辞，集中在此维护，避免 10 处逐字段重复。
 * 各模块通过 `import('./deps.mjs').RouteDeps` 引用。
 *
 * @typedef {object} RouteDeps
 * @property {object} [store] 数据库访问层。
 * @property {object} [streamManager] 推流管理器（health/activeCount/maxStreams）。
 * @property {object} [edgeHub] 边缘网关。
 * @property {object} [demoSource] 演示流。
 * @property {object} [metrics] 运行指标计数器。
 * @property {any} [detectionEngine] 服务端识别引擎（可选）。
 * @property {object} [notifier] 通知引擎（含 testChannel，可选）。
 * @property {number} [startedAt] 进程启动时间戳。
 * @property {string} [dataDir] 数据根目录。
 * @property {string} [snapshotDir] 抓拍目录。
 * @property {string} [recordingsDir] 告警短视频目录。
 * @property {string} [previewDir] 预览底图目录。
 * @property {string} [continuousDir] 录像段根目录。
 * @property {string} [databaseFile] 数据库文件路径。
 * @property {string} [edgeGatewayToken] 边缘网关令牌。
 * @property {number} [mediaMaxBytes] 演示媒体占用上限字节数。
 * @property {boolean} [ffprobeOk] FFprobe 是否可用。
 * @property {boolean} [recordingEnabled] 采集总闸状态。
 * @property {string} [continuousPlayDir] 回放会话临时目录。
 * @property {string} [exportDir] 录像导出临时目录。
 * @property {object} [playbackManager] 按需转码会话管理器。
 * @property {object} [captureManager] 持续录像采集管理器。
 * @property {(options: object) => Promise<string|null>} [exportRecording] 录像段拼接导出。
 * @property {boolean} [ffmpegAvailable] FFmpeg 可用性（录像/回放）。
 * @property {number} [retentionDays] 录像保留天数。
 * @property {string} [DEMO_CAMERA_CODE] 演示点位编码常量。
 * @property {string} [DEMO_CAMERA_NAME] 演示点位名称常量。
 * @property {string} [DEMO_CAMERA_ZONE] 演示点位区域常量。
 * @property {import('express').RequestHandler} [requireAuth] 登录鉴权中间件。
 * @property {(...roles: string[]) => import('express').RequestHandler} [requireRole] 角色鉴权中间件。
 * @property {import('express').RequestHandler} [requireManager] 管理角色鉴权中间件。
 * @property {(user: any, siteId?: string) => boolean} [canManageSite] 站点管理权限判定。
 * @property {(user: any, camera: any) => boolean} [canManageCamera] 点位管理权限判定。
 * @property {(user: any, camera: any, store: object) => boolean} [canAccessCameraSite] 点位站点访问权判定。
 * @property {(user: any, alarm: any, store: object) => boolean} [canAccessAlarmSite] 告警站点访问权判定。
 * @property {(user: any, store: object) => string[] | null} [allowedSiteIdsFor] 用户可见站点 ID 集合（null 表示全部）。
 * @property {(user: any) => string[] | null} [adminSiteIdsFor] 用户可管理站点 ID 集合。
 * @property {(user: any) => string} [fallbackSiteIdFor] 缺省站点 ID。
 * @property {(value: any, maxLength?: number) => string} [normalizeText] 文本归一化。
 * @property {(req: import('express').Request) => string} [clientIp] 客户端 IP。
 * @property {Function} [log] 结构化日志。
 * @property {(event: string, payload: any, siteId?: string) => void} [broadcastEvent] SSE 事件广播。
 * @property {() => void} [syncDetection] 检测引擎点位对齐。
 * @property {Function} [parseSnapshot] 抓拍 data URL 解析。
 * @property {Function} [mapAlarmEvent] 告警事件映射。
 * @property {(row: unknown) => unknown} [mapAudit] 审计行映射。
 * @property {Function} [publicUser] 用户公开信息映射。
 * @property {Function} [validUsername] 用户名校验。
 * @property {Function} [validatePassword] 密码强度校验。
 * @property {Function} [passwordHash] 密码摘要。
 * @property {Function} [verifyPassword] 密码比对。
 * @property {Function} [validateCameraInput] 点位输入校验。
 * @property {Function} [cameraForClient] 点位客户端映射。
 * @property {Function} [capturePreview] ROI 预览抓图。
 * @property {Function} [notifyChannelForClient] 通知渠道客户端映射。
 * @property {Function} [parseNotifyChannelInput] 通知渠道输入解析。
 * @property {() => object} [demoPurgeFilter] 演示数据清理过滤条件。
 * @property {(cameraId: string) => void} [rememberDemoCameraId] 记录演示点位 ID。
 * @property {() => Promise<{snapshots: object, recordings: object}>} [computeMediaUsage] 媒体占用统计。
 * @property {(req: import('express').Request) => any} [currentUser] 当前会话用户。
 * @property {(req: import('express').Request, res: import('express').Response, user: any) => void} [setSessionCookie] 写入会话 Cookie。
 * @property {(res: import('express').Response) => void} [clearSessionCookie] 清除会话 Cookie。
 * @property {(ip: string, key: string) => boolean} [checkLoginBlocked] 登录是否受限。
 * @property {(ip: string, key: string) => void} [recordLoginFailure] 记录登录失败。
 * @property {Array} [defaultCameras] 默认点位列表。
 * @property {{ inFlight: boolean }} [setupGuard] 首次安装守卫。
 * @property {Set<object>} [sseClients] SSE 客户端集合。
 */

/** 空导出，保持 ESM 模块语义（本文件仅承载文档注释）。 */
export {};
