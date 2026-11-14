import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_CONFIRM_FIELD,
  PUBLIC_ALARM_STATUSES,
  closeAlarmBlock,
  toInternalAlarmStatus,
  toPublicAlarm,
  toPublicAlarmStatus,
} from './alarm-status.mjs';

test('对外状态转落库状态：closed 落到 archived，历史别名 archived 仍接受', () => {
  assert.equal(toInternalAlarmStatus('pending'), 'pending');
  assert.equal(toInternalAlarmStatus('confirmed'), 'confirmed');
  assert.equal(toInternalAlarmStatus('false'), 'false');
  assert.equal(toInternalAlarmStatus('closed'), 'archived');
  assert.equal(toInternalAlarmStatus('archived'), 'archived');
});

test('落库状态转对外状态：archived 输出 closed，其余原样', () => {
  assert.equal(toPublicAlarmStatus('pending'), 'pending');
  assert.equal(toPublicAlarmStatus('confirmed'), 'confirmed');
  assert.equal(toPublicAlarmStatus('false'), 'false');
  assert.equal(toPublicAlarmStatus('archived'), 'closed');
  assert.equal(toPublicAlarmStatus('closed'), 'closed');
});

test('双向转换闭环：closed → archived → closed，且不会二次改写', () => {
  const internal = toInternalAlarmStatus('closed');
  assert.equal(internal, 'archived');
  assert.equal(toPublicAlarmStatus(internal), 'closed');
  assert.equal(toPublicAlarmStatus(toPublicAlarmStatus(internal)), 'closed');
});

test('未知状态值不被接受（入参）也不被篡改（出参）', () => {
  assert.equal(toInternalAlarmStatus('bogus'), null);
  assert.equal(toInternalAlarmStatus('Fire'), null);
  assert.equal(toInternalAlarmStatus(undefined), null);
  assert.equal(toPublicAlarmStatus('bogus'), 'bogus');
});

test('对外暴露的状态集合固定为 pending/confirmed/closed', () => {
  assert.deepEqual([...PUBLIC_ALARM_STATUSES], ['pending', 'confirmed', 'closed']);
});

test('关闭前置校验：火情四步、设备健康与误报的单项确认分开判定', () => {
  // 火情：四步未完成，返回缺失的四步字段。
  assert.deepEqual(
    closeAlarmBlock({
      status: 'confirmed',
      level: 'fire',
      steps: [true, true, true, false],
    }),
    { error: '应急处置清单未完成，无法关闭告警', missing: ['call_119'] },
  );
  // 火情：四步完成即可关闭，不要求第 5 位确认。
  assert.equal(
    closeAlarmBlock({
      status: 'confirmed',
      level: 'smoke',
      steps: [true, true, true, true],
    }),
    null,
  );
  // 设备离线：只需要第 5 位确认。
  assert.deepEqual(
    closeAlarmBlock({ status: 'confirmed', level: 'offline', steps: [false, false, false, false] }),
    { error: '处置确认未完成，无法关闭告警', missing: [CLOSE_CONFIRM_FIELD] },
  );
  assert.equal(
    closeAlarmBlock({
      status: 'confirmed',
      level: 'camera_abnormal',
      steps: [false, false, false, false, true],
    }),
    null,
  );
  // 误报清理：同样只要一个确认项。
  assert.deepEqual(
    closeAlarmBlock({ status: 'false', level: 'fire', steps: [true, true, true, true] }),
    { error: '处置确认未完成，无法关闭告警', missing: [CLOSE_CONFIRM_FIELD] },
  );
  assert.equal(
    closeAlarmBlock({
      status: 'false',
      level: 'fire',
      steps: [true, true, true, true, true],
    }),
    null,
  );
  // pending 不经过关闭路径，不做额外限制。
  assert.equal(closeAlarmBlock({ status: 'pending', level: 'fire', steps: [] }), null);
});

test('toPublicAlarm 只改 status 字段，不改原对象', () => {
  const alarm = { id: 'a1', status: 'archived', note: '已处置' };
  const publicAlarm = toPublicAlarm(alarm);
  assert.equal(publicAlarm.status, 'closed');
  assert.equal(publicAlarm.note, '已处置');
  assert.equal(alarm.status, 'archived', '原对象不能被就地修改');

  const pending = { id: 'a2', status: 'pending' };
  assert.equal(toPublicAlarm(pending), pending, '无需转换时应复用原引用');
  assert.equal(toPublicAlarm(null), null);
});
