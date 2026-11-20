import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {hashAlgorithmData} from './program.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw new TypeError('V8 qualification costs: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};

// The frontend profile and the qualified public execution profile describe
// different boundaries. In particular, training-js/1 alone does not identify
// which bounded protocol adapters supplied an admitted script's public state.
export function qualificationProfiles(result){
  const side=result.exported?.sidecar;
  return {sourceProfile:result.sourceProfile??'training-js/1',
    executionProfile:side?.protocolProfile??side?.profile??null,
    protocolExtensions:structuredClone(side?.protocolExtensions??[])};
}

// Cost measurement reuses exact qualified artifacts, never reruns a teacher or
// drops a failed source case to make the measured denominator look better.
export function readQualificationCostInputs(directory){
  directory=resolve(directory);
  const reportBytes=readFileSync(join(directory,'report.json')),report=JSON.parse(reportBytes);
  require(report.schema==='semantic-v8-qualification/1'&&Array.isArray(report.rows)&&
    report.artifactDigestEncoding==='sha256 of exact UTF-8 file bytes',
  'a completed qualification report with exact-byte artifact digests is required');
  const readArtifact=name=>{
    require(typeof name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name),'unsafe artifact path');
    require(/^[a-f0-9]{64}$/.test(report.artifacts?.[name]??''),'missing artifact digest: '+name);
    const bytes=readFileSync(join(directory,name));
    require(sha(bytes)===report.artifacts[name],'artifact bytes changed: '+name);
    return JSON.parse(bytes);
  };
  const {digest,...population}=readArtifact('population.json');
  require(digest===report.populationDigest&&hashAlgorithmData(population)===digest,
    'population digest changed');
  require(population.producerRevision===report.producerRevision&&population.population===report.population&&
    population.inputs===report.inputs&&population.declared===report.declared&&
    Array.isArray(population.tasks)&&population.tasks.length===report.declared&&
    report.rows.length===report.declared,'population identity or denominator changed');
  const ids=population.tasks.map(task=>task.fixture.id);
  require(new Set(ids).size===ids.length&&report.rows.every((row,index)=>row.id===ids[index]),
    'qualification rows differ from declared source order');
  if(population.selectedCaseIds!==undefined||report.selectedCaseIds!==undefined){
    const selected=population.selectedCaseIds;
    require(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&
      JSON.stringify(selected)===JSON.stringify(ids.filter(id=>selected.includes(id)))&&
      JSON.stringify(selected)===JSON.stringify(report.selectedCaseIds),'diagnostic selection differs from frozen population');
    const selectedIds=new Set(selected);
    require(report.rows.every(row=>selectedIds.has(row.id)||row.source==='untested'&&row.native==='untested'),
      'unselected qualification case claims an execution');
  }
  require(report.sourceQualified===report.rows.filter(row=>row.source==='passed').length&&
    report.nativeAdmitted===report.rows.filter(row=>row.native==='passed').length,'qualification totals changed');
  return {directory,report,population,reportSha256:sha(reportBytes),readArtifact};
}

const sum=(rows,key)=>rows.reduce((n,row)=>n+row[key],0);
const countBy=(rows,key)=>Object.fromEntries([...new Set(rows.map(row=>row[key]))]
  .map(value=>[value,rows.filter(row=>row[key]===value).length]));
export function summarizeQualificationCosts(rows,{tokenizer=false}={}){
  const source=rows.filter(row=>row.source==='passed'),measured=rows.filter(row=>row.cost?.status==='passed'),
    flat=measured.map(row=>row.cost),coverage=source.map(row=>row.regionCoverage).filter(Boolean),
    native=rows.filter(row=>row.nativePacking?.status==='passed').map(row=>row.nativePacking);
  const generatedBytes=flat.reduce((n,row)=>n+row.bytes.generated,0),
    detailedBytes=flat.reduce((n,row)=>n+row.bytes.detailed,0),
    tokenRows=flat.filter(row=>row.tokens?.total!==null&&row.tokens?.total!==undefined),
    generatedTokens=tokenRows.reduce((n,row)=>n+row.tokens.generated,0),
    detailedTokens=tokenRows.reduce((n,row)=>n+row.detailedTokens,0);
  return {
    declared:rows.length,sourceQualified:source.length,sourceDispositions:countBy(rows,'source'),
    compactEpisodes:coverage.filter(row=>row.compactRegions>0).length,
    whollyDetailedEpisodes:coverage.filter(row=>row.compactRegions===0).length,
    regionCoverage:{measuredEpisodes:coverage.length,unmeasuredEpisodes:rows.length-coverage.length,
      compact:sum(coverage,'compactRegions'),detailed:sum(coverage,'detailedRegions'),
      compactRecords:sum(coverage,'compactRecords'),detailedRecords:sum(coverage,'detailedRecords')},
    flat:{sourceQualified:source.length,measured:flat.length,unmeasured:rows.length-flat.length,
      dispositions:countBy(source.map(row=>({status:row.cost?.status??'untested'})),'status'),
      bytes:{generated:generatedBytes,detailed:detailedBytes,
        detailedShare:generatedBytes?detailedBytes/generatedBytes:null,
        cumulativeContext:flat.reduce((n,row)=>n+row.bytes.cumulativeContext,0),
        peakContext:Math.max(0,...flat.map(row=>row.bytes.peakContext))},
      tokenMeasurement:!tokenizer||!source.length?'untested':tokenRows.length===source.length?'passed':'partial',
      tokenMeasuredEpisodes:tokenRows.length,
      tokens:!tokenizer?null:{generated:generatedTokens,detailed:detailedTokens,
        detailedShare:generatedTokens?detailedTokens/generatedTokens:null,
        terminal:tokenRows.reduce((n,row)=>n+row.tokens.terminal,0),
        observedAndContext:tokenRows.reduce((n,row)=>n+row.tokens.observedAndContext,0),
        total:tokenRows.reduce((n,row)=>n+row.tokens.total,0),
        peakContext:Math.max(0,...tokenRows.map(row=>row.tokens.peakContext))},
      scope:'Sums cover measured episodes only; source refusals and measurement limits remain in the declared denominator.'},
    nativePacking:{status:native.length?'measured':'untested',measuredEpisodes:native.length,unmeasuredEpisodes:rows.length-native.length,
      generatedTokens:sum(native,'generatedTokens'),observedTokens:sum(native,'observedTokens'),
      terminalTokens:sum(native,'terminalTokens'),physicalRecords:sum(native,'physicalRecords'),
      logicalRecords:sum(native,'logicalRecords'),
      scope:'Actual retained native training packing receipts. Physical records include inserted contexts and framing; these counts do not measure serving latency or model success.'},
    model:{status:'unmeasured',nextStep:null,completedExecution:null,latencyMs:null},
    nativeServing:{status:'unmeasured',latencyMs:null,cacheSavings:null},defaultPromotion:'not-qualified'
  };
}
