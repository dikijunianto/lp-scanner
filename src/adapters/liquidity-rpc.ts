import { z } from "zod";
import { HttpClient } from "./http";
import { countRpc } from "../core/traffic";
export class ReadOnlyRpc {
  requests = 0;
  private id = 0;
  constructor(
    private url: string,
    private http = new HttpClient(250, fetch, 1),
    private batchSize = 10,
  ) {}
  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const allowed = [
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_call",
      "eth_getLogs",
      "getGenesisHash",
      "getMultipleAccounts",
      "getBlockTime",
    ];
    if (calls.some((c) => !allowed.includes(c.method)))
      throw new Error("Read-only RPC method required");
    const results: unknown[] = [];
    for (let start = 0; start < calls.length; start += this.batchSize) {
      const chunk = calls
        .slice(start, start + this.batchSize)
        .map((c) => ({ ...c, jsonrpc: "2.0", id: ++this.id }));
      this.requests++;
      countRpc();
      const response = await this.http.json(
        this.url,
        z.array(
          z.object({
            id: z.number().int(),
            result: z.unknown().optional(),
            error: z.unknown().optional(),
          }),
        ),
        { body: chunk },
      );
      if (
        response.length !== chunk.length ||
        new Set(response.map((r) => r.id)).size !== chunk.length ||
        response.some((r) => !chunk.some((c) => c.id === r.id))
      )
        throw new Error("Malformed RPC batch");
      for (const request of chunk) {
        const r = response.find((r) => r.id === request.id)!;
        results.push(r.error ? undefined : r.result);
      }
    }
    return results;
  }
  async call(method: string, params: unknown[]) {
    return (await this.batch([{ method, params }]))[0];
  }
}
export const hexQuantity = z.string().regex(/^0x[0-9a-fA-F]+$/);
export const blockSchema = z.object({
  number: hexQuantity,
  timestamp: hexQuantity,
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
export function words(value: unknown, count?: number): bigint[] {
  if (typeof value !== "string" || !/^0x([a-fA-F0-9]{64})+$/.test(value))
    throw new Error("Malformed ABI response");
  const chunks = value.slice(2).match(/.{64}/g)!;
  if (count !== undefined && chunks.length !== count) throw new Error("Malformed ABI response");
  return chunks.map((w) => BigInt(`0x${w}`));
}
export function wordAddress(value: unknown) {
  const n = words(value, 1)[0];
  if (n >= 2n ** 160n || n === 0n) throw new Error("Malformed token address");
  return `0x${n.toString(16).padStart(40, "0")}`;
}
export function signedTick(value: bigint) {
  const n = BigInt.asIntN(256, value);
  if (n < -887272n || n > 887272n) throw new Error("Invalid tick");
  return Number(n);
}
