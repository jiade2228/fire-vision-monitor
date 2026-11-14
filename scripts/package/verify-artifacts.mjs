/**
 * 发布产物内容闸门（zip / deb / rpm 共用）。
 *
 * 背景：v1.2.6 的 deb/rpm 曾因 nfpm 写成 `type: dir` 只产出空目录，产物
 * “打包成功”但装完没有应用代码；v1.2.8 验收又出现 rpm 条目数被误记为
 * 普通文件数。两件事的共同点是：产物内容没有被**机器**校验，只靠人看清单。
 *
 * 本模块只用 Node 内置能力直接读归档结构，不依赖 rpm / dpkg-deb / unzip，
 * 因此 Windows 开发机与 Linux CI 能得到完全一致的结论：
 *   - 三包都必须包含 program/server/boot.mjs、program/dist/index.html、
 *     program/node、program/package.json；
 *   - program/node 必须带可执行位（zip 读外部属性，deb/rpm 读文件模式）；
 *   - 任一缺失或不可执行即判失败，由调用方中止打包，不产出坏包。
 *
 * CLI：
 *   node scripts/package/verify-artifacts.mjs <产物...> [--json]
 *   退出码：0 全部通过；1 存在失败；2 参数/格式错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 三包共同要求的四项必备文件（包内相对 program/ 的路径）。 */
export const REQUIRED_FILES = Object.freeze([
  'program/server/boot.mjs',
  'program/dist/index.html',
  'program/node',
  'program/package.json',
]);

/** 需要可执行位的条目。 */
export const EXECUTABLE_FILES = Object.freeze(['program/node']);

/**
 * 归档条目路径归一化：去掉 zip 顶层目录、deb/rpm 安装前缀，统一成
 * `program/...`。不在 program 子树下的条目返回 null。
 *
 * @param {string} entry 归档内原始路径（`/` 分隔）。
 * @returns {string|null}
 */
export function normalizeEntryPath(entry) {
  const value = String(entry).replace(/\\/g, '/');
  let normalized = null;
  const index = value.indexOf('/program/');
  if (index >= 0) normalized = value.slice(index + 1);
  else if (value.startsWith('program/')) normalized = value;
  if (!normalized) return null;
  // 目录条目可能带结尾 `/`，与文件路径统一后再比较，避免 total 重复计数。
  const trimmed = normalized.replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * 判断条目是否可执行（任一执行位被置位）。
 *
 * @param {{mode:number,type:string}} entry 归一化后的条目。
 * @returns {boolean}
 */
export function isExecutable(entry) {
  return entry.type === 'file' && (entry.mode & 0o111) !== 0;
}

/**
 * 校验一组归档条目是否满足四项必备文件与执行位要求。
 * 这是纯函数，便于用合成数据覆盖全部失败分支（单测入口）。
 *
 * @param {Array<{path:string,mode:number,type:string}>} entries 归档条目。
 * @returns {{ok:boolean,total:number,missing:string[],notExecutable:string[],required:Array<{path:string,present:boolean,executable:boolean|null}>}}
 */
export function checkEntries(entries) {
  const byPath = new Map();
  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.path);
    if (!normalized) continue;
    // 同名多条时优先保留普通文件（tar 里目录与文件不会同名，这里仅防御）。
    const previous = byPath.get(normalized);
    if (!previous || (previous.type !== 'file' && entry.type === 'file')) {
      byPath.set(normalized, { ...entry, path: normalized });
    }
  }

  const missing = [];
  const notExecutable = [];
  const required = REQUIRED_FILES.map((rel) => {
    const entry = byPath.get(rel);
    if (!entry || entry.type !== 'file') {
      missing.push(rel);
      return { path: rel, present: false, executable: null };
    }
    const needsExec = EXECUTABLE_FILES.includes(rel);
    const executable = needsExec ? isExecutable(entry) : null;
    if (needsExec && !executable) {
      notExecutable.push(rel);
      return { path: rel, present: true, executable: false };
    }
    return { path: rel, present: true, executable };
  });

  return {
    ok: missing.length === 0 && notExecutable.length === 0,
    total: byPath.size,
    missing,
    notExecutable,
    required,
  };
}

// ---------------- ZIP ----------------

/**
 * 读取 zip 中央目录，返回条目列表（不依赖 unzip）。
 *
 * @param {string} file zip 路径。
 * @returns {Array<{path:string,mode:number,type:string}>}
 */
