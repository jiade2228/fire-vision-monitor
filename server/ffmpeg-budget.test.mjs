import test from 'node:test';
import assert from 'node:assert/strict';

import { FfmpegBudget } from './ffmpeg-budget.mjs';

/**
 * RES-1：FFmpeg 进程预算的回归测试。
 *
 * 重点锁住三件事：
 *   1. 预算不足时是「排队」而不是「拒绝」——拒绝会让点位永远起不来；
 *   2. release 幂等——重复释放不能把名额算错（否则预算会被虚占）；
 *   3. 等待超时必须给出可读错误，且超时者不会占用名额。
 */

/**
 * 保持事件循环存活直到 fn 完成。
 *
 * 预算的等待超时定时器是 unref 的（避免「有请求在排队」时进程退不出去），
 * 因此测试里必须自己挂一个 ref 定时器，否则 Node 测试框架会认为
 * 「事件循环已结束但 promise 仍未 resolve」而判定失败。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withKeepAlive(fn) {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

test('预算充足时立即放行，并正确计数', async () => {
  const budget = new FfmpegBudget({ limit: 2 });
  const a = await budget.acquire({ label: 'a' });
  const b = await budget.acquire({ label: 'b' });
  assert.equal(budget.activeCount, 2);
  assert.equal(budget.waitingCount, 0);
  assert.equal(budget.stats().totalAcquired, 2);

  budget.release(a);
  assert.equal(budget.activeCount, 1);
  budget.release(b);
  assert.equal(budget.activeCount, 0);
});

test('预算不足时排队等待，释放后按 FIFO 唤醒', async () => {
  const budget = new FfmpegBudget({ limit: 1 });
  const first = await budget.acquire({ label: 'first' });

  const order = [];
  const second = budget.acquire({ label: 'second' }).then((token) => {
    order.push('second');
    return token;
  });
  const third = budget.acquire({ label: 'third' }).then((token) => {
    order.push('third');
    return token;
  });
  await Promise.resolve();
  assert.equal(budget.waitingCount, 2, '超出预算的请求应进入等待队列');

  budget.release(first);
  const secondToken = await second;
  assert.deepEqual(order, ['second'], '应先唤醒最早排队者');
  assert.equal(budget.activeCount, 1);

  budget.release(secondToken);
  const thirdToken = await third;
  assert.deepEqual(order, ['second', 'third']);
  budget.release(thirdToken);
  assert.equal(budget.activeCount, 0);
  assert.equal(budget.waitingCount, 0);
});

test('release 幂等：重复释放不会多放名额', async () => {
  const budget = new FfmpegBudget({ limit: 1 });
  const token = await budget.acquire();
  budget.release(token);
  budget.release(token);
  budget.release(token);
  assert.equal(budget.activeCount, 0, '重复释放不应产生负数或重复计数');
  // 名额应完全释放，可以再拿一个。
  const next = await budget.acquire();
  assert.ok(next);
  assert.equal(budget.activeCount, 1);
});

test('release(null) 与 release(undefined) 是安全的空操作', () => {
  const budget = new FfmpegBudget({ limit: 1 });
  budget.release(null);
  budget.release(undefined);
  assert.equal(budget.activeCount, 0);
});

test('等待超时：给出可读错误，且不占用名额', async () => {
  const budget = new FfmpegBudget({ limit: 1, waitTimeoutMs: 1_000 });
  const held = await budget.acquire();
  await withKeepAlive(async () => {
    await assert.rejects(
      () => budget.acquire({ label: 'late' }),
      /FFmpeg 进程预算已满/,
    );
  });
  assert.equal(budget.waitingCount, 0, '超时者应从队列移除');
  assert.equal(budget.activeCount, 1, '超时者不得占用名额');
  assert.equal(budget.stats().totalRejected, 1);
  budget.release(held);
  assert.equal(budget.activeCount, 0);
});

test('withSlot：无论成功失败都归还名额', async () => {
  const budget = new FfmpegBudget({ limit: 1 });
  const value = await budget.withSlot({ label: 'ok' }, async () => 'done');
  assert.equal(value, 'done');
  assert.equal(budget.activeCount, 0);

  await assert.rejects(() =>
    budget.withSlot({ label: 'boom' }, async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(budget.activeCount, 0, '抛错也必须归还名额');
});

test('setLimit 上调后立即唤醒排队者', async () => {
  const budget = new FfmpegBudget({ limit: 1 });
  const held = await budget.acquire();
  let granted = false;
  const waiting = budget.acquire().then(() => {
    granted = true;
  });
  await Promise.resolve();
  assert.equal(granted, false);

  budget.setLimit(2);
  await waiting;
  assert.equal(granted, true, '上限上调后应立即放行');
  assert.equal(budget.stats().limit, 2);
  budget.release(held);
});

test('上限与等待超时被夹取到安全区间', () => {
  const budget = new FfmpegBudget({ limit: 0, waitTimeoutMs: 1 });
  assert.equal(budget.limit, 1, '上限至少为 1');
  assert.ok(budget.waitTimeoutMs >= 1_000, '等待超时不得小于 1 秒');
  const high = new FfmpegBudget({ limit: 9999 });
  assert.equal(high.limit, 64, '上限不得超过 64');
});

test('peakActive 记录历史峰值，便于观测', async () => {
  const budget = new FfmpegBudget({ limit: 3 });
  const tokens = [];
  for (let i = 0; i < 3; i += 1) tokens.push(await budget.acquire());
  for (const token of tokens) budget.release(token);
  assert.equal(budget.stats().peakActive, 3);
  assert.equal(budget.stats().active, 0);
});
