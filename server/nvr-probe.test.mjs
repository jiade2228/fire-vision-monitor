import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProbeCases, loadPlan, resultRow, toCsv } from './nvr-probe.mjs';

test('probe plan expands channels and strips secrets from CSV output', () => {
  process.env.TEST_NVR_PASS = 'p@ss:word';
  const plan = loadPlan({
    devices: [
      {
        name: 'Hikvision Lab',
        vendorId: 'hikvision',
        host: '192.168.1.64',
        username: 'admin',
        passwordEnv: 'TEST_NVR_PASS',
        startChannel: 1,
        count: 2,
        streams: ['main', 'sub'],
      },
    ],
  });
  const cases = buildProbeCases(plan);
  assert.equal(cases.length, 4);
  assert.deepEqual(
    cases.map((item) => `${item.channel}:${item.stream}`),
    ['1:main', '1:sub', '2:main', '2:sub'],
  );
  assert.ok(cases[0].sourceUrl.includes('/Streaming/Channels/101'));
  const csv = toCsv([
    resultRow(cases[0], {
      ok: true,
      latencyMs: 300,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: '25/1',
    }),
  ]);
  assert.equal(csv.includes('p@ss:word'), false);
  assert.equal(csv.includes('192.168.1.64'), false);
  assert.match(csv, /PASS|true/);
});

test('single-channel camera produces one probe case', () => {
  process.env.TEST_NVR_PASS = 'secret';
  const plan = loadPlan({
    devices: [
      {
        name: 'Axis Lab',
        vendorId: 'axis',
        host: '192.168.1.90',
        username: 'root',
        passwordEnv: 'TEST_NVR_PASS',
        count: 8,
        streams: ['main', 'sub'],
      },
    ],
  });
  const cases = buildProbeCases(plan);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].channel, 1);
  assert.equal(cases[0].stream, 'main');
});

test('invalid vendor and missing password are rejected', () => {
  assert.throws(
    () =>
      loadPlan({
        devices: [
          {
            vendorId: 'unknown',
            host: '192.168.1.1',
            username: 'admin',
            password: 'x',
          },
        ],
      }),
    /不受支持/,
  );
  assert.throws(
    () =>
      loadPlan({
        devices: [
          {
            vendorId: 'hikvision',
            host: '192.168.1.1',
            username: 'admin',
            passwordEnv: 'MISSING_NVR_ENV',
          },
        ],
      }),
    /缺少密码/,
  );
});
