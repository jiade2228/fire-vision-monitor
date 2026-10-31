import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { AlarmCreateInput, AlarmPatchInput } from '../lib/api';
import type { Alarm } from '../types';

function sortAlarms(alarms: Alarm[]) {
  return [...alarms].sort((a, b) => b.createdAt - a.createdAt);
}

export function useAlarms() {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fetching = useRef(false);
  const mounted = useRef(true);
  const lastRefreshRef = useRef(0);

  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const result = await api.alarms();
      if (mounted.current) {
        setAlarms(sortAlarms(result.alarms));
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

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const events =
      typeof EventSource === 'undefined' ? null : new EventSource('/api/events');
    const mergeAlarm = (alarm: Alarm) => {
      setAlarms((prev) => {
        const exists = prev.some((item) => item.id === alarm.id);
        return sortAlarms(
          exists
            ? prev.map((item) => (item.id === alarm.id ? alarm : item))
            : [alarm, ...prev],
        );
      });
    };
    const onCreate = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { alarm: Alarm };
        if (payload.alarm) mergeAlarm(payload.alarm);
      } catch {
        // 忽略格式异常的单条事件。
      }
    };
    const onUpdate = onCreate;
    const onOpen = () => {
      void refresh();
    };
    const onError = () => {
      void refresh();
    };
    events?.addEventListener('alarm.created', onCreate as EventListener);
    events?.addEventListener('alarm.updated', onUpdate as EventListener);
    events?.addEventListener('open', onOpen);
    events?.addEventListener('error', onError);

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (
        typeof EventSource !== 'undefined' &&
        events?.readyState === EventSource.OPEN &&
        Date.now() - lastRefreshRef.current < 20_000
      ) {
        return;
      }
      void refresh();
    }, 3000);
    const handleVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      mounted.current = false;
      events?.close();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, [refresh]);

  const createAlarm = useCallback(async (input: AlarmCreateInput) => {
    try {
      const result = await api.createAlarm(input);
      setAlarms((prev) => {
        if (prev.some((alarm) => alarm.id === result.alarm.id)) return prev;
        return sortAlarms([result.alarm, ...prev]);
      });
      return result.alarm;
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 413) {
        const withoutSnapshot = await api.createAlarm({ ...input, snapshot: null });
        setAlarms((prev) => {
          if (prev.some((alarm) => alarm.id === withoutSnapshot.alarm.id)) return prev;
          return sortAlarms([withoutSnapshot.alarm, ...prev]);
        });
        return withoutSnapshot.alarm;
      }
      throw requestError;
    }
  }, []);

  const patchAlarm = useCallback(
    async (id: string, patch: AlarmPatchInput) => {
      const result = await api.updateAlarm(id, patch);
      setAlarms((prev) =>
        sortAlarms(prev.map((alarm) => (alarm.id === id ? result.alarm : alarm))),
      );
      return result.alarm;
    },
    [],
  );

  return { alarms, loading, error, refresh, createAlarm, patchAlarm };
}
