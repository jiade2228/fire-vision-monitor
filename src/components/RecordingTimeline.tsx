import { useCallback, useEffect, useState } from 'react';
import type { Camera } from '../types';
import { api, type RecordingTimelineResponse } from '../lib/api';
import { formatDateTime } from '../lib/format';

interface Props {
  cameras: Camera[];
}

/** 本地日历日的 [00:00, 次日 00:00) 转 epoch ms，服务端文件名按 UTC 解释。 */
function localDayRange(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const from = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  const to = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
  return { from, to };
}

function todayValue() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 持续录像时间线（设计文档 §7 的骨架）。
 * 当前阶段只消费索引：展示有录像的连续块、告警保护段与无录像缺口，
 * 点击块可定位时刻；播放/导出接口需采集 worker 与按需转码在真机联调后开放。
 */
export default function RecordingTimeline({ cameras }: Props) {
  const [cameraId, setCameraId] = useState(cameras[0]?.id ?? '');
  const [date, setDate] = useState(todayValue());
  const [data, setData] = useState<RecordingTimelineResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!cameraId) return;
    setLoading(true);
    setError('');
    try {
      const { from, to } = localDayRange(date);
      setData(await api.recordingsTimeline({ cameraId, from, to }));
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '时间线加载失败');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [cameraId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const timeline = data?.timeline;
  const span = timeline ? timeline.to - timeline.from : 1;
  const percent = (value: number) => ((value - (timeline?.from ?? 0)) / span) * 100;
  const width = (startedAt: number, endedAt: number) =>
    Math.max(((endedAt - startedAt) / span) * 100, 0.15);

  return (
    <section className="panel recording-panel">
      <div className="panel-head">
        <div>
          <h2>持续录像回放</h2>
          <p className="panel-sub">按时间轴查看录像段与缺口；采集与按需转码待真机联调后启用</p>
        </div>
        <div className="recording-controls">
          <select
            aria-label="选择点位"
            value={cameraId}
            onChange={(event) => setCameraId(event.target.value)}
          >
            {cameras.length === 0 && <option value="">暂无点位</option>}
            {cameras.map((camera) => (
              <option key={camera.id} value={camera.id}>
                {camera.name}
              </option>
            ))}
          </select>
          <input
            aria-label="选择日期"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <div className="recording-error">{error}</div>}

      {timeline && (
        <>
          <div className="recording-track" role="img" aria-label="当日录像覆盖时间线">
            {[0, 6, 12, 18].map((hour) => (
              <span key={hour} className="recording-tick" style={{ left: `${(hour / 24) * 100}%` }} />
            ))}
            {timeline.gaps.map((gap) => (
              <span
                key={`gap-${gap.startedAt}`}
                className="recording-gap"
                style={{ left: `${percent(gap.startedAt)}%`, width: `${width(gap.startedAt, gap.endedAt)}%` }}
              />
            ))}
            {timeline.blocks.map((block) => (
              <button
                type="button"
                key={`block-${block.startedAt}`}
                className={`recording-block${block.protected ? ' is-protected' : ''}`}
                style={{ left: `${percent(block.startedAt)}%`, width: `${width(block.startedAt, block.endedAt)}%` }}
                title={`${formatDateTime(block.startedAt)} 起，${block.segmentCount} 段，${formatBytes(block.bytes)}${block.protected ? '（告警保护）' : ''}`}
                onClick={() => setSelected(block.startedAt)}
              />
            ))}
          </div>
          <div className="recording-scale">
            {['00:00', '06:00', '12:00', '18:00', '24:00'].map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <div className="recording-legend">
            <span><i className="recording-swatch is-recorded" />有录像</span>
            <span><i className="recording-swatch is-protected" />告警保护</span>
            <span><i className="recording-swatch is-gap" />无录像</span>
            <span className="recording-summary">
              {timeline.segmentCount} 段 · 覆盖 {(timeline.coverageMs / 3600000).toFixed(1)} 小时
            </span>
          </div>

          {timeline.blocks.length === 0 ? (
            <div className="empty-state">
              <strong>该日暂无录像段</strong>
              <p>持续录像采集启用后，段文件会每 5 分钟自动对账并出现在此处。</p>
            </div>
          ) : (
            <p className="recording-hint">
              {selected === null
                ? '点击时间条上的蓝色/红色区块可定位到该时刻。'
                : `已定位 ${formatDateTime(selected)}；播放与导出需待按需转码接口开放。`}
            </p>
          )}
          {!data?.enabled && (
            <p className="recording-hint">
              当前未启用持续录像采集（RECORDING=1 且采集 worker 就绪后生效）；索引、对账与权限链路已可用。
            </p>
          )}
        </>
      )}
    </section>
  );
}
