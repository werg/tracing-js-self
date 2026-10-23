import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shrinkReferenceMismatch} from '../src/corpus/reference-shrinker.mjs';

test('deterministic mismatch shrinking preserves an independent predicate',()=>{
 let checks=0;
 const oracle=([n])=>{checks++;return n>0;};
 const a=shrinkReferenceMismatch([100],oracle);
 const b=shrinkReferenceMismatch([100],([n])=>n>0);
 assert.deepEqual(a,b);
 assert.equal(a.status,'minimized');
 assert.deepEqual(a.minimizedArgs,[1]);
 assert(a.acceptedReductions>0);
 assert(a.evaluations<=32);
 assert.equal(checks,a.evaluations);
 assert.equal(a.verifiedOwned,false);
 assert.equal(a.admitted,false);
 assert.equal(a.authority,'native-reference-predicate-only');
});
test('array and string reductions keep the demonstrated mismatch',()=>{
 const arr=shrinkReferenceMismatch([[3,7,9,11]],([items])=>
  items.includes(7));
 assert.equal(arr.status,'minimized');
 assert.deepEqual(arr.minimizedArgs,[[7]]);
 const text=shrinkReferenceMismatch(['hello!'],([s])=>s.includes('!'));
 assert.equal(text.status,'minimized');
 assert.deepEqual(text.minimizedArgs,['!']);
});
test('nonreproducible, throwing and bounded oracles fail closed',()=>{
 const missing=shrinkReferenceMismatch([9],()=>false);
 assert.equal(missing.status,'not-reproduced');
 assert.equal(missing.acceptedReductions,0);
 const error=shrinkReferenceMismatch([9],()=>{throw Error('oracle failed');});
 assert.equal(error.status,'not-reproduced');
 assert.equal(error.oracleErrors,1);
 const capped=shrinkReferenceMismatch([[1,2,3,4,5]],()=>true,
  {maxEvaluations:2});
 assert(capped.evaluations<=2);
 assert.throws(()=>shrinkReferenceMismatch({},()=>true),/Invalid/);
 assert.throws(()=>shrinkReferenceMismatch([1],()=>true,
  {maxEvaluations:257}),/Invalid/);
});
