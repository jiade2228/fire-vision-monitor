import test from 'node:test';
import assert from 'node:assert/strict';

import { installProcessGuards } from './process-safety.mjs';

/**
 * 捕获 installProcessGuards 注册的进程监听器，避免真的触发未捕获异常
 * 影响测试运行器（node --test 自身也会监听这两个事件）。
 */
function withCapturedHandlers(run) {
  const originalOn = process.on;
  const originalOff = process.off;
  const captured = [];
  process.on = function patched(event, listener) {
    if (event === 'unhandledRejection' || event === 'uncaughtException') {
      captured.push({ event, listener });
      return this;
    }
    return originalOn.call(this, event, listener);
  };
  process.off = function patched(event, listener) {
    const index = captured.findIndex((item) => item.event === event && item.listener === listener);
    if (index >= 0) {
      captured.splice(index, 1);
      return this;
    }
    return originalOff.call(this, event, listener);
  };
  try {
    return run(captured);
  } finally {
    process.on = originalOn;
    process.off = originalOff;
  }
}

test('未捕获 rejection 被计数、记录日志且不退出进程', () => {
  withCapturedHandlers((captured) => {
    const logs = [];
    const guards = installProcessGuards({ log: (level, event, fields) => logs.push({ level, event, fields }) });
    assert.equal(captured.length, 2, '应注册 unhandledRejection 与 uncaughtException 两个监听器');

    const handler = captured.find((item) => item.event === 'unhandledRejection').listener;
    handler(new Error('boom'));

    assert.equal(guards.state.unhandledRejections, 1);
    assert.equal(guards.state.lastUnhandled.message, 'boom');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, 'unhandled_rejection');
    assert.equal(logs[0].level, 'error');
    assert.equal(logs[0].fields.total, 1);
  });
});

test('非 Error 的 rejection 也能被兜住并计数', () => {
  withCapturedHandlers((captured) => {
    const guards = installProcessGuards({ log: () => {} });
    const handler = captured.find((item) => item.event === 'unhandledRejection').listener;
    handler('字符串原因');
    assert.equal(guards.state.unhandledRejections, 1);
    assert.equal(guards.state.lastUnhandled.message, '字符串原因');
  });
});

test('uncaughtException 触发致命回调', () => {
  withCapturedHandlers((captured) => {
    const fatal = [];
    const guards = installProcessGuards({ log: () => {}, onFatal: (error) => fatal.push(error) });
    const handler = captured.find((item) => item.event === 'uncaughtException').listener;
    const error = new Error('fatal');
    handler(error);

    assert.equal(guards.state.uncaughtExceptions, 1);
    assert.equal(fatal.length, 1);
    assert.equal(fatal[0], error);
  });
});

test('计数变化会同步给 onCount（供 /api/metrics 暴露）', () => {
  withCapturedHandlers((captured) => {
    const snapshots = [];
    installProcessGuards({ log: () => {}, onCount: (state) => snapshots.push(state.unhandledRejections) });
    const handler = captured.find((item) => item.event === 'unhandledRejection').listener;
    handler(new Error('x'));
    handler(new Error('y'));
    assert.deepEqual(snapshots, [1, 2]);
  });
});

test('致命回调自身抛错不会影响异常处理', () => {
  withCapturedHandlers((captured) => {
    const guards = installProcessGuards({
      log: () => {},
      onFatal: () => {
        throw new Error('回调也炸了');
      },
    });
    const handler = captured.find((item) => item.event === 'uncaughtException').listener;
    assert.doesNotThrow(() => handler(new Error('x')));
    assert.equal(guards.state.uncaughtExceptions, 1);
  });
});
