import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SecretBox } from './secrets.mjs';
import { openStore } from './store.mjs';

function box() {
  return new SecretBox(crypto.randomBytes(32));
}

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-store-guard-'));
  t.after(() =>
    fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  );
  return openStore({ dataDir, secretBox: box() });
}

function insertUser(store, { id, username, role = 'admin', disabled = false }) {
  const salt = crypto.randomBytes(16).toString('hex');
  store.createUser({
    id,
    username,
    displayName: username,
    role,
    siteAdmin: false,
    salt,
    passwordHash: crypto.scryptSync('password-1', salt, 64).toString('hex'),
    disabled,
    tokenVersion: 0,
    createdAt: Date.now(),
  });
}

test('事务支持重入：内层事务并入外层，不抛「嵌套 BEGIN」', async (t) => {
  const store = await makeStore(t);
  assert.doesNotThrow(() => {
    store.transaction(() => {
      store.setMeta('outer', '1');
      store.transaction(() => {
        store.setMeta('inner', '2');
      });
    });
  });
  assert.equal(store.getMeta('outer'), '1');
  assert.equal(store.getMeta('inner'), '2');
  // 内层抛错应让外层整体回滚。
  assert.throws(() => {
    store.transaction(() => {
      store.setMeta('keep', '1');
      store.transaction(() => {
        store.setMeta('drop', '1');
        throw new Error('boom');
      });
    });
  }, /boom/);
  assert.equal(store.getMeta('keep'), null, '外层事务应回滚内层的写入');
  store.close();
});

test('管理员降级：并发式重复降级被事务内的计数拦住', async (t) => {
  const store = await makeStore(t);
  insertUser(store, { id: 'u1', username: 'admin1' });
  insertUser(store, { id: 'u2', username: 'admin2' });

  // 第一个降级成功（此时还有 2 个可用管理员）。
  const first = store.updateUserWithAdminGuard('u1', { role: 'viewer' });
  assert.equal(first.ok, true);
  assert.equal(first.user.role, 'viewer');

  // 只剩 1 个管理员时，再降级必须被拒绝。
  const second = store.updateUserWithAdminGuard('u2', { role: 'viewer' });
  assert.equal(second.ok, false);
  assert.match(second.error, /管理员/);
  assert.equal(store.getUser('u2').role, 'admin', '被拒绝的降级不应落库');
  store.close();
});

test('管理员停用与删除同样受「至少保留一个」保护', async (t) => {
  const store = await makeStore(t);
  insertUser(store, { id: 'u1', username: 'admin1' });
  insertUser(store, { id: 'u2', username: 'admin2' });

  // 先停用一个（此时还有 2 个可用管理员，允许）。
  const first = store.updateUserWithAdminGuard('u1', { disabled: true });
  assert.equal(first.ok, true);

  // 只剩 1 个可用管理员时，再停用/删除必须被拒绝。
  const disabled = store.updateUserWithAdminGuard('u2', { disabled: true });
  assert.equal(disabled.ok, false, '只剩一个管理员时不允许再停用');

  const deleted = store.deleteUserWithAdminGuard('u2');
  assert.equal(deleted.ok, false);
  assert.ok(store.getUser('u2'), '被拒绝的删除不应生效');
  store.close();
});

test('删除用户会清理指向该用户的孤儿引用（审计/事件/告警）', async (t) => {
  const store = await makeStore(t);
  insertUser(store, { id: 'u1', username: 'admin1', role: 'viewer' });
  insertUser(store, { id: 'u2', username: 'admin2' });
  store.recordAudit({
    user: { id: 'u1', username: 'admin1' },
    action: 'camera.create',
    targetType: 'camera',
    targetId: 'c1',
  });
  store.db
    .prepare(
      `INSERT INTO alarm_events (id, alarm_id, user_id, username, action, detail, created_at)
       VALUES ('e1', 'a1', 'u1', 'admin1', 'created', '', 1)`,
    )
    .run();

  assert.equal(store.deleteUser('u1'), true);
  assert.equal(store.getUser('u1'), null);
  assert.equal(
    store.db.prepare('SELECT user_id FROM audit_logs').get().user_id,
    null,
    '审计日志的 user_id 应被置空而不是悬挂',
  );
  assert.equal(
    store.db.prepare('SELECT user_id FROM alarm_events').get().user_id,
    null,
    '事件流水的 user_id 应被置空',
  );
  store.close();
});

