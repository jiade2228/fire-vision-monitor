/**
 * E2E 冒烟测试：真实浏览器走通「登录 → 建点位 → 告警推送 → 处置确认」。
 *
 * 依赖本机 Chrome 与 hallmark 技能自带的 puppeteer-core；任一缺失时跳过并返回 0，
 * 方便在没有浏览器环境的机器上照常跑 npm test。
 *
 * 用法：npm run e2e   （或 E2E_HEADED=1 npm run e2e 打开窗口调试）
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

const fsSyncExists = (candidate) => {
  try {
    return fsSync.existsSync(candidate);
  } catch {
    return false;
  }
};

function loadPuppeteer() {
  const skillDirs = [
    'C:/Users/87304/.workbuddy/skills/hallmark/',
    path.join(root, 'node_modules/'),
  ];
  for (const dir of skillDirs) {
    try {
      return createRequire(dir)('puppeteer-core');
    } catch {
      // try next
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
  return candidates.find((candidate) => fsSyncExists(candidate)) ?? null;
}

async function waitFor(predicate, timeoutMs = 10_000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
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
    cookie: (response.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(';')[0])
      .join('; '),
  };
}

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const puppeteer = loadPuppeteer();
  const executablePath = findChrome();
  if (!puppeteer || !executablePath) {
    console.log('E2E 跳过：未找到 Chrome 或 puppeteer-core（npm test 仍会覆盖接口层）');
    process.exit(0);
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fire-e2e-'));
  const child = spawn(process.execPath, ['server/index.mjs', '--port', String(port)], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MAX_CONCURRENT_STREAMS: '1',
      OFFLINE_TIMEOUT_MS: '120000',
      OFFLINE_CHECK_INTERVAL_MS: '15000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.resume();

  const browser = await puppeteer.launch({
    executablePath,
    headless: process.env.E2E_HEADED !== '1',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
      try {
        const response = await fetch(`${base}/api/auth/status`);
        if (response.ok) break;
      } catch {
        // waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const setup = await api('/api/setup', {
      method: 'POST',
      body: { username: 'admin', displayName: 'E2E 管理员', password },
    });
    if (setup.status !== 201) throw new Error(`setup 失败：${setup.status}`);
    const adminCookie = setup.cookie;

    const page = await browser.newPage();
    await page.setViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    await page.goto(base, { waitUntil: 'networkidle2', timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));

    await page.type('input[placeholder="请输入用户名"]', 'admin');
    await page.type('input[type="password"]', password);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.textContent.trim() === '登录',
      );
      button?.click();
    });
    check(
      '登录后进入监控视图',
      await waitFor(
        () =>
          page.evaluate(() =>
            Boolean(document.querySelector('.video-wall') || document.querySelector('.tile')),
          ),
        8000,
      ),
    );

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((item) =>
        item.textContent.includes('系统管理'),
      );
      button?.click();
    });
    check(
      '管理面板打开',
      await waitFor(() => page.evaluate(() => Boolean(document.querySelector('#admin-title'))), 6000),
    );

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((item) =>
        item.textContent.includes('新增单个点位'),
      );
      button?.click();
    });
    const filled = await page.evaluate(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      const fill = (labelText, value) => {
        const label = [...document.querySelectorAll('label')].find((item) =>
          item.textContent.includes(labelText),
        );
        const input = label?.querySelector('input');
        if (!input) return false;
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const okName = fill('点位名称', 'E2E 测试点位');
      const okZone = fill('所属区域', 'E2E 区');
      return okName && okZone;
    });
    check('点位表单填写成功', filled);

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.textContent.trim() === '保存点位',
      );
      button?.click();
    });
    check(
      '点位列表出现新点位',
      await waitFor(
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.point-main strong')].some(
              (item) => item.textContent === 'E2E 测试点位',
            ),
          ),
        8000,
      ),
    );

    await page.evaluate(() => {
      document.querySelector('.settings-close')?.click();
    });
    await page.evaluate(() => {
      const tab = [...document.querySelectorAll('.nav-tab')].find((item) =>
        item.textContent.includes('告警中心'),
      );
      tab?.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const cameras = await api('/api/cameras', { cookie: adminCookie });
    const target = cameras.body.cameras.find((camera) => camera.name === 'E2E 测试点位');
    if (!target) throw new Error('未通过接口找到新建点位');
    const alarm = await api('/api/alarms', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        cameraId: target.id,
        level: 'fire',
        confidence: 90,
        hotspot: { x: 40, y: 60 },
      },
    });
    check('接口创建火焰告警', alarm.status === 201);

    check(
      'SSE 推送后告警卡片出现',
      await waitFor(
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.alarm-card')].some((item) =>
              item.textContent.includes('E2E 测试点位'),
            ),
          ),
        8000,
      ),
    );

    // 应用会自动展开最新待处置告警：只有按钮不在 DOM 里才需要点一次展开，避免把卡片点折叠。
    const confirmVisible = await waitFor(async () => {
      const visible = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some(
          (item) => item.textContent.trim() === '确认火情',
        ),
      );
      if (!visible) {
        await page.evaluate(() => document.querySelector('.alarm-head')?.click());
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return visible;
    }, 6000);
    check('告警卡片展开且出现确认按钮', confirmVisible);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (item) => item.textContent.trim() === '确认火情',
      );
      button?.click();
    });
    check(
      '确认后状态变为处置中',
      await waitFor(
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll('.status-chip')].some(
              (item) => item.textContent.trim() === '处置中',
            ),
          ),
        8000,
      ),
    );

    const layout = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    check('390px 视口无横向溢出', layout.scroll <= layout.viewport, JSON.stringify(layout));

    // 本地视频测试回归：上传火灾样本 → 告警弹出 → 断开后检测框/光晕必须消失
    // （曾出现断开后告警框残留）。样本只在本地有（test-videos 不入库），缺失则跳过。
    const fireSample = path.join(root, 'test-videos', '火灾-酒精壁炉明火.webm');
    if (fsSync.existsSync(fireSample)) {
      await page.setViewport({ width: 1440, height: 900 });
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((item) =>
          item.textContent.includes('监控'),
        );
        button?.click();
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await page.evaluate(() => window.scrollTo(0, 0));
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(fireSample);
        const alarmVisible = await waitFor(
          () =>
            page.evaluate(
              () =>
                [...document.querySelectorAll('button')].some((item) =>
                  item.textContent.includes('确认火情'),
                ),
            ),
          60_000,
        );
        check('本地视频测试产生告警', alarmVisible);
        if (alarmVisible) {
          await page.evaluate(() => {
            const tile = document.querySelector('.camera-tile');
            const button = [...(tile?.querySelectorAll('button') ?? [])].find((item) =>
              item.textContent.includes('断开'),
            );
            button?.click();
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          const cleaned = await page.evaluate(() => {
            const tile = document.querySelector('.camera-tile');
            return {
              hasVideo: Boolean(tile?.querySelector('video')),
              hasDetectBox: Boolean(tile?.querySelector('.detect-box')),
              hasGlow: Boolean(tile?.querySelector('.tile-alert-glow')),
            };
          });
          check(
            '断开后检测框与光晕消失',
            !cleaned.hasVideo && !cleaned.hasDetectBox && !cleaned.hasGlow,
            JSON.stringify(cleaned),
          );
        }
      }
    } else {
      console.log('  --  本地视频测试回归：未找到 test-videos 样本，跳过');
    }

    console.log(failures === 0 ? 'E2E 全部通过' : `E2E 失败 ${failures} 项`);
  } catch (error) {
    failures += 1;
    console.error('E2E 异常：', error.message);
  } finally {
    await browser.close().catch(() => undefined);
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await fs.rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
