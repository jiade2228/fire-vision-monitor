import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, isArmedNow, serializeSchedule, toClientSchedule } from './schedule.mjs';

test('parseSchedule：空/非法输入回退全天候布防，跨零点窗口归一化', () => {
  assert.deepEqual(parseSchedule(null), { always: true });
  assert.deepEqual(parseSchedule(''), { always: true });
  assert.deepEqual(parseSchedule('not-json'), { always: true });
  assert.deepEqual(parseSchedule('{"windows":[]}'), { always: true });
  assert.deepEqual(parseSchedule('{"windows":[{"start":"bad","end":"08:00"}]}'), { always: true });

  const parsed = parseSchedule(
    '{"windows":[{"days":[1,3,5],"start":"22:00","end":"06:00"}]}',
  );
  assert.equal(parsed.always, false);
  assert.deepEqual(parsed.windows[0].days, [1, 3, 5]);
  assert.equal(parsed.windows[0].start, 22 * 60);
  // end < start 时加一天，数值区间即可表达跨零点。
  assert.equal(parsed.windows[0].end, 6 * 60 + 24 * 60);
});

test('isArmedNow：工作时段、全天候、跨零点窗口判定', () => {
  // 全天候。
  assert.equal(isArmedNow(null, new Date(2026, 10, 3, 3, 0)), true);
  assert.equal(isArmedNow({ always: true }, new Date()), true);

  // 周一 10:00，窗口周一-周五 08:00-20:00 → 布防。
  const weekday = { always: false, windows: [{ days: [1, 2, 3, 4, 5], start: 480, end: 1200 }] };
  assert.equal(isArmedNow(weekday, new Date(2026, 10, 2, 10, 0)), true); // 周一
  // 周一 07:59 → 撤防。
  assert.equal(isArmedNow(weekday, new Date(2026, 10, 2, 7, 59)), false);
  // 周六 10:00 → 撤防（2026-11-07 是周六）。
  assert.equal(isArmedNow(weekday, new Date(2026, 10, 7, 10, 0)), false);

  // 跨零点：周日 22:00-06:00。
  const overnight = { always: false, windows: [{ days: [0], start: 1320, end: 360 + 1440 }] };
  assert.equal(isArmedNow(overnight, new Date(2026, 10, 1, 23, 30)), true, '周日 23:30 布防');
  assert.equal(isArmedNow(overnight, new Date(2026, 10, 2, 2, 0)), true, '周一 02:00 延续布防');
  assert.equal(isArmedNow(overnight, new Date(2026, 10, 2, 6, 0)), false, '周一 06:00 撤防');
  assert.equal(isArmedNow(overnight, new Date(2026, 10, 2, 12, 0)), false, '周一中午撤防');
  assert.equal(isArmedNow(overnight, new Date(2026, 10, 1, 12, 0)), false, '周日中午撤防');
});

test('serializeSchedule：解析形态往返无损，全天候/非法回退 NULL', () => {
  // 原始字符串形态：合法原样保留，非法归 NULL。
  const raw = '{"windows":[{"days":[1],"start":"08:00","end":"20:00"}]}';
  assert.equal(serializeSchedule(raw), raw);
  assert.equal(serializeSchedule('{"windows":[]}'), null);
  assert.equal(serializeSchedule(undefined), null);
  assert.equal(serializeSchedule({ always: true }), null);

  // 解析形态（分钟数、跨零点）→ HH:mm 字符串，parseSchedule 可无损回读。
  const normalized = {
    always: false,
    windows: [{ days: [1, 3], start: 1320, end: 360 + 1440 }],
  };
  const stored = serializeSchedule(normalized);
  assert.equal(stored, '{"windows":[{"days":[1,3],"start":"22:00","end":"06:00"}]}');
  const reparsed = parseSchedule(stored);
  assert.equal(reparsed.always, false);
  assert.equal(reparsed.windows[0].start, 1320);
  assert.equal(reparsed.windows[0].end, 360 + 1440);
});

test('toClientSchedule：解析形态转前端 HH:mm 形态，全天候回退 null', () => {
  const parsed = parseSchedule('{"windows":[{"days":[1,5],"start":"22:00","end":"06:00"}]}');
  const client = toClientSchedule(parsed);
  assert.equal(client.windows.length, 1);
  assert.deepEqual(client.windows[0].days, [1, 5]);
  assert.equal(client.windows[0].start, '22:00');
  assert.equal(client.windows[0].end, '06:00');
  assert.equal(typeof client.windows[0].start, 'string');
  assert.equal(toClientSchedule({ always: true }), null);
  assert.equal(toClientSchedule(null), null);
});
