import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AlarmCreateInput, AlarmPatchInput } from '../lib/api';
import { connectSse } from '../lib/sse';
import type { Alarm } from '../types';

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;

/**
 * 告警数据入口归一化。
 *
 * 服务端异常或旧数据可能给出 NaN / 负数 / 超范围的 confidence 与 hotspot，
 * 旧实现直接把它们写进 `width: ${x}%` / `left: ${x}%`，会撑破布局或显示
 * `NaN%`。轮询与 SSE 两条路径都经过这里，一处收敛即可覆盖所有渲染。
 */
function normalizeAlarm(alarm: Alarm): Alarm {
  const confidence = clampPercent(Number(alarm.confidence));
  const hotspot = alarm.hotspot ?? { x: 0, y: 0 };
  const steps = Array.isArray(alarm.steps) ? alarm.steps.map(Boolean) : [];
  return {
    ...alarm,
    confidence,
    steps,
    hotspot: {
      x: clampPercent(Number(hotspot.x)),
      y: clampPercent(Number(hotspot.y)),
    },
  };
}

function sortAlarms(alarms: Alarm[]) {
  return [...alarms].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 判断两条告警在展示层面是否等价。
 *
 * SSE 事件与轮询可能推送同一条告警的相同内容；此时若仍返回新数组，
 * React 会重渲染整张告警列表（列表项都拿到了新的 props 引用）。
 * 返回 true 时复用原数组引用，可让 React 直接跳过这次渲染。
 */
function sameAlarm(a: Alarm, b: Alarm) {
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.level === b.level &&
    a.confidence === b.confidence &&
    a.cameraId === b.cameraId &&
    a.cameraName === b.cameraName &&
    a.zone === b.zone &&
    a.siteId === b.siteId &&
    a.note === b.note &&
    a.snapshot === b.snapshot &&
    a.clip === b.clip &&
    a.createdAt === b.createdAt &&
    a.confirmedAt === b.confirmedAt &&
    a.closedAt === b.closedAt &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => step === b.steps[index])
  );
}

/** 两个已排序列表在展示层面是否完全一致（用于定时补刷时复用数组引用）。 */
function sameAlarms(a: Alarm[], b: Alarm[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, index) => sameAlarm(item, b[index]));
}

/**
 * 合并一条告警到列表。
 *
 * RES-3 重渲染优化：不做全量排序。
 * - 新告警由服务端刚创建，createdAt 必然最大，直接前插即可；
 * - 已存在的告警只是状态/备注变化，createdAt 不变，位置不动，无需重排；
 * - 内容完全没变时返回原数组引用，让 React 跳过整表重渲染。
 *
 * @param prev 当前列表。
 * @param alarm 新增或更新的告警。
 * @returns {Alarm[]} 新列表（内容无变化时返回原引用）。
 */
function upsertAlarm(prev: Alarm[], alarm: Alarm): Alarm[] {
  const index = prev.findIndex((item) => item.id === alarm.id);
  if (index < 0) {
    if (prev.length === 0 || prev[0].createdAt <= alarm.createdAt) {
      return [alarm, ...prev];
    }
    // 兜底：万一 createdAt 不是最新，仍要保证整体倒序正确。
    const next = [...prev];
    let at = next.length;
    while (at > 0 && next[at - 1].createdAt < alarm.createdAt) at -= 1;
    next.splice(at, 0, alarm);
    return next;
  }
  if (sameAlarm(prev[index], alarm)) return prev;
  const next = [...prev];
  next[index] = alarm;
  return next;
}

/** 每页条数。历史告警超过这个数量时用「加载更多」翻页（D-03）。 */
const PAGE_SIZE = 50;

/** 日期字符串（YYYY-MM-DD）按上海时区换算成当天起止时间戳。 */
function shanghaiDayStart(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) - 8 * 3600 * 1000;
}

/** 判断一条告警是否落在当前时间筛选区间内。 */
function withinRange(createdAt: number, from: string, to: string): boolean {
  if (from && createdAt < shanghaiDayStart(from)) return false;
  if (to && createdAt > shanghaiDayStart(to) + 86_400_000 - 1) return false;
  return true;
}

export type AlarmRange = { from: string; to: string };

