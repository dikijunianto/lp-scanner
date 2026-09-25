import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { env } from "../config/env";
import { countApi, countCache } from "../core/traffic";
export class HttpClient {
  private nextAt = 0;
  private cache = new Map<string, { until: number; data: unknown }>();
  constructor(
    private spacingMs: number,
    private fetcher: typeof fetch = fetch,
    private retries = env.HTTP_RETRIES,
    private timeoutMs = env.HTTP_TIMEOUT_MS,
  ) {}
  async json<T>(
    url: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; ttl?: number } = {},
  ): Promise<T> {
    const key = `${url}:${JSON.stringify(options.body ?? "")}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) { countCache(); return schema.parse(cached.data); }
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const wait = Math.max(0, this.nextAt - Date.now());
      this.nextAt = Date.now() + wait + this.spacingMs;
      if (wait) await sleep(wait);
      try {
        countApi();
        const response = await this.fetcher(url, {
          method: options.body ? "POST" : "GET",
          headers: {
            accept: "application/json",
            ...(options.body ? { "content-type": "application/json" } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
            const retry = response.headers.get("retry-after");
            const retryMs = retry
              ? Number.isFinite(Number(retry))
                ? Number(retry) * 1000
                : Date.parse(retry) - Date.now()
              : 0;
            await response.body?.cancel();
            await sleep(Math.min(30000, Math.max(500 * 2 ** attempt, retryMs || 0)));
            continue;
          }
          await response.body?.cancel();
          throw new Error(`Upstream HTTP ${response.status}`);
        }
        const data = schema.parse(await response.json());
        if (options.ttl) {
          // ponytail: bounded process cache; use shared cache only with multiple API servers.
          if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, { until: Date.now() + options.ttl, data });
        }
        return data;
      } catch (error) {
        if (error instanceof z.ZodError) throw new Error("Upstream response failed validation");
        if (error instanceof Error && error.message.startsWith("Upstream HTTP")) throw error;
        if (attempt === this.retries) throw new Error("Upstream request failed or timed out");
        await sleep(500 * 2 ** attempt);
      }
    }
    throw new Error("Upstream retries exhausted");
  }
}
export const numeric = z
  .union([z.number(), z.string().regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite());
export const optionalNumeric = numeric.nullish().transform((v) => v ?? null);
export const nonnegative = numeric.pipe(z.number().nonnegative());
export const optionalPositive = nonnegative.nullish().transform((v) => v ?? null);
export const candleSchema = z
  .object({
    timestamp: z.number().nonnegative(),
    open: z.number().positive(),
    high: z.number().positive(),
    low: z.number().positive(),
    close: z.number().positive(),
    volume: z.number().nonnegative(),
  })
  .refine(
    (c) =>
      c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && c.low <= c.high,
  );
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^Upstream (HTTP \d{3}|request failed or timed out|response failed validation|retries exhausted)$/.test(
    message,
  )
    ? message
    : "Source unavailable; check configuration and connectivity";
}
