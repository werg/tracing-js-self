// Numeric inspection proxies for locally rechecked owned execution traces.
// Compression and receipt ratios are not human-rated readability or proof
// that an independently verified operation oracle covers every effect.
const round=n=>Math.round(n*1000)/1000;
const percentile=(values,p)=>{
 if(!values.length)return null;
 const xs=[...values].sort((a,b)=>a-b);
 return xs[Math.floor((xs.length-1)*p)];
};
export function measureOwnedTrace(row,semanticEvents){
 const archive=row?.exported?.sidecar?.archive;
 const timeline=row?.exported?.public?.timeline;
 if(!Array.isArray(semanticEvents)||!semanticEvents.length||
   !Array.isArray(archive?.events)||!Array.isArray(timeline))
  throw new TypeError('Missing independently verified trace');
 const generated=timeline.filter(item=>item.kind==='semantic'&&item.mode==='generated');
 const records=generated.map(item=>item.line);
 if(!records.length)throw new Error('Empty model-visible generated trace');
 const sizes=records.map(x=>Buffer.byteLength(x,'utf8'));
 const bytes=sizes.reduce((sum,n)=>sum+n,0);
 const sourceAudit=row.sourceSites;
 let coverage=null;
 if(sourceAudit!==undefined){
  if(sourceAudit?.schema!=='owned-source-site-audit/1'||sourceAudit.valid!==true||
    !Number.isSafeInteger(sourceAudit.totals?.mapped)||
    !Number.isSafeInteger(sourceAudit.totals?.total)||
    sourceAudit.totals.total<0||sourceAudit.totals.mapped<0||
    sourceAudit.totals.mapped>sourceAudit.totals.total)
   throw new Error('Invalid original-source receipt metadata');
  coverage=sourceAudit.totals.total===0?null:
   round(sourceAudit.totals.mapped/sourceAudit.totals.total);
 }
 return {rawEvents:archive.events.length,semanticEvents:semanticEvents.length,
  generatedRecords:records.length,
  generatedBytes:bytes,bytesPerRecord:round(bytes/records.length),
  eventsPerGeneratedRecord:round(archive.events.length/generated.length),
  over256ByteRecordFraction:round(sizes.filter(n=>n>256).length/sizes.length),
  reportedOriginalSourceCoverage:coverage,
  sourceAuditAvailable:sourceAudit!==undefined};
}
export function summarizeOwnedTraceQuality(profiles){
 if(!Array.isArray(profiles))throw new TypeError('Invalid quality inventory');
 const items=profiles.map(x=>x.quality);
 if(items.some(x=>!x||!Number.isSafeInteger(x.rawEvents)||
   !Number.isFinite(x.eventsPerGeneratedRecord)||x.generatedRecords<1))
  throw new TypeError('Invalid owned trace quality');
 const quantiles={};
 for(const metric of ['rawEvents','semanticEvents','generatedRecords',
  'generatedRecords','generatedBytes','eventsPerGeneratedRecord',
  'over256ByteRecordFraction']){
  const xs=items.map(x=>x[metric]);
  quantiles[metric]={min:percentile(xs,0),p50:percentile(xs,0.5),
   p90:percentile(xs,0.9),max:percentile(xs,1)};
 }
 const reported=profiles.filter(x=>x.quality.sourceAuditAvailable);
 const inspectionQueue=[...profiles].sort((a,b)=>
  b.quality.eventsPerGeneratedRecord-a.quality.eventsPerGeneratedRecord||
  b.quality.generatedBytes-a.quality.generatedBytes||
  a.id.localeCompare(b.id)).slice(0,24).map(x=>({
   id:x.id,family:x.family,
   eventsPerGeneratedRecord:x.quality.eventsPerGeneratedRecord,
   generatedBytes:x.quality.generatedBytes,
   reportedOriginalSourceCoverage:x.quality.reportedOriginalSourceCoverage}));
 return {schema:'owned-trace-quality-proxies/1',
  authority:'locally-rechecked-owned-non-admitted',admitted:0,episodes:profiles.length,
  reportedSourceAuditEpisodes:reported.length,
  reportedOriginalSourceCoverage:reported.length?round(
   reported.reduce((sum,x)=>sum+(x.quality.reportedOriginalSourceCoverage??0),0)/
    reported.length):null,
  quantiles,inspectionQueue,warnings:[
   'Compression statistics prioritize human review; they do not certify readability or losslessness.',
   'Original source coverage uses supplied original-site receipts; remapping requires pinned original files.',
   'Native reference output comparisons cannot certify complete intermediate-operation semantics.',
   'All inspected episodes remain explicitly non-admitted.']};
}
