/**
 * 最小 ZIP 写入器（无外部依赖）。
 *
 * 为什么自己实现：打包需要生成 `.zip`，但各平台工具行为不一致 ——
 *   - Git Bash 自带的是 GNU tar，`tar -a -c -f x.zip` 不会生成 zip，
 *     而是生成 tar 归档却用 .zip 扩展名（文件头是文件名而非 `PK`），
 *     用户双击解压会失败；
 *   - Windows 自带的 bsdtar 支持 zip，但 PATH 里常先命中 GNU tar；
 *   - `zip` 命令在 Windows 上通常不存在。
 * 为避免"本机打包成功、用户解压失败"，这里用 Node 内置 zlib 直接写 ZIP。
 *
 * 支持：UTF-8 文件名、deflate 压缩、单文件 < 4GB（不需要 zip64）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** CRC32 查表（IEEE 802.3，ZIP 使用）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/**
 * 计算 CRC32。
 * @param {Buffer} buffer 数据。
 * @returns {number} 无符号 32 位 CRC。
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 把 Date 转成 MS-DOS 时间/日期对。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time: time & 0xffff, date: day & 0xffff };
}

/** 递归列出目录下所有文件（返回相对路径，统一用 `/`）。 */
function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      result.push(...listFiles(root, rel));
    } else if (entry.isFile()) {
      result.push(rel);
    }
  }
  return result;
}

/**
 * 把目录打包成 ZIP。
 *
 * @param {object} options
 * @param {string} options.sourceDir 要打包的目录。
 * @param {string} options.outFile 输出 zip 路径。
 * @param {string} [options.rootName] 包内顶层目录名（默认用 sourceDir 的 basename）。
 * @param {number} [options.level] deflate 级别（0 表示仅存储）。
 * @returns {{files: number, bytes: number, outBytes: number}}
 */
export function zipDirectory({ sourceDir, outFile, rootName, level = 6 }) {
  const root = path.basename(path.resolve(sourceDir));
  const top = rootName ?? root;
  const files = listFiles(sourceDir);
  const now = new Date();
  const { time, date } = dosDateTime(now);

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const rel of files) {
    const absolute = path.join(sourceDir, rel);
    const data = fs.readFileSync(absolute);
    const name = `${top}/${rel}`;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const compressed = level > 0 ? zlib.deflateRawSync(data, { level }) : data;
    // 压缩后反而更大时改用存储，避免无意义膨胀。
    const useDeflate = level > 0 && compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用标志：UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra 长度

    localChunks.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42); // 本地头偏移

    centralChunks.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outFile, Buffer.concat([...localChunks, centralBuffer, eocd]));
  return {
    files: files.length,
    bytes: fs.statSync(outFile).size,
    outBytes: fs.statSync(outFile).size,
  };
}
