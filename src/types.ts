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
export type AlarmStatus = 'pending' | 'confirmed' | 'false' | 'archived';
export type CameraStatus = 'normal' | 'smoke' | 'fire';
export type ViewKey = 'monitor' | 'alarms' | 'records';
export type AlarmFilter = 'all' | 'pending' | 'active' | 'closed';
export type ToastKind = 'info' | 'danger' | 'ok';

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
  snapshot?: string;
  clip?: string | null;
  createdAt: number;
  status: AlarmStatus;
  confirmedAt?: number;
  closedAt?: number;
  steps: boolean[];
  note?: string;
}

export interface AlarmHandlers {
  onToggle: (id: string) => void;
  onConfirm: (id: string) => void;
  onFalse: (id: string) => void;
  onToggleStep: (id: string, index: number) => void;
  onArchive: (id: string) => void;
  onNoteChange: (id: string, note: string) => void;
}

export interface ToastState {
  text: string;
  kind: ToastKind;
}