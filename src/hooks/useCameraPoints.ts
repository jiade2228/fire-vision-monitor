import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ManagedCamera } from '../lib/api';

export function useCameraPoints() {
  const [cameras, setCameras] = useState<ManagedCamera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async (): Promise<ManagedCamera[]> => {
    try {
      const result = await api.cameras();
      setCameras(result.cameras);
      setError('');
      return result.cameras;
    } catch (requestError) {
      const message =
        requestError instanceof ApiError ? requestError.message : '点位加载失败';
      if (requestError instanceof ApiError && requestError.status === 401) {
        return [];
      }
      setError(message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { cameras, setCameras, loading, error, refresh };
}
