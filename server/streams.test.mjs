import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StreamError, StreamManager } from './streams.mjs';

test('missing FFmpeg fails fast and does not leave a locked stream state', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-stream-'));
  const manager = new StreamManager({
    dataDir,
    ffmpegPath: path.join(dataDir, 'does-not-exist-ffmpeg'),
    maxStreams: 1,
    logger: { warn: () => undefined, info: () => undefined },
  });
  t.after(async () => {
    manager.stopAll();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assert.equal(manager.init(), false);
  await assert.rejects(
    () =>
      manager.ensure({
        id: 'camera-1',
        sourceUrl: 'rtsp://example.invalid/live',
      }),
    (error) => error instanceof StreamError && error.code === 'FFMPEG_MISSING',
  );
  assert.equal(manager.activeCount(), 0);
});
