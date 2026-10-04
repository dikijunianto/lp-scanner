import {afterEach,describe,expect,it,vi} from 'vitest';
import {createStore} from '../src/db/store';
import {emptyPool,emptyToken} from '../src/core/model';
import {snapshot} from '../src/core/analytics';
import {indexLiveEvmFees} from '../src/adapters/evm-fees';
import type {ReadOnlyRpc} from '../src/adapters/liquidity-rpc';
import {env} from '../src/config/env';
import {liveFeeFailure} from '../src/db/continuity';

const now=1791200046000,end=Math.floor(now/60000)*60000;
const hash=`0x${'a'.repeat(64)}`,address=(n:string)=>`0x${n.repeat(40)}`;
function fixture(covered=true,unpriced=false) {
  vi.setSystemTime(now);
  const store=createStore(':memory:');
  const p=emptyPool({chain:'base',protocol:'uniswap-v3',dex:'Uniswap V3',poolAddress:address('3'),
    token0:emptyToken(address('1'),'A'),token1:emptyToken(address('2'),'B'),source:'fixture'},now);
  p.volume1h=10000000;p.feeTier=.0005;
  p.activeLiquidityDetails={method:'V3_VIRTUAL_RESERVES_V1',block:'0x64',blockTime:end+2000,
    rpcSource:'fixture',token0Address:address('1'),token1Address:address('2'),decimals0:6,decimals1:18,
    amount0:'1',amount1:'1',price0Usd:1,price1Usd:1,priceSource:'fixture',priceObservedAt:now,pairPrice:'1'};
  store.save([snapshot(p,[])]);
  const events=unpriced?[{poolId:p.id,blockNumber:99,blockHash:hash,txHash:hash,logIndex:0,
    timestamp:end-100000,volumeUsd:null,feesUsd:null,confidence:'UNAVAILABLE' as const,chain:'base'}]:[];
  store.saveLiveFeeBatch(p.id,'base',events,1,covered?end-3600000:end-300000,100,hash,end+2000,
    100+env.FEE_CONFIRMATIONS,now,'RPC_GET_LOGS','fixture');
  if(!covered) {
    const cursor=store.liveFeeCursor(p.id)!;
    // Legacy cursor extent can claim an hour; only explicit intervals provide new evidence.
    vi.spyOn(store,'liveFeeCursor').mockReturnValue({...cursor,startTime:end-3600000});
  }
  const rpc={call:vi.fn(async(_method:string,params:unknown[])=>({
    number:params[0]==='latest'?`0x${(100+env.FEE_CONFIRMATIONS).toString(16)}`:'0x64',
    timestamp:`0x${Math.floor((params[0]==='latest'?now:end+2000)/1000).toString(16)}`,hash}))} as unknown as ReadOnlyRpc;
  return {store,p,rpc};
}
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
describe('explicit live fee coverage',()=>{
  it('rematerializes a caught-up head as complete zero activity from fully covered time',async()=>{
    const {store,p,rpc}=fixture();
    try {
      const result=await indexLiveEvmFees(p,rpc,store);
      expect(result.indexed).toBe(0);
      const fee=store.latestFeeWindows(p.id)['1h']!;
      expect(fee).toMatchObject({methodology:'EVENT_DERIVED',continuityState:'COMPLETE',
        activityState:'NO_ACTIVITY',volumeUsd:0,feesUsd:0,swapCount:0});
      expect(store.hotPoolDetails(now)[0]).toMatchObject({feeComplete:true,activity:'NO_ACTIVITY',
        zeroActivityState:'COMPLETE_ZERO_ACTIVITY',feeFailure:null});
    } finally {store.close();}
  });
  it('rejects an inferred cursor span with incomplete explicit coverage',async()=>{
    const {store,p,rpc}=fixture(false);
    try {
      await indexLiveEvmFees(p,rpc,store);
      expect(store.latestFeeWindows(p.id)['1h']).toMatchObject({methodology:'UNAVAILABLE',feesUsd:null,
        activityState:'MISSING_DATA'});
      expect(store.hotPoolDetails(now)[0]).toMatchObject({feeComplete:false,activity:'ACTIVE_OR_MISSING',feeFailure:'CURSOR_GAP'});
    } finally {store.close();}
  });
  it('keeps fully ingested but unpriced swaps distinct from missing events',async()=>{
    const {store,p,rpc}=fixture(true,true);
    try {
      await indexLiveEvmFees(p,rpc,store);
      expect(store.hotPoolDetails(now)[0]).toMatchObject({eventCovered:true,feeComplete:false,
        unpricedSwaps:1,feeFailure:'UNPRICED_SWAPS'});
      expect(store.feeWaterfall(now)).toMatchObject({active:1,eventComplete:1,swapPricesComplete:0,feeComplete:0});
    } finally {store.close();}
  });
});
describe('fee failure classification',()=>{
  const base={complete:false,covered:false,currentWindow:true,fresh:true,error:null,unpriced:0,swaps:0};
  it.each([
    [{...base,currentWindow:false,fresh:false,error:'RPC_PROVIDER_FAILURE'},'PROVIDER_FAILURE'],
    [{...base,error:'Block changed during log read'},'REORG_PENDING'],
    [{...base,error:'Indexer source unavailable'},'SOURCE_GAP'],
    [{...base,currentWindow:false},'WINDOW_NOT_MATURE'],
    [base,'CURSOR_GAP'],
    [{...base,covered:true,unpriced:2,swaps:3},'UNPRICED_SWAPS'],
    [{...base,covered:true},'NO_EVENTS'],
    [{...base,covered:true,swaps:3},'OTHER'],
    [{...base,covered:true,complete:true},null],
  ])('classifies without hiding infrastructure failures: %j',(input,reason)=>{
    expect(liveFeeFailure(input)).toBe(reason);
  });
});
