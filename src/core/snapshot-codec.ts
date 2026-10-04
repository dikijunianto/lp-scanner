import {deflateRawSync,inflateRawSync} from 'node:zlib';
import type {Snapshot} from './model';
interface Envelope {codec:'snapshot-deflate-v1';payload:string;pool:{feeTier:Snapshot['pool']['feeTier'];activeLiquidityDetails:{method:string}|null}}
export function encodeSnapshot(data:Snapshot):Snapshot {
  const plain=JSON.stringify(data);
  // Every encoded value must remain readable under the bounded decoder.
  if(Buffer.byteLength(plain)>2**20)return data;
  const compressed=deflateRawSync(plain,{level:1}).toString('base64');
  const envelope:Envelope={codec:'snapshot-deflate-v1',payload:compressed,pool:{feeTier:data.pool.feeTier,
    activeLiquidityDetails:data.pool.activeLiquidityDetails?{method:data.pool.activeLiquidityDetails.method}:null}};
  return JSON.stringify(envelope).length<plain.length?envelope as unknown as Snapshot:data;
}
export function decodeSnapshot(data:Snapshot):Snapshot {
  const candidate=data as unknown as Partial<Envelope>;
  if(candidate.codec===undefined)return data;
  if(candidate.codec!=='snapshot-deflate-v1' || typeof candidate.payload!=='string' ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.payload))throw new Error('Malformed compressed snapshot');
  const result=JSON.parse(inflateRawSync(Buffer.from(candidate.payload,'base64'),{maxOutputLength:2**20}).toString()) as Snapshot;
  if(!result?.pool?.id || !result.metrics || !Number.isFinite(result.pool.timestamp))throw new Error('Invalid decoded snapshot');
  return result;
}
