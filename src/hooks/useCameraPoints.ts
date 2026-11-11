import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ManagedCamera } from '../lib/api';

export function useCameraPoints() {
  const [cameras, setCameras] = useState<ManagedCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 卸载守卫：请求返回时组件可能已被卸载（切换视图/关闭面板），
  // 此时写 state 会造成内存泄漏与状态错写。
  const mounted = useRef(true);

  const refresh = useCallback(async (): Promise<ManagedCamera[]> => {
    try {
      const result = await api.cameras();
      if (!mounted.current) return result.cameras;
      setCameras(result.cameras);
      setError('');
      return result.cameras;
    } catch (requestError) {
      const message =
        requestError instanceof ApiError ? requestError.message : '点位加载失败';
      if (requestError instanceof ApiError && requestError.status === 401) {
        return [];
      }
      if (mounted.current) setError(message);
      return [];
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { cameras, setCameras, loading, error, refresh };
}
