import type {ResearchEpoch} from './epoch';
export function cleanEpochFreezeAllowed(input:{version:string;summaryStatus:string;summaryAgeMs:number;maxSummaryAgeMs:number;
  epoch:ResearchEpoch|null;runId:string|null;summaryRunId:string|null;runStatus:string;epochId:string|null;
  actualDurationMs:number|null;clockValid:boolean}) {
  return input.version==='sprint10-v4' && input.summaryStatus==='READY' && input.summaryAgeMs>=0 && input.summaryAgeMs<=input.maxSummaryAgeMs &&
    input.epoch?.status==='COMPLETE' && input.runId!==null && input.runId===input.summaryRunId && input.epoch.id===input.epochId &&
    input.runStatus==='PASS' && input.actualDurationMs!==null && input.actualDurationMs>=86400000 && input.clockValid;
}
