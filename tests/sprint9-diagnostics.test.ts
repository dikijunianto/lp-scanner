import {it,expect} from 'vitest';
import {createStore} from '../src/db/store';
import {diskMode} from '../src/db/continuity';
import {env} from '../src/config/env';
it('serves a persisted compact summary without invoking historical aggregates',()=>{
 const store=createStore(':memory:');try{
  expect(store.diagnosticSummary()).toBeNull();
  store.saveDiagnosticSummary({generatedAt:10,hotCoverage:[{chain:'base',pools:1}]},11);
  expect(store.diagnosticSummary()).toEqual({updatedAt:11,data:{generatedAt:10,hotCoverage:[{chain:'base',pools:1}]}});
  store.saveDiagnosticSummary({generatedAt:20},21);expect(store.diagnosticSummary()!.data.generatedAt).toBe(20);
 }finally{store.close();}
});
it('enforces emergency/critical/high disk boundaries',()=>{
 expect(diskMode((env.DISK_EMERGENCY_GIB*2**30)-1)).toBe('EMERGENCY');
 expect(diskMode(env.DISK_EMERGENCY_GIB*2**30)).toBe('CRITICAL');
 expect(diskMode(env.DISK_CRITICAL_GIB*2**30)).toBe('HIGH');
});
