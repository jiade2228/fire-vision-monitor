/**
 * 全局共享 JSDoc 类型定义（纯文档，无运行时代码）。
 *
 * 各模块通过 `import('./types.mjs').<Type>` 引用，为公共接口提供统一的数据
 * 结构描述。字段与 SQLite 表列一一对应（见 schema.mjs）：数据库行对象（row）
 * 使用下划线原始列名，本文件描述的是对外暴露的驼峰字段对象。
 */

/**
 * 用户账号（users 表）。
 *
 * @typedef {object} User
 * @property {string} id UUID。
 * @property {string} username 登录名（3-32 位字母数字下划线）。
 * @property {string|null} displayName 显示名。
 * @property {'admin'|'operator'|'viewer'} role 全局角色（schema CHECK 约束同此三值）。
 * @property {boolean} siteAdmin 是否站点管理员。
 * @property {string} salt 密码盐（hex）。
 * @property {string} passwordHash scrypt 摘要（hex，64 字节）。
 * @property {boolean} disabled 是否停用。
 * @property {number} tokenVersion 令牌版本（修改密码后递增使旧会话失效）。
 * @property {number} createdAt 创建时间（毫秒时间戳）。
 */

/**
 * 站点（多租户/分组，sites 表）。
 *
 * @typedef {object} Site
 * @property {string} id UUID。
 * @property {string} name 站点名称。
 * @property {string} code 站点编码（唯一）。
 * @property {number} createdAt 创建时间（毫秒时间戳）。
 */

/**
 * 视频点位（cameras 表）。
 *
 * @typedef {object} Camera
 * @property {string} id UUID。
 * @property {string} code 点位编码（唯一，自动递增生成）。
 * @property {string} name 点位名称。
 * @property {string} zone 区域/防区。
 * @property {'rtsp'|'hls'|'http'|'edge'} protocol 取流协议。
 * @property {string} sourceUrl 源地址（rtsp 加密存储，读取时解密）。
 * @property {string} sourceKey 源指纹（同源去重键）。
 * @property {string|null} siteId 所属站点。
 * @property {boolean} detectEnabled 是否启用服务端识别。
 * @property {'low'|'standard'|'high'|null} detectSensitivity 识别灵敏度。
 * @property {Array<{x:number,y:number,w:number,h:number}>} detectRoi 屏蔽区（0-100 百分比矩形，最多 8 个）。
 * @property {boolean} enabled 是否启用。
 * @property {number} createdAt 创建时间（毫秒时间戳）。
 * @property {number} updatedAt 更新时间（毫秒时间戳）。
 */

/**
 * 告警（alarms 表）。
 *
 * @typedef {object} Alarm
 * @property {string} id UUID。
 * @property {string} cameraId 点位 ID（点位删除后可能为孤儿 ID）。
 * @property {string} cameraName 告警时点位名称快照。
 * @property {string} zone 告警时防区快照。
 * @property {string|null} siteId 告警时所属站点快照。
 * @property {'fire'|'smoke'|'offline'|'camera_abnormal'} level 告警级别。
 * @property {number} confidence 识别置信度（0-100 整数百分值）。
 * @property {{x:number,y:number}} hotspot 热点坐标（0-100 百分比坐标）。
 * @property {string|null} snapshot 抓拍图接口路径（无文件时为 null）。
 * @property {string|null} snapshotFile 抓拍文件名。
 * @property {string|null} clip 短视频接口路径（无文件时为 null）。
 * @property {string|null} clipFile 短视频文件名。
 * @property {'pending'|'confirmed'|'false'|'archived'} status 处置状态。
 * @property {string} note 处置备注。
 * @property {boolean[]} steps 处置步骤勾选（路由层最多接受 16 项）。
 * @property {number} createdAt 告警时间（毫秒时间戳）。
 * @property {number} updatedAt 更新时间（毫秒时间戳）。
 * @property {number|null} confirmedAt 确认时间。
 * @property {number|null} falseAt 误报时间。
 * @property {number|null} archivedAt 归档时间。
 * @property {number|null} closedAt 关闭时间（归档/误报二者取一）。
 * @property {string|null} createdBy 创建人。
 * @property {string|null} updatedBy 最后处置人。
 */

/**
 * 告警事件流水（alarm_events 表）。
 *
 * @typedef {object} AlarmEvent
 * @property {string} id UUID。
 * @property {string} alarmId 所属告警。
 * @property {string|null} userId 操作人 ID。
 * @property {string|null} username 操作人名称。
 * @property {string} action 动作（created/confirmed/false/archived/escalated/recovered…）。
 * @property {string} detail 动作描述（最长 500 字）。
 * @property {number} createdAt 时间（毫秒时间戳）。
 */

/**
 * 通知渠道（notify_channels 表；url/secret 加密存储，读取时解密）。
 *
 * @typedef {object} NotifyChannel
 * @property {string} id UUID。
 * @property {string|null} siteId 绑定站点（null 为全局渠道）。
 * @property {'wecom'|'webhook'|'dingtalk'} kind 渠道类型。
 * @property {string} name 渠道名称。
 * @property {string} url 推送地址。
 * @property {string} secret 签名密钥（无则为空串）。
 * @property {boolean} enabled 是否启用（连续失败会自动停用）。
 * @property {string|null} templateId 绑定文案模板 ID。
 * @property {string|null} templateBody 模板正文（未绑定模板为 null）。
 * @property {string} credentialError 凭据解密失败原因（正常为空串；非空表示推送会被跳过）。
 * @property {number} createdAt 创建时间（毫秒时间戳）。
 * @property {number} updatedAt 更新时间（毫秒时间戳）。
 */

/**
 * 通知文案模板（notification_templates 表）。
 *
 * @typedef {object} NotificationTemplate
 * @property {string} id UUID。
 * @property {string} name 模板名称。
 * @property {string} body 模板正文（支持 {占位符}）。
 * @property {boolean} builtin 是否内置模板（内置不可删除）。
 * @property {number} createdAt 创建时间（毫秒时间戳）。
 * @property {number} updatedAt 更新时间（毫秒时间戳）。
 */

/**
 * 审计日志（audit_logs 表）。
 *
 * @typedef {object} AuditLogEntry
 * @property {string} id UUID。
 * @property {string|null} userId 操作人 ID。
 * @property {string|null} username 操作人名称。
 * @property {string} action 动作（点分前缀，如 camera.create）。
 * @property {string|null} targetType 目标类型（user/camera/alarm/site/notify…）。
 * @property {string|null} targetId 目标 ID。
 * @property {string} detail 详情（最长 1000 字）。
 * @property {string} ip 来源 IP。
 * @property {number} createdAt 时间（毫秒时间戳）。
 */

/**
 * 库内统计（Store.stats() 返回值）。
 *
 * @typedef {object} StoreStats
 * @property {number} users 用户总数。
 * @property {number} cameras 点位总数。
 * @property {number} activeAlarms 未处置告警数（pending+confirmed）。
 * @property {number} alarms 告警总数。
 */

/** 空导出，保持 ESM 模块语义（本文件仅承载文档注释）。 */
export {};
