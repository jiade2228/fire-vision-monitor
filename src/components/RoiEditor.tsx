import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { RoiRect } from '../lib/api';

interface Props {
  value: RoiRect[];
  onChange: (next: RoiRect[]) => void;
  previewUrl?: string | null;
  disabled?: boolean;
}

const MAX_RECTS = 8;
const round1 = (value: number) => Math.round(value * 10) / 10;

/** 在 16:9 画布上拖拽框选屏蔽区，坐标以百分比保存，与服务端掩码一致。 */
export default function RoiEditor({
  value,
  onChange,
  previewUrl = null,
  disabled = false,
}: Props) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<RoiRect | null>(null);

  const pointFrom = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || value.length >= MAX_RECTS) return;
    const point = pointFrom(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = point;
    setDraft({ x: point.x, y: point.y, w: 0, h: 0 });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start) return;
    const point = pointFrom(event);
    if (!point) return;
    setDraft({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      w: Math.abs(point.x - start.x),
      h: Math.abs(point.y - start.y),
    });
  };

  const finish = () => {
    if (!startRef.current) return;
    startRef.current = null;
    const current = draft;
    setDraft(null);
    if (
      current &&
      current.w >= 2 &&
      current.h >= 2 &&
      value.length < MAX_RECTS
    ) {
      onChange([
        ...value,
        {
          x: round1(current.x),
          y: round1(current.y),
          w: round1(current.w),
          h: round1(current.h),
        },
      ]);
    }
  };

  return (
    <div className={`roi-editor ${disabled ? 'is-disabled' : ''}`}>
      <div
        ref={canvasRef}
        className="roi-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        role="presentation"
      >
        {previewUrl ? (
          <img
            className="roi-preview"
            src={previewUrl}
            alt="点位预览"
            draggable={false}
          />
        ) : (
          <span className="roi-placeholder">
            暂无预览画面，可直接按比例框选需要屏蔽的区域
          </span>
        )}
        {value.map((rect, index) => (
          <div
            key={`${rect.x}-${rect.y}-${rect.w}-${index}`}
            className="roi-rect"
            style={{
              left: `${rect.x}%`,
              top: `${rect.y}%`,
              width: `${rect.w}%`,
              height: `${rect.h}%`,
            }}
          >
            <button
              type="button"
              className="roi-remove"
              aria-label="移除屏蔽区"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() =>
                onChange(value.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              ×
            </button>
          </div>
        ))}
        {draft && (
          <div
            className="roi-rect is-draft"
            style={{
              left: `${draft.x}%`,
              top: `${draft.y}%`,
              width: `${draft.w}%`,
              height: `${draft.h}%`,
            }}
          />
        )}
      </div>
      <div className="roi-meta">
        <span>
          屏蔽区 {value.length}/{MAX_RECTS}
        </span>
        {value.length > 0 && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onChange([])}
          >
            清空屏蔽区
          </button>
        )}
      </div>
    </div>
  );
}
