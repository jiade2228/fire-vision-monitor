import { memo, useEffect, useState } from 'react';
import type { Alarm, AlarmHandlers } from '../types';
import {
  EMERGENCY_STEPS,
  confidenceTone,
  getLevelMeta,
  getStatusMeta,
} from '../lib/detection';
import { formatDateTime } from '../lib/format';

interface Props {
  alarm: Alarm;
  expanded: boolean;
  handlers: AlarmHandlers;
  readOnly?: boolean;
}

function AlarmCard({ alarm, expanded, handlers, readOnly = false }: Props) {
  const total = alarm.steps.length;
  const done = alarm.steps.filter(Boolean).length;
  const statusMeta = getStatusMeta(alarm.status);
  const levelMeta = getLevelMeta(alarm.level);
  const isDeviceHealth = alarm.level === 'offline' || alarm.level === 'camera_abnormal';
  const note = alarm.note ?? '';
  const [noteDraft, setNoteDraft] = useState(note);
  const [noteDirty, setNoteDirty] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const progress = total > 0 ? (done / total) * 100 : 0;

  useEffect(() => {
    if (!noteDirty) setNoteDraft(note);
  }, [note, noteDirty]);

  // 保存失败时**保留草稿**：原实现提交后立刻 setNoteDirty(false)，
  // effect 随即用服务端旧值覆盖输入框，用户刚输入的内容无声消失。
  const commitNote = async () => {
    if (noteDraft === note || noteSaving) return;
    setNoteSaving(true);
    try {
      const ok = await handlers.onNoteChange(alarm.id, noteDraft);
      if (ok) setNoteDirty(false);
    } finally {
      setNoteSaving(false);
    }
  };

  return (
    <article className={`alarm-card alarm-card--${alarm.level} ${expanded ? 'is-open' : ''}`}>
      <button
        type="button"
        className="alarm-head"
        onClick={() => handlers.onToggle(alarm.id)}
        aria-expanded={expanded}
      >
        <span className={`level-dot level-dot--${alarm.level}`} aria-hidden="true" />
        <span className="alarm-main">
          <span className="alarm-title">
            <strong>{isDeviceHealth ? levelMeta.label : `${levelMeta.label}识别`}</strong>
            <span className="alarm-zone">
              {alarm.zone} · {alarm.cameraName}
            </span>
          </span>
          <span className="alarm-meta">
            {formatDateTime(alarm.createdAt)}
            {!isDeviceHealth && ` · 置信度 ${alarm.confidence}%`}
          </span>
        </span>
        <span className={`status-chip status-chip--${statusMeta.tone}`} data-testid="alarm-status-chip">{statusMeta.label}</span>
      </button>

      {expanded && (
        <div className="alarm-body">
          <div className={`alarm-shot ${alarm.snapshot ? '' : 'is-empty'}`}>
            {alarm.snapshot ? (
              <img
                className="shot-img"
                src={alarm.snapshot}
                alt={`${alarm.cameraName} 识别抓拍`}
              />
            ) : (
              <span className="shot-empty">该通道未提供抓拍图像</span>
            )}
            {alarm.snapshot && (
              <span
                className={`detect-box detect-box--${alarm.level} detect-box--snap`}
                style={{ left: `${alarm.hotspot.x}%`, top: `${alarm.hotspot.y}%` }}
                aria-hidden="true"
              >
                <span className={`detect-label detect-label--${alarm.level}`}>
                  {levelMeta.label} {alarm.confidence}%
                </span>
              </span>
            )}
            <span className="shot-badge">{alarm.snapshot ? '识别抓拍' : '无抓拍'}</span>
            {alarm.snapshot && (
              <a
                className="shot-download"
                href={alarm.snapshot}
                download={`${alarm.id.slice(-8)}-${alarm.cameraName}-抓拍.jpg`}
              >
                下载抓拍
              </a>
            )}
          </div>
          {!alarm.snapshot && (
            <p className="shot-empty-line">该通道未提供抓拍图像</p>
          )}

          {alarm.clip && (
            <div className="alarm-clip">
              <video
                className="clip-player"
                src={alarm.clip}
                controls
                preload="metadata"
              />
              <a
                className="clip-download"
                href={alarm.clip}
                download={`${alarm.id.slice(-8)}-${alarm.cameraName}-现场.mp4`}
              >
                下载短视频
              </a>
            </div>
          )}

          <div className="alarm-content">
          {!isDeviceHealth && (
            <div className="conf-row">
              <span className="conf-label">识别置信度</span>
              <span className="conf-track">
                <span
                  className={`conf-fill conf-fill--${confidenceTone(alarm.confidence)}`}
                  style={{ width: `${alarm.confidence}%` }}
                />
              </span>
              <span className="conf-value">{alarm.confidence}%</span>
            </div>
          )}

          <div className="note-field">
            <div className="note-head">
              <label htmlFor={`note-${alarm.id}`}>值守备注</label>
              <span>{noteDraft.length}/300</span>
            </div>
            <textarea
              id={`note-${alarm.id}`}
              className="note-input"
              value={noteDraft}
              maxLength={300}
              rows={2}
              readOnly={readOnly}
              placeholder={
                readOnly ? '只读账号不可编辑备注' : '记录现场核实情况，失焦后自动保存…'
              }
              onChange={(event) => {
                setNoteDirty(true);
                setNoteDraft(event.target.value);
              }}
              onBlur={() => {
                void commitNote();
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void commitNote();
                }
              }}
            />
          </div>

          {alarm.status === 'pending' && (
            <>
              <p className="alarm-tip">
                {alarm.level === 'camera_abnormal'
                  ? '画面长时间无效（疑似遮挡、过暗或过曝），请现场检查镜头与供电；画面恢复后系统会自动归档。'
                  : isDeviceHealth
                    ? '视频流超时未收到画面，请检查设备电源、网络与交换机端口；恢复后系统会自动归档。'
                    : `${levelMeta.caption}在连续多帧画面中超过报警阈值，请核实画面后处置。`}
              </p>
              {readOnly ? (
                <p className="alarm-readonly">只读账号仅可查看告警，需由值班员或管理员处置。</p>
              ) : (
                <div className="alarm-actions">
                  <button type="button" className="btn btn-danger" onClick={() => handlers.onConfirm(alarm.id)} data-testid="alarm-confirm">
                    {isDeviceHealth
                      ? alarm.level === 'camera_abnormal'
                        ? '确认画面异常'
                        : '确认设备异常'
                      : '确认火情'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => handlers.onFalse(alarm.id)}>
                    {isDeviceHealth
                      ? alarm.level === 'camera_abnormal'
                        ? '忽略本次异常'
                        : '忽略本次离线'
                      : '标记误报'}
                  </button>
                </div>
              )}
            </>
          )}

          {alarm.status === 'confirmed' && (isDeviceHealth ? (
            <>
              <p className="alarm-tip">
                {alarm.level === 'camera_abnormal'
                  ? '画面恢复后系统会自动归档；如已人工处理，可立即归档。'
                  : '设备恢复后系统会自动归档；如已人工处理，可立即归档。'}
              </p>
              {readOnly ? (
                <p className="alarm-readonly">只读账号不可修改告警状态。</p>
              ) : (
                <div className="alarm-actions">
                  <button type="button" className="btn btn-ok" onClick={() => handlers.onArchive(alarm.id)}>
                    设备已恢复，归档
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="steps-head">
                <span>应急处置清单</span>
                <span className="steps-count">
                  {done}/{total}
                </span>
              </div>
              <ul className="checklist">
                {EMERGENCY_STEPS.map((step, index) => (
                  <li key={step}>
                    <button
                      type="button"
                      className={`step ${alarm.steps[index] ? 'is-done' : ''}`}
                      disabled={readOnly}
                      onClick={() => handlers.onToggleStep(alarm.id, index)}
                    >
                      <span className="step-box" aria-hidden="true">
                        {alarm.steps[index] ? '✓' : index + 1}
                      </span>
                      <span className="step-text">{step}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="step-progress">
                <span
                  className="step-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {readOnly ? (
                <p className="alarm-readonly">只读账号不可修改应急处置进度。</p>
              ) : (
                <div className="alarm-actions">
                  <button
                    type="button"
                    className="btn btn-ok"
                    onClick={() => handlers.onArchive(alarm.id)}
                    disabled={done < total}
                  >
                    火情已扑灭，归档
                  </button>
                  {done < total && <span className="action-hint">完成全部步骤后可归档</span>}
                </div>
              )}
            </>
          ))}

          {(alarm.status === 'false' || alarm.status === 'archived') && (
            <p className="alarm-closed">
              {alarm.status === 'false'
                ? isDeviceHealth
                  ? alarm.level === 'camera_abnormal'
                    ? '本次画面异常已忽略，通道继续监测。'
                    : '本次离线已忽略，通道继续监测。'
                  : '已判定为误报，通道恢复正常监测。'
                : isDeviceHealth
                  ? alarm.level === 'camera_abnormal'
                    ? '画面已恢复，异常告警已归档。'
                    : '设备已恢复，离线告警已归档。'
                  : '处置完成，告警已归档至处置记录。'}
              <span>{alarm.closedAt ? formatDateTime(alarm.closedAt) : ''}</span>
            </p>
          )}
          </div>
        </div>
      )}
    </article>
  );
}

export default memo(AlarmCard);