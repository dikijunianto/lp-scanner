import { createStore } from "../db/store";
import { ScanSupervisor } from "./scan-supervisor";
const store = createStore();
const scanner = new ScanSupervisor(store);
try {
  await scanner.scan();
  if (store.recentRuns()[0]?.status === "error") process.exitCode = 1;
} finally {
  store.close();
}
