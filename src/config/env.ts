import "dotenv/config";
import { z } from "zod";
const integer = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.url().optional());
const schema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/scanner.sqlite"),
  API_PORT: integer(3001, 1024, 65535),
  SCAN_INTERVAL_SECONDS: integer(60, 15, 86400),
  RETENTION_DAYS: integer(0, 0, 36500),
  METEORA_API_URL: z.url().default("https://dlmm.datapi.meteora.ag"),
  METEORA_MIN_TVL: z.coerce.number().nonnegative().default(10000),
  METEORA_MAX_POOLS: integer(1000, 0, 200000),
  METEORA_REQUESTS_PER_SECOND: integer(5, 1, 30),
  GECKO_API_URL: z.url().default("https://api.geckoterminal.com/api/v2"),
  EVM_PAGES: integer(1, 1, 10),
  GECKO_REQUESTS_PER_MINUTE: integer(20, 1, 30),
  BASE_SUBGRAPH_URL: optionalUrl,
  BSC_SUBGRAPH_URL: optionalUrl,
  BASE_RPC_URL: optionalUrl,
  BSC_RPC_URL: optionalUrl,
  RPC_ENRICH_LIMIT: integer(5, 0, 100),
  HTTP_TIMEOUT_MS: integer(15000, 100, 120000),
  HTTP_RETRIES: integer(2, 0, 5),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  SURGE_MULTIPLIER: z.coerce.number().min(1.1).default(3),
  SURGE_MIN_HOURLY_FEES: z.coerce.number().nonnegative().default(10),
  ALERT_MIN_ACTIVITY: integer(80, 0, 100),
  ALERT_MAX_RISK: integer(60, 0, 100),
  ALERT_MIN_FEE_EFFICIENCY: z.coerce.number().nonnegative().default(0.001),
  ALERT_COOLDOWN_MINUTES: integer(60, 1, 10080),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  APP_URL: z.url().default("http://localhost:3000"),
});
const result = schema.safeParse(process.env);
if (!result.success)
  throw new Error(
    `Invalid environment: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
  );
export const env = result.data;
