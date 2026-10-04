import {describe,expect,it} from "vitest";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createStore} from "../src/db/store";

describe("nonblocking WAL maintenance",()=>{
  it("skips in-memory databases without inventing reader telemetry",()=>{
    const store=createStore(":memory:");
    try {expect(store.walMaintenance(100000)).toBeNull();expect(store.walStatus()).toBeNull();}
    finally {store.close();}
  });
  it("records pending frames during a real reader and completes after release",()=>{
    const directory=mkdtempSync(join(tmpdir(),"lp-wal-")),path=join(directory,"scanner.sqlite");
    const store=createStore(path),writer=new Database(path),reader=new Database(path,{readonly:true});
    let release:()=>void=()=>{};
    try {
      writer.pragma("wal_autocheckpoint=0");
      reader.exec("BEGIN");reader.prepare("SELECT COUNT(*) FROM app_settings").get();
      release=store.beginOwnedRead("test reader transaction",90000);
      writer.transaction(()=>{
        for(let n=0;n<30;n++) writer.prepare("INSERT OR REPLACE INTO app_settings VALUES (?,?)")
          .run(`wal-test:${n}`,"x".repeat(8000));
      })();
      const blocked=store.walMaintenance(100000)!;
      expect(blocked.error).toBeNull();expect(blocked.remainingFrames).toBeGreaterThan(0);
      expect(blocked.blockedOrPending).toBe(true);expect(blocked.result!.logFrames).toBeGreaterThan(0);
      expect(blocked.ownedReaderAgeMs).toBe(10000);expect(blocked.ownedReaderCount).toBe(1);
      expect(blocked.globalReaderAgeMs).toBeNull();expect(blocked.globalReaderStatus).toBe("UNKNOWN");
      expect(blocked.readerCoverage).toBe("EXPLICIT_OWNED_SCOPES_ONLY");
      expect(blocked.durationMs).toBeGreaterThanOrEqual(0);expect(blocked.walBeforeBytes).toBeGreaterThan(0);
      expect(store.walMaintenance(100001)).toEqual(blocked);
      reader.exec("ROLLBACK");release();
      const completed=store.walMaintenance(160000)!;
      expect(completed.error).toBeNull();expect(completed.remainingFrames).toBe(0);
      expect(completed.blockedOrPending).toBe(false);expect(completed.ownedReaderAgeMs).toBeNull();
      expect(completed.ownedReaderCount).toBe(0);expect(store.walStatus()).toEqual(completed);
      // PASSIVE does not promise file truncation, and the status write creates new WAL frames.
      expect(writer.prepare("SELECT COUNT(*) n FROM app_settings WHERE key LIKE 'wal-test:%'").get())
        .toEqual({n:30});
    } finally {release();reader.close();writer.close();store.close();rmSync(directory,{recursive:true,force:true});}
  });
  it("keeps its throttle after reopening the owned store",()=>{
    const directory=mkdtempSync(join(tmpdir(),"lp-wal-reopen-")),path=join(directory,"scanner.sqlite");
    let store=createStore(path);
    try {
      const first=store.walMaintenance(100000);store.close();store=createStore(path);
      expect(store.walMaintenance(120000)).toEqual(first);
      expect(store.walMaintenance(160000)?.attemptedAt).toBe(160000);
    } finally {store.close();rmSync(directory,{recursive:true,force:true});}
  });
});
