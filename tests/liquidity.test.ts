import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { emptyPool, emptyToken } from "../src/core/model";
import { analyze, snapshot } from "../src/core/analytics";
import {
  binPairPrice,
  tokenUnits,
  tickPairPrice,
  v3VirtualAmounts,
  usdValue,
  priceEvidence,
  reliableLiquidity,
} from "../src/core/liquidity";
import { currentSnapshot } from "../src/db/store";
import { HttpClient } from "../src/adapters/http";
import { ReadOnlyRpc, signedTick, words } from "../src/adapters/liquidity-rpc";
import { enrichEvmLiquidity, evmNetworks, multicallAbi } from "../src/adapters/evm-liquidity";
import { mintDecimals, decodePair } from "../src/adapters/meteora-liquidity";
const require = createRequire(import.meta.url);
const { BN } = require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
const { binIdToBinArrayIndex } = require("@meteora-ag/dlmm") as typeof import("@meteora-ag/dlmm");
const now = 1790000000000,
  a = "0x0000000000000000000000000000000000000001",
  b = "0x0000000000000000000000000000000000000002";
function pool() {
  return emptyPool(
    {
      chain: "base",
      protocol: "uniswap-v3",
      dex: "Uniswap V3",
      poolAddress: "0x0000000000000000000000000000000000000003",
      token0: {
        ...emptyToken(a, "A"),
        usdPrice: 1,
        usdPriceObservedAt: now,
        usdPriceSource: "fixture",
        usdPriceConfidence: "HIGH",
      },
      token1: {
        ...emptyToken(b, "B"),
        usdPrice: 1,
        usdPriceObservedAt: now,
        usdPriceSource: "fixture",
        usdPriceConfidence: "HIGH",
      },
      source: "fixture",
    },
    now,
  );
}
const abi = (...xs: bigint[]) =>
  "0x" + xs.map((x) => BigInt.asUintN(256, x).toString(16).padStart(64, "0")).join("");
