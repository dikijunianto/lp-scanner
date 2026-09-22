import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Snapshot } from "../core/model";
import type { Store } from "../db/store";
import { alerts } from "../db/schema";
import { env } from "../config/env";
export function qualifies(s: Snapshot) {
  return (
    s.metrics.surge ||
    ((s.metrics.activity ?? -1) >= env.ALERT_MIN_ACTIVITY &&
      s.metrics.risk <= env.ALERT_MAX_RISK &&
      s.metrics.feeEfficiency1h !== null &&
      s.metrics.feeEfficiency1h >= env.ALERT_MIN_FEE_EFFICIENCY)
  );
}
export async function recordAlert(store: Store, s: Snapshot) {
  if (!qualifies(s)) return;
  const kind = s.metrics.surge ? "ACTIVITY SURGE" : "ACTIVITY THRESHOLD";
  if (!store.alertDue(s.pool.id, kind, env.ALERT_COOLDOWN_MINUTES * 60000)) return;
  const id = store.db
    .insert(alerts)
    .values({ poolId: s.pool.id, timestamp: Date.now(), kind, data: s, delivery: "local" })
    .returning({ id: alerts.id })
    .get().id;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const fmt = (n: number | null, suffix = "") =>
    n === null ? "unknown" : `${n.toFixed(2)}${suffix}`;
  const text = [
    `LP ${kind}`,
    `Pair: ${s.pool.pair}`,
    `DEX: ${s.pool.dex} | Chain: ${s.pool.chain}`,
    `Activity: ${s.metrics.activity ?? "unknown"}/100 (${s.metrics.activityCoverage}% coverage)`,
    `Risk: ${s.metrics.risk}/100 (${s.metrics.riskCoverage}% coverage)`,
    `Fee efficiency 1h: ${fmt(s.metrics.feeEfficiency1h === null ? null : s.metrics.feeEfficiency1h * 100, "%")}`,
    `Volume / active liquidity: ${fmt(s.metrics.capitalTurnover1h, "×")}`,
    `Volume acceleration: ${fmt(s.metrics.volumeAcceleration, "×")}`,
    `Fee acceleration: ${fmt(s.metrics.feeAcceleration, "×")}`,
    `Price 1h: ${fmt(s.pool.priceChange1h, "%")}`,
    ...s.metrics.activityReasons,
    `Read-only observation; not expected return.`,
    `${env.APP_URL}/pool/${encodeURIComponent(s.pool.id)}`,
  ].join("\n");
  try {
    // Deliberately do not retry a send: a timeout may occur after Telegram delivered it.
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(env.HTTP_TIMEOUT_MS),
      },
    );
    const result = z.object({ ok: z.boolean() }).parse(await response.json());
    store.db
      .update(alerts)
      .set({ delivery: response.ok && result.ok ? "sent" : "failed" })
      .where(eq(alerts.id, id))
      .run();
  } catch {
    store.db.update(alerts).set({ delivery: "unknown" }).where(eq(alerts.id, id)).run();
  }
}
