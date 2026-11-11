import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHANGHAI_OFFSET_MS,
  shanghaiDateKey,
  shanghaiDayStart,
  toShanghaiParts,
} from './time.mjs';

/**
 * 业务时区工具的边界测试。
 *
 * 背景：这套函数决定「告警按天聚合」「每日值守摘要触发」「布防时段判定」
 * 的口径。此前这些逻辑分散在 SQL 的 '+8 hours'、手写 Date.UTC 减 8 小时、
 * Intl 格式化与本地时区 getter 四处，容器 TZ=UTC 部署时曾出现整体偏移 8 小时。
 * 收敛后必须有测试锁死，否则改动一处就会静默影响三处业务。
 */

test('toShanghaiParts：UTC 16:00 是上海次日 00:00', () => {
  // 2026-11-11T16:00:00Z === 2026-11-12T00:00:00+08:00
  const ts = Date.UTC(2026, 10, 11, 16, 0, 0);
  assert.deepEqual(toShanghaiParts(ts), {
    y: 2026, m: 11, d: 12, hh: 0, mm: 0, ss: 0,
  });
});

test('toShanghaiParts：跨月与跨年边界', () => {
  // UTC 2026-12-31T15:59:59Z === 上海 2026-12-31 23:59:59
  assert.deepEqual(
    toShanghaiParts(Date.UTC(2026, 11, 31, 15, 59, 59)),
    { y: 2026, m: 12, d: 31, hh: 23, mm: 59, ss: 59 },
  );
  // UTC 2026-12-31T16:00:00Z === 上海 2027-01-01 00:00:00
  assert.deepEqual(
    toShanghaiParts(Date.UTC(2026, 11, 31, 16, 0, 0)),
    { y: 2027, m: 1, d: 1, hh: 0, mm: 0, ss: 0 },
  );
});

test('toShanghaiParts：闰年 2 月 29 日', () => {
  // 2028 是闰年；UTC 2028-02-28T16:00:00Z === 上海 2028-02-29 00:00
  const parts = toShanghaiParts(Date.UTC(2028, 1, 28, 16, 0, 0));
  assert.equal(parts.y, 2028);
  assert.equal(parts.m, 2);
  assert.equal(parts.d, 29);
});

test('shanghaiDayStart：当日 00:00 换算回 epoch 且可逆', () => {
  const parts = { y: 2026, m: 11, d: 12 };
  const start = shanghaiDayStart(parts);
  // 上海 2026-11-12 00:00 === UTC 2026-11-11 16:00
  assert.equal(start, Date.UTC(2026, 10, 11, 16, 0, 0));
  // 往回拆应得到同日 00:00:00
  assert.deepEqual(toShanghaiParts(start), {
    y: 2026, m: 11, d: 12, hh: 0, mm: 0, ss: 0,
  });
  // 当日最后一毫秒仍属同一天
  assert.equal(shanghaiDateKey(start + 86_400_000 - 1), '2026-11-12');
  // 次日 00:00 进入新的一天
  assert.equal(shanghaiDateKey(start + 86_400_000), '2026-11-13');
});

test('shanghaiDateKey：补零与跨日一致性', () => {
  assert.equal(shanghaiDateKey(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01');
  assert.equal(shanghaiDateKey(Date.UTC(2026, 8, 9, 3, 0, 0)), '2026-09-09');
});

test('偏移常量固定 +8 小时（无夏令时）', () => {
  assert.equal(SHANGHAI_OFFSET_MS, 8 * 60 * 60 * 1000);
  // 夏季与冬季的偏移必须一致：若误用系统时区，这里会暴露。
  const summer = toShanghaiParts(Date.UTC(2026, 6, 1, 4, 0, 0));
  const winter = toShanghaiParts(Date.UTC(2026, 0, 1, 4, 0, 0));
  assert.equal(summer.hh, 12);
  assert.equal(winter.hh, 12);
});
