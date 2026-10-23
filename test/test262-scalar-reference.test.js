import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scalarTest262Reference} from '../src/corpus/test262-scalar-reference.mjs';
import {executeRuntimeTest262} from '../src/test262-runtime.js';
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