export function readZipEntries(file) {
  const buffer = fs.readFileSync(file);
  // EOCD 至少 22 字节，注释最长 65535，向后扫描找到签名。
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：未找到中央目录结尾记录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`zip 中央目录第 ${i + 1} 条签名错误`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttr = buffer.readUInt32LE(offset + 38);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const mode = (externalAttr >>> 16) & 0xffff;
    const type = name.endsWith('/') || (mode & 0o170000) === 0o040000
      ? 'dir'
      : (mode & 0o170000) === 0o120000 ? 'link' : 'file';
    entries.push({ path: name, mode: mode & 0o7777, type });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------- DEB ----------------

/** 解析 ar 归档，返回 [{name, data}]。 */
function readArMembers(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('latin1', 0, 8) !== '!<arch>\n') {
    throw new Error('不是有效的 deb：缺少 ar 魔数');
  }
  const members = [];
  let offset = 8;
  while (offset + 60 <= buffer.length) {
    const header = buffer.toString('latin1', offset, offset + 60);
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    const start = offset + 60;
    members.push({ name, data: buffer.subarray(start, start + size) });
    offset = start + size + (size % 2);
  }
  return members;
}

/** 解压 deb 的 data.tar.*（gzip / xz / zstd；xz 交给系统 xz）。 */
function decompressDataTar(name, data) {
  if (name.endsWith('.gz')) return zlib.gunzipSync(data);
  if (name.endsWith('.tar')) return data;
  const tool = name.endsWith('.xz') ? 'xz' : name.endsWith('.zst') ? 'zstd' : null;
  if (!tool) throw new Error(`不支持的 deb 载荷压缩：${name}`);
  const args = tool === 'xz' ? ['-dc'] : ['-dc'];
  const result = spawnSync(tool, args, { input: data, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`解压 ${name} 失败：缺少 ${tool} 或数据损坏`);
  }
  return result.stdout;
}

/**
 * 解析 tar（ustar + GNU 长文件名），只保留路径/模式/类型。
 *
 * @param {Buffer} buffer tar 数据。
 * @returns {Array<{path:string,mode:number,type:string}>}
 */
