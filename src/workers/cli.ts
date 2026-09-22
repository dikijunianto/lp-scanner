import { createStore } from "../db/store";
import { Scanner } from "./scanner";
const store = createStore();
const scanner = new Scanner(store);
try {
  await scanner.scan();
  if (store.recentRuns()[0]?.status === "error") process.exitCode = 1;
} finally {
  store.close();
}
