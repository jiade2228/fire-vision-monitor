import { useEffect, useState } from 'react';

type Subscriber = {
  intervalMs: number;
  lastTick: number;
  update: () => void;
};

const subscribers = new Set<Subscriber>();
let sharedTimer: number | null = null;

function ensureTimer() {
  if (sharedTimer !== null || typeof window === 'undefined') return;
  sharedTimer = window.setInterval(() => {
    const now = Date.now();
    subscribers.forEach((subscriber) => {
      if (now - subscriber.lastTick >= subscriber.intervalMs) {
        subscriber.lastTick = now;
        subscriber.update();
      }
    });
  }, 1000);
}

function removeTimerIfIdle() {
  if (subscribers.size === 0 && sharedTimer !== null) {
    window.clearInterval(sharedTimer);
    sharedTimer = null;
  }
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const subscriber: Subscriber = {
      intervalMs: Math.max(1000, intervalMs),
      lastTick: Date.now(),
      update: () => setNow(Date.now()),
    };
    subscribers.add(subscriber);
    ensureTimer();
    return () => {
      subscribers.delete(subscriber);
      removeTimerIfIdle();
    };
  }, [intervalMs]);

  return now;
}
