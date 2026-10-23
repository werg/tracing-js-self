import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyAjvContract,AJV_VERSION,AJV_TARBALL_INTEGRITY}
 from '../src/corpus/ajv-reference.mjs';
const row=(schema,data,expected=true)=>({
 schema:'external-corpus-fixture/1',admitted:false,verified:false,
 program:{kind:'json-schema-contract',draft:'draft7'},
 provenance:{repository:'json-schema-org/JSON-Schema-Test-Suite'},
 fixture:{kind:'schema-validation',schema,data},expected:{kind:'validity',valid:expected}
});
const factories={draft7:()=>({compile:schema=>(data=>{
 const result=typeof data===schema.type;
 const check=()=>result;
 check.source={validateCode:'function validate(data){return true}'};
 return check;
 })()})};
test('mocked bounded validator reference distinguishes agreement, disagreement, and unsupported',()=>{
 const construct={draft7:()=>({compile:()=>Object.assign(
  value=>typeof value==='string',{source:{validateCode:'function v(){return true}'}})})};
 const agreed=verifyAjvContract(row({type:'string'},'hi'),construct);
 assert.equal(agreed.status,'reference-agreed');
 assert.equal(agreed.verifiedOwned,false);
 assert.equal(agreed.admitted,false);
 assert.match(agreed.generatedCodeSha256,/^[a-f0-9]{64}$/);
 const wrong=verifyAjvContract(row({type:'string'},42),construct);
 assert.equal(wrong.status,'disagreed');
 assert.equal(verifyAjvContract({...row({},42),admitted:true},construct).status,'unsupported');
 assert.equal(verifyAjvContract({...row({},42),
  program:{kind:'json-schema-contract',draft:'draft999'}},construct).status,'unsupported');
 const threw=verifyAjvContract(row({},42),{draft7:()=>({compile:()=>{
  throw Error('unknown dynamic reference');
 }})});
 assert.equal(threw.status,'unsupported');
 const async=verifyAjvContract(row({},42),{draft7:()=>({compile:()=>async()=>true})});
 assert.equal(async.status,'unsupported');
 assert.equal(AJV_VERSION,'8.17.1');
 assert.match(AJV_TARBALL_INTEGRITY,/^sha512-/);
});
