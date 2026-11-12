import { useEffect, useMemo, useState } from 'react';
import type { Alarm, AlarmFilter, AlarmHandlers, AlarmLevel } from '../types';
import { downloadAlarmsCsv } from '../lib/export';
import { LEVEL_META } from '../lib/detection';
import AlarmCard from './AlarmCard';
import AlarmClipTimeline from './AlarmClipTimeline';
import type { AlarmFilters, AlarmRange } from '../hooks/useAlarms';

interface Props {
  alarms: Alarm[];
  expandedId: string | null;
  handlers: AlarmHandlers;
  readOnly?: boolean;
  /** 服务端过滤后的总条数（含未加载部分）。 */
  total?: number;
  /** 是否还有下一页（D-03 分页）。 */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** 时间范围筛选（YYYY-MM-DD，空字符串表示不限）。 */
  range?: AlarmRange;
  onRangeChange?: (next: AlarmRange) => void;
  /** 状态/等级/关键词筛选（D-02：服务端过滤）。 */
  filters?: AlarmFilters;
  onFiltersChange?: (next: Partial<AlarmFilters>) => void;
  /** 全量分组计数（服务端统计，避免与已加载页口径矛盾）。 */
  statusCounts?: { all: number; pending: number; confirmed: number; closed: number };
}

type LevelFilter = 'all' | AlarmLevel;
type SortOrder = 'newest' | 'oldest';

const FILTERS: { key: AlarmFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处置' },
  { key: 'active', label: '处置中' },
  { key: 'closed', label: '已关闭' },
];

