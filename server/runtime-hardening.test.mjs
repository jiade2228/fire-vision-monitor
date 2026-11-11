import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openStore } from './store.mjs';
import { SecretBox } from './secrets.mjs';
import { reconcileRecordingSegments } from './recording-index.mjs';
import { createGuards } from './http/guards.mjs';
import { CAPABILITIES } from './auth/roles.mjs';

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-hardening-'));
  const store = await openStore({
    dataDir,
    secretBox: new SecretBox(crypto.randomBytes(32)),
  });
  t.after(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { store, dataDir };
}

function makeUser(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    displayName: '测试用户',
    role: 'viewer',
    siteAdmin: false,
    salt: 's',
    passwordHash: 'h',
    disabled: false,
    tokenVersion: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

/** 构造一个最小 Express-like res，记录 status 与 body。 */
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test('增量对账：第二次对账不再写库，变化段能被识别', async (t) => {
  const { store, dataDir } = await makeStore(t);
  const root = path.join(dataDir, 'continuous');
  const dayDir = path.join(root, 'cam', '20261111');
  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(path.join(dayDir, '000000.ts'), 'x'.repeat(100));
  await fs.writeFile(path.join(dayDir, '000100.ts'), 'y'.repeat(200));

  const opts = { segmentSeconds: 60 };
  const first = await reconcileRecordingSegments(store, root, opts);
  assert.equal(first.scanned, 2);
  assert.equal(first.inserted, 2, '首次应新增 2 段');

  // 文件没变：不应产生任何写入。
  const second = await reconcileRecordingSegments(store, root, opts);
  assert.equal(second.scanned, 2, 'scanned 仍应报告扫描总数');
  assert.equal(second.inserted, 0, '重复对账不应重复插入');
  assert.equal(second.updated, 0, '未变化的段不应被 upsert');

  // 改一个文件大小：只应更新这一段。
  await fs.writeFile(path.join(dayDir, '000000.ts'), 'z'.repeat(333));
  const third = await reconcileRecordingSegments(store, root, opts);
  assert.equal(third.inserted, 0);
  assert.equal(third.updated, 1, '只应更新发生变化的那一段');
});

test('增量对账：删除文件后孤儿记录被清理', async (t) => {
  const { store, dataDir } = await makeStore(t);
  const root = path.join(dataDir, 'continuous');
  const dayDir = path.join(root, 'cam', '20261111');
  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(path.join(dayDir, '000000.ts'), 'a'.repeat(50));
  await fs.writeFile(path.join(dayDir, '000100.ts'), 'b'.repeat(60));
  const first = await reconcileRecordingSegments(store, root, { segmentSeconds: 60 });
  assert.equal(first.inserted, 2);

  // 只删一个文件：目录仍非空，孤儿记录应被清理。
  // （目录整体变空时代码有意不清空索引，避免采集重启/挂载切换误判「录像全部丢失」。）
  await fs.rm(path.join(dayDir, '000000.ts'));
  const second = await reconcileRecordingSegments(store, root, { segmentSeconds: 60 });
  assert.equal(second.orphansRemoved, 1);
  assert.equal(store.allRecordingSegmentFiles().length, 1);
});

test('权限修订号：账号与站点授权变更后递增（SSE 缓存据此失效）', async (t) => {
  const { store } = await makeStore(t);
  assert.equal(store.authRevision, 0);
  const user = store.createUser(makeUser());
  assert.equal(store.authRevision, 1, '创建账号应递增');

  store.updateUser(user.id, { displayName: '改名' });
  assert.equal(store.authRevision, 2, '资料变更应递增（权限可能随之变化）');

  store.bumpTokenVersion(user.id);
  assert.equal(store.authRevision, 3, '会话版本变更应递增');

  const site = store.createSite({
    id: crypto.randomUUID(), code: 'S1', name: '站点一', createdAt: Date.now(),
  });
  store.setUserSites(user.id, [site.id]);
  assert.equal(store.authRevision, 4, '站点授权变更必须递增，否则撤权不会实时生效');

  store.deleteUser(user.id);
  assert.equal(store.authRevision, 5, '删除账号应递增');
});

test('统一错误体：requireAuth / requireRole / requireManager 均带 code', () => {
  const store = { siteMemberSiteIds: () => [], defaultSiteId: 'default' };
  const guards = createGuards(store, () => null);

  // requireAuth：未登录
  let res = makeRes();
  let nextCalled = false;
  guards.requireAuth({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, '请先登录', '对外文案保持不变');
  assert.equal(res.body.code, 'unauthenticated');
  assert.equal(nextCalled, false);

  // requireRole：角色不匹配
  res = makeRes();
  guards.requireRole('admin')({ user: { role: 'viewer' } }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, '当前账号没有此操作权限');
  assert.equal(res.body.code, 'forbidden');

  // requireRole：未登录
  res = makeRes();
  guards.requireRole('admin')({ user: null }, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'unauthenticated');

  // requireManager：文案保持既有值，只补 code
  res = makeRes();
  guards.requireManager({ user: { role: 'viewer', siteAdmin: false } }, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, '当前账号没有管理权限');
  assert.equal(res.body.code, 'forbidden');

  // requireCapability：站点管理员不得访问 GLOBAL_ADMIN
  res = makeRes();
  guards.requireCapability(CAPABILITIES.GLOBAL_ADMIN)(
    { user: { role: 'operator', siteAdmin: true } }, res, () => {},
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'forbidden');
});

test('审计 action 索引存在且 COUNT 走覆盖索引', async (t) => {
  const { store } = await makeStore(t);
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);
  for (const expected of [
    'idx_audit_action_created',
    'idx_audit_user',
    'idx_alarm_event_user',
    'idx_alarm_created_by',
    'idx_alarm_updated_by',
  ]) {
    assert.ok(names.includes(expected), `应存在索引 ${expected}`);
  }
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) AS total FROM audit_logs WHERE action LIKE 'camera%'",
    )
    .all()
    .map((row) => row.detail)
    .join(' | ');
  assert.match(plan, /idx_audit_action_created/, `COUNT 应走覆盖索引，实际计划：${plan}`);
});

