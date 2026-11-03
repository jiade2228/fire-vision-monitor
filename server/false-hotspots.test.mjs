import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './store.mjs';
import { SecretBox } from './secrets.mjs';

test('listFalseAlarmCounts：按点位聚合误报、站点过滤、窗口期过滤', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-hotspots-'));
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const actor = { id: null, username: 'tester' };
  const cameraA = store.createCamera({ name: 'A 点', zone: '甲', protocol: 'none', sourceUrl: '', enabled: true });
  const cameraB = store.createCamera({ name: 'B 点', zone: '乙', protocol: 'none', sourceUrl: '', enabled: true });

  const create = (camera, level = 'fire') =>
    store.createAlarm({
      id: crypto.randomUUID(),
      cameraId: camera.id,
      cameraName: camera.name,
      zone: camera.zone,
      level,
      confidence: 80,
      hotspot: { x: 50, y: 50 },
      actor,
    });
  const markFalse = (alarm) =>
    store.updateAlarm(alarm.id, { status: 'false', falseAt: Date.now() }, actor);

  // A 点 3 次误报、B 点 1 次误报、另有 1 条未处置（不计入）。
  for (let i = 0; i < 3; i += 1) markFalse(create(cameraA));
  markFalse(create(cameraB));
  create(cameraB);

  const hotspots = store.listFalseAlarmCounts({ days: 7 });
  assert.equal(hotspots.length, 2);
  assert.equal(hotspots[0].cameraId, cameraA.id);
  assert.equal(Number(hotspots[0].count), 3);
  assert.equal(Number(hotspots[1].count), 1);
  assert.equal(hotspots[0].cameraName, 'A 点');

  // 站点过滤：默认站点包含全部；传入空数组时无结果。
  assert.equal(store.listFalseAlarmCounts({ days: 7, siteIds: [] }).length, 0);
  const all = store.listFalseAlarmCounts({ days: 7, siteIds: null });
  assert.equal(all.length, 2);

  // 窗口期：1 天窗口仍包含（刚创建）；0 天边界由 days>=1 保证。
  assert.equal(store.listFalseAlarmCounts({ days: 1 }).length, 2);
});
