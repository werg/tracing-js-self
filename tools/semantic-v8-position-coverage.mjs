import { isDeepStrictEqual } from 'node:util';

/** Require the native fresh-corpus versus actual-loss comparison, with its scope intact. */
export function assertIndependentPositionCoverage(evidence, targetInventory) {
  const expected=evidence?.independentPreparedPositionInventory;
  const actual=evidence?.optimizerPositionSummary;
  const comparison=evidence?.positionComparison;
  const state=evidence?.optimizerPositionExposure;
  const targets=targetInventory?.positiveWeight;
  const globalStep=evidence?.globalStep;
  const failures=[];
  const require=(condition,message)=>{if(!condition)failures.push(message);};
  require(evidence?.tokenOrMaskPositionCoverage==='complete-for-prepared-text','text position status');
  require(evidence?.routerInternalPositionCoverage==='unmeasured','hidden routing scope');
  require(evidence?.learnedSuccess===null,'no learned-quality claim');
  require(expected?.schema==='semantic-v8-independent-prepared-positions/1','independent prepared inventory');
  require(expected?.registryDigest===targetInventory?.registryDigest,'prepared registry binding');
  require(expected?.preparedManifestFingerprint===targetInventory?.preparedManifestFingerprint,'prepared manifest binding');
  require(isDeepStrictEqual(expected?.sourceIds,targetInventory?.sourceIds),'independent source population');
  for(const field of ['sourceCount','logicalTargetCount','physicalTargetRecordCount']){
    require(Number.isSafeInteger(targets?.[field])&&targets[field]>0,`positive target ${field}`);
    require(expected?.[field]===targets?.[field]&&actual?.[field]===targets?.[field],`independent/actual ${field}`);
  }
  require(expected?.unmeasuredPhysicalTargets===0&&actual?.unmeasuredPhysicalTargets===0,'unsupported physical targets');
  require(expected?.verifiedPhysicalTargets===targets?.physicalTargetRecordCount&&
    actual?.verifiedPhysicalTargets===targets?.physicalTargetRecordCount,'verified physical population');
  require(isDeepStrictEqual(actual?.positiveWeightPositionCounts,expected?.positiveWeightPositionCounts),
    'actual versus independent position counts');
  for(const name of ['lexical','reconstruction','structure','terminal','modality']){
    const count=expected?.positiveWeightPositionCounts?.[name];
    require(Number.isSafeInteger(count)&&count>=0,`explicit ${name} position count`);
    if(name!=='modality')require(count===(targets?.lossDenominators?.[name]??0),`${name} denominator agreement`);
  }
  require(actual?.scoredOccurrences===targets?.physicalTargetRecordCount,'one occurrence per physical target');
  require(actual?.routerInternalPositionCoverage==='unmeasured'&&comparison?.routerInternalPositionCoverage==='unmeasured',
    'unmeasured router rows cannot receive token-position credit');
  require(state?.digest===actual?.digest&&isDeepStrictEqual(state?.objective,expected?.objective),
    'checkpoint position and objective binding');
  require(actual?.learnedSuccess===null&&comparison?.learnedSuccess===null,'position receipts do not claim learned quality');
  require(comparison?.exactOnePassPreparedTextPositions===true&&comparison?.positiveWeightPositionCountsMatch===true,
    'independent exact position comparison');
  const positions=actual?.routerInternalPositionCounts;
  const assignments=actual?.routerInternalAssignmentCounts;
  const validRouterCounts=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.values(value).every(count=>Number.isSafeInteger(count)&&count>=0);
  const sumRouterCounts=value=>validRouterCounts(value)?Object.values(value).reduce((sum,count)=>sum+count,0):null;
  require(actual?.routerInternalPositionAccounting==='complete-per-update','actual router accounting status');
  require(Number.isSafeInteger(globalStep)&&globalStep>0&&
    actual?.routerInternalPositionAuditUpdates===globalStep&&
    state?.routerInternalPositionAuditUpdates===globalStep,'per-update router receipt history');
  require(validRouterCounts(positions)&&validRouterCounts(assignments)&&
    isDeepStrictEqual(Object.keys(positions??{}).sort(),Object.keys(assignments??{}).sort()),
    'router position and assignment count maps');
  require(Number.isSafeInteger(actual?.routerInternalPositionCount)&&actual.routerInternalPositionCount>0&&
    actual.routerInternalPositionCount===sumRouterCounts(positions)&&
    actual.routerInternalAssignmentCount===sumRouterCounts(assignments)&&
    actual.routerInternalAssignmentCount>=actual.routerInternalPositionCount,
    'router internal count totals');
  if(validRouterCounts(positions)&&validRouterCounts(assignments)){
    for(const name of Object.keys(positions))
      require(assignments[name]>=positions[name],`router assignment count for ${name}`);
  }
  require(isDeepStrictEqual(comparison?.routerInternalPositionCounts,positions)&&
    isDeepStrictEqual(comparison?.routerInternalAssignmentCounts,assignments)&&
    comparison?.routerInternalPositionCount===actual?.routerInternalPositionCount&&
    comparison?.routerInternalAssignmentCount===actual?.routerInternalAssignmentCount&&
    comparison?.routerInternalPositionAuditUpdates===globalStep&&
    comparison?.routerInternalPositionAccounting==='complete-per-update',
    'router counts agree across the optimizer history comparison');
  require(comparison?.independentPreparedPhysicalTargets===targets?.physicalTargetRecordCount&&
    comparison?.observedPhysicalTargets===targets?.physicalTargetRecordCount,'physical comparison denominator');
  for(const field of ['missingPhysicalTargets','unexpectedPhysicalTargets','preparedOracleMismatches',
    'independentOccurrenceMismatches','targetCensusWindowOrOccurrenceMismatches',
    'targetCensusWithoutPositionReceipt','unmeasuredPhysicalTargets'])
    require(Array.isArray(comparison?.[field])&&comparison[field].length===0,field);
  if(failures.length)throw new Error('Independent V8 target-position coverage failed: '+failures.join(', '));
}
