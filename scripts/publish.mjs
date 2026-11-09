#!/usr/bin/env node
/**
 * 发布辅助：把本地 main 推送到指定 Git 仓库，并补齐 package.json 的 repository 字段。
 *
 * 用法：
 *   node scripts/publish.mjs <git-url>            # 预演，只打印将要执行的动作
 *   node scripts/publish.mjs <git-url> --apply    # 真正执行（会改 package.json 并 push）
 *
 * 只有显式带 --apply 才会产生外部动作；凭据由本机 git 凭据管理器提供，
 * 本脚本不读取、不存储任何 token。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2];
const apply = process.argv.includes('--apply');

function fail(message) {
  console.error(`[publish] ${message}`);
  process.exit(1);
}

if (!url) {
  fail('缺少仓库地址。示例：node scripts/publish.mjs https://github.com/<owner>/<repo>.git --apply');
}
if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
  fail('仓库地址格式不正确，应形如 https://github.com/<owner>/<repo>.git 或 git@github.com:<owner>/<repo>.git');
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const branch = git('branch', '--show-current');
if (branch !== 'main') fail(`当前分支为 ${branch}，请切回 main 再发布`);
if (git('status', '--porcelain')) fail('工作区有未提交改动，请先提交');

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
const repository = { type: 'git', url };

let remote = '';
const remotes = git('remote').split('\n').filter(Boolean);
if (remotes.includes('origin')) remote = git('remote', 'get-url', 'origin');

console.log('[publish] 计划：');
console.log(`  1. package.json repository = ${JSON.stringify(repository)}`);
console.log(`  2. ${remote ? `git remote set-url origin ${url}` : `git remote add origin ${url}`}`);
console.log(`  3. git push -u origin main`);
console.log(`  4. 到仓库 Actions 页确认 CI（test + build + e2e）全绿`);
console.log('  5. 在仓库 Settings → Branches 为 main 配置「需 PR + CI 通过」保护');

if (!apply) {
  console.log('\n[publish] 预演结束，未做任何改动。加 --apply 才会真正执行。');
  process.exit(0);
}

pkg.repository = repository;
await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
if (remote) git('remote', 'set-url', 'origin', url);
else git('remote', 'add', 'origin', url);

// repository 字段变更需要单独提交，避免混入业务提交。
git('add', 'package.json');
try {
  git('commit', '-m', `chore: 补充 repository 元数据（${url}）`);
} catch {
  console.log('[publish] package.json 无变化或已提交，跳过');
}
git('push', '-u', 'origin', 'main');
console.log('[publish] 推送完成，请在仓库页面核对 CI 与分支保护。');
