import assert from 'node:assert/strict';
import test from 'node:test';
import {assertIndependentPositionCoverage} from '../tools/semantic-v8-position-coverage.mjs';

function fixture(){
  const targets={sourceCount:1,logicalTargetCount:2,physicalTargetRecordCount:3,
    lossDenominators:{lexical:5,reconstruction:5,structure:12,terminal:6}};
  const counts={...targets.lossDenominators,modality:3};
  const objective={effectiveLossWeights:{lexical:1,reconstruction:0.1,structure:0.1,
    terminal:0.1,modality:0.25,router_z:0.001}};
  const inventory={registryDigest:'a'.repeat(64),preparedManifestFingerprint:'b'.repeat(64),
    sourceIds:['source'],positiveWeight:targets};
  const expected={schema:'semantic-v8-independent-prepared-positions/1',
    registryDigest:inventory.registryDigest,preparedManifestFingerprint:inventory.preparedManifestFingerprint,
    sourceIds:['source'],sourceCount:1,logicalTargetCount:2,physicalTargetRecordCount:3,
    verifiedPhysicalTargets:3,unmeasuredPhysicalTargets:0,positiveWeightPositionCounts:counts,objective};
  const actual={...expected,digest:'c'.repeat(64),scoredOccurrences:3,
    routerInternalPositionCoverage:'unmeasured',learnedSuccess:null,
    routerInternalPositionCounts:{p:4,adapter_c:2},routerInternalPositionCount:6,
    routerInternalAssignmentCounts:{p:4,adapter_c:4},routerInternalAssignmentCount:8,
    routerInternalPositionAuditUpdates:3,routerInternalPositionAccounting:'complete-per-update'};
  const comparison={exactOnePassPreparedTextPositions:true,positiveWeightPositionCountsMatch:true,
    independentPreparedPhysicalTargets:3,observedPhysicalTargets:3,missingPhysicalTargets:[],
    unexpectedPhysicalTargets:[],preparedOracleMismatches:[],independentOccurrenceMismatches:[],
    targetCensusWindowOrOccurrenceMismatches:[],targetCensusWithoutPositionReceipt:[],
    unmeasuredPhysicalTargets:[],routerInternalPositionCoverage:'unmeasured',learnedSuccess:null,
    routerInternalPositionCounts:actual.routerInternalPositionCounts,routerInternalPositionCount:6,
    routerInternalAssignmentCounts:actual.routerInternalAssignmentCounts,routerInternalAssignmentCount:8,
    routerInternalPositionAuditUpdates:3,routerInternalPositionAccounting:'complete-per-update'};
  const evidence={globalStep:3,tokenOrMaskPositionCoverage:'complete-for-prepared-text',
    routerInternalPositionCoverage:'unmeasured',learnedSuccess:null,
    independentPreparedPositionInventory:expected,optimizerPositionSummary:actual,
    positionComparison:comparison,optimizerPositionExposure:{digest:actual.digest,objective,
      routerInternalPositionAuditUpdates:3}};
  return structuredClone({inventory,evidence});
}

test('full gate requires explicit independent positions and preserves logical/physical counts',()=>{
  const {inventory,evidence}=fixture();
  assert.doesNotThrow(()=>assertIndependentPositionCoverage(evidence,inventory));
});

const mutations={
  'historical unmeasured report':e=>{e.tokenOrMaskPositionCoverage='unmeasured';},
  'missing position inventory':e=>{delete e.independentPreparedPositionInventory;},
  'same-count shifted mask':e=>{e.positionComparison.preparedOracleMismatches=[['source','logical','physical']];},
  'duplicated occurrence':e=>{e.positionComparison.independentOccurrenceMismatches=[['physical',1,2]];},
  'omitted target':e=>{e.positionComparison.missingPhysicalTargets=[['source','logical','physical']];},
  'invented target':e=>{e.positionComparison.unexpectedPhysicalTargets=[['source','logical','invented']];},
  'missing decoder count':e=>{delete e.optimizerPositionSummary.positiveWeightPositionCounts.lexical;},
  'boolean count':e=>{e.optimizerPositionSummary.positiveWeightPositionCounts.lexical=true;},
  'unsupported structured masks':e=>{e.optimizerPositionSummary.unmeasuredPhysicalTargets=1;},
  'logical/physical conflation':e=>{e.independentPreparedPositionInventory.physicalTargetRecordCount=2;},
  'hidden routing credit':e=>{e.routerInternalPositionCoverage='complete';},
  'missing per-update router receipt':e=>{e.optimizerPositionSummary.routerInternalPositionAuditUpdates=2;},
  'router assignment total mismatch':e=>{e.optimizerPositionSummary.routerInternalAssignmentCount=7;},
  'router scope promotion':e=>{e.positionComparison.routerInternalPositionCoverage='complete';},
  'changed source membership':e=>{e.independentPreparedPositionInventory.sourceIds=['other'];},
  'changed objective':e=>{e.optimizerPositionExposure.objective={different:true};},
  'learned quality promotion':e=>{e.learnedSuccess=true;},
};
for(const [name,change] of Object.entries(mutations))test(`full gate rejects ${name}`,()=>{
  const {inventory,evidence}=fixture();change(evidence);
  assert.throws(()=>assertIndependentPositionCoverage(evidence,inventory),/Independent V8 target-position coverage failed/);
});
