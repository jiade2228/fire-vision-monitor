/**
 * 产物内容闸门单测。
 *
 * 覆盖验收要求的三包四项检查：齐全通过、缺 boot.mjs、缺 dist/index.html、
 * node 缺执行位、缺 package.json。用合成条目覆盖全部失败分支，
 * 另加一条真实 zip 的端到端用例，确保归档读取链路本身可用。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkEntries,
  normalizeEntryPath,
  verifyArtifact,
} from './verify-artifacts.mjs';
import { zipDirectory } from './zip.mjs';

/** 构造一份齐全的 program 条目（node 0755）。 */
function completeEntries() {
  return [
    { path: '/opt/fire-vision/program/server/boot.mjs', mode: 0o644, type: 'file' },
    { path: '/opt/fire-vision/program/dist/index.html', mode: 0o644, type: 'file' },
    { path: '/opt/fire-vision/program/node', mode: 0o100755, type: 'file' },
    { path: '/opt/fire-vision/program/package.json', mode: 0o644, type: 'file' },
  ];
}

test('四项必备文件齐全时通过', () => {
  const result = checkEntries(completeEntries());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.notExecutable, []);
  assert.ok(result.required.every((item) => item.present));
});

test('缺少 program/server/boot.mjs 时失败', () => {
  const entries = completeEntries().filter((item) => !item.path.endsWith('boot.mjs'));
  const result = checkEntries(entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['program/server/boot.mjs']);
});

test('缺少 program/dist/index.html 时失败', () => {
  const entries = completeEntries().filter((item) => !item.path.endsWith('index.html'));
  const result = checkEntries(entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['program/dist/index.html']);
});

test('program/node 缺执行位时失败', () => {
  const entries = completeEntries().map((item) => (
    item.path.endsWith('program/node') ? { ...item, mode: 0o100644 } : item
  ));
  const result = checkEntries(entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.notExecutable, ['program/node']);
});

test('缺少 program/package.json 时失败', () => {
  const entries = completeEntries().filter((item) => !item.path.endsWith('package.json'));
  const result = checkEntries(entries);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['program/package.json']);
});

test('三种包的路径前缀都能归一化到 program/', () => {
  assert.equal(
    normalizeEntryPath('fire-vision-1.2.8-linux-x64/program/server/boot.mjs'),
    'program/server/boot.mjs',
  );
  assert.equal(
    normalizeEntryPath('./opt/fire-vision/program/dist/index.html'),
    'program/dist/index.html',
  );
  assert.equal(
    normalizeEntryPath('/opt/fire-vision/program/node'),
    'program/node',
  );
  assert.equal(normalizeEntryPath('/opt/fire-vision/README-QUICKSTART.txt'), null);
});

test('真实 zip：齐全时通过，缺文件时失败', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fv-verify-'));
  const bundle = path.join(root, 'fire-vision-test-linux-x64');
  const program = path.join(bundle, 'program');
  await fsp.mkdir(path.join(program, 'server'), { recursive: true });
  await fsp.mkdir(path.join(program, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(program, 'server', 'boot.mjs'), '// boot\n');
  await fsp.writeFile(path.join(program, 'dist', 'index.html'), '<!doctype html>\n');
  await fsp.writeFile(path.join(program, 'package.json'), '{}\n');
  await fsp.writeFile(path.join(program, 'node'), '// node\n');
  await fsp.chmod(path.join(program, 'node'), 0o755);

  const goodZip = path.join(root, 'good.zip');
  zipDirectory({ sourceDir: bundle, outFile: goodZip, rootName: path.basename(bundle) });
  assert.equal(verifyArtifact(goodZip).ok, true);

  await fsp.rm(path.join(program, 'server', 'boot.mjs'));
  const badZip = path.join(root, 'bad.zip');
  zipDirectory({ sourceDir: bundle, outFile: badZip, rootName: path.basename(bundle) });
  const bad = verifyArtifact(badZip);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['program/server/boot.mjs']);

  fs.rmSync(root, { recursive: true, force: true });
});
