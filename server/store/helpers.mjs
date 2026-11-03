import { bool, jsonSteps } from '../schema.mjs';

export function parseRoi(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((rect) =>
      rect && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(Number(rect[key]))),
    )
    .slice(0, 8)
    .map((rect) => ({
      x: Math.min(100, Math.max(0, Number(rect.x))),
      y: Math.min(100, Math.max(0, Number(rect.y))),
      w: Math.min(100, Math.max(0, Number(rect.w))),
      h: Math.min(100, Math.max(0, Number(rect.h))),
    }));
}

export function serializeRoi(roi) {
  const list = parseRoi(Array.isArray(roi) ? JSON.stringify(roi) : roi);
  return list.length ? JSON.stringify(list) : null;
}

export function cameraRowToObject(row, secretBox) {
  if (!row) return null;
  let sourceUrl = row.source_url ?? '';
  if (row.protocol === 'rtsp' && sourceUrl.startsWith('enc:v1:')) {
    sourceUrl = secretBox.decrypt(sourceUrl);
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    zone: row.zone,
    protocol: row.protocol,
    sourceUrl,
    sourceKey: row.source_key,
    siteId: row.site_id ?? null,
    detectEnabled: row.detect_enabled === undefined ? true : bool(row.detect_enabled),
    detectSensitivity: row.detect_sensitivity ?? null,
    detectRoi: parseRoi(row.detect_roi),
    enabled: bool(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function userRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    siteAdmin: bool(row.is_site_admin),
    salt: row.salt,
    passwordHash: row.password_hash,
    disabled: bool(row.disabled),
    tokenVersion: row.token_version,
    createdAt: row.created_at,
  };
}

export function alarmRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    cameraId: row.camera_id,
    cameraName: row.camera_name,
    zone: row.zone,
    siteId: row.site_id ?? null,
    level: row.level,
    confidence: row.confidence,
    hotspot: { x: row.hotspot_x, y: row.hotspot_y },
    snapshot: row.snapshot_file ? `/api/alarms/${row.id}/snapshot` : null,
    snapshotFile: row.snapshot_file,
    clip: row.clip_file ? `/api/alarms/${row.id}/clip` : null,
    clipFile: row.clip_file,
    status: row.status,
    note: row.note,
    steps: jsonSteps(row.steps_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    falseAt: row.false_at,
    archivedAt: row.archived_at,
    closedAt: row.archived_at ?? row.false_at ?? null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}
