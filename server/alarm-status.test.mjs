import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUBLIC_ALARM_STATUSES,
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
