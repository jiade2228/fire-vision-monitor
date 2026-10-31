import { spawn, spawnSync } from 'node:child_process';

export function ffprobeAvailable(ffprobePath = process.env.FFPROBE_PATH || 'ffprobe') {
  const result = spawnSync(ffprobePath, ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0;
}

function sanitize(value) {
  return String(value ?? '')
    .replace(/rtsps?:\/\/[^\s@]+@/gi, 'rtsp://***@')
    .replace(/https?:\/\/[^\s]+@/gi, 'https://***@')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export function probeStream({
  sourceUrl,
  protocol = 'rtsp',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  timeoutMs = Number(process.env.PROBE_TIMEOUT_MS) || 12_000,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [
      '-v',
      'error',
      '-rw_timeout',
      String(Math.max(timeoutMs - 1000, 1000) * 1000),
      ...(protocol === 'rtsp' ? ['-rtsp_transport', 'tcp'] : []),
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate:format=format_name',
      '-of',
      'json',
      sourceUrl,
    ];
    const child = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-32_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: sanitize(error.message),
      });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: `测流超时（${Math.round(timeoutMs / 1000)} 秒），请检查设备地址、网络或凭据`,
        });
        return;
      }
      if (code !== 0) {
        resolve({
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: sanitize(stderr) || `FFprobe 退出码 ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const video = parsed.streams?.[0] ?? {};
        resolve({
          ok: true,
          latencyMs: Date.now() - startedAt,
          codec: video.codec_name ?? null,
          width: video.width ?? null,
          height: video.height ?? null,
          fps: video.avg_frame_rate ?? null,
          format: parsed.format?.format_name ?? null,
        });
      } catch {
        resolve({
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: '无法解析 FFprobe 输出',
        });
      }
    });
  });
}
