import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  LAYOUT_MARKER,
  platformDataDir,
  probeWritable,
  readLayoutMode,
  resolveLayout,
} from './app-paths.mjs';
import { parseEnvFile, loadEnvFile } from './env-file.mjs';

/**
 * 目录布局与配置文件。
 *
 * 最关键的一条约束：**没有布局标记时必须与改造前完全一致**（`<项目根>/data`），
 * 否则现有源码部署、守护脚本与全部测试都会被这次改造波及。
 */

test('readLayoutMode：无标记文件返回 null（按源码形态处理）', () => {
  assert.equal(readLayoutMode('/nonexistent', { readFile: () => { throw new Error('nope'); } }), null);
});

test('readLayoutMode：识别 portable / installed，非法内容返回 null', () => {
  const make = (content) => () => content;
  assert.equal(readLayoutMode('/x', { readFile: make('{"mode":"portable"}') }), 'portable');
  assert.equal(readLayoutMode('/x', { readFile: make('{"mode":"installed"}') }), 'installed');
  assert.equal(readLayoutMode('/x', { readFile: make('{"mode":"other"}') }), null);
  assert.equal(readLayoutMode('/x', { readFile: make('not json') }), null);
});

test('platformDataDir：三平台各自的标准目录', () => {
  assert.match(platformDataDir({ platform: 'win32', env: { ProgramData: 'D:\\PD' } }), /PD.*FireVision/i);
  assert.match(platformDataDir({ platform: 'darwin', home: '/Users/t' }), /Library\/Application Support\/FireVision/);
  assert.equal(platformDataDir({ platform: 'linux', home: '/home/t' }), '/var/lib/fire-vision');
});

test('resolveLayout：源码形态保持 <项目根>/data（不破坏既有行为）', () => {
  const layout = resolveLayout({
    projectRoot: '/app',
    argv: ['node', 'server/boot.mjs'],
    env: {},
    platform: 'linux',
    home: '/home/t',
    isWritable: () => true,
    readFile: () => { throw new Error('no marker'); },
  });
  assert.equal(layout.mode, 'source');
  assert.equal(layout.dataDir, path.join(path.resolve('/app'), 'data'));
  assert.equal(layout.fallback, false);
});

test('resolveLayout：DATA_DIR 环境变量优先于默认目录', () => {
  const layout = resolveLayout({
    projectRoot: '/app',
    argv: ['node', 'x'],
    env: { DATA_DIR: '/custom/data' },
    platform: 'linux',
    isWritable: () => true,
    readFile: () => { throw new Error('no marker'); },
  });
  assert.equal(layout.dataDir, path.resolve('/custom/data'));
  assert.match(layout.reason, /DATA_DIR/);
});

test('resolveLayout：--data-dir 优先级最高（压过 DATA_DIR）', () => {
  const layout = resolveLayout({
    projectRoot: '/app',
    argv: ['node', 'x', '--data-dir', '/cli/data'],
    env: { DATA_DIR: '/env/data' },
    platform: 'linux',
    isWritable: () => true,
    readFile: () => { throw new Error('no marker'); },
  });
  assert.equal(layout.dataDir, path.resolve('/cli/data'));
  assert.match(layout.reason, /--data-dir/);
});

test('resolveLayout：便携包数据落在包内 data/', () => {
  const layout = resolveLayout({
    projectRoot: '/opt/fire-vision/program',
    argv: ['node', 'x'],
    env: {},
    platform: 'linux',
    isWritable: () => true,
    readFile: () => JSON.stringify({ mode: 'portable' }),
  });
  assert.equal(layout.mode, 'portable');
  assert.equal(layout.dataDir, path.join(path.resolve('/opt/fire-vision'), 'data'));
});

test('resolveLayout：便携目录不可写时回退用户目录并标记 fallback', () => {
  const layout = resolveLayout({
    projectRoot: '/opt/fire-vision/program',
    argv: ['node', 'x'],
    env: {},
    platform: 'linux',
    home: '/home/t',
    isWritable: () => false,
    readFile: () => JSON.stringify({ mode: 'portable' }),
  });
  assert.equal(layout.fallback, true);
  assert.match(layout.dataDir, /\.fire-vision/);
});

test('resolveLayout：安装形态默认用平台标准目录', () => {
  const layout = resolveLayout({
    projectRoot: '/opt/fire-vision/program',
    argv: ['node', 'x'],
    env: {},
    platform: 'linux',
    home: '/home/t',
    isWritable: (dir) => dir === '/var/lib/fire-vision',
    readFile: () => JSON.stringify({ mode: 'installed' }),
  });
  assert.equal(layout.mode, 'installed');
  assert.equal(layout.dataDir, '/var/lib/fire-vision');
  assert.equal(layout.fallback, false);
});

test('resolveLayout：安装形态标准目录不可写时回退安装目录旁的 data', () => {
  const layout = resolveLayout({
    projectRoot: '/opt/fire-vision/program',
    argv: ['node', 'x'],
    env: {},
    platform: 'linux',
    home: '/home/t',
    isWritable: (dir) => dir === path.join(path.resolve('/opt/fire-vision'), 'data'),
    readFile: () => JSON.stringify({ mode: 'installed' }),
  });
  assert.equal(layout.dataDir, path.join(path.resolve('/opt/fire-vision'), 'data'));
  assert.equal(layout.fallback, true);
});

test('probeWritable：真实目录可写、不可写路径返回 false 不抛错', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'writable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  assert.equal(probeWritable(dir), true);
  // 用一个非法路径（父级是文件）触发失败
  const file = path.join(dir, 'blocker');
  await fs.writeFile(file, 'x');
  assert.equal(probeWritable(path.join(file, 'sub')), false);
});

test('parseEnvFile：注释/空行/export/引号/含 # 的值', () => {
  const { entries, errors } = parseEnvFile([
    '# 注释',
    '',
    'PORT=4173',
    'export DATA_DIR="/var/lib/fire-vision"',
    "TEMPLATE='站点 #1'",
    'bad line without equals',
    '1INVALID=x',
    'EMPTY=',
  ].join('\n'));

  const map = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  assert.equal(map.PORT, '4173');
  assert.equal(map.DATA_DIR, '/var/lib/fire-vision', 'export 前缀与引号应被去掉');
  assert.equal(map.TEMPLATE, '站点 #1', '值里的 # 不应被当成注释');
  assert.equal(map.EMPTY, '');
  assert.equal(errors.length, 2, '缺等号与非法变量名各报一条');
  assert.equal(entries.find((e) => e.key === 'PORT').line, 3);
});

test('loadEnvFile：不覆盖已存在的环境变量（环境变量优先）', () => {
  const content = 'PORT=5000\nRECORDING=1\n';
  const env = { PORT: '4173' };
  const result = loadEnvFile('/fake', { env, readFile: () => content });
  assert.equal(env.PORT, '4173', '已存在的变量不应被配置文件覆盖');
  assert.equal(env.RECORDING, '1', '未设置的变量应注入');
  assert.deepEqual(result.skipped, ['PORT']);
  assert.equal(result.loaded, 1);
});

test('loadEnvFile：文件不存在时返回 missing 而不抛错', () => {
  const result = loadEnvFile('/definitely/missing.env', {
    env: {},
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(result.missing, true);
  assert.equal(result.loaded, 0);
});

test('LAYOUT_MARKER 名称固定（打包脚本与运行期必须一致）', () => {
  assert.equal(LAYOUT_MARKER, '.fire-vision-layout.json');
});
