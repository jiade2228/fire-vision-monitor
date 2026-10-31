import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './store.mjs';

async function withStore(fn) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fire-audit-'));
  const store = await openStore({ dataDir });
  try {
    await fn(store);
  } finally {
    store.close();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('审计日志：按动作前缀/关键词/时间范围筛选与计数', async () => {
  await withStore(async (store) => {
    const now = Date.now();
    store.recordAudit({ action: 'auth.login', user: { username: 'alice' }, detail: '登录成功', ip: '10.0.0.1' });
    store.recordAudit({ action: 'camera.create', user: { username: 'alice' }, detail: '新增点位 CAM-01', ip: '10.0.0.1' });
    store.recordAudit({ action: 'camera.update', user: { username: 'bob' }, detail: '修改点位 CAM-02', ip: '10.0.0.2' });
    store.recordAudit({ action: 'demo.start', user: { username: 'alice' }, detail: '启动演示', ip: '10.0.0.1' });

    // 动作前缀
    const cameraLogs = store.listAuditFiltered({ action: 'camera' });
    assert.equal(cameraLogs.length, 2);
    assert.ok(cameraLogs.every((row) => row.action.startsWith('camera')));
    assert.equal(store.countAuditFiltered({ action: 'camera' }), 2);

    // 精确动作（前缀匹配的退化情形）
    const loginLogs = store.listAuditFiltered({ action: 'auth.login' });
    assert.equal(loginLogs.length, 1);

    // 关键词匹配 username / detail
    assert.equal(store.countAuditFiltered({ q: 'bob' }), 1);
    assert.equal(store.countAuditFiltered({ q: 'CAM-02' }), 1);
    assert.equal(store.countAuditFiltered({ q: '不存在的词' }), 0);

    // 时间范围：from 在未来 → 无记录；to 在过去 → 全部排除
    assert.equal(store.listAuditFiltered({ from: now + 60_000 }).length, 0);
    assert.equal(store.countAuditFiltered({ to: now - 60_000 }), 0);
    assert.equal(store.countAuditFiltered({ from: now - 60_000 }), 4);

    // 组合条件取交集
    assert.equal(store.countAuditFiltered({ action: 'camera', q: 'alice' }), 1);

    // 倒序 + 分页
    const page1 = store.listAuditFiltered({ limit: 2, offset: 0 });
    const page2 = store.listAuditFiltered({ limit: 2, offset: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.ok(page1[0].created_at >= page1[1].created_at, '应按时间倒序');
    assert.notEqual(page1[0].id, page2[0].id);

    // 上限钳制：limit 超过 200 也应安全
    assert.ok(store.listAuditFiltered({ limit: 9999 }).length <= 200);
  });
});
