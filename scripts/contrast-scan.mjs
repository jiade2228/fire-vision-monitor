/**
 * 浅色主题逐页对比度扫描：真实浏览器走通登录，切到浅色主题，
 * 遍历主要视图与管理面板各 Tab，收集文字元素的有效前景/背景并计算 WCAG 对比度，
 * 输出不达标的违规点（正文 < 4.5:1，大字号/加粗 < 3:1）。
 *
 * 仅用于本地核查浅色主题可读性，不写入任何源码。
 * 用法：node scripts/contrast-scan.mjs   （可选 CONTRAST_OUT=report.json）
 */
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getFreePort } from '../server/test-port.mjs';
import { E2E_ADMIN_PASSWORD } from '../server/test-password.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT) || (await getFreePort());
const base = `http://127.0.0.1:${port}`;
const csrf = { 'X-Requested-With': 'flame-vision' };
const password = E2E_ADMIN_PASSWORD;
const outPath = process.env.CONTRAST_OUT || path.join(root, 'contrast-report.json');

const fsSyncExists = (c) => {
  try {
    return fsSync.existsSync(c);
  } catch {
    return false;
  }
};
function loadPuppeteer() {
  const dirs = [process.env.PUPPETEER_REQUIRE_DIR, path.join(root, 'node_modules/')].filter(Boolean);
  for (const dir of dirs) {
    try {
      return createRequire(dir)('puppeteer-core');
    } catch {
      /* next */
    }
  }
  return null;
}
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.CHROME_PATH,
  ].filter(Boolean);
  return candidates.find(fsSyncExists) ?? null;
}
async function waitFor(predicate, timeoutMs = 10_000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
async function api(pathName, { method = 'GET', body, cookie = '' } = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: {
      ...csrf,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return {
    status: response.status,
    body: payload,
    cookie: (response.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; '),
  };
}

const scanFn = () => {
  const parseRgb = (value) => {
    const nums = String(value ?? '').match(/[\d.]+/g);
    if (!nums || nums.length < 3) return null;
    return {
      rgb: [Number(nums[0]), Number(nums[1]), Number(nums[2])],
      alpha: nums.length > 3 ? Number(nums[3]) : 1,
    };
  };
  const hslToRgb = (h, s, l) => {
    h /= 360;
    s /= 100;
    l /= 100;
    const k = (n) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
  };
  // 把 linear-gradient 的颜色停靠点平均成一个不透明 RGB，作为该层的有效背景。
  const gradientAvg = (image) => {
    const colors = [];
    const re = /(rgb|rgba|hsl|hsla)\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(image))) {
      const parts = m[2].split(/[,\s/]+/).filter(Boolean);
      if (m[1].startsWith('rgb')) colors.push(parts.slice(0, 3).map(Number));
      else colors.push(hslToRgb(Number(parts[0]), Number(parts[1]), Number(parts[2])));
    }
    if (!colors.length) return null;
    return colors
      .reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]], [0, 0, 0])
      .map((n) => Math.round(n / colors.length));
  };
  // 从元素（文字所在元素）向上，按「绘制顺序」合成有效背景：
  // 元素自身背景在最上层，祖先背景在下层。每遇到一层不透明背景（纯色 alpha=1 或渐变），
  // 它只会填充当前「尚未被覆盖」的透明度；一旦累计不透明度达到 1，更上层的背景不可见，即可停止。
  // 这样可避免旧逻辑把「任意一个渐变祖先」误当成最终背景、从而忽略元素自身不透明背景的假阴性/假阳性。
  const resolveBg = (el) => {
    let r = 255, g = 255, b = 255, a = 0;
    let node = el;
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const image = style.backgroundImage;
      if (image && image !== 'none') {
        const grad = gradientAvg(image);
        if (grad && a < 1) {
          // 渐变是不透明层，仅覆盖仍透明部分；其下（已合成进 base）的更上层背景不受影响。
          r = grad[0]; g = grad[1]; b = grad[2]; a = 1;
        }
        // 渐变已是不透明层，其下任何背景都不可见，停止遍历。
        break;
      }
      const bg = parseRgb(style.backgroundColor);
      if (bg && bg.alpha > 0 && a < 1) {
        const contribution = bg.alpha * (1 - a);
        r = bg.rgb[0] * contribution + r * (1 - contribution);
        g = bg.rgb[1] * contribution + g * (1 - contribution);
        b = bg.rgb[2] * contribution + b * (1 - contribution);
        a += contribution;
        if (a >= 0.999) break;
      }
      node = node.parentElement;
    }
    return { rgb: [r, g, b] };
  };
  const lum = ([r, g, b]) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg, bg) => {
    const l1 = lum(fg);
    const l2 = lum(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const out = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    // SVG 元素的 offsetParent 恒为 undefined，旧判断会把 <svg>/<text>/<rect>
    // 全部跳过（统计图表从未进入扫描）。改用可见包围盒判断。
    let visible;
    if (el instanceof SVGElement) {
      const box = el.getBoundingClientRect();
      visible = box.width > 0 && box.height > 0;
    } else {
      visible = Boolean(el.offsetParent) || el === document.body;
    }
    if (!visible) continue;
    const text = (el.textContent || '').trim();
    if (!text || text.length > 120) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const fg = parseRgb(style.color);
    if (!fg) continue;
    const resolved = resolveBg(el);
    if (resolved.gradient || !resolved.rgb) continue;
    const fsPx = parseFloat(style.fontSize) || 16;
    const weight = parseInt(style.fontWeight, 10) || 400;
    const bold = weight >= 700;
    const large = fsPx >= 24 || (fsPx >= 18.66 && bold);
    const threshold = large ? 3 : 4.5;
    const r = ratio(fg.rgb, resolved.rgb);
    if (r < threshold) {
      const signature = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')}`;
      out.push({
        signature,
        text: text.slice(0, 40),
        fg: style.color,
        bg: `rgb(${resolved.rgb.map((n) => Math.round(n)).join(', ')})`,
        ratio: Number(r.toFixed(2)),
        fontSize: fsPx,
        bold,
      });
    }
  }
  return out;
};

