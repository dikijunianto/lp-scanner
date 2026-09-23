import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { HttpClient, safeError } from "../src/adapters/http";
import { MeteoraAdapter, normalizeMeteora } from "../src/adapters/meteora";
import { normalizeEvm, UniswapV3Adapter, PancakeV3Adapter } from "../src/adapters/evm";
const address = "11111111111111111111111111111111";
const raw = {
  address,
  name: "X-Y",
  token_x: { address, symbol: "X", freeze_authority_disabled: false },
  token_y: { address, symbol: "Y" },
  tvl: 100000,
  current_price: 2,
  created_at: 1780000000000,
  volume: { "1h": 100 },
  fees: { "1h": 5 },
  pool_config: { bin_step: 10 },
};
const evm = {
  attributes: {
    address: "0x0000000000000000000000000000000000000001",
    name: "X / Y 0.3%",
    reserve_in_usd: "1000",
    base_token_price_quote_token: "2",
    pool_created_at: "2025-01-01T00:00:00Z",
    volume_usd: { h1: "1000" },
    transactions: { h1: { buys: 2, sells: 3, buyers: 2, sellers: 2 } },
  },
  relationships: {
    dex: { data: { id: "uniswap-v3-base" } },
    base_token: { data: { id: "base_0x0000000000000000000000000000000000000002" } },
    quote_token: { data: { id: "base_0x0000000000000000000000000000000000000003" } },
  },
};
describe("adapters", () => {
  it("normalizes official Meteora fields without inventing active liquidity or 5m fees", () => {
    const p = normalizeMeteora(raw);
    expect(p.fees1h).toBe(5);
    expect(p.fees5m).toBeNull();
    expect(p.activeLiquidityUsd).toBeNull();
    expect(p.token0.freezeAuthority).toBe(true);
    expect(p.token1.freezeAuthority).toBeNull();
    expect(p.binStep).toBe(10);
  });
  it("rejects malformed values instead of coercing null to zero", () => {
    expect(() => normalizeMeteora({ ...raw, tvl: "bad" })).toThrow();
    expect(normalizeMeteora({ ...raw, tvl: null }).tvlUsd).toBeNull();
    expect(() => normalizeMeteora({ ...raw, fees: { "1h": -1 } })).toThrow();
  });
  it("paginates and deduplicates Meteora discovery", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ pages: 2, total: 2, data: [raw] }))
      .mockResolvedValueOnce(
        Response.json({
          pages: 2,
          total: 2,
          data: [{ ...raw, address: "22222222222222222222222222222222" }],
        }),
      );
    const a = new MeteoraAdapter(new HttpClient(0, fetcher));
    expect((await a.scan()).pools).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects an entirely invalid feed", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ pages: 1, total: 1, data: [{}] }));
    await expect(new MeteoraAdapter(new HttpClient(0, fetcher)).scan()).rejects.toThrow();
  });
  it("keeps EVM fees unknown, avoids unique-trader double counting and quote/USD changes", () => {
    const p = normalizeEvm(evm, new UniswapV3Adapter().config);
    expect(p.fees1h).toBeNull();
    expect(p.swapCount).toBe(5);
    expect(p.uniqueTraderCount).toBeNull();
    expect(p.priceChange1h).toBeNull();
    expect(p.priceUnit).toBe("Y per X");
    expect(p.poolAge).toBeGreaterThan(0);
  });
  it("rejects pools from an unrelated DEX", () => {
    expect(() => normalizeEvm(evm, new PancakeV3Adapter().config)).toThrow();
  });
  it("scans EVM without RPC or paid keys", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [evm] }));
    const a = new UniswapV3Adapter(new HttpClient(0, fetcher));
    const result = await a.scan();
    expect(result.pools).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("fees and unique traders");
  });
  it("reports missing upstreams without leaking a URL or token", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("https://secret-key.example"));
    const client = new HttpClient(0, fetcher, 0);
    await expect(client.json("https://example.com", z.object({}))).rejects.toThrow(
      "Upstream request failed or timed out",
    );
    expect(safeError(new Error("secret"))).not.toContain("secret");
  });
  it("retries transient status codes and caches validated responses", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValue(Response.json({ ok: true }));
    const client = new HttpClient(0, fetcher, 1);
    expect(
      await client.json("https://example.com", z.object({ ok: z.boolean() }), { ttl: 10000 }),
    ).toEqual({ ok: true });
    await client.json("https://example.com", z.object({ ok: z.boolean() }), { ttl: 10000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not retry schema failures or permanent HTTP errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    await expect(
      new HttpClient(0, fetcher, 2).json("https://example.com", z.object({})),
    ).rejects.toThrow("403");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("retrieves Meteora candles in bounded slices and removes duplicate/incomplete boundaries", async () => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    requests.push(String(url));
    const u = new URL(String(url)),
      start = Number(u.searchParams.get("start_time")),
      end = Number(u.searchParams.get("end_time"));
    expect(end - start).toBe(21600);
    return Response.json({
      data: [start, end].map((timestamp) => ({
        timestamp,
        open: 1,
        high: 2,
        low: 1,
        close: 1,
        volume: 5,
      })),
    });
  });
  const candles = await new MeteoraAdapter(new HttpClient(0, fetcher as typeof fetch)).candles(
    normalizeMeteora(raw),
  );
  expect(requests).toHaveLength(4);
  expect(candles).toHaveLength(4);
  expect(new Set(candles.map((c) => c.timestamp)).size).toBe(4);
});
