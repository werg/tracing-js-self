import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWitness,decodeWitness} from '../src/training/format.js';

test('canonical witness seed is exact, bounded, and cannot alias another seed',()=>{
  const fields={entry:'run',source:'function run(){return Math.random();}',sites:[]};
  const zero=encodeWitness('code',{...fields,randomSeed:0});
  const one=encodeWitness('code',{...fields,randomSeed:1});
  assert.notEqual(zero,one);
  assert.equal(decodeWitness(zero).fields.randomSeed,0);
  assert.equal(decodeWitness(one).fields.randomSeed,1);
  assert.throws(()=>encodeWitness('code',{...fields,randomSeed:4294967296}),/seed/);
});