test('删除站点会解绑通知渠道而不是留下悬挂引用', async (t) => {
  const store = await makeStore(t);
  const site = store.createSite({ id: 'site-1', name: '站点一', code: 'S1' });
  store.createNotifyChannel({
    id: 'ch1',
    siteId: site.id,
    kind: 'webhook',
    name: '渠道',
    url: 'https://example.com/hook',
    secret: 's',
  });
  assert.equal(store.deleteSite(site.id), true);
  const channel = store.getNotifyChannel('ch1');
  assert.ok(channel, '渠道本身不应被静默删除');
  assert.equal(channel.siteId, null, '渠道应解绑到空站点');
  store.close();
});

test('录像索引 limit 负值被夹取（SQLite 中 LIMIT -1 表示不限制）', async (t) => {
  const store = await makeStore(t);
  // 600 段：足以区分「不限制（600）」与「夹取到默认上限（500）」。
  const many = Array.from({ length: 600 }, (_item, index) => ({
    cameraId: 'cam-many',
    file: `cam-many/${index}.ts`,
    startedAt: index * 1000,
    endedAt: index * 1000 + 500,
    bytes: 100,
  }));
  store.upsertRecordingSegments(many);

  assert.equal(
    store.listRecordingSegments({ cameraId: 'cam-many', limit: -1 }).length,
    600,
    'limit=-1 应回退到默认上限（与不传 limit 一致），而不是「不限制」',
  );
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-many' }).length, 600);
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-many', limit: 10 }).length, 10);

  const pruned = store.pruneRecordingSegments({ limit: -1 });
  assert.equal(pruned.length, 500, 'limit=-1 不能触发无确认的全量淘汰');
  assert.equal(store.listRecordingSegments({ cameraId: 'cam-many' }).length, 100);
  store.close();
});

test('录像段批量写入统计新增与更新条数', async (t) => {
  const store = await makeStore(t);
  const first = store.upsertRecordingSegments([
    {
      cameraId: 'cam-1',
      file: 'cam-1/a.ts',
      startedAt: 1,
      endedAt: 2,
      bytes: 10,
    },
  ]);
  assert.deepEqual(first, { inserted: 1, updated: 0 });
  const second = store.upsertRecordingSegments([
    {
      cameraId: 'cam-1',
      file: 'cam-1/a.ts',
      startedAt: 1,
      endedAt: 2,
      bytes: 10,
    },
  ]);
  assert.deepEqual(second, { inserted: 0, updated: 0 }, '内容未变化不应计为更新');
  const third = store.upsertRecordingSegments([
    {
      cameraId: 'cam-1',
      file: 'cam-1/a.ts',
      startedAt: 1,
      endedAt: 2,
      bytes: 20,
    },
  ]);
  assert.deepEqual(third, { inserted: 0, updated: 1 });
  store.close();
});

test('误报解除保护：同窗口仍有其它告警时保留取证录像保护', async (t) => {
  const store = await makeStore(t);
  const createdAt = Date.now();
  const base = {
    cameraId: 'cam-1',
    cameraName: '点位',
    zone: '区域',
    level: 'fire',
    confidence: 90,
    hotspot: { x: 50, y: 50 },
    status: 'confirmed',
    createdAt,
  };
  const a1 = store.createAlarm({ ...base, id: 'a1' });
  // 同一相机的「活跃告警」有部分唯一索引（pending/confirmed），
  // 所以先把 a1 归档（移出索引），再创建同相机的 a2——
  // 这正是「窗口内还有其它未误报告警」的真实场景。
  store.updateAlarm(a1.id, { status: 'archived' });
  const a2 = store.createAlarm({ ...base, id: 'a2' });
  store.upsertRecordingSegments([
    {
      cameraId: 'cam-1',
      file: 'cam-1/x.ts',
      startedAt: createdAt - 1000,
      endedAt: createdAt + 1000,
      bytes: 10,
      protected: true,
    },
  ]);

  store.updateAlarm(a2.id, { status: 'false' });
  const stillProtected = store.db
    .prepare('SELECT protected FROM recording_segments WHERE file = ?')
    .get('cam-1/x.ts');
  assert.equal(stillProtected.protected, 1, '同窗口还有其它告警时不应解除保护');

  store.updateAlarm(a1.id, { status: 'false' });
  const released = store.db
    .prepare('SELECT protected FROM recording_segments WHERE file = ?')
    .get('cam-1/x.ts');
  assert.equal(released.protected, 0, '窗口内已无告警，应解除保护');
  store.close();
});

