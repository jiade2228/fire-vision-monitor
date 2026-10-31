import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FlameDetector } from '../server/detector.mjs';

/**
 * 本地视频检测预验：不接入平台也能知道一段视频会不会被识别为火焰/烟雾。
 * 用法：node scripts/detect-file.mjs <视频文件> [low|standard|high]
 *
 * 抽帧参数与服务端检测引擎完全一致（1fps → 160×90 等比缩放+补边 → RGBA），
 * 因此结果就是该视频接入平台后的预期表现。
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const sensitivity = process.argv[3] || 'standard';
if (!file) {
  console.error('用法: node scripts/detect-file.mjs <视频文件> [low|standard|high]');
  process.exit(2);
}
const width = 160;
const height = 90;
const frameBytes = width * height * 4;

const args = [
  '-v',
  'error',
  '-nostdin',
  '-i',
  path.resolve(file),
  '-an',
  '-vf',
  `fps=1,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
  '-f',
  'rawvideo',
  '-pix_fmt',
  'rgba',
  'pipe:1',
];
const child = spawn('ffmpeg', args, {
  cwd: projectRoot,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const detector = new FlameDetector(sensitivity, 12_000);
const hits = [];
let frames = 0;
let buffer = Buffer.alloc(0);

child.stdout.on('data', (chunk) => {
  buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
  while (buffer.length - 0 >= frameBytes && buffer.length >= frameBytes) {
    const frame = buffer.subarray(0, frameBytes);
    buffer = buffer.subarray(frameBytes);
    frames += 1;
    const result = detector.analyze(Buffer.from(frame), width, height);
    if (result) {
      hits.push({
        atSecond: frames,
        level: result.level,
        confidence: result.confidence,
        hotspot: result.hotspot,
      });
    }
  }
});

child.on('error', (error) => {
  console.error(`FFmpeg 启动失败：${error.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  if (code !== 0) {
    console.error(`FFmpeg 退出码 ${code}，无法解码该文件`);
    process.exit(1);
  }
  const levels = [...new Set(hits.map((hit) => hit.level))];
  console.log(
    JSON.stringify(
      {
        file: path.basename(file),
        sensitivity,
        frames,
        hits: hits.length,
        levels,
        first: hits[0] ?? null,
      },
      null,
      1,
    ),
  );
  if (hits.length === 0) {
    console.log('结论：全程未触发告警（对「正常场景」样本即预期结果）。');
  } else {
    const label = levels.includes('fire') ? '火焰' : levels.includes('smoke') ? '烟雾' : '离线';
    console.log(`结论：第 ${hits[0].atSecond} 秒左右判定为${label}（共 ${hits.length} 次命中，含冷却去重）。`);
  }
});
