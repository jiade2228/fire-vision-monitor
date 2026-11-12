import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveFileMode, zipDirectory } from '../scripts/package/zip.mjs';

/**
 * ZIP 权限位回归（云端验收 D-01，P1）。
 *
 * 现象：Linux 便携包解压后 `start.sh` 与 `program/node` 均为 -rw-r--r--，
 * 按 README 首行执行 `./start.sh` 直接 Permission denied —— 首次部署无法启动。
 *
 * 根因：ZIP 的外部属性（external attributes）保存 Unix 权限位，
 * 原实现写 0 且「创建版本」是 FAT 语义，unzip 无从恢复执行位。
 */

/**
 * 解析 zip 中央目录，取出每个条目的权限位与 create_system。
 * @param {string} file zip 路径。
 * @returns {Array<{name: string, mode: number, createSystem: number, versionMadeBy: number}>}
 */
function readCentralEntries(file) {
  const buffer = fs.readFileSync(file);
  // EOCD 在文件尾部（无注释时固定 22 字节）
  const eocdOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdOffset > 0, '应能找到 EOCD');
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名应正确');
    const versionMadeBy = buffer.readUInt16LE(offset + 4);
    const externalAttr = buffer.readUInt32LE(offset + 38);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({
      name,
      mode: (externalAttr >>> 16) & 0o7777,
      createSystem: versionMadeBy >>> 8,
      versionMadeBy,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('resolveFileMode：保留执行位，缺失时按约定补齐', () => {
  // 已有执行位 → 原样保留
  assert.equal(resolveFileMode('start.sh', 0o100755), 0o755);
  assert.equal(resolveFileMode('program/node', 0o100755), 0o755);
  // Windows 上 stat 不含执行位 → 脚本与 node 补 0755
  assert.equal(resolveFileMode('start.sh', 0o100666), 0o755);
  assert.equal(resolveFileMode('fire-vision-1.2.4/program/node', 0o100666), 0o755);
  assert.equal(resolveFileMode('fire-vision-1.2.4/program/node.exe', 0o100666), 0o755);
  // 普通文件 → 0644
  assert.equal(resolveFileMode('README-QUICKSTART.txt', 0o100666), 0o644);
  assert.equal(resolveFileMode('program/server/index.mjs', 0o100666), 0o644);
});

test('zipDirectory：写入 Unix 权限位，unzip 可恢复可执行位（D-01）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zip-mode-'));
  try {
    await fsp.mkdir(path.join(dir, 'program'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'start.sh'), '#!/bin/sh\necho hi\n', 'utf8');
    await fsp.writeFile(path.join(dir, 'program', 'node'), 'binary-placeholder', 'utf8');
    await fsp.writeFile(path.join(dir, 'README-QUICKSTART.txt'), '说明', 'utf8');
    // Linux 上打出来的包应保留真实权限；Windows 上 stat 无执行位，靠约定补齐。
    await fsp.chmod(path.join(dir, 'start.sh'), 0o755).catch(() => {});
    await fsp.chmod(path.join(dir, 'program', 'node'), 0o755).catch(() => {});

    const outFile = path.join(dir, 'bundle.zip');
    const result = zipDirectory({ sourceDir: dir, outFile, rootName: 'bundle' });
    assert.equal(result.files, 3);

    const entries = readCentralEntries(outFile);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    for (const entry of entries) {
      assert.equal(entry.createSystem, 3, `${entry.name} 的 create_system 应为 3（Unix），实际 ${entry.createSystem}`);
    }
    assert.equal(byName.get('bundle/start.sh').mode, 0o755, 'start.sh 应为 0755');
    assert.equal(byName.get('bundle/program/node').mode, 0o755, 'program/node 应为 0755');
    assert.equal(byName.get('bundle/README-QUICKSTART.txt').mode, 0o644, '普通文件应为 0644');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
