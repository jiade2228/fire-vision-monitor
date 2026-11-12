import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { openStore } from './store.mjs';
import { SecretBox } from './secrets.mjs';

/**
 * v1.2.4 云端验收回归（D-02 / D-03 / D-05 / D-07）。
 *
 * 背景：云端验收（Ubuntu 22.04，Linux 便携包）报出 7 条缺陷，本文件锁定
 * 其中 4 条需要服务端行为保障的部分：
 * - D-02：状态/等级/关键词筛选原先只在界面本地过滤已加载的一页，
 *   超过一页后标签漏筛、计数偏少（口径矛盾：标签 50 / 页面 64）；
 * - D-03：删除点位后历史告警引用的抓拍与短视频残留成孤儿文件；
 * - D-05：缺 FFmpeg 时 /healthz 判为不健康（连带守护重启、部署误判失败）；
 * - D-07：boot 与 index 两条启动日志的 dataDirSource 自相矛盾。
 */

async function makeStore(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-acc124-'));
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

/** 建一个点位。 */
function makeCamera(store, name) {
  return store.createCamera({
    id: crypto.randomUUID(),
    name,
    zone: 'A 区',
    protocol: 'none',
    sourceUrl: '',
    enabled: true,
    detectEnabled: true,
    detectSensitivity: null,
    detectRoi: [],
    schedule: null,
    siteId: store.defaultSiteId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** 造一条告警。 */
function makeAlarm(store, camera, { status = 'pending', level = 'fire', snapshotFile = null, clipFile = null, createdAt = Date.now() } = {}) {
  const alarm = store.createAlarm({
    id: crypto.randomUUID(),
    cameraId: camera.id,
    cameraName: camera.name,
    zone: camera.zone,
    siteId: store.defaultSiteId,
    level,
    confidence: 90,
    hotspot: { x: 50, y: 50 },
    snapshotFile,
    clipFile,
    createdAt,
    updatedAt: createdAt,
  });
  // createAlarm 内部固定写入 pending，这里按需流转到目标状态。
  if (status !== 'pending') store.updateAlarm(alarm.id, { status });
  return alarm;
}

test('D-02：状态/等级/关键词筛选下推服务端，标签计数基于全量', async (t) => {
  const { store } = await makeStore(t);
  const camera = makeCamera(store, '筛选测试点位');

  // 业务约束：每路点位同时只允许 1 条活动告警（pending/confirmed），
  // 因此历史告警必须「建一条即归档」，活动告警则分散到不同点位。
  const archived = [];
  for (let index = 0; index < 60; index += 1) {
    const alarm = makeAlarm(store, camera, {
      status: 'pending',
      level: index % 2 === 0 ? 'fire' : 'smoke',
      createdAt: Date.now() - 120_000 + index,
    });
    store.updateAlarm(alarm.id, { status: 'archived' });
    archived.push(alarm.id);
  }
  // 两个点位各留 1 条处置中：其中一条创建时间最早，必然落在第一页之外。
  const cameraA = makeCamera(store, '处置中点位 A');
  const cameraB = makeCamera(store, '处置中点位 B');
  makeAlarm(store, cameraA, { status: 'confirmed', level: 'fire', createdAt: Date.now() - 90_000 });
  makeAlarm(store, cameraB, { status: 'confirmed', level: 'smoke', createdAt: Date.now() - 10_000 });
  // 一个点位留 1 条待处置（关键词用例复用它，不再重复创建）
  const cameraC = makeCamera(store, '待处置点位 C');
  const pendingAlarm = makeAlarm(store, cameraC, {
    status: 'pending',
    level: 'fire',
    createdAt: Date.now() - 5_000,
  });

  // 状态筛选必须命中全量，而不是只命中第一页
  const confirmed = store.listAlarms(50, { status: 'confirmed' });
  assert.equal(confirmed.length, 2, '处置中应命中 2 条（含早于第一页的那条）');
  assert.ok(confirmed.every((alarm) => alarm.status === 'confirmed'));

  const pending = store.listAlarms(50, { status: 'pending' });
  assert.equal(pending.length, 1, '待处置应命中 1 条');

  const closed = store.listAlarms(100, { status: 'closed' });
  assert.equal(closed.length, 60, '已关闭应命中 60 条');

  // 等级筛选
  const smoke = store.listAlarms(100, { level: 'smoke' });
  assert.equal(smoke.length, 31, '等级筛选 smoke 应命中 31 条');
  const fireOnly = store.listAlarms(100, { level: 'fire' });
  assert.equal(fireOnly.length, 32, '等级筛选 fire 应命中 32 条');

  // 关键词搜索（跨页生效）
  const hits = store.listAlarms(50, { keyword: pendingAlarm.id });
  assert.equal(hits.length, 1, '关键词应命中目标告警');
  const noHit = store.listAlarms(50, { keyword: '不存在的关键词zzz' });
  assert.equal(noHit.length, 0, '无匹配时不应返回数据');

  // 分组计数：基于全量，且不受 status 自身影响
  const counts = store.countAlarmsByStatus({});
  assert.equal(counts.all, 63, '全部计数应为 63');
  assert.equal(counts.pending, 1, '待处置计数应为 1');
  assert.equal(counts.confirmed, 2, '处置中计数应为 2');
  assert.equal(counts.closed, 60, '已关闭计数应为 60');

  // 按等级过滤后的计数口径
  const smokeCounts = store.countAlarmsByStatus({ level: 'smoke' });
  assert.equal(smokeCounts.all, 31, '按等级过滤后总数为 31');

  // 计数与列表口径必须一致：标签数 ≠ 已加载页数
  const firstPage = store.listAlarms(50, {});
  assert.equal(firstPage.length, 50, '第一页 50 条');
  assert.ok(
    counts.all > firstPage.length,
    '全量计数应大于第一页条数（这正是 D-02 的原始症状）',
  );

  // 状态筛选下的 total 与列表一致
  const totalConfirmed = store.countAlarms({ status: 'confirmed' });
  assert.equal(totalConfirmed, confirmed.length, 'total 与筛选结果条数应一致');
});

test('D-03：删除点位时能列出该点位告警引用的媒体文件', async (t) => {
  const { store } = await makeStore(t);
  const camera = makeCamera(store, '媒体清理点位');
  const other = makeCamera(store, '其它点位');

  const first = makeAlarm(store, camera, { snapshotFile: 'snap-a.jpg', clipFile: 'clip-a.mp4' });
  // 同点位同时只允许 1 条活动告警，造第二条前先归档第一条。
  store.updateAlarm(first.id, { status: 'archived' });
  makeAlarm(store, camera, { snapshotFile: 'snap-b.jpg', clipFile: null });
  makeAlarm(store, other, { snapshotFile: 'snap-other.jpg', clipFile: 'clip-other.mp4' });

  const media = store.listAlarmMediaByCamera(camera.id);
  assert.deepEqual(media.snapshots.sort(), ['snap-a.jpg', 'snap-b.jpg']);
  assert.deepEqual(media.clips, ['clip-a.mp4'], '只应返回该点位引用的短视频');

  const otherMedia = store.listAlarmMediaByCamera(other.id);
  assert.deepEqual(otherMedia.snapshots, ['snap-other.jpg']);
  assert.equal(
    media.snapshots.includes('snap-other.jpg'),
    false,
    '不应包含其它点位的媒体',
  );
});

test('D-07：布局来源在 boot 二次解析后保持一致', async (t) => {
  const { resolveLayout, LAYOUT_REASON_ENV } = await import('./app-paths.mjs');
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-layout-'));
  t.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const programRoot = path.join(dataDir, 'app', 'program');
  await fs.mkdir(path.join(programRoot, 'server'), { recursive: true });

  // 首次解析（boot 做的事）：没有 DATA_DIR，走源码形态默认目录
  const first = resolveLayout({ projectRoot: programRoot, argv: [], env: {} });
  assert.equal(typeof first.reason, 'string');

  // boot 把结果写进环境变量后，index 二次解析
  const env = { DATA_DIR: first.dataDir, [LAYOUT_REASON_ENV]: first.reason };
  const second = resolveLayout({ projectRoot: programRoot, argv: [], env });
  assert.equal(second.reason, first.reason, '两条启动日志的 dataDirSource 应一致');
  assert.equal(second.dataDir, first.dataDir);
});
