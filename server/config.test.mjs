import test from 'node:test';
import assert from 'node:assert/strict';

import {
  envBoolean,
  envNumber,
  normalizeClock,
  normalizePort,
} from './config.mjs';

/** 临时设置环境变量并在测试后恢复。 */
function withEnv(t, values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return fn();
}

test('envNumber：未设置/空串/非数字一律回退默认值并告警', (t) => {
  const warnings = [];
  const opts = { defaultValue: 180, min: 1, onWarn: (m) => warnings.push(m) };
  withEnv(t, { CFG_A: undefined }, () => {
    assert.equal(envNumber('CFG_A', opts), 180);
  });
  withEnv(t, { CFG_A: '' }, () => {
    assert.equal(envNumber('CFG_A', opts), 180);
  });
  withEnv(t, { CFG_A: 'abc' }, () => {
    assert.equal(envNumber('CFG_A', opts), 180);
  });
  withEnv(t, { CFG_A: 'Infinity' }, () => {
    assert.equal(envNumber('CFG_A', opts), 180);
  });
  assert.equal(warnings.length, 2, '非数字与 Infinity 应各告警一次');
});

test('envNumber：负数不再静默生效（防止删光告警的保留策略）', (t) => {
  withEnv(t, { CFG_B: '-5' }, () => {
    assert.equal(
      envNumber('CFG_B', { defaultValue: 180, min: 1, max: 3650 }),
      1,
      '-5 必须被钳到下界 1，而不是原样透传',
    );
  });
  withEnv(t, { CFG_B: '-1' }, () => {
    assert.equal(envNumber('CFG_B', { defaultValue: 60_000, min: 1_000 }), 1_000);
  });
});

test('envNumber：allowZero 显式控制「0 = 关闭」语义', (t) => {
  withEnv(t, { CFG_C: '0' }, () => {
    assert.equal(
      envNumber('CFG_C', { defaultValue: 2 * 1024 ** 3, min: 0, allowZero: true }),
      0,
      'MEDIA_MAX_BYTES=0 必须真的关闭水位清理',
    );
    assert.equal(
      envNumber('CFG_C', { defaultValue: 180, min: 1 }),
      180,
      '未声明 allowZero 时 0 回退默认（保留天数不应为 0）',
    );
  });
});

test('envNumber：超上界钳制并记录告警', (t) => {
  const warnings = [];
  withEnv(t, { CFG_D: '999999' }, () => {
    assert.equal(
      envNumber('CFG_D', { defaultValue: 60, min: 10, max: 600, onWarn: (m) => warnings.push(m) }),
      600,
    );
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /超出范围/);
});

test('envNumber：默认保留小数，integer 选项才归整', (t) => {
  withEnv(t, { CFG_E: '0.01' }, () => {
    assert.equal(
      envNumber('CFG_E', { defaultValue: 5, min: 0.001, max: 1440 }),
      0.01,
      'ESCALATION_MINUTES=0.01 是既有测试契约，不能被抹成 0',
    );
  });
  withEnv(t, { CFG_E: '7.6' }, () => {
    assert.equal(envNumber('CFG_E', { defaultValue: 1, min: 1, max: 30, integer: true }), 8);
  });
});

test('envBoolean：统一 0/false/no/off 与 1/true/yes/on', (t) => {
  for (const [raw, expected] of [
    ['1', true], ['true', true], ['YES', true], ['on', true],
    ['0', false], ['false', false], ['no', false], ['OFF', false],
  ]) {
    withEnv(t, { CFG_F: raw }, () => {
      assert.equal(envBoolean('CFG_F', true), expected, `${raw} 应解析为 ${expected}`);
    });
  }
  // 旧写法 SERVER_DETECTION !== '0' 会把 'false' 当作开启。
  withEnv(t, { CFG_F: 'false' }, () => {
    assert.equal(envBoolean('CFG_F', true), false);
  });
  const warnings = [];
  withEnv(t, { CFG_F: 'maybe' }, () => {
    assert.equal(envBoolean('CFG_F', true, { onWarn: (m) => warnings.push(m) }), true);
  });
  assert.equal(warnings.length, 1);
});

test('normalizePort：非法端口不再直接崩在 listen', () => {
  assert.deepEqual(normalizePort('4173'), { port: 4173, error: null });
  for (const bad of ['abc', '-1', '0', '65536', '4173.5', '']) {
    assert.ok(normalizePort(bad).error, `${JSON.stringify(bad)} 应判非法`);
    assert.equal(normalizePort(bad).port, 4173);
  }
});

test('normalizeClock：非法时刻回退，不再让每日摘要永不触发', () => {
  assert.deepEqual(normalizeClock('08:00'), { value: '08:00', hour: 8, minute: 0 });
  assert.equal(normalizeClock('25:99').value, '08:00', '超出范围应回退');
  assert.equal(normalizeClock('08:00:30').value, '08:00', '多余部分应回退默认值');
  assert.equal(normalizeClock('8:05').value, '08:05');
  const warnings = [];
  normalizeClock('abc', '08:00', { onWarn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
});

test('配置回归：0 不再被吞、负数不再生效、NaN 不再传播', (t) => {
  // 这是本轮 config.mjs 要一次性修掉的三类真实故障的联合断言。
  withEnv(t, {
    MEDIA_MAX_BYTES: '0',
    ALARM_RETENTION_DAYS: '-5',
    MAX_CONCURRENT_STREAMS: 'abc',
  }, () => {
    assert.equal(
      envNumber('MEDIA_MAX_BYTES', { defaultValue: 2 * 1024 ** 3, min: 0, allowZero: true }),
      0,
    );
    assert.equal(
      envNumber('ALARM_RETENTION_DAYS', { defaultValue: 180, min: 1, max: 3650 }),
      1,
    );
    assert.equal(
      envNumber('MAX_CONCURRENT_STREAMS', { defaultValue: 8, min: 1, max: 64 }),
      8,
    );
  });
});
