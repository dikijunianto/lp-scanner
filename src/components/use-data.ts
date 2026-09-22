"use client";
import { useEffect, useState, useCallback } from "react";
export function useData<T>(url: string, interval = 30000) {
  const [observedAt, setObservedAt] = useState(0);
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(65000)]),
        });
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? "Pool not found."
              : "Scanner unavailable. Check that both local services are running.",
          );
        const body = (await response.json()) as T;
        if (active) {
          setData(body);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Request failed");
      } finally {
        if (active) {
          setObservedAt(Date.now());
          timer = setTimeout(load, interval);
        }
      }
    };
    void load();
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [url, interval, version]);
  return { data, error, observedAt, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}
