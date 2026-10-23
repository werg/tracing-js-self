// Real Ajv compiled-schema diagnostics over pinned JSON Schema contracts.
// Executes native production validator code, NOT the owned interpreter.
// Generated validateCode hashes are evidence of which actual code ran, not
// independently certified intermediate semantic operations.
import {createHash} from 'node:crypto';
export const AJV_VERSION='8.17.1';
export const AJV_TARBALL_INTEGRITY='sha512-B/gBuNg5SiMTrPkC+A2+cW0RszwxYmn6VYxB/inlBStS5nx6xHIt/ehKRhIMhqusl7a8LjQoZnjCs5vhwxOQ1g==';
const hash=s=>createHash('sha256').update(s).digest('hex');
const supported=new Set(['draft7','draft2019-09','draft2020-12']);
const refusal=(status,reason,details={})=>({schema:'ajv-native-validator-reference/1',
 authority:'native-v8-diagnostic-only',verifiedOwned:false,admitted:false,
 status,reason,...details});
export function verifyAjvContract(record,constructors){
 if(record?.schema!=='external-corpus-fixture/1'||record.admitted!==false||
  record.verified!==false||record.program?.kind!=='json-schema-contract'||
  record.provenance?.repository!=='json-schema-org/JSON-Schema-Test-Suite'||
  record.fixture?.kind!=='schema-validation'||
  record.expected?.kind!=='validity'||
  typeof record.expected.valid!=='boolean')
  return refusal('unsupported','Untrusted or malformed acquired JSON Schema fixture');
 const draft=record.program.draft;
 if(!supported.has(draft)||typeof constructors?.[draft]!=='function')
  return refusal('unsupported','No exact Ajv dialect constructor: '+String(draft));
 const schema=record.fixture.schema;
 if(typeof schema!=='boolean'&&(!schema||typeof schema!=='object'||Array.isArray(schema)))
  return refusal('unsupported','Invalid JSON Schema contract value');
 try{
  const ajv=constructors[draft]();
  const validate=ajv.compile(schema);
  if(typeof validate!=='function')
   return refusal('unsupported','Ajv compiler did not create a validator function');
  const result=validate(structuredClone(record.fixture.data));
  if(typeof result!=='boolean')
   return refusal('unsupported','Ajv returned non-boolean or asynchronous result');
  const code=typeof validate.source?.validateCode==='string'?
   validate.source.validateCode:null;
  const receipts={draft,generatedCodeSha256:code?hash(code):null,
   generatedCodeBytes:code?Buffer.byteLength(code):null,
   generatedFunction:validate.name||null,
   upstreamExpected:record.expected.valid,observedResult:result};
  return result===record.expected.valid?
   refusal('reference-agreed','Pinned contract agrees with production Ajv',receipts):
   refusal('disagreed','Production Ajv result differs from pinned expected label',receipts);
 }catch(error){
  return refusal('unsupported','Ajv schema compilation/execution unsupported: '+
   String(error?.message??error).slice(0,160),{draft});
 }
}
