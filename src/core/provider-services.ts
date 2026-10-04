import type {ServiceHealth} from './epoch';
export interface ServiceEvidence {chain:string;service:string;source:string;lastSuccessAt:number|null;healthy:boolean}
export function providerServices(evidence:ServiceEvidence[],now=Date.now(),maxAgeMs=180000):ServiceHealth[] {
  return ['solana','base'].flatMap(chain=>['POOL_DISCOVERY','PRICE','CURRENT_STATE','LIVE_EVENTS','DEPTH_STATE'].map(service=>{
    const rows=evidence.filter(e=>e.chain===chain && e.service===service);
    const fresh=rows.filter(e=>e.lastSuccessAt!==null && e.lastSuccessAt<=now+30000 && now-e.lastSuccessAt<=maxAgeMs);
    const healthy=fresh.filter(e=>e.healthy);
    const required=!(chain==='solana' && service==='LIVE_EVENTS');
    const state=healthy.length?'HEALTHY':fresh.length?'DEGRADED':'UNAVAILABLE';
    return {chain,service,state:state as ServiceHealth['state'],required,sources:fresh.map(e=>e.source),
      reason:required?(state==='UNAVAILABLE'?'NO_FRESH_REQUIRED_SOURCE':null):'SOLANA_API_FEES_NOT_EVENT_COMPLETE'};
  }));
}
