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
    process.env.PUPPETEER_REQUIRE_DIR,
    path.join(root, 'node_modules/'),
  ].filter(Boolean);
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

    await page.type('[data-testid="login-username"]', 'admin');
    await page.type('input[type="password"]', password);
    await page.evaluate(() => {
      document.querySelector('[data-testid="login-submit"]')?.click();
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
      document.querySelector('[data-testid="open-admin"]')?.click();
    });
    check(
      '管理面板打开',
      await waitFor(() => page.evaluate(() => Boolean(document.querySelector('#admin-title'))), 6000),
    );

    await page.evaluate(() => {
      document.querySelector('[data-testid="point-add-single"]')?.click();
    });
    const filled = await page.evaluate(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      const fill = (testId, value) => {
        const input = document.querySelector(`[data-testid="${testId}"]`);
        if (!input) return false;
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const okName = fill('point-name-input', 'E2E 测试点位');
      const okZone = fill('point-zone-input', 'E2E 区');
      return okName && okZone;
    });
    check('点位表单填写成功', filled);

    await page.evaluate(() => {
      document.querySelector('[data-testid="point-save"]')?.click();
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
      document.querySelector('[data-testid="nav-tab-alarms"]')?.click();
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
        Boolean(document.querySelector('[data-testid="alarm-confirm"]')),
      );
      if (!visible) {
        await page.evaluate(() => document.querySelector('.alarm-head')?.click());
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return visible;
    }, 6000);
    check('告警卡片展开且出现确认按钮', confirmVisible);
    await page.evaluate(() => {
      document.querySelector('[data-testid="alarm-confirm"]')?.click();
    });
    check(
      '确认后状态变为处置中',
      await waitFor(
        () =>
          page.evaluate(() =>
            [...document.querySelectorAll('[data-testid="alarm-status-chip"]')].some(
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
        document.querySelector('[data-testid="nav-tab-monitor"]')?.click();
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await page.evaluate(() => window.scrollTo(0, 0));
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.uploadFile(fireSample);
        const alarmVisible = await waitFor(
          () =>
            page.evaluate(
              () => Boolean(document.querySelector('[data-testid="alarm-confirm"]')),
            ),
          60_000,
        );
        check('本地视频测试产生告警', alarmVisible);
        if (alarmVisible) {
          await page.evaluate(() => {
            const tile = document.querySelector('.camera-tile');
            tile?.querySelector('[data-testid="tile-disconnect"]')?.click();
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

    // 主题切换：手动切换后 CSS 变量生效，刷新后仍保持（验证持久化与防闪烁初始化）。
    if (await page.$('.topbar-theme')) {
      const shellBefore = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.app-shell') ?? document.body)
          .backgroundImage,
      );
      await page.click('.topbar-theme');
      const switched = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        bg: getComputedStyle(document.body).backgroundColor,
        shell: getComputedStyle(document.querySelector('.app-shell') ?? document.body)
          .backgroundImage,
      }));
      check(
        '切换浅色主题后配色生效',
        switched.theme === 'light' &&
          switched.scheme === 'light' &&
          switched.bg !== 'rgb(7, 12, 20)' &&
          switched.shell !== shellBefore,
        JSON.stringify(switched),
      );
      // 浅色主题逐容器对比度：只判定前景/背景色都明确（不透明、非渐变）的容器；
      // 透明 / 半透明 / 渐变背景会与父级混合，无法单独判定，按规格跳过，避免假失败。
      let contrast = null;
      let contrastError = '';
      try {
        contrast = await page.evaluate(() => {
          const selectors = ['.app-shell', '.topbar', '.panel', '.topbar-user', 'body'];
          const parse = (value) => {
            const nums = String(value ?? '').match(/[\d.]+/g);
            if (!nums || nums.length < 3) return null;
            return {
              rgb: [Number(nums[0]), Number(nums[1]), Number(nums[2])],
              alpha: nums.length > 3 ? Number(nums[3]) : 1,
            };
          };
          const lum = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
          const results = [];
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (!el) {
              results.push({ selector, skipped: true, reason: '未找到元素' });
              continue;
            }
            const style = getComputedStyle(el);
            const color = style.color;
            const backgroundColor = style.backgroundColor;
            const fg = parse(color);
            const bg = parse(backgroundColor);
            if (!fg || !bg || bg.alpha < 1) {
              results.push({
                selector,
                color,
                backgroundColor,
                skipped: true,
                reason: '透明/半透明/渐变背景或颜色不可解析',
              });
              continue;
            }
            const textLum = lum(fg.rgb);
            const bgLum = lum(bg.rgb);
            results.push({
              selector,
              color,
              backgroundColor,
              skipped: false,
              textLum: Number(textLum.toFixed(3)),
              bgLum: Number(bgLum.toFixed(3)),
              diff: Number(Math.abs(textLum - bgLum).toFixed(3)),
            });
          }
          return results;
        });
      } catch (error) {
        contrastError = error.message;
      }
      const judged = (contrast ?? []).filter((item) => !item.skipped);
      const contrastOk =
        !contrastError && (judged.length === 0 || judged.every((item) => item.diff >= 0.25));
      let contrastDetail;
      if (contrastError) {
        contrastDetail = `取值失败：${contrastError}`;
      } else if (judged.length === 0) {
        contrastDetail = `全部透明背景，已跳过 — ${JSON.stringify(contrast)}`;
      } else {
        contrastDetail = JSON.stringify(contrast);
      }
      check('浅色主题主要容器文字/背景对比度达标', contrastOk, contrastDetail);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
      check('刷新后主题保持', persisted === 'light', String(persisted));
    } else {
      check('主题切换按钮存在', false, '未找到 .topbar-theme');
    }

    // ---------- 持续录像回放端点回归（追加） ----------
    // 只写假 TS 段：FFmpeg 无法解码，故仅断言会话创建/状态字段，不断言分片内容。
    const cameraId = target.id; // E2E 已建真实点位（UUID，仅含 [A-Za-z0-9_-]）
    const continuousRoot = path.join(dataDir, 'continuous');
    const cameraSegDir = path.join(continuousRoot, cameraId);
    const pad2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    // 目录 YYYYMMDD / 文件 HHmmss.ts 与 epoch ms 一律按 UTC 解释（对齐 recording-index.mjs）。
    const segmentStartMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
    );
    const utcDate = `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
    const segPathOf = (epochMs) => {
      const d = new Date(epochMs);
      const day = `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
      const file = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}.ts`;
      return path.join(cameraSegDir, day, file);
    };
    const segmentFiles = [segmentStartMs, segmentStartMs + 30_000].map(segPathOf);

    check('录像点位 ID 符合段路径字符集', /^[A-Za-z0-9_-]+$/.test(cameraId), String(cameraId));

    let wrote = 0;
    let writeError = '';
    try {
      for (const file of segmentFiles) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, 'E2E fake recording segment');
        wrote += 1;
      }
    } catch (error) {
      writeError = error.message;
    }
    check(
      '写入假录像段文件',
      wrote === segmentFiles.length,
      writeError || `${wrote}/${segmentFiles.length}`,
    );

    try {
      const reconcile = await api('/api/recordings/reconcile', {
        method: 'POST',
        cookie: adminCookie,
      });
      check(
        '录像对账补录假段',
        (reconcile.body?.inserted ?? 0) >= 1,
        JSON.stringify(reconcile.body),
      );

      const timeline = await api(
        `/api/recordings/timeline?cameraId=${encodeURIComponent(cameraId)}&date=${utcDate}`,
        { cookie: adminCookie },
      );
      const blocks = timeline.body?.timeline?.blocks;
      check(
        '录像时间线出现可用块',
        timeline.status === 200 && Array.isArray(blocks) && blocks.length >= 1,
        JSON.stringify(timeline.body?.timeline ?? timeline.body),
      );

      const recStatus = await api('/api/recordings/status', { cookie: adminCookie });
      check(
        '录像状态端点返回采集字段',
        recStatus.status === 200 &&
          recStatus.body !== null &&
          typeof recStatus.body === 'object' &&
          'enabled' in recStatus.body &&
          'ffmpegAvailable' in recStatus.body &&
          'retentionDays' in recStatus.body,
        JSON.stringify(recStatus.body),
      );

      const playFrom = segmentStartMs - 1000;
      const playTo = segmentStartMs + 120000;
      const play = await api(
        `/api/recordings/play?cameraId=${encodeURIComponent(cameraId)}&from=${playFrom}&to=${playTo}`,
        { cookie: adminCookie },
      );
      const playlist = typeof play.body?.playlist === 'string' ? play.body.playlist : '';
      const sessionId = typeof play.body?.sessionId === 'string' ? play.body.sessionId : '';
      check(
        '回放会话创建成功且返回 playlist',
        play.status === 200 && playlist.startsWith('/api/recordings/play/'),
        `status=${play.status}, sessionId=${sessionId}, playlist=${playlist}`,
      );

      const playStatus = sessionId
        ? await api(`/api/recordings/play/${encodeURIComponent(sessionId)}/status`, {
            cookie: adminCookie,
          })
        : { status: 0, body: null };
      check(
        '回放会话状态端点返回 state',
        ['pending', 'ready', 'failed'].includes(playStatus.body?.state),
        `status=${playStatus.status}, body=${JSON.stringify(playStatus.body)}`,
      );

      const missingCamera = await api(
        `/api/recordings/play?cameraId=__not_exist__&from=${playFrom}&to=${playTo}`,
        { cookie: adminCookie },
      );
      check('不存在点位回放返回 404', missingCamera.status === 404, `status=${missingCamera.status}`);
    } catch (error) {
      check('录像端点回归未抛异常', false, error.message);
    } finally {
      // 只删本次写入的 cameraId 子目录，不动 continuous 下其它内容；失败用 check 记录。
      try {
        await fs.rm(cameraSegDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        check('清理假录像段目录', true);
      } catch (error) {
        check('清理假录像段目录', false, error.message);
      }
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
