import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDORS_BY_ID, buildVendorUrl } from './vendors.mjs';
import { probeStream } from './probe.mjs';

export function loadPlan(config) {
  if (!config || !Array.isArray(config.devices) || config.devices.length === 0) {
    throw new Error('配置中缺少 devices 数组');
  }
  return config.devices.map((device, index) => {
    const vendor = VENDORS_BY_ID.get(device.vendorId);
    if (!vendor) throw new Error(`设备 ${index + 1} 的品牌 ${device.vendorId} 不受支持`);
    const password = device.passwordEnv
      ? process.env[device.passwordEnv]
      : device.password;
    if (!password) {
      throw new Error(
        `设备 ${device.name ?? index + 1} 缺少密码：设置 ${device.passwordEnv ?? 'password'}`,
      );
    }
    if (!device.host || !/^[a-zA-Z0-9.-]{1,253}$/.test(device.host)) {
      throw new Error(`设备 ${device.name ?? index + 1} 的 host 无效`);
    }
    const port = Number(device.port ?? vendor.defaultPort);
    const count = vendor.singleChannel ? 1 : Math.min(Math.max(Number(device.count) || 1, 1), 64);
    const startChannel = vendor.singleChannel ? 1 : Math.max(Number(device.startChannel) || 1, 1);
    const requestedStreams = Array.isArray(device.streams) ? device.streams : ['main', 'sub'];
    const streams = vendor.supportsSubstream === false
      ? ['main']
      : requestedStreams.filter((value) => value === 'main' || value === 'sub');
    if (!streams.length) throw new Error('streams 至少需要 main 或 sub');
    return {
      id: `D${index + 1}`,
      name: String(device.name ?? `设备 ${index + 1}`),
      vendor,
      host: device.host,
      port,
      username: String(device.username ?? ''),
      password: String(password),
      startChannel,
      count,
      streams,
      template: device.template,
    };
  });
}

export function buildProbeCases(plan) {
  const cases = [];
  for (const device of plan) {
    for (let offset = 0; offset < device.count; offset += 1) {
      const channel = device.startChannel + offset;
      for (const stream of device.streams) {
        const sourceUrl = buildVendorUrl(device.vendor, {
          username: device.username,
          password: device.password,
          host: device.host,
          port: device.port,
          channel,
          stream,
          template: device.template,
        });
        cases.push({
          deviceId: device.id,
          deviceName: device.name,
          vendorId: device.vendor.id,
          vendorName: device.vendor.name,
          channel,
          stream,
          sourceUrl,
        });
      }
    }
  }
  return cases;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), 4) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function resultRow(item, result) {
  return {
    device: item.deviceName,
    vendor: item.vendorName,
    channel: item.channel,
    stream: item.stream,
    ok: result.ok,
    latencyMs: result.latencyMs,
    codec: result.codec ?? '',
    width: result.width ?? '',
    height: result.height ?? '',
    fps: result.fps ?? '',
    error: result.error ?? '',
  };
}

export function toCsv(rows) {
  const headers = [
    'device',
    'vendor',
    'channel',
    'stream',
    'ok',
    'latencyMs',
    'codec',
    'width',
    'height',
    'fps',
    'error',
  ];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    result[arg.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--')
      ? argv[++index]
      : true;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    console.error(
      '用法: node server/nvr-probe.mjs --config devices.json [--out report.json] [--csv report.csv] [--concurrency 2] [--timeout 12000]',
    );
    process.exit(2);
  }
  const configPath = path.resolve(String(args.config));
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const plan = loadPlan(config);
  const cases = buildProbeCases(plan);
  const timeoutMs = Number(args.timeout) || Number(process.env.PROBE_TIMEOUT_MS) || 12_000;
  const concurrency = Number(args.concurrency) || 2;
  console.log(
    `NVR 联调计划：${plan.length} 台设备，${cases.length} 个测试项，并发 ${concurrency}`,
  );

  const rows = await runPool(cases, concurrency, async (item) => {
    const result = await probeStream({
      sourceUrl: item.sourceUrl,
      protocol: 'rtsp',
      timeoutMs,
    });
    const row = resultRow(item, result);
    console.log(
      `${row.ok ? 'PASS' : 'FAIL'} ${row.device} ch${row.channel} ${row.stream} ` +
        (row.ok
          ? `${row.codec} ${row.width}x${row.height} ${row.latencyMs}ms`
          : row.error),
    );
    return row;
  });

  const passed = rows.filter((row) => row.ok).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    passed,
    failed: rows.length - passed,
    devices: plan.map((device) => ({
      name: device.name,
      vendor: device.vendor.name,
      host: device.host,
      count: device.count,
    })),
    results: rows,
  };
  console.log(`结果：${passed}/${rows.length} 通过`);
  if (args.out) {
    const out = path.resolve(String(args.out));
    await fs.writeFile(out, JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(`JSON 报告：${out}`);
  }
  if (args.csv) {
    const csv = path.resolve(String(args.csv));
    await fs.writeFile(csv, toCsv(rows), { mode: 0o600 });
    console.log(`CSV 报告：${csv}`);
  }
  if (passed !== rows.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
