import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runFfmpegOnce } from './ffmpeg-once.mjs';

function fakeChild() {
  const emitter = new EventEmitter();
  emitter.kill = () => undefined;
  return emitter;
}

test('onExit 抛错时返回 failureValue，Promise 不会挂起', async () => {
  const child = fakeChild();
  const promise = runFfmpegOnce({
    spawnImpl: () => child,
    ffmpegPath: 'ffmpeg',
    args: [],
    timeoutMs: 50,
    failureValue: null,
    onExit: () => {
      throw new Error('existsSync failed');
    },
  });
  child.emit('exit', 0);
  assert.equal(await promise, null);
});

test('spawn 抛错时直接返回 failureValue', async () => {
  const value = await runFfmpegOnce({
    spawnImpl: () => {
      throw new Error('ENOENT');
    },
    ffmpegPath: 'ffmpeg',
    args: [],
    timeoutMs: 50,
    failureValue: false,
    onExit: () => 'unexpected',
  });
  assert.equal(value, false);
});
