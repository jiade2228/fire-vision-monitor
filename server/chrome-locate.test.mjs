import test from 'node:test';
import assert from 'node:assert/strict';

import { chromeCandidates, findChrome } from '../scripts/lib/chrome-locate.mjs';

/**
 * 浏览器定位的跨平台行为。
 *
 * 依据：E2E 与对比度扫描原先只列 Windows 路径，macOS/Linux 上即使装了
 * Chrome 也会被判为「未找到」而直接跳过，形成「本地绿、实际没测」的假象。
 */

test('chromeCandidates：macOS 覆盖系统级与用户级安装位置', () => {
  const list = chromeCandidates({ platform: 'darwin', env: {}, home: '/Users/tester' });
  assert.ok(list.some((p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(list.some((p) => p.includes('/Users/tester/Applications/')));
  assert.ok(list.some((p) => p.includes('Chromium')));
});

test('chromeCandidates：Linux 覆盖常见发行版路径', () => {
  const list = chromeCandidates({ platform: 'linux', env: {}, home: '/home/tester' });
  assert.ok(list.includes('/usr/bin/google-chrome'));
  assert.ok(list.includes('/usr/bin/chromium'));
});

test('chromeCandidates：Windows 保留原有两个 Program Files 路径', () => {
  const list = chromeCandidates({ platform: 'win32', env: {}, home: 'C:\\Users\\tester' });
  assert.ok(list.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'));
  assert.ok(list.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
});

test('chromeCandidates：CHROME_PATH 始终排在最前', () => {
  const list = chromeCandidates({
    platform: 'darwin',
    env: { CHROME_PATH: '/custom/chrome' },
    home: '/Users/tester',
  });
  assert.equal(list[0], '/custom/chrome');
});

test('findChrome：命中候选路径即返回', () => {
  const found = findChrome({
    platform: 'darwin',
    env: {},
    home: '/Users/tester',
    exists: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    which: () => null,
  });
  assert.equal(found, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});

test('findChrome：候选都不存在时回退到 PATH 查找', () => {
  const found = findChrome({
    platform: 'linux',
    env: {},
    home: '/home/tester',
    exists: (p) => p === '/opt/google/chrome',
    which: (name) => (name === 'google-chrome' ? '/opt/google/chrome' : null),
  });
  assert.equal(found, '/opt/google/chrome');
});

test('findChrome：完全找不到时返回 null 而不是抛错', () => {
  const found = findChrome({
    platform: 'linux',
    env: {},
    home: '/home/tester',
    exists: () => false,
    which: () => null,
  });
  assert.equal(found, null);
});