export default function AlarmCenter({
  alarms,
  expandedId,
  handlers,
  readOnly = false,
  total,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  range,
  onRangeChange,
  filters,
  onFiltersChange,
  statusCounts,
}: Props) {
  // D-02：状态/等级/关键词筛选由服务端执行（props 受控），
  // 这里只保留排序与搜索框的输入态（输入需即时回显，故本地保存后再防抖上报）。
  const filter = filters?.status ?? 'all';
  const levelFilter = filters?.level ?? 'all';
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [queryInput, setQueryInput] = useState(filters?.keyword ?? '');
  const [mode, setMode] = useState<'list' | 'replay'>('list');

  // 标签计数优先用服务端全量统计；无服务端数据时回退到本地统计（兼容旧调用方）。
  const counts = useMemo(() => {
    if (statusCounts) {
      return {
        all: statusCounts.all,
        pending: statusCounts.pending,
        active: statusCounts.confirmed,
        closed: statusCounts.closed,
      };
    }
    return {
      all: alarms.length,
      pending: alarms.filter((a) => a.status === 'pending').length,
      active: alarms.filter((a) => a.status === 'confirmed').length,
      closed: alarms.filter((a) => a.status === 'false' || a.status === 'archived').length,
    };
  }, [alarms, statusCounts]);

  // 列表已由服务端按筛选条件过滤，这里只负责排序。
  const list = useMemo(
    () =>
      [...alarms].sort((a, b) =>
        sortOrder === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
      ),
    [alarms, sortOrder],
  );

  // 关键词防抖上报：避免每次按键都打一次接口。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const current = filters?.keyword ?? '';
      if (queryInput.trim() !== current.trim()) {
        onFiltersChange?.({ keyword: queryInput });
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [queryInput, filters?.keyword, onFiltersChange]);

  const hasActiveFilter =
    filter !== 'all' ||
    levelFilter !== 'all' ||
    (filters?.keyword ?? '').trim() !== '' ||
    sortOrder !== 'newest';

  const resetFilters = () => {
    onFiltersChange?.({ status: 'all', level: 'all', keyword: '' });
    setQueryInput('');
    setSortOrder('newest');
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>告警中心</h2>
          <p className="panel-sub">全部视频识别告警、处置进度与值守记录</p>
        </div>
        <div className="alarm-view-switch" role="group" aria-label="告警视图切换">
          <button
            type="button"
            className={`btn btn-sm ${mode === 'list' ? 'is-active' : ''}`}
            onClick={() => setMode('list')}
          >
            列表
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'replay' ? 'is-active' : ''}`}
            onClick={() => setMode('replay')}
          >
            短片回放
          </button>
        </div>
        <div className="filter-row" role="group" aria-label="告警状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={filter === item.key}
              className={`chip ${filter === item.key ? 'is-active' : ''}`}
              onClick={() => onFiltersChange?.({ status: item.key })}
            >
              {item.label}
              <span className="chip-count">{counts[item.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {mode === 'replay' ? (
        <AlarmClipTimeline alarms={alarms} />
      ) : (
        <>
          <div className="alarm-toolbar">
        <div className="search-field">
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={queryInput}
            aria-label="搜索告警"
            placeholder="搜索编号、通道、区域或备注"
            onChange={(event) => setQueryInput(event.target.value)}
          />
          {queryInput && (
            <button
              type="button"
              className="search-clear"
              aria-label="清空搜索"
              onClick={() => {
                setQueryInput('');
                onFiltersChange?.({ keyword: '' });
              }}
            >
              ×
            </button>
          )}
        </div>

        <label className="toolbar-field">
          <span>类型</span>
          <select
            value={levelFilter}
            aria-label="按识别类型筛选"
            onChange={(event) =>
              onFiltersChange?.({ level: event.target.value as LevelFilter })
            }
          >
            <option value="all">全部类型</option>
            {(Object.keys(LEVEL_META) as AlarmLevel[]).map((level) => (
              <option key={level} value={level}>
                {LEVEL_META[level].label}
              </option>
            ))}
          </select>
        </label>

        <label className="toolbar-field">
          <span>排序</span>
          <select
            value={sortOrder}
            aria-label="告警排序方式"
            onChange={(event) => setSortOrder(event.target.value as SortOrder)}
          >
            <option value="newest">最新优先</option>
            <option value="oldest">最早优先</option>
          </select>
        </label>

        <label className="toolbar-field">
          <span>起始</span>
          <input
            type="date"
            lang="zh-CN"
            value={range?.from ?? ''}
            aria-label="告警起始日期"
            onChange={(event) =>
              onRangeChange?.({ from: event.target.value, to: range?.to ?? '' })
            }
          />
        </label>

        <label className="toolbar-field">
          <span>截止</span>
          <input
            type="date"
            lang="zh-CN"
            value={range?.to ?? ''}
            aria-label="告警截止日期"
            min={range?.from || undefined}
            onChange={(event) =>
              onRangeChange?.({ from: range?.from ?? '', to: event.target.value })
            }
          />
        </label>

        {(range?.from || range?.to) && (
          <button
            type="button"
            className="btn btn-sm"
            aria-label="清除时间范围"
            onClick={() => onRangeChange?.({ from: '', to: '' })}
          >
            清除时间
          </button>
        )}

        <span className="toolbar-count">
          {typeof total === 'number' && (range?.from || range?.to)
            ? `符合 ${total} 条`
            : typeof total === 'number'
              ? `共 ${total} 条`
              : `共 ${list.length} 条`}
        </span>

        <button
          type="button"
          className="btn btn-sm toolbar-export"
          disabled={list.length === 0}
          onClick={() => downloadAlarmsCsv(list, '火情告警清单')}
        >
          导出 CSV
        </button>
      </div>

      {list.length === 0 ? (
        <div className="empty-state">
          <strong>{alarms.length === 0 ? '暂无告警记录' : '当前筛选下暂无告警'}</strong>
          <span>
            {alarms.length === 0
              ? '回到实时监控接入视频信号，识别到异常后会在这里生成告警。'
              : '尝试更换关键词或筛选条件。'}
          </span>
          {hasActiveFilter && alarms.length > 0 && (
            <button type="button" className="btn btn-sm empty-action" onClick={resetFilters}>
              重置筛选
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="alarm-list">
            {list.map((alarm) => (
              <AlarmCard
                key={alarm.id}
                alarm={alarm}
                expanded={expandedId === alarm.id}
                handlers={handlers}
                readOnly={readOnly}
              />
            ))}
          </div>
          {hasMore && onLoadMore && (
            <div className="alarm-load-more">
              <button
                type="button"
                className="btn"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore
                  ? '加载中…'
                  : `加载更多（已显示 ${list.length} / ${typeof total === 'number' ? total : list.length} 条）`}
              </button>
            </div>
          )}
        </>
      )}
      </>)}
    </section>
  );
}