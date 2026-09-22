import { describe, it, expect } from "vitest";
import { createStore } from "../src/db/store";
import { Scanner } from "../src/workers/scanner";
import { emptyPool, emptyToken } from "../src/core/model";
import { snapshot } from "../src/core/analytics";
import { recordAlert } from "../src/workers/alerts";
const pool = () =>
  emptyPool({
    chain: "solana",
    protocol: "meteora-dlmm",
    dex: "Test",
    poolAddress: "test",
    token0: emptyToken("x", "X"),
    token1: emptyToken("y", "Y"),
    source: "test fixture",
  });
describe("persistence and isolation", () => {
  it("appends snapshots, updates current pool and keeps tokens", () => {
    const s = createStore(":memory:");
    try {
      const p = pool();
      s.save([snapshot(p, []), snapshot({ ...p, timestamp: p.timestamp + 1, price: 2 }, [])]);
      expect(s.history(p.id)).toHaveLength(2);
      expect(s.get(p.id)?.pool.price).toBe(2);
      expect(s.list()).toHaveLength(1);
    } finally {
      s.close();
    }
  });
  it("keeps all history by default and prunes only explicitly", () => {
    const s = createStore(":memory:");
    try {
      const p = { ...pool(), timestamp: Date.now() - 3 * 86400000 };
      s.save([snapshot(p, [])]);
      s.prune(0);
      expect(s.history(p.id, 0)).toHaveLength(1);
      s.prune(1);
      expect(s.history(p.id, 0)).toHaveLength(0);
      expect(s.get(p.id)).toBeDefined();
    } finally {
      s.close();
    }
  });
  it("isolates source failures and prevents overlapping scans in the process", async () => {
    const s = createStore(":memory:");
    try {
      let calls = 0;
      const scanner = new Scanner(s, [
        {
          name: "broken",
          scan: async () => {
            throw new Error("secret endpoint");
          },
          candles: async () => [],
        },
        {
          name: "working",
          scan: async () => {
            calls++;
            return { pools: [pool()], notes: [] };
          },
          candles: async () => [],
        },
      ]);
      await Promise.all([scanner.scan(), scanner.scan()]);
      expect(calls).toBe(1);
      expect(s.list()).toHaveLength(1);
      expect(s.recentRuns()[0].status).toBe("degraded");
      expect(JSON.stringify(s.recentRuns())).not.toContain("secret endpoint");
    } finally {
      s.close();
    }
  });
  it("persists alert cooldown across calls without sending Telegram", async () => {
    const s = createStore(":memory:");
    try {
      const item = snapshot(pool(), []);
      item.metrics.surge = true;
      s.save([item]);
      await recordAlert(s, item);
      await recordAlert(s, item);
      expect(s.recentAlerts()).toHaveLength(1);
      expect(s.recentAlerts()[0].delivery).toBe("local");
    } finally {
      s.close();
    }
  });
});