test('点位同源冲突：预检与写入同事务，唯一约束冲突归一化为 DUPLICATE_SOURCE', async (t) => {
  const store = await makeStore(t);
  const makeCamera = (name, sourceUrl) =>
    store.createCamera({ name, zone: 'A', protocol: 'hls', sourceUrl, enabled: true });

  const first = makeCamera('一号', 'http://example.com/live.m3u8');

  // 1) 常规预检命中同源指纹。
  assert.throws(
    () => makeCamera('二号', 'http://example.com/live.m3u8'),
    (error) => error.code === 'DUPLICATE_SOURCE',
  );

  // 2) 模拟竞态窗口：预检被绕过（预检返回 null），此时唯一索引兜底，
  //    抛出的错误仍须归一化为 DUPLICATE_SOURCE，而不是原始 SQL 报错。
  const originalLookup = store.cameraBySourceKey.bind(store);
  store.cameraBySourceKey = () => null;
  try {
    assert.throws(
      () => makeCamera('三号', 'http://example.com/live.m3u8'),
      (error) => error.code === 'DUPLICATE_SOURCE',
    );
  } finally {
    store.cameraBySourceKey = originalLookup;
  }
  assert.equal(
    store.listCameras().length,
    1,
    '冲突写入应整体回滚，不留半成品记录',
  );

  // 3) 更新到别的点位已占用的源地址，同样报 DUPLICATE_SOURCE 且不落库。
  const other = makeCamera('四号', 'http://example.com/other.m3u8');
  assert.throws(
    () => store.updateCamera(first.id, { sourceUrl: other.sourceUrl }),
    (error) => error.code === 'DUPLICATE_SOURCE',
  );
  assert.equal(store.getCamera(first.id).sourceUrl, 'http://example.com/live.m3u8');

  store.close();
});

test('录像段淘汰：默认跳过保护段，超配额时允许淘汰最旧保护段', async (t) => {
  const store = await makeStore(t);
  const now = Date.now();
  store.upsertRecordingSegments([
    {
      cameraId: 'cam-1',
      file: 'cam-1/old-protected.ts',
      startedAt: now - 10_000,
      endedAt: now - 5_000,
      bytes: 100,
      protected: true,
    },
    {
      cameraId: 'cam-1',
      file: 'cam-1/old-plain.ts',
      startedAt: now - 20_000,
      endedAt: now - 15_000,
      bytes: 100,
      protected: false,
    },
    {
      cameraId: 'cam-1',
      file: 'cam-1/recent.ts',
      startedAt: now - 1_000,
      endedAt: now,
      bytes: 100,
      protected: false,
    },
  ]);

  // 默认语义：保护段不参与淘汰。
  const pruned = store.pruneRecordingSegments({ before: now, limit: 100 });
  assert.deepEqual(pruned, ['cam-1/old-plain.ts']);
  const stillProtected = store.db
    .prepare('SELECT COUNT(*) AS count FROM recording_segments WHERE file = ?')
    .get('cam-1/old-protected.ts');
  assert.equal(stillProtected.count, 1, '默认不得淘汰受保护的取证段');

  // 超配额场景：允许淘汰最旧保护段，否则 recordingMaxBytes 对告警点位形同虚设。
  const withProtected = store.pruneRecordingSegments({
    before: now,
    limit: 100,
    includeProtected: true,
  });
  assert.ok(
    withProtected.includes('cam-1/old-protected.ts'),
    '超配额时应允许淘汰最旧保护段',
  );
  const remaining = store.db
    .prepare('SELECT file FROM recording_segments ORDER BY file')
    .all()
    .map((row) => row.file);
  assert.deepEqual(remaining, ['cam-1/recent.ts']);
  store.close();
});