afterEach(() => vi.useRealTimers());
describe("active liquidity math and quality", () => {
  it("preserves base units across 6, 9, 18 and extreme decimals", () => {
    for (const d of [0, 6, 9, 18, 255])
      expect(tokenUnits((10n ** BigInt(d)).toString(), d).toString()).toBe("1");
    expect(() => tokenUnits("1", 256)).toThrow();
    expect(() => tokenUnits("-1", 6)).toThrow();
  });
  it("uses decimal-adjusted bin and tick prices including negative bin arrays", () => {
    expect(binPairPrice(0, 25, 9, 6).toNumber()).toBe(1000);
    expect(binPairPrice(-1, 100, 6, 6).toNumber()).toBeCloseTo(1 / 1.01, 12);
    expect(tickPairPrice(1, 18, 6).toString()).toBe("1000100000000");
    expect(binIdToBinArrayIndex(new BN(-1)).toNumber()).toBe(-1);
    expect(binIdToBinArrayIndex(new BN(-70)).toNumber()).toBe(-1);
    expect(binIdToBinArrayIndex(new BN(-71)).toNumber()).toBe(-2);
  });
  it("values both actual balances and virtual reserves in USD", () => {
    expect(usdValue(tokenUnits("1500000", 6), tokenUnits("2000000000", 9), 2, 3)).toBe(9);
    const v = v3VirtualAmounts("1000000", (2n ** 96n).toString(), 0, 6, 6);
    expect(usdValue(v.amount0, v.amount1, 2, 3)).toBe(5);
    const mixed = v3VirtualAmounts("1000000000000000000", (2n ** 96n).toString(), 0, 18, 6);
    expect(mixed.amount0.toString()).toBe("1");
    expect(mixed.amount1.toString()).toBe("1000000000000");
  });
  it("handles zero liquidity without producing ratios or falling back to TVL", () => {
    const v = v3VirtualAmounts("0", (2n ** 96n).toString(), 0, 6, 6);
    expect(usdValue(v.amount0, v.amount1, 1, 1)).toBe(0);
    const p = pool();
    p.tvlUsd = 1e9;
    p.fees1h = 100;
    p.volume1h = 1000;
    for (const value of [null, 0]) {
      p.activeLiquidityUsd = value;
      expect(analyze(p, []).feeEfficiency1h).toBeNull();
      expect(analyze(p, []).capitalTurnover1h).toBeNull();
    }
  });
  it("handles extreme valid ticks and rejects impossible state", () => {
    for (const [q, t] of [
      ["4295128739", -887272],
      ["1461446703485210103287273052203988822378723970341", 887271],
    ] as const) {
      const v = v3VirtualAmounts("1", q, t, 18, 6);
      expect(v.amount0.isFinite()).toBe(true);
      expect(v.amount1.isFinite()).toBe(true);
    }
    expect(() => v3VirtualAmounts("1", "0", 0, 6, 6)).toThrow();
    expect(() => v3VirtualAmounts("1", (2n ** 96n).toString(), 10, 6, 6)).toThrow();
    expect(() => tickPairPrice(887273, 6, 6)).toThrow();
    expect(signedTick(BigInt.asUintN(256, -887272n))).toBe(-887272);
  });
  it("rejects missing, stale and disagreeing USD prices", () => {
    const p = pool();
    const price = binPairPrice(0, 1, 6, 6);
    expect(priceEvidence(p.token0, p.token1, price, now, 180000, 0.1).price0Usd).toBe(1);
    p.token0.usdPrice = null;
    expect(() => priceEvidence(p.token0, p.token1, price, now, 180000, 0.1)).toThrow();
    p.token0.usdPrice = 2;
    expect(() => priceEvidence(p.token0, p.token1, price, now, 180000, 0.1)).toThrow(/disagree/);
    p.token0.usdPrice = 1;
    expect(() => priceEvidence(p.token0, p.token1, price, now + 180001, 180000, 0.1)).toThrow(
      /stale/,
    );
    expect(() => usdValue(tokenUnits("0", 0), tokenUnits("0", 0), null, 1)).toThrow();
  });
  it("expires current metrics without modifying persisted snapshot/history", () => {
    const p = pool();
    Object.assign(p, {
      activeLiquidityUsd: 20,
      activeLiquiditySource: "ONCHAIN_DERIVED",
      activeLiquidityConfidence: "MEDIUM",
      activeLiquidityUpdatedAt: now,
      activeLiquidityExpiresAt: now + 120000,
      fees1h: 2,
      volume1h: 100,
    });
    const s = snapshot(p, [], []);
    s.metrics.surge = true;
    s.metrics.tvlChange30m = -30;
    const original = JSON.stringify(s);
    expect(reliableLiquidity(p, now)).toBe(true);
    const expired = currentSnapshot(s, now + 120001);
    expect(expired.metrics.feeEfficiency1h).toBeNull();
    expect(expired.metrics.capitalTurnover1h).toBeNull();
    expect(expired.pool.activeLiquidityUsd).toBeNull();
    expect(expired.metrics.surge).toBe(true);
    expect(expired.metrics.tvlChange30m).toBe(-30);
    expect(JSON.stringify(s)).toBe(original);
  });
  it("validates Solana mint state, owner and DLMM discriminators", () => {
    const data = Buffer.alloc(82);
    data[44] = 9;
    data[45] = 1;
    const account = {
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      executable: false,
      data: [data.toString("base64"), "base64"] as [string, "base64"],
    };
    expect(mintDecimals(account)).toBe(9);
    expect(() => mintDecimals({ ...account, owner: a })).toThrow();
    expect(() => decodePair(account)).toThrow();
    expect(() => mintDecimals({ ...account, data: ["AA==", "base64"] })).toThrow();
  });
});
describe("batched on-chain enrichment", () => {
  function rpc(
    options: {
      stale?: boolean;
      malformed?: boolean;
      wrongChain?: boolean;
      missingPrice?: boolean;
      token0?: string;
      token1?: string;
      decimals0?: number;
      decimals1?: number;
      balanceFailure?: boolean;
      malformedBalance?: boolean;
      balance0?: bigint;
      balance1?: bigint;
      reorg?: boolean;
      liquidity?: bigint;
    } = {},
  ) {
    const block = {
      number: "0x123",
      timestamp: "0x" + Math.floor((now - (options.stale ? 121000 : 1000)) / 1000).toString(16),
      hash: "0x" + "a".repeat(64),
    };
    const calls: unknown[][] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const requests = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify(
          requests
            .map((r: { id: number; method: string; params: unknown[] }) => {
              calls.push(r.params);
              let result: unknown;
              if (r.method === "eth_chainId") result = options.wrongChain ? "0x38" : "0x2105";
              else if (r.method === "eth_getBlockByNumber") result = options.reorg && r.params[0] === block.number
                ? { ...block, hash: "0x" + "b".repeat(64) } : block;
              else {
                const data = (r.params[0] as { data: string }).data;
                const [inner] = multicallAbi.decodeFunctionData("aggregate3", data);
                result = multicallAbi.encodeFunctionResult("aggregate3", [
                  inner.map((c: { target: string; callData: string }) => {
                    let value = (
                      {
                        "0x3850c7bd": abi(2n ** 96n, 0n, 0n, 1n, 1n, 0n, 1n),
                        "0x1a686502": abi(options.liquidity ?? 1000000n),
                        "0x0dfe1681": abi(BigInt(options.token0 ?? a)),
                        "0xd21220a7": abi(BigInt(options.token1 ?? b)),
                        "0xddca3f43": abi(500n),
                        "0xd0c93a7c": abi(10n),
                        "0xc45a0155": abi(BigInt(evmNetworks.base.factory)),
                        "0x313ce567": abi(BigInt(c.target.toLowerCase() === (options.token0 ?? a).toLowerCase()
                          ? options.decimals0 ?? 6 : options.decimals1 ?? 6)),
                      } as Record<string, string>
                    )[c.callData];
                    if (c.callData.startsWith("0x70a08231")) {
                      if (options.balanceFailure) return [false, "0x"];
                      value = options.malformedBalance ? "0x123" : abi(c.target.toLowerCase() ===
                        (options.token0 ?? a).toLowerCase() ? options.balance0 ?? 250000000000n : options.balance1 ?? 300000000000n);
                    }
                    if (options.malformed && c.callData === "0x3850c7bd") value = "0x123";
                    return [true, value];
                  }),
                ]);
              }
              return { id: r.id, jsonrpc: "2.0", result };
            })
            .reverse(),
        ),
      );
    }) as typeof fetch;
    return { rpc: new ReadOnlyRpc("https://fixture.test", new HttpClient(0, fetcher, 0)), calls };
  }
  it("reads pinned state, decimals and fee; values canonical token order", async () => {
    vi.setSystemTime(now);
    const p = pool();
    [p.token0, p.token1] = [p.token1, p.token0];
    [p.token0Address, p.token1Address] = [p.token1Address, p.token0Address];
    const test = rpc();
    expect((await enrichEvmLiquidity([p], "base", test.rpc)).enriched).toBe(1);
    expect(p.activeLiquidityUsd).toBe(2);
    expect(p.feeTier).toBe(0.0005);
    expect(p.activeLiquiditySource).toBe("ESTIMATED");
    expect(p.activeLiquidityDetails?.decimals0).toBe(6);
    expect(test.calls.filter((c) => typeof c[0] === "object").every((c) => c[1] === "0x123")).toBe(
      true,
    );
  });
  it.each([{ stale: true }, { malformed: true }, { wrongChain: true }])(
    "leaves unavailable on bad RPC: %j",
    async (options) => {
      vi.setSystemTime(now);
      const p = pool();
      const test = rpc(options);
      await enrichEvmLiquidity([p], "base", test.rpc);
      expect(p.activeLiquidityUsd).toBeNull();
      expect(p.activeLiquiditySource).toBe("UNAVAILABLE");
      expect(p.pairState).toBeUndefined();
    },
  );
  it("leaves unavailable when token pricing is absent", async () => {
    vi.setSystemTime(now);
    const p = pool();
    p.token0.usdPrice = null;
    await enrichEvmLiquidity([p], "base", rpc().rpc);
    expect(p.activeLiquidityUsd).toBeNull();
    expect(p.activeLiquidityReason).toMatch(/pricing/);
    expect(p.pairState?.depositedToken0Amount).toBe(250000);
    expect(p.pairState?.depositedLiquidityUsd).toBe(0);
  });
  it("captures pinned actual custody with 6/18 decimals despite missing analyzed-token USD", async () => {
    vi.setSystemTime(now);
    const p = pool(), anchor = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const other = "0x0000000000000000000000000000000000000099";
    p.token0.address = p.token0Address = anchor;
    p.token0.usdPriceSource = "DefiLlama Coins API";
    p.token0.usdPriceSourceTimestamp = now - 1000;
    p.token1.address = p.token1Address = other;
    p.token1.usdPrice = null;
    const test = rpc({ token0: anchor, token1: other, decimals0: 6, decimals1: 18,
      balance0: 250000000000n, balance1: 3n * 10n ** 18n });
    await enrichEvmLiquidity([p], "base", test.rpc);
    expect(p.activeLiquidityUsd).toBeNull();
    expect(p.pairState).toMatchObject({ token0Address: anchor, token1Address: other,
      depositedToken0Amount: 250000, depositedToken1Amount: 3, depositedLiquidityUsd: 250000,
      blockNumber: "0x123", sourceTimestamp: now - 1000,
      execution:{kind:"V3_CURRENT_RANGE",sqrtPriceX96:(2n ** 96n).toString(),
        liquidityRaw:"1000000",tick:0,tickSpacing:10,decimals0:6,decimals1:18} });
    expect(p.pairState?.source).toContain("not tradable reserves");
    const aggregates = test.calls.filter((c) => typeof c[0] === "object");
    expect(aggregates.every((c) => c[1] === "0x123")).toBe(true);
    const balances = aggregates.flatMap((c) => {
      const [inner] = multicallAbi.decodeFunctionData("aggregate3", (c[0] as { data: string }).data);
      return inner.filter((r: { callData: string }) => r.callData.startsWith("0x70a08231"));
    });
    expect(balances).toHaveLength(2);
    expect(balances.every((r: { callData: string }) => r.callData.endsWith(p.poolAddress.slice(2)))).toBe(true);
    expect(test.calls.at(-1)?.[0]).toBe("0x123");
  });
  it.each([{ balanceFailure: true }, { malformedBalance: true }])(
    "does not replace missing custody with virtual reserves or TVL: %j", async (options) => {
      vi.setSystemTime(now);
      const p = pool();
      p.tvlUsd = 100000000;
      await enrichEvmLiquidity([p], "base", rpc(options).rpc);
      expect(p.activeLiquidityUsd).toBe(2);
      expect(p.pairState).toBeUndefined();
    });
  it("retains a verified zero custody balance and rejects reorg evidence", async () => {
    vi.setSystemTime(now);
    const p = pool();
    await enrichEvmLiquidity([p], "base", rpc({ balance0: 0n, balance1: 0n }).rpc);
    expect(p.pairState?.depositedToken0Amount).toBe(0);
    expect(p.pairState?.depositedLiquidityUsd).toBe(0);
    await enrichEvmLiquidity([p], "base", rpc({ reorg: true }).rpc);
    expect(p.pairState).toBeUndefined();
    expect(p.activeLiquidityUsd).toBeNull();
  });
  it("preserves raw zero in-range liquidity without deriving infinite execution reserves", async () => {
    vi.setSystemTime(now);
    const p = pool();
    await enrichEvmLiquidity([p], "base", rpc({ liquidity:0n }).rpc);
    expect(p.activeLiquidityUsd).toBe(0);
    expect(p.pairState?.execution).toMatchObject({liquidityRaw:"0",sqrtPriceX96:(2n ** 96n).toString()});
    expect(Number.isFinite(p.pairState!.pairPrice)).toBe(true);
    expect(Number.isFinite(p.pairState!.depositedToken0Amount)).toBe(true);
  });
  it("rejects malformed batches, duplicate ids and write methods", async () => {
    for (const body of [
      { result: 1 },
      [
        { id: 1, result: 1 },
        { id: 1, result: 2 },
      ],
    ]) {
      const r = new ReadOnlyRpc(
        "https://fixture.test",
        new HttpClient(0, async () => new Response(JSON.stringify(body)), 0),
      );
      await expect(r.batch([{ method: "eth_chainId", params: [] }])).rejects.toThrow();
    }
    const r = new ReadOnlyRpc("https://fixture.test");
    await expect(r.call("eth_sendTransaction", [])).rejects.toThrow(/Read-only/);
    expect(() => words("0x123")).toThrow();
  });
});

