export interface Camera {
  id: string;
  code: string;
  name: string;
  zone: string;
}

export type CameraSource =
  | { kind: 'file'; url: string; label: string }
  | {
      kind: 'remote';
      url: string;
      protocol: 'hls' | 'http';
      label: string;
    };

export type AlarmLevel = 'fire' | 'smoke' | 'offline' | 'camera_abnormal';
export type DetectionSensitivity = 'low' | 'standard' | 'high';
/**
 * 告警状态：对外契约为 pending / confirmed / closed；
 * false（误报）与 archived 为历史/兼容值，服务端已统一输出 closed。
 */
export type AlarmStatus = 'pending' | 'confirmed' | 'false' | 'archived' | 'closed';
export type CameraStatus = 'normal' | 'smoke' | 'fire';
export type ViewKey = 'monitor' | 'alarms' | 'records';
export type AlarmFilter = 'all' | 'pending' | 'active' | 'closed';
export type ToastKind = 'info' | 'danger' | 'ok' | 'warn';

export interface DetectionResult {
  level: AlarmLevel;
  confidence: number;
  hotspot: { x: number; y: number };
}

export interface Alarm {
  id: string;
  cameraId: string;
  cameraName: string;
  zone: string;
  siteId?: string | null;
  level: AlarmLevel;
  confidence: number;
  hotspot: { x: number; y: number };
  /** 抓拍图接口路径；服务端无文件时返回 null。 */
  snapshot?: string | null;
  clip?: string | null;
  createdAt: number;
  status: AlarmStatus;
  confirmedAt?: number;
  closedAt?: number;
  steps: boolean[];
  /** 处置备注；服务端无备注时返回 null。 */
  note?: string | null;
}

export interface AlarmHandlers {
  onToggle: (id: string) => void;
  onConfirm: (id: string) => void;
  onFalse: (id: string) => void;
  onToggleStep: (id: string, index: number) => void;
  onArchive: (id: string) => void;
  /** 保存备注；resolve(true) 表示保存成功（失败时调用方应保留草稿）。 */
  onNoteChange: (id: string, note: string) => Promise<boolean>;
}

export interface ToastState {
  text: string;
  kind: ToastKind;
}