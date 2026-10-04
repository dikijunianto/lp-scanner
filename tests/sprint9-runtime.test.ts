import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/db/store";
import { runs } from "../src/db/schema";
import { clockEvent, keepAwakeArgs, sampleTrace } from "../src/core/clock";
import { ScanSupervisor } from "../src/workers/scan-supervisor";

describe("Sprint 9 runtime isolation", () => {
  it("kills a synchronously blocked child, prevents overlap, and records aborted spans", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lp-scanner-supervisor-"));
    const marker = join(directory, "blocked.json");
    const entry = join(directory, "blocked.mjs");
    writeFileSync(entry, `
      import { writeFileSync } from "node:fs";
      const startedAt = Date.now();
      process.send({type:"span",span:{phase:"discovery",operation:"fixture.complete",
        provider:null,startedAt,endedAt:startedAt+1,durationMs:1,timeoutMs:null,success:true}});
      process.send({type:"spanStart",span:{phase:"enrichment",operation:"fixture.blocked",
        provider:"fixture",startedAt:startedAt+1,timeoutMs:1500}}, () => {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));
        while (true) {}
      });
    `);
    const store = createStore(join(directory, "scanner.db"));
    const deadlineMs = 1500;
    const supervisor = new ScanSupervisor(store, entry, deadlineMs);
    try {
      const first = supervisor.scan();
      expect(supervisor.running).toBe(true);
      expect(supervisor.scan()).toBe(first);
      expect(store.scanSkipped()).toBe(1);
      await first;
      expect(supervisor.running).toBe(false);
      const { pid } = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
      expect(() => process.kill(pid, 0)).toThrow();
      const rows = store.db.select().from(runs).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("error");
      expect(rows[0].data[0].notes).toContain("SCAN_DEADLINE");
      const trace = store.scanTrace(rows[0].id);
      expect(trace.root).toMatchObject({
        deadline_ms: deadlineMs, deadline_breached: 1, error_class: "SCAN_DEADLINE",
      });
      const root = trace.root as { duration_ms: number; monotonic_ms: number };
      expect(root.monotonic_ms).toBeGreaterThanOrEqual(deadlineMs - 20);
      expect(root.duration_ms).toBeLessThan(10000);
      expect(trace.children).toHaveLength(2);
      expect(trace.children).toEqual(expect.arrayContaining([
        expect.objectContaining({ operation: "fixture.complete", success: 1, aborted: 0 }),
        expect.objectContaining({ operation: "fixture.blocked", success: 0, aborted: 1,
          error_class: "SCAN_DEADLINE" }),
      ]));
    } finally {
      await supervisor.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);

  it("distinguishes clock jumps from late scheduler pulses", () => {
    expect(clockEvent(1000, 1000)).toBeNull();
    expect(clockEvent(3000, 1000)).toBeNull();
    expect(clockEvent(3001, 1000)).toBe("SYSTEM_CLOCK_JUMP");
    expect(clockEvent(-1000, 1000)).toBeNull();
    expect(clockEvent(-1001, 1000)).toBe("SYSTEM_CLOCK_JUMP");
    expect(clockEvent(10001, 10001)).toBe("SYSTEM_SCHEDULER_DELAY");
    expect(clockEvent(15000, 10001)).toBe("SYSTEM_CLOCK_JUMP");
  });

  it("requests opt-in macOS keep-awake until the parent exits", () => {
    expect(keepAwakeArgs("darwin", 1234)).toEqual(["-dimsu", "-w", "1234"]);
    expect(keepAwakeArgs("darwin", 1234, false)).toBeNull();
    expect(keepAwakeArgs("linux", 1234)).toBeNull();
    expect(keepAwakeArgs("win32", 1234)).toBeNull();
  });

  it("samples normal traces deterministically and retains failures and slow runs", () => {
    expect(sampleTrace(1, 0, 99, false, 100)).toBe(false);
    expect(sampleTrace(1, 1, 99, false, 100)).toBe(true);
    expect(sampleTrace(1, 0.5, 99, false, 100)).toBe(false);
    expect(sampleTrace(2, 0.5, 99, false, 100)).toBe(true);
    expect(sampleTrace(2, 0.5, 99, false, 100)).toBe(true);
    expect(sampleTrace(1, 0, 99, true, 100)).toBe(true);
    expect(sampleTrace(1, 0, 100, false, 100)).toBe(true);
  });
});
