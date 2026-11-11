import { useMemo, useState } from 'react';
import type { Alarm, AlarmFilter, AlarmHandlers, AlarmLevel } from '../types';
import { downloadAlarmsCsv } from '../lib/export';
import { LEVEL_META } from '../lib/detection';
import AlarmCard from './AlarmCard';
import AlarmClipTimeline from './AlarmClipTimeline';

interface Props {
  alarms: Alarm[];
  expandedId: string | null;
  handlers: AlarmHandlers;
  readOnly?: boolean;
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
}: Props) {
  const [filter, setFilter] = useState<AlarmFilter>('all');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'list' | 'replay'>('list');

  const counts = useMemo(
    () => ({
      all: alarms.length,
      pending: alarms.filter((a) => a.status === 'pending').length,
      active: alarms.filter((a) => a.status === 'confirmed').length,
      closed: alarms.filter((a) => a.status === 'false' || a.status === 'archived').length,
    }),
    [alarms],
  );

  const list = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return alarms
      .filter((alarm) => {
        if (filter === 'pending' && alarm.status !== 'pending') return false;
        if (filter === 'active' && alarm.status !== 'confirmed') return false;
        if (filter === 'closed' && alarm.status !== 'false' && alarm.status !== 'archived') {
          return false;
        }
        if (levelFilter !== 'all' && alarm.level !== levelFilter) return false;
        if (!keyword) return true;
        return [
          alarm.id,
          alarm.cameraId,
          alarm.cameraName,
          alarm.zone,
          alarm.note,
        ].some((value) => (value ?? '').toLocaleLowerCase().includes(keyword));
      })
      .sort((a, b) =>
        sortOrder === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
      );
  }, [alarms, filter, levelFilter, query, sortOrder]);

  const hasActiveFilter =
    filter !== 'all' || levelFilter !== 'all' || query.trim() !== '' || sortOrder !== 'newest';

  const resetFilters = () => {
    setFilter('all');
    setLevelFilter('all');
    setQuery('');
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
              onClick={() => setFilter(item.key)}
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
            value={query}
            aria-label="搜索告警"
            placeholder="搜索编号、通道、区域或备注"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="清空搜索"
              onClick={() => setQuery('')}
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
            onChange={(event) => setLevelFilter(event.target.value as LevelFilter)}
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

        <span className="toolbar-count">共 {list.length} 条</span>

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
        )}
      </>)}
    </section>
  );
}