export function readTarEntries(buffer) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const mode = Number.parseInt(header.toString('latin1', 100, 108).replace(/[^0-7]/g, '') || '0', 8);
    const size = Number.parseInt(header.toString('latin1', 124, 136).replace(/[^0-7]/g, '') || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    let name = prefix ? `${prefix}/${rawName}` : rawName;

    if (typeflag === 'L') {
      longName = buffer.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/, '');
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      // pax 扩展头：不承载文件，跳过其数据块。
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    if (longName) { name = longName; longName = null; }

    const type = typeflag === '5' ? 'dir' : typeflag === '2' ? 'link' : 'file';
    entries.push({ path: name, mode: mode & 0o7777, type });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * 读取 deb 内 data.tar.* 的条目。
 *
 * @param {string} file deb 路径。
 * @returns {Array<{path:string,mode:number,type:string}>}
 */
export function readDebEntries(file) {
  const members = readArMembers(file);
  const dataTar = members.find((member) => member.name.startsWith('data.tar'));
  if (!dataTar) throw new Error('不是有效的 deb：缺少 data.tar.*');
  return readTarEntries(decompressDataTar(dataTar.name, dataTar.data));
}

// ---------------- RPM ----------------

const RPM_TAG = {
  FILEDIRINDEXES: 1116,
  FILEBASENAMES: 1117,
  FILEDIRNAMES: 1118,
  FILEMODES: 1030,
};

/** 读取 rpm header 的标签表与数据区。 */
function parseRpmHeader(buffer, offset) {
  if (buffer.readUInt32BE(offset) !== 0x8eade801) {
    throw new Error(`rpm header 魔数错误（偏移 ${offset}）`);
  }
  const indexCount = buffer.readUInt32BE(offset + 8);
  const dataSize = buffer.readUInt32BE(offset + 12);
  const indexStart = offset + 16;
  const storeStart = indexStart + indexCount * 16;
  return {
    tags: new Map(),
    indexStart,
    indexCount,
    storeStart,
    store: buffer.subarray(storeStart, storeStart + dataSize),
    end: storeStart + dataSize,
  };
}

/** 按 rpm 类型解码标签值。 */
function readRpmTagValue(type, offset, count, store) {
  if (type === 6) {
    const end = store.indexOf(0, offset);
    return store.toString('utf8', offset, end < 0 ? store.length : end);
  }
  if (type === 8) {
    const values = [];
    let cursor = offset;
    for (let i = 0; i < count; i += 1) {
      const end = store.indexOf(0, cursor);
      values.push(store.toString('utf8', cursor, end < 0 ? store.length : end));
      cursor = (end < 0 ? store.length : end) + 1;
    }
    return values;
  }
  if (type === 4) {
    const values = [];
    for (let i = 0; i < count; i += 1) values.push(store.readUInt32BE(offset + i * 4));
    return values;
  }
  if (type === 3) {
    const values = [];
    for (let i = 0; i < count; i += 1) values.push(store.readUInt16BE(offset + i * 2));
    return values;
  }
  if (type === 5) {
    const values = [];
    for (let i = 0; i < count; i += 1) values.push(Number(store.readBigUInt64BE(offset + i * 8)));
    return values;
  }
  return null;
}

/**
 * 读取 rpm 头文件表，重建每个条目的路径与权限位。
 * rpm 把路径拆成 dirnames + basenames + dirindexes，直接搜二进制是找不到
 * `program/server/boot.mjs` 的，必须按标签重组。
 *
 * @param {string} file rpm 路径。
 * @returns {Array<{path:string,mode:number,type:string}>}
 */
export function readRpmEntries(file) {
  const buffer = fs.readFileSync(file);
  const signatureOffset = 96;
  const signatureIndexCount = buffer.readUInt32BE(signatureOffset + 8);
  const signatureDataSize = buffer.readUInt32BE(signatureOffset + 12);
  const signatureEnd = signatureOffset + 16 + signatureIndexCount * 16 + signatureDataSize;
  const mainOffset = (signatureEnd + 7) & ~7;
  const header = parseRpmHeader(buffer, mainOffset);

  for (let i = 0; i < header.indexCount; i += 1) {
    const entryOffset = header.indexStart + i * 16;
    const tag = buffer.readInt32BE(entryOffset);
    const type = buffer.readUInt32BE(entryOffset + 4);
    const offset = buffer.readUInt32BE(entryOffset + 8);
    const count = buffer.readUInt32BE(entryOffset + 12);
    header.tags.set(tag, readRpmTagValue(type, offset, count, header.store));
  }

  const dirIndexes = header.tags.get(RPM_TAG.FILEDIRINDEXES) || [];
  const basenames = header.tags.get(RPM_TAG.FILEBASENAMES) || [];
  const dirnames = header.tags.get(RPM_TAG.FILEDIRNAMES) || [];
  const modes = header.tags.get(RPM_TAG.FILEMODES) || [];
  if (!basenames.length || basenames.length !== modes.length) {
    throw new Error('rpm 文件表不完整：basenames 与 filemodes 数量不一致');
  }

  return basenames.map((basename, i) => {
    const dirname = dirnames[dirIndexes[i]] ?? '';
    const mode = modes[i] ?? 0;
    const format = mode & 0o170000;
    const type = format === 0o040000 ? 'dir' : format === 0o120000 ? 'link' : 'file';
    return { path: `${dirname}${basename}`, mode: mode & 0o7777, type };
  });
}

// ---------------- 统一入口 ----------------

/**
 * 根据扩展名读取归档条目。
 *
 * @param {string} file 产物路径。
 * @returns {{type:string,entries:Array<{path:string,mode:number,type:string}>}}
 */
export function readArtifact(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.zip') return { type: 'zip', entries: readZipEntries(file) };
  if (ext === '.deb') return { type: 'deb', entries: readDebEntries(file) };
  if (ext === '.rpm') return { type: 'rpm', entries: readRpmEntries(file) };
  throw new Error(`不支持的产物类型：${ext || '(无扩展名)'}（仅支持 .zip/.deb/.rpm）`);
}

/**
 * 校验单个产物。
 *
 * @param {string} file 产物路径。
 * @returns {{file:string,type:string,total:number,ok:boolean,missing:string[],notExecutable:string[],required:Array<object>}}
 */
export function verifyArtifact(file) {
  const { type, entries } = readArtifact(file);
  const result = checkEntries(entries);
  return { file, type, ...result };
}

/** 供安装器调用的断言版本：失败时抛出带明细的错误。 */
export function assertArtifactComplete(file) {
  const result = verifyArtifact(file);
  if (!result.ok) {
    const details = [];
    if (result.missing.length) details.push(`缺少 ${result.missing.join('、')}`);
    if (result.notExecutable.length) details.push(`缺少可执行位 ${result.notExecutable.join('、')}`);
    throw new Error(`${path.basename(file)} 内容闸门未通过：${details.join('；')}`);
  }
  return result;
}

// ---------------- CLI ----------------

function formatTable(results) {
  const lines = [];
  for (const item of results) {
    if (item.error) {
      lines.push(`FAIL  ${item.file}  ${item.error}`);
      continue;
    }
    const status = item.ok ? 'PASS' : 'FAIL';
    const checks = item.required
      .map((check) => {
        const state = !check.present ? 'MISSING' : check.executable === false ? 'NO-EXEC' : 'OK';
        return `${check.path}=${state}`;
      })
      .join(' ');
    lines.push(`${status}  ${item.type.padEnd(3)}  条目 ${String(item.total).padStart(4)}  ${item.file}`);
    lines.push(`      ${checks}`);
  }
  return lines.join('\n');
}

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((arg) => !arg.startsWith('--'));
  if (!files.length) {
    console.error('用法：node scripts/package/verify-artifacts.mjs <产物.zip|.deb|.rpm ...> [--json]');
    process.exit(2);
  }
  const results = files.map((file) => {
    try {
      return verifyArtifact(path.resolve(file));
    } catch (error) {
      return { file, ok: false, error: error.message };
    }
  });
  if (json) console.log(JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  else console.log(formatTable(results));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv.slice(2));