export function useAlarms() {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 实时推送中断标记：供顶栏展示「正在重连」，避免值守人员误以为告警仍在实时到达。
  const [sseDown, setSseDown] = useState(false);
  // 分页与时间筛选状态（D-03）。
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [range, setRange] = useState<AlarmRange>({ from: '', to: '' });
  const fetching = useRef(false);
  const mounted = useRef(true);
  const lastRefreshRef = useRef(0);
  // 当前已加载条数：定时补刷沿用这个上限，避免「加载更多」的结果被一次补刷冲掉。
  const loadedRef = useRef(PAGE_SIZE);
  // 请求代次：时间筛选切换时让在途的旧请求结果失效，避免旧区间数据覆盖新区间。
  const generation = useRef(0);
  const rangeRef = useRef<AlarmRange>(range);
  rangeRef.current = range;

  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const run = ++generation.current;
    try {
      const { from, to } = rangeRef.current;
      const limit = Math.min(Math.max(loadedRef.current, PAGE_SIZE), 1000);
      const result = await api.alarms(limit, {
        from: from || undefined,
        to: to || undefined,
      });
      if (mounted.current && generation.current === run) {
        const sorted = sortAlarms(result.alarms.map(normalizeAlarm));
        // 内容未变时复用原数组引用，让 React 跳过整张列表的重渲染。
        // SSE 路径已用 sameAlarm 做同样的优化，定时补刷不应把它抵消掉。
        setAlarms((prev) => (sameAlarms(prev, sorted) ? prev : sorted));
        loadedRef.current = Math.max(sorted.length, PAGE_SIZE);
        setTotal(Number(result.total ?? sorted.length));
        setHasMore(Boolean(result.hasMore));
        setError('');
        lastRefreshRef.current = Date.now();
      }
    } catch (requestError) {
      if (
        mounted.current &&
        !(requestError instanceof ApiError && requestError.status === 401)
      ) {
        setError(
          requestError instanceof Error ? requestError.message : '告警加载失败',
        );
      }
    } finally {
      fetching.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  /**
   * 加载下一页并追加到列表尾部。
   * 以当前已加载条数作为 offset，重复项按 id 去重（SSE 可能已插入同一条）。
   */
  const loadMore = useCallback(async () => {
    if (fetching.current || loadingMore) return;
    fetching.current = true;
    setLoadingMore(true);
    try {
      const { from, to } = rangeRef.current;
      const result = await api.alarms(PAGE_SIZE, {
        offset: loadedRef.current,
        from: from || undefined,
        to: to || undefined,
      });
      if (mounted.current) {
        const page = result.alarms.map(normalizeAlarm);
        setAlarms((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          const appended = page.filter((item) => !seen.has(item.id));
          return appended.length ? sortAlarms([...prev, ...appended]) : prev;
        });
        loadedRef.current += page.length;
        setTotal(Number(result.total ?? 0));
        setHasMore(Boolean(result.hasMore));
      }
    } catch (requestError) {
      if (mounted.current) {
        setError(
          requestError instanceof Error ? requestError.message : '加载更多失败',
        );
      }
    } finally {
      fetching.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  }, [loadingMore]);

  /** 应用时间筛选：重置分页并重新拉取第一页。 */
  const applyRange = useCallback(
    (next: AlarmRange) => {
      rangeRef.current = next;
      setRange(next);
      loadedRef.current = PAGE_SIZE;
      generation.current += 1;
      fetching.current = false;
      setAlarms([]);
      setHasMore(false);
      setLoading(true);
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    /**
     * RES-3：合并告警时不做全量排序（详见 upsertAlarm）。
     */
    const mergeAlarm = (alarm: Alarm) => {
      const { from, to } = rangeRef.current;
      if (!withinRange(alarm.createdAt, from, to)) return;
      setAlarms((prev) => upsertAlarm(prev, alarm));
    };
    const onEvent = (type: string, data: string) => {
      if (type !== 'alarm.created' && type !== 'alarm.updated') return;
      try {
        const payload = JSON.parse(data) as { alarm: Alarm };
        if (payload.alarm) mergeAlarm(normalizeAlarm(payload.alarm));
      } catch {
        // 忽略格式异常的单条事件。
      }
    };
    // RES-3：自行管理重连与退避，断开期间不再反复全量刷新。
    const client = connectSse({
      url: '/api/events',
      events: ['alarm.created', 'alarm.updated'],
      onEvent,
      onOpen: () => {
        setSseDown(false);
        // 重连成功后补一次全量（断线期间可能有事件丢失）。
        void refresh();
      },
      onDisconnect: () => setSseDown(true),
    });
    // 断线时 SSE 客户端已在做指数退避重连；全量轮询只是兜底，
    // 每 3 秒打一次 /api/alarms 会在服务端故障期间形成持续压力。
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const interval = client.connected ? 20_000 : 15_000;
      if (Date.now() - lastRefreshRef.current < interval) return;
      void refresh();
    }, 3000);
    const handleVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      mounted.current = false;
      client.close();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [refresh]);

  const createAlarm = useCallback(async (input: AlarmCreateInput) => {
    try {
      const result = await api.createAlarm(input);
      if (mounted.current) {
        // RES-3：复用 upsertAlarm，内容未变时保持原数组引用。
        setAlarms((prev) => upsertAlarm(prev, normalizeAlarm(result.alarm)));
      }
      return result.alarm;
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 413) {
        const withoutSnapshot = await api.createAlarm({ ...input, snapshot: null });
        if (mounted.current) {
          setAlarms((prev) => upsertAlarm(prev, normalizeAlarm(withoutSnapshot.alarm)));
        }
        return withoutSnapshot.alarm;
      }
      throw requestError;
    }
  }, []);

  const patchAlarm = useCallback(
    async (id: string, patch: AlarmPatchInput) => {
      const result = await api.updateAlarm(id, patch);
      if (mounted.current) {
        // RES-3：状态/备注变更不影响 createdAt，位置不变，无需重排。
        setAlarms((prev) => upsertAlarm(prev, normalizeAlarm(result.alarm)));
      }
      return result.alarm;
    },
    [],
  );

  return {
    alarms,
    loading,
    error,
    sseDown,
    refresh,
    createAlarm,
    patchAlarm,
    // D-03：分页与时间筛选
    total,
    hasMore,
    loadingMore,
    loadMore,
    range,
    applyRange,
  };
}
