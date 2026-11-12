/**
 * 配置文件（KEY=VALUE）解析。
 *
 * 背景：代码中有 101 处 `process.env`、约 40 个可配置项。让现场人员在
 * 系统环境变量里逐条设置既不可发现也不可校验，安装/便携形态需要一个
 * 可读、可备份、可版本对比的配置文件。
 *
 * 规则（刻意保持简单，避免引入配置语法）：
 *   - 每行 `KEY=VALUE`，忽略空行与 `#` 开头的注释
 *   - 支持 `export ` 前缀（方便同时被 shell source）
 *   - 值两端的成对引号会被去掉，行尾同一行注释不解析（值里可含 `#`）
 *   - **不覆盖已存在的环境变量**：环境变量优先，便于临时覆盖与 CI
 *   - KEY 仅允许 `[A-Za-z_][A-Za-z0-9_]*`
 */

import fs from 'node:fs';

/** 合法的环境变量名。 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析配置文件内容。
 *
 * @param {string} content 文件内容。
 * @returns {{entries: Array<{key: string, value: string, line: number}>, errors: Array<{line: number, message: string}>}}
 */
export function parseEnvFile(content) {
  const entries = [];
  const errors = [];
  const lines = String(content ?? '').split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      errors.push({ line: lineNo, message: '缺少 KEY=VALUE 形式' });
      return;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      errors.push({ line: lineNo, message: `非法变量名：${key.slice(0, 40)}` });
      return;
    }
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    entries.push({ key, value, line: lineNo });
  });
  return { entries, errors };
}

/**
 * 读取配置文件并注入环境变量（不覆盖已有值）。
 *
 * @param {string} file 配置文件路径。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] 目标环境对象。
 * @param {Function} [options.readFile] 注入读取函数（测试用）。
 * @returns {{loaded: number, skipped: string[], errors: Array<{line:number,message:string}>, missing: boolean}}
 */
export function loadEnvFile(file, { env = process.env, readFile = fs.readFileSync } = {}) {
  let content;
  try {
    content = readFile(file, 'utf8');
  } catch {
    return { loaded: 0, skipped: [], errors: [], missing: true };
  }
  const { entries, errors } = parseEnvFile(content);
  const skipped = [];
  let loaded = 0;
  for (const { key, value } of entries) {
    if (env[key] !== undefined && env[key] !== '') {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    loaded += 1;
  }
  return { loaded, skipped, errors, missing: false };
}
