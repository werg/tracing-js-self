// Refusals/debugging evidence are never positive training targets. Preserve the
// original source, inputs and independent observations before any reduction.
import {createHash} from 'node:crypto';
import {encodeNativeGraph} from '../host/graph-codec.js';
import {identityDigest,admissionEnvironment,normalizeSeeds} from './admission-identity.js';

export class AdmissionFailure extends Error{
  constructor(category,message,details=null){
    super(message);this.name='AdmissionFailure';this.admissionCategory=category;this.details=details;
  }
}
export function classifyAdmissionFailure(error,phase){
  if(error.admissionCategory)return {status:error.admissionCategory,category:error.admissionCategory};
  const message=String(error.message??error);
  if(/Candidate identity evidence changed|immutable candidate identity|Native receipt does not bind/.test(message))
    return {status:'identity_rejected',category:'identity_rejected'};
  if(phase==='native-consumer')return {status:'native_rejected',category:'native_rejected'};
  if(phase==='projection')return {status:'projection_refused',category:'projection_refused'};
  if(phase==='reference')return {status:'reference_process_failure',category:'reference_process_failure'};
  if(/deadline|timed out|timeout/i.test(message))return {status:'profile_limit',category:'teacher_timeout'};
  if(/^Driver safety limit \(\d+ steps\)/.test(message)||
    error instanceof RangeError&&/cap|maximum|limit|budget|steps|bound|exceed/i.test(message))
    return {status:'profile_limit',category:'teacher_resource_limit'};
  if(error instanceof SyntaxError||/unsupported|not supported|outside.*profile/i.test(message)||
    String(error.category??'').startsWith('unsupported'))return {status:'unsupported',category:'unsupported_source'};
  return {status:'teacher_failed',category:'teacher_execution_failed'};
}
const exactHash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function createFailureRecord({candidate,error,phase,archive=null,observations={}}){
  const classification=classifyAdmissionFailure(error,phase);
  let inputGraph=null,inputEncodingError=null;
  try{inputGraph=encodeNativeGraph(candidate.args??[]);}catch(problem){inputEncodingError=String(problem.message??problem);}
  const original={schema:'semantic-candidate-failure-payload/1',...classification,phase,
    reason:String(error.message??error),error:{name:error.name??'Error',code:error.code??null,
      category:error.category??error.admissionCategory??null,details:error.details??null,
      stack:typeof error.stack==='string'?error.stack.slice(0,16384):null},
    source:candidate.source,sourceDigest:exactHash(candidate.source),entry:candidate.entry,
    inputGraph,inputDigest:inputGraph===null?null:identityDigest(inputGraph),inputEncodingError,
    fixture:candidate.fixture,fixtureDigest:identityDigest(candidate.fixture),
    family:candidate.family,ancestorIds:candidate.ancestorIds??[],taskId:candidate.taskId??candidate.family,
    license:candidate.license,trustTier:candidate.trustTier,provenance:candidate.provenance??{},
    profile:'training-js/1',limits:{maxSteps:candidate.maxSteps,timeoutMs:candidate.timeoutMs,
      maxGenerated:candidate.projectionOptions?.maxGenerated??16384,
      maxOperators:candidate.projectionOptions?.maxOperators??8},
    projectionOptions:candidate.projectionOptions??{},splitIdentity:candidate.splitIdentity,
    seeds:normalizeSeeds(candidate.seeds??{},candidate.seed??17,archive?.initialState.control.a0.randomSeed??candidate.randomSeed??null),
    environment:admissionEnvironment(),producerRevision:candidate.producerRevision??null,
    nativePolicy:candidate.nativePolicy??null,archiveDigest:archive===null?null:exactHash(archive),
    observations:structuredClone(observations)};
  const failureDigest=identityDigest(original);
  return {schema:'semantic-candidate-failure/1',failureDigest,original,
    minimization:{status:'not_attempted',originalFailureDigest:failureDigest,counterexample:null}};
}
export function verifyFailureRecord(record){
  if(record?.schema!=='semantic-candidate-failure/1'||record.original?.schema!=='semantic-candidate-failure-payload/1'||
    record.failureDigest!==identityDigest(record.original)||
    record.minimization?.originalFailureDigest!==record.failureDigest||
    record.original.sourceDigest!==exactHash(record.original.source)||
    record.original.fixtureDigest!==identityDigest(record.original.fixture)||
    record.original.inputGraph!==null&&record.original.inputDigest!==identityDigest(record.original.inputGraph))
    throw new Error('Original candidate failure evidence changed');
  if(record.minimizationDigest!==undefined&&record.minimizationDigest!==identityDigest(record.minimization))
    throw new Error('Failure minimization receipt changed');
  const counterexample=record.minimization.counterexample;
  if(counterexample!==null){
    if(counterexample.sourceDigest!==exactHash(counterexample.source)||
      counterexample.failure?.original.source!==counterexample.source)
      throw new Error('Minimized counterexample bytes changed');
    verifyFailureRecord(counterexample.failure);
  }
  return true;
}
