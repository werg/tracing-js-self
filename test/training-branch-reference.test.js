import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,validateTrainingExport} from 'tracing-js-self/training';
import {instrumentBranchSource,compareBranchObservations} from '../src/training/branch-reference.js';

const strict=body=>'"use strict";\n'+body;
function verify(code,args=[]){
  const result=verifyTrainingCase({source:strict(code),entry:'f',args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const audit=result.exported.sidecar.branchAudit;
  assert.equal(audit.schema,'reference-branches/1');
  assert.equal(audit.status,'agreed');
  assert.equal(validateTrainingExport(result.exported).valid,true);
  assert(!Object.hasOwn(result.exported.public,'branchAudit'));
  return audit;
}
test('independent V8 observes if/for/while/do-while/ternary decisions',()=>{
  const audit=verify(`function f(n){
    let sum=0;for(let i=0;i<n;i++){if(i===2)continue;sum+=i;}
    let k=2;do{k--;}while(k>0);
    while(n>4){n--;}
    return sum+(n===3?10:20);
  }`,[4]);
  assert(audit.covered.branches>=12);
});
test('short-circuit tests retain original values and skip unevaluated RHS',()=>{
  for(const args of [[0,null],[1,4],[2,undefined],[3,false]]){
    const audit=verify(`function f(a,b){
      let hits=0;function inc(x){hits++;return x;}
      let x=a&&inc(b);let y=b||inc(a);let z=b??inc(a);
      if((a&&b)||(a??1))hits++;
      return [x,y,z,hits];
    }`,args);
    assert(audit.covered.branches>=5);
  }
});
test('nested logical operators and conditional test keep source identities',()=>{
  assert.equal(verify('function f(a,b,c){return a&&(b||c)?2:7;}',
    [true,false,true]).checked,3);
});
test('missing, reordered, excess or different decisions are rejected',()=>{
  const a=[{site:'1:2',decision:['bool',true]},{site:'5:6',decision:['bool',false]}];
  assert.deepEqual(compareBranchObservations(a,a),{status:'agreed',checked:2});
  for(const b of [[{site:'1:2',decision:['bool',false]},a[1]],
    a.slice(0,1),[a[1],a[0]],[...a,a[0]]])
    assert.equal(compareBranchObservations(a,b).status,'mismatch');
});
test('instrumentation leaves strict directive and literal source intact',()=>{
  const source=strict('function f(x){if(x>0)return x?2:3;return 4;}');
  const result=instrumentBranchSource(source);
  assert(result.startsWith('"use strict";\n'));
  assert.equal((result.match(/__tracingBranch/g)??[]).length,2);
  assert(result.includes('x>0'));
});
