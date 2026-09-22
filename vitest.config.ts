import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: {
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      BASE_SUBGRAPH_URL: "",
      BSC_SUBGRAPH_URL: "",
      BASE_RPC_URL: "",
      BSC_RPC_URL: "",
      LOG_LEVEL: "silent",
    },
  },
});
