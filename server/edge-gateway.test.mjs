import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEdgeConfig } from './edge-gateway.mjs';

test('edge gateway config resolves environment secrets without exposing them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-edge-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'edge.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      centralUrl: 'ws://127.0.0.1:4173/gateway',
      gatewayId: 'site-a',
      name: '现场 A',
      tokenEnv: 'TEST_EDGE_TOKEN',
      cameras: {
        ch01: {
          label: '一号仓库',
          sourceUrlEnv: 'TEST_EDGE_RTSP',
        },
      },
    }),
  );
  process.env.TEST_EDGE_TOKEN = '0123456789abcdef0123456789abcdef';
  process.env.TEST_EDGE_RTSP =
    'rtsp://admin:secret@192.168.1.10:554/Streaming/Channels/101';
  const config = await loadEdgeConfig(configPath);
  assert.equal(config.gatewayId, 'site-a');
  assert.equal(config.cameras.get('ch01').label, '一号仓库');
  assert.ok(config.cameras.get('ch01').sourceUrl.includes('secret'));
  assert.ok(config.dataDir.endsWith('edge-data'));

  await assert.rejects(
    () =>
      loadEdgeConfig(
        path.join(dir, 'missing.json'),
      ),
    /ENOENT/,
  );
});