async function main() {
  const puppeteer = loadPuppeteer();
  const executablePath = findChrome();
  if (!puppeteer || !executablePath) {
    console.log('对比度扫描跳过：未找到 Chrome 或 puppeteer-core');
    process.exit(0);
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-contrast-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: { ...process.env, DATA_DIR: dataDir, MAX_CONCURRENT_STREAMS: '1', OFFLINE_TIMEOUT_MS: '120000', OFFLINE_CHECK_INTERVAL_MS: '15000' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.resume();
  const browser = await puppeteer.launch({
    executablePath,
    headless: process.env.E2E_HEADED !== '1',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const report = {};
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      try {
        const r = await fetch(`${base}/api/auth/status`);
        if (r.ok) break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const setup = await api('/api/setup', { method: 'POST', body: { username: 'admin', displayName: '扫描管理员', password } });
    if (setup.status !== 201) throw new Error(`setup 失败：${setup.status}`);
    const adminCookie = setup.cookie;
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 500));
    await page.type('[data-testid="login-username"]', 'admin');
    await page.type('input[type="password"]', password);
    await page.evaluate(() => document.querySelector('[data-testid="login-submit"]')?.click());
    await waitFor(() => page.evaluate(() => Boolean(document.querySelector('.video-wall') || document.querySelector('.tile'))), 8000);

    // 建一个真实点位，供各 Tab 有内容可扫。
    const cam = await api('/api/cameras', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '扫描点位', zone: '扫描区', protocol: 'none', enabled: true, detectEnabled: true },
    });
    const cameraId = cam.body?.camera?.id;
    if (cameraId) {
      await api('/api/alarms', { method: 'POST', cookie: adminCookie, body: { cameraId, level: 'fire', confidence: 90, hotspot: { x: 40, y: 60 } } });
    }

    // 切浅色主题
    await page.evaluate(() => document.querySelector('.topbar-theme')?.click());
    await waitFor(() => page.evaluate(() => document.documentElement.dataset.theme === 'light'), 4000);

    const gotoView = async (testId) => {
      await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`)?.click(), testId);
      await new Promise((r) => setTimeout(r, 500));
    };
    const openAdminTab = async (label) => {
      await page.evaluate(() => document.querySelector('[data-testid="open-admin"]')?.click());
      await new Promise((r) => setTimeout(r, 400));
      await page.evaluate((lbl) => {
        const btns = [...document.querySelectorAll('.admin-tab')];
        const btn = btns.find((b) => (b.textContent || '').includes(lbl));
        btn?.click();
      }, label);
      await new Promise((r) => setTimeout(r, 500));
    };

    const scan = async (pageName) => {
      await new Promise((r) => setTimeout(r, 400));
      const items = await page.evaluate(scanFn);
      report[pageName] = items;
      console.log(`  ${pageName}: ${items.length} 处对比度不达标`);
    };

    await scan('monitor');

    // 动态状态覆盖：Toast 与错误提示平时不渲染，旧扫描的「0 违规」从未覆盖它们。
    // 这里按真实类名注入三种 Toast 与全局错误条，单独扫一次后立即移除。
    await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.id = 'contrast-probe-states';
      holder.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;display:flex;gap:4px;flex-wrap:wrap;max-width:600px';
      for (const [kind, text] of [
        ['', '操作已完成'],
        ['toast--danger', '操作失败，请重试'],
        ['toast--ok', '保存成功'],
      ]) {
        const el = document.createElement('div');
        el.className = `toast ${kind}`.trim();
        el.textContent = text;
        holder.appendChild(el);
      }
      const err = document.createElement('p');
      err.className = 'admin-error';
      err.textContent = '保存失败：点位名称不能为空';
      holder.appendChild(err);
      const warn = document.createElement('span');
      warn.className = 'pill pill--warn';
      warn.textContent = '实时推送中断 · 重连中';
      holder.appendChild(warn);
      document.body.appendChild(holder);
    });
    await scan('feedback-states');
    await page.evaluate(() => document.getElementById('contrast-probe-states')?.remove());

    await gotoView('nav-tab-alarms');
    await scan('alarms');
    await gotoView('nav-tab-records');
    await scan('records');
    await openAdminTab('点位');
    await scan('admin-cameras');
    await openAdminTab('账号');
    await scan('admin-users');
    await openAdminTab('站点');
    await scan('admin-sites');
    await openAdminTab('统计');
    await scan('admin-stats');
    await openAdminTab('通知');
    await scan('admin-notify');
    await openAdminTab('审计');
    await scan('admin-audit');
  } catch (error) {
    console.error('对比度扫描异常：', error.message);
  } finally {
    await browser.close().catch(() => undefined);
    if (child.exitCode === null) child.kill('SIGTERM');
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  const total = Object.values(report).reduce((n, arr) => n + arr.length, 0);
  console.log(`\n对比度扫描完成，共 ${total} 处不达标，报告已写入 ${outPath}`);
  process.exit(0);
}

await main();