// Captured public mainnet accounts; frozen bytes keep SDK decoding and valuation deterministic.
import fixture from "./fixtures/dlmm-accounts.json";
import { enrichMeteoraLiquidity } from "../src/adapters/meteora-liquidity";
import type { Pool } from "../src/core/model";
describe("DLMM account enrichment", () => {
  it.each(["valid", "stale", "malformed", "missing-price", "wrong-owner"])(
    "handles %s account evidence",
    async (mode) => {
      const time = fixture.blockTime as number;
      vi.setSystemTime(time * 1000 + 1000);
      const p = structuredClone(fixture.pool) as Pool;
      for (const t of [p.token0, p.token1]) t.usdPriceObservedAt = time * 1000;
      if (mode === "missing-price") p.token1.usdPrice = null;
      const fetcher = async (_url: unknown, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            JSON.parse(String(init?.body)).map(
              (r: { id: number; method: string; params: unknown[] }) => {
                let result: unknown;
                if (r.method === "getGenesisHash")
                  result = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
                else if (r.method === "getBlockTime") result = mode === "stale" ? time - 180 : time;
                else {
                  const keys = r.params[0] as string[];
                  result = {
                    context: fixture.accounts.context,
                    value: keys.map((k) => {
                      const a = structuredClone(fixture.accounts.value[fixture.keys.indexOf(k)]);
                      if (mode === "wrong-owner") a.owner = "invalid";
                      return a;
                    }),
                  };
                  if (mode === "malformed") result = { context: { slot: -1 }, value: [] };
                }
                return { jsonrpc: "2.0", id: r.id, result };
              },
            ),
          ),
        );
      await enrichMeteoraLiquidity(
        [p],
        new ReadOnlyRpc("https://fixture.test", new HttpClient(0, fetcher, 0)),
      );
      if (mode === "valid") {
        expect(p.activeLiquidityUsd).toBeCloseTo(39979.36839909611, 5);
        expect(p.activeLiquidityDetails?.activeBinId).toBe(-124);
        expect(p.activeLiquidityDetails?.rawAmount0).toBe("60861192245");
        expect(p.activeLiquiditySource).toBe("ONCHAIN_DERIVED");
      } else expect(p.activeLiquidityUsd).toBeNull();
    },
  );
});
