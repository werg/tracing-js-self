import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scalarTest262Reference} from '../src/corpus/test262-scalar-reference.mjs';
import {executeRuntimeTest262} from '../src/test262-runtime.js';
import {wrapOwnedScalarTest262,runWrappedScalarReference,mapTest262ScalarSites}
  from '../src/corpus/test262-training.mjs';
const header='/*---\nflags: [noStrict]\n---*/\n';
test('same scalar semantics require both V8 reference and owned replay',()=>{
 const source=header+'assert.sameValue(1+2,3); assert.notSameValue(0,-0);';
 const reference=scalarTest262Reference(source);
 assert.equal(reference.status,'passed',reference.reason??'');
 assert.equal(reference.assertionCount,2);
 const owned=executeRuntimeTest262(source,{expectedAssertions:2,maxSteps:12000});
 assert.equal(owned.status,'passed',owned.reason??'');
 assert.equal(owned.trace.replayed,true);
 assert.equal(owned.assertionCount,reference.assertionCount);
});
test('false positive assertions and unsupported metadata never become owned agreement',()=>{
 assert.notEqual(scalarTest262Reference(header+'assert.sameValue(1,2);').status,'passed');
 assert.equal(scalarTest262Reference('/*---\nflags: [async]\n---*/\nassert.sameValue(1,1)').status,'unsupported');
 assert.equal(scalarTest262Reference(header+'var nothing=1;').status,'unsupported');
});

test('bounded pure Test262 source is retained verbatim with original-body site receipts',()=>{
 const original=header+'assert.sameValue(1+2,3);';
 const wrapped=wrapOwnedScalarTest262(original);
 assert.equal(wrapped.source.slice(wrapped.mapping.generatedStart,
   wrapped.mapping.generatedEnd),original);
 const reference=runWrappedScalarReference(wrapped);
 assert.equal(reference.status,'passed',reference.reason??'');
 assert.equal(reference.assertionCount,1);
 const generated=wrapped.mapping.generatedStart;
 const siteAudit=mapTest262ScalarSites(wrapped,original,{events:[
   {id:'e1',source:{start:generated,end:generated+12}},
   {id:'e2',source:{start:0,end:5}}
 ]});
 assert.equal(siteAudit.stats.mapped,1);
 assert.equal(siteAudit.stats.synthetic,1);
 assert.equal(siteAudit.valid,true);
 assert.throws(()=>mapTest262ScalarSites(wrapped,original+' ',{events:[]}),/Changed/);
});
