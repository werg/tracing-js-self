import {hashAlgorithmData} from './program.js';
import {rootedInputGraphIdentity} from './retained-serving-costs.js';

const fail=message=>{throw new TypeError('Serving cost comparison: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};
const measured=row=>row?.cost?.status==='passed'&&Number.isSafeInteger(row.cost.tokens?.total);
const metrics=row=>{
  const cost=row.cost,result={predictions:cost.predictions,generatedBytes:cost.bytes.generated,
    promptBytes:cost.bytes.cumulativeContext,peakPromptBytes:cost.bytes.peakContext,
    generatedTokens:cost.tokens.generated,detailedTokens:cost.detailedTokens??cost.tokens.detailed,
    promptTokens:cost.tokens.observedAndContext,terminalTokens:cost.tokens.terminal,
    flatTotalTokens:cost.tokens.total,peakPromptTokens:cost.tokens.peakContext};
  require(Object.values(result).every(value=>Number.isSafeInteger(value)&&value>=0),'exact integer cost measurements required');
  require(result.generatedTokens+result.promptTokens+result.terminalTokens===result.flatTotalTokens&&
    result.detailedTokens<=result.generatedTokens,'physical token segment totals differ');
  return result;
};
function summarize(rows){
  const paired=rows.filter(row=>row.status==='paired'),keys=['predictions','generatedBytes','promptBytes','peakPromptBytes',
    'generatedTokens','detailedTokens','promptTokens','terminalTokens','flatTotalTokens','peakPromptTokens'];
  const total=side=>Object.fromEntries(keys.map(key=>[key,key.startsWith('peak')?
    Math.max(0,...paired.map(row=>row[side][key])):paired.reduce((n,row)=>n+row[side][key],0)])),
    before=total('before'),after=total('after');
  return {declaredRows:rows.length,paired:paired.length,
    dispositions:Object.fromEntries([...new Set(rows.map(row=>row.status))].map(status=>[status,rows.filter(row=>row.status===status).length])),
    before,after,afterOverBefore:Object.fromEntries(keys.map(key=>[key,before[key]?after[key]/before[key]:null])),
    delta:Object.fromEntries(keys.map(key=>[key,after[key]-before[key]])),
    detailedTokenShare:{before:before.generatedTokens?before.detailedTokens/before.generatedTokens:null,
      after:after.generatedTokens?after.detailedTokens/after.generatedTokens:null},
    flatTokenRegressions:paired.filter(row=>row.after.flatTotalTokens>row.before.flatTotalTokens).map(row=>row.id)};
}

/** Reports must already be hash-checked against their retained artifacts. */
export function compareRetainedServingCosts(before,groups){
  require(before?.schema==='semantic-retained-population-token-costs/1'&&Array.isArray(before.rows)&&
    Array.isArray(groups)&&groups.length>0,'a retained baseline and current population reports are required');
  require(new Set(groups.map(group=>group.id)).size===groups.length,'duplicate current population identity');
  const currents=new Map(),allCurrent=[];
  for(const group of groups){
    const {report,population}=group;
    require(report?.schema==='semantic-v8-population-costs/1'&&Array.isArray(report.rows)&&
      Array.isArray(population?.tasks)&&report.rows.length===population.tasks.length&&
      report.producerRevision===population.producerRevision,'current cost and frozen task inventory differ');
    for(const field of ['fingerprint','tokenizerSha256','codecVersion','vocabSize'])
      require(report.tokenizerEvidence?.identity?.[field]!==undefined&&
        report.tokenizerEvidence.identity[field]===before.tokenizerEvidence?.identity?.[field],'pinned tokenizer identity differs');
    require(report.tokenizerEvidence.qualification?.codecSourceSha256===before.tokenizerEvidence.qualification?.codecSourceSha256,
      'exact tokenizer implementation differs');
    const ids=new Set();
    for(const [index,row]of report.rows.entries()){
      const task=population.tasks[index];require(row.id===task.fixture.id&&!ids.has(row.id),'current case order or identity differs');ids.add(row.id);
      const selected={group:group.id,row,task};allCurrent.push(selected);
      if(!currents.has(row.id))currents.set(row.id,[]);currents.get(row.id).push(selected);
    }
  }
  const seenBaseline=new Set(),usedCurrent=new Set(),rows=[];
  for(const old of before.rows){
    const identity=old.population+':'+old.id;require(!seenBaseline.has(identity),'duplicate historical case identity');seenBaseline.add(identity);
    const matches=currents.get(old.id)??[],row={id:old.id,baselinePopulation:old.population,currentPopulation:null,
      baselineDisposition:old.sourceDisposition,currentDisposition:null,status:'current-case-missing',before:null,after:null};
    if(matches.length>1){row.status='current-case-ambiguous';rows.push(row);continue;}
    if(!matches.length){rows.push(row);continue;}
    const current=matches[0],fixture=current.task.fixture;usedCurrent.add(current);
    row.currentPopulation=current.group;row.currentDisposition=current.row.source;
    if(!measured(old)){row.status='baseline-unmeasured';rows.push(row);continue;}
    const expected=old.sourceIdentity;
    require(expected?.rootedInputGraph?.digest&&expected.sourceDigest===old.sourceDigest,'baseline lacks exact source and rooted-input identity');
    const input=rootedInputGraphIdentity(fixture.argsGraph);
    row.identity={baselineSourceDigest:expected.sourceDigest,currentSourceDigest:hashAlgorithmData(fixture.source??null),
      baselineEntry:expected.entry,currentEntry:fixture.entry,baselineRootedInput:expected.rootedInputGraph,currentRootedInput:input};
    if(typeof fixture.source!=='string'||hashAlgorithmData(fixture.source)!==expected.sourceDigest||fixture.entry!==expected.entry||
      input.digest!==expected.rootedInputGraph.digest){row.status='source-entry-or-input-differs';rows.push(row);continue;}
    if(!measured(current.row)){row.status='current-unmeasured';rows.push(row);continue;}
    row.status='paired';row.before=metrics(old);row.after=metrics(current.row);rows.push(row);
  }
  for(const current of allCurrent)if(!usedCurrent.has(current))rows.push({id:current.row.id,baselinePopulation:null,
    currentPopulation:current.group,baselineDisposition:null,currentDisposition:current.row.source,
    status:'baseline-not-retained',before:null,after:null});
  return {schema:'semantic-paired-serving-costs/1',
    pairing:'Case ID, exact source bytes, entry and validated rooted initial input graph; object IDs are alpha-renamed and unreachable internal allocations are counted separately.',
    limitation:'The historical serializer does not independently retain a canonical full host fixture schedule. Matched rows establish source/entry/initial-input equality, not a new source or model execution qualification.',
    tokenizerEvidence:before.tokenizerEvidence,
    denominators:{baselineRetainedDeclared:before.rows.length,
      baselineSerializerRetained:before.rows.filter(row=>row.servingArtifact).length,
      baselineTokenMeasured:before.rows.filter(measured).length,
      baselineUnavailable:before.unavailableBaselines,
      currentPopulations:groups.map(group=>({id:group.id,declared:group.report.rows.length,
        sourceQualified:group.report.rows.filter(row=>row.source==='passed').length,
        tokenMeasured:group.report.rows.filter(measured).length}))},
    summary:summarize(rows),baselinePopulations:Object.fromEntries([...new Set(before.rows.map(row=>row.population))]
      .map(id=>[id,summarize(rows.filter(row=>row.baselinePopulation===id))])),
    currentPopulations:Object.fromEntries(groups.map(group=>[group.id,summarize(rows.filter(row=>row.currentPopulation===group.id))])),
    model:{status:'unmeasured',nextStep:null,completedExecution:null,latencyMs:null},nativeServing:{status:'unmeasured'},
    defaultPromotion:'not-qualified',rows};
}
