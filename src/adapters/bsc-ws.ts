import { pancakeSwapTopic } from "../core/fees";

type WsLike=Pick<WebSocket,"addEventListener"|"send"|"close"|"readyState">;
type Factory=(url:string)=>WsLike;
export type WsStatus="DISABLED"|"CONNECTING"|"LIVE"|"RECONNECTING";
const hexNumber=(value:unknown)=>typeof value==="string" && /^0x[0-9a-f]+$/i.test(value)
  ? Number(BigInt(value)):null;

// WebSocket is a wake-up source. The persisted cursor still advances only through
// contiguous, confirmed HTTP/indexer reads, which also recover disconnects/reorgs.
export class BscWsSource {
  private socket:WsLike|null=null;
  private stopped=false;
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  private heartbeatTimer:ReturnType<typeof setInterval>|null=null;
  private openTimer:ReturnType<typeof setTimeout>|null=null;
  private failures=0;
  private lastMessage=0;
  private confirmedHead=0;
  private subscriptions=new Map<string,"logs"|"heads">();
  private pending=new Map<string,number>();
  private seen=new Set<string>();
  status:WsStatus="DISABLED";
  constructor(private url:string,private addresses:string[],private confirmations:number,
    private onConfirmed:()=>void,private onStatus?:(status:WsStatus)=>void,
    private factory:Factory=(url)=>new WebSocket(url)) {}
  start() {this.stopped=false;this.connect();}
  stop() {
    this.stopped=true;this.status="DISABLED";this.onStatus?.(this.status);
    if(this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if(this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if(this.openTimer) clearTimeout(this.openTimer);
    this.socket?.close();this.socket=null;
  }
  private setStatus(status:WsStatus) {this.status=status;this.onStatus?.(status);}
  private reconnect() {
    if(this.stopped || this.reconnectTimer) return;
    this.setStatus("RECONNECTING");this.socket?.close();this.socket=null;
    if(this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if(this.openTimer) clearTimeout(this.openTimer);
    const delay=Math.min(30000,1000*2**Math.min(5,this.failures++));
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.connect();},delay);
  }
  private connect() {
    if(this.stopped || !this.addresses.length) return;
    this.setStatus("CONNECTING");this.subscriptions.clear();
    let socket:WsLike;
    try {socket=this.factory(this.url);} catch {this.reconnect();return;}
    this.socket=socket;
    this.openTimer=setTimeout(()=>{if(this.socket===socket && this.status!=="LIVE") this.reconnect();},15000);
    socket.addEventListener("open",()=>{
      if(this.socket!==socket || this.stopped) return;
      this.failures=0;this.lastMessage=Date.now();
      socket.send(JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_subscribe",
        params:["logs",{address:this.addresses,topics:[pancakeSwapTopic]}]}));
      socket.send(JSON.stringify({jsonrpc:"2.0",id:2,method:"eth_subscribe",params:["newHeads"]}));
      this.heartbeatTimer=setInterval(()=>{
        if(this.socket!==socket) return;
        if(Date.now()-this.lastMessage>60000) this.reconnect();
        else socket.send(JSON.stringify({jsonrpc:"2.0",id:3,method:"eth_blockNumber",params:[]}));
      },30000);
    });
    socket.addEventListener("message",(event)=>{
      if(this.socket!==socket || this.stopped) return;
      this.lastMessage=Date.now();
      let message:Record<string,unknown>;
      try {message=JSON.parse(String((event as MessageEvent).data)) as Record<string,unknown>;} catch {return;}
      if(message.error) {this.reconnect();return;}
      if((message.id===1 || message.id===2) && typeof message.result==="string") {
        this.subscriptions.set(message.result,message.id===1?"logs":"heads");
        if(this.subscriptions.size===2) {if(this.openTimer) clearTimeout(this.openTimer);this.setStatus("LIVE");}
        return;
      }
      const params=message.params as {subscription?:string;result?:Record<string,unknown>}|undefined;
      if(!params?.subscription || !params.result) return;
      const kind=this.subscriptions.get(params.subscription),value=params.result;
      const head=hexNumber(value.number);
      if(kind==="heads" && head!==null && Number.isSafeInteger(head)) {
        this.confirmedHead=head-this.confirmations;
        let ready=false;
        for(const [key,block] of this.pending) if(block<=this.confirmedHead) {
          this.pending.delete(key);ready=true;
        }
        if(ready) this.onConfirmed();
        if(this.seen.size>10000) this.seen.clear();
      }
      const block=hexNumber(value.blockNumber),logIndex=hexNumber(value.logIndex);
      if(kind==="logs" && block!==null && Number.isSafeInteger(block) &&
        logIndex!==null && Number.isSafeInteger(logIndex) &&
        typeof value.blockHash==="string" && typeof value.transactionHash==="string") {
        const key=`${value.blockHash}:${value.transactionHash}:${value.logIndex}`.toLowerCase();
        if(value.removed===true) {this.pending.delete(key);this.onConfirmed();return;}
        if(this.seen.has(key)) return;
        this.seen.add(key);
        if(block<=this.confirmedHead) this.onConfirmed(); else this.pending.set(key,block);
      }
    });
    socket.addEventListener("close",()=>{if(this.socket===socket) this.reconnect();});
    socket.addEventListener("error",()=>{if(this.socket===socket) this.reconnect();});
  }
}