test('内置通知模板不可删除（JSDoc 契约与实现一致）', async (t) => {
  const { store } = await makeStore(t);
  const builtin = store.listNotificationTemplates().find((item) => item.builtin);
  assert.ok(builtin, 'V6 迁移应播种内置模板');
  assert.equal(store.deleteNotificationTemplate(builtin.id), false, '内置模板删除必须被拒绝');
  assert.ok(store.listNotificationTemplates().some((item) => item.id === builtin.id));
  // 普通模板仍可删除。
  const custom = store.createNotificationTemplate({ name: '自定义', body: 'test {level}' });
  assert.equal(store.deleteNotificationTemplate(custom.id), true);
});

test('通知去重：发送成功不重投，失败后允许重试', async (t) => {
  const { store } = await makeStore(t);
  const args = ['alarm-1', 'channel-1', 'escalated'];
  assert.equal(store.claimNotification(...args), true, '首次允许');
  assert.equal(store.claimNotification(...args), false, 'pending 期间不可重复');
  store.finishNotification(...args, { status: 'sent' });
  assert.equal(store.claimNotification(...args), false, '已送达不得重投（幂等）');

  const failedArgs = ['alarm-2', 'channel-1', 'escalated'];
  assert.equal(store.claimNotification(...failedArgs), true);
  store.finishNotification(...failedArgs, { status: 'failed', error: 'timeout' });
  assert.equal(store.claimNotification(...failedArgs), true, '失败后应允许重试');
  assert.equal(store.claimNotification(...failedArgs), false, '重试中不可重复 claim');
});

test('deleteSite 递增权限修订号（SSE 缓存失效）', async (t) => {
  const { store } = await makeStore(t);
  const site = store.createSite({
    id: crypto.randomUUID(), code: 'TMP', name: '临时站点', createdAt: Date.now(),
  });
  const before = store.authRevision;
  assert.equal(store.deleteSite(site.id), true);
  assert.equal(store.authRevision, before + 1, '删站点必须让 SSE 权限缓存失效');
});

test('登录限流：全局失败维度不依赖 IP/用户名', async (t) => {
  // 通过 createSession 暴露的守卫函数验证第四维（不依赖部署配置）。
  const { createSession } = await import('./http/session.mjs');
  const metrics = { loginFailures: 0 };
  const session = createSession({
    store: {},
    sessionSecret: 'x'.repeat(32),
    sessionCookie: 'fv_test',
    sessionLifetimeSeconds: 3600,
    metrics,
    parseCookies: () => ({}),
  });
  // 不同 IP、不同用户名各尝试少量次数，前三维都未达阈值。
  for (let i = 0; i < 20; i += 1) {
    session.recordLoginFailure(`10.0.0.${i}`, `user-${i}`);
  }
  assert.equal(session.checkLoginBlocked('10.0.99.99', 'fresh-user'), false);
  // 继续累积到全局阈值后，全站进入冷却 —— 与 IP/用户名无关。
  for (let i = 0; i < 480; i += 1) {
    session.recordLoginFailure(`10.1.${Math.floor(i / 256)}.${i % 256}`, `bulk-${i}`);
  }
  assert.equal(session.checkLoginBlocked('203.0.113.9', 'never-seen'), true);
});

test('删除点位：有未处置告警时拒绝，清空后允许并清理索引', async (t) => {
  const { store } = await makeStore(t);
  const siteId = store.defaultSiteId;
  const camera = store.createCamera({
    name: '待删点位', zone: 'A', protocol: 'none', sourceUrl: '', enabled: true, siteId,
  });
  // 建一条 pending 告警
  const alarm = store.createAlarm({
    id: crypto.randomUUID(),
    cameraId: camera.id,
    cameraName: camera.name,
    zone: camera.zone,
    siteId,
    level: 'fire',
    confidence: 90,
    hotspot: { x: 50, y: 50 },
  });
  assert.equal(store.countOpenAlarmsByCamera(camera.id), 1, '应统计到 1 条未处置告警');

  // 处置后归零
  store.updateAlarm(alarm.id, { status: 'confirmed' });
  assert.equal(store.countOpenAlarmsByCamera(camera.id), 1, 'confirmed 仍属未处置');
  store.updateAlarm(alarm.id, { status: 'archived' });
  assert.equal(store.countOpenAlarmsByCamera(camera.id), 0, '归档后不应再计入');

  // 录像索引按点位清理
  store.upsertRecordingSegments([
    {
      id: 'seg-1', cameraId: camera.id, file: `${camera.id}/20261111/000000.ts`,
      startedAt: Date.now(), endedAt: Date.now() + 60_000, bytes: 1024, protected: false,
    },
  ]);
  const cleaned = store.deleteRecordingSegmentsByCamera(camera.id);
  assert.equal(cleaned.deleted, 1, '应清理该点位的录像索引');
  assert.equal(store.allRecordingSegmentFiles().length, 0);
});
