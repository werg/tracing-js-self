#!/usr/bin/env node
// Exhaustive cross-product of a declared finite primitive corpus, compared to
// the independent pinned spec oracle. Not exhaustive language conformance.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRuntime } from '../src/runtime.js';
import { createSpecOracle } from '../src/spec-oracle.js';
import { validateBundle } from '../src/validation.js';
import { replayExact } from '../src/replay.js';

const profile=JSON.parse(readFileSync(new URL('../profiles/targets.lock.json',import.meta.url),'utf8'));
const pkg=JSON.parse(readFileSync(new URL('../node_modules/@engine262/engine262/package.json',import.meta.url),'utf8'));
assert.equal(pkg.version,profile.referenceEngine.npmVersion,'Unpinned engine262');
const oracle=await createSpecOracle();
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--output' || !args[1]))
  throw new Error('Usage: node scripts/run-owned-arithmetic-probes.mjs [--output report.json]');
const values=['undefined','null','false','true','0','(-0)','2','(-2)','(0 / 0)','(1 / 0)','(-1 / 0)',
  "''","'2'","'not-a-number'","'x'",'0n','2n','(-2n)'];
const operators=['+','-','*','/','%','**'];
const expressions=[];
for(const operator of operators)for(const left of values)for(const right of values)
  expressions.push('('+left+') '+operator+' ('+right+')');
expressions.push("' 0x10 ' - 0", "'0o17' * 2", "'0b101' / 1", "'1e2' - 0", "'+Infinity' - 0",
  "'1_000' - 0", "'\\u00a0-0\\ufeff' * 1", "'x' + 9007199254740993n", '9007199254740993n + 2n',
  '(1 / 0) ** 0', '(-1) ** (1 / 0)', '(-0) ** (-3)', '(-7n) / 3n', '(-7n) % 3n');

function reference(expression) {
  // Outcome encoding executes inside the oracle realm. Only the resulting
  // primitive string crosses back; no oracle object becomes tracer state.
  const source=`let result;
    try {
      const value=(${expression});
      let encoded;
      if(value===undefined) encoded=['undefined'];
      else if(value===null) encoded=['null'];
      else if(typeof value==='boolean') encoded=['bool',value];
      else if(typeof value==='string') encoded=['str',value];
      else if(typeof value==='bigint') encoded=['bigint',String(value)];
      else if(typeof value==='number') {
        let number=value;
        if(Object.is(value,-0)) number='-0';
        else if(Number.isNaN(value)) number='NaN';
        else if(value===Infinity) number='+Infinity';
        else if(value===-Infinity) number='-Infinity';
        encoded=['num',number];
      } else throw new Error('Unexpected non-scalar reference result');
      result=JSON.stringify({type:'normal',value:encoded});
    } catch(error) { result=JSON.stringify({type:'throw',errorType:error.name}); }`;
  const encoded=oracle.evaluateScalar(source,{url:'arithmetic:'+expression});
  assert.equal(encoded[0],'str');return JSON.parse(encoded[1]);
}

let normal=0, abrupt=0, events=0;
for(const expression of expressions) {
  const expected=reference(expression);
  const runtime=createRuntime().start('let result='+expression+';');
  const progress=runtime.drive();
  let actual;
  if(progress.kind==='terminated') {
    const record=Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
      .find(([name])=>name==='result')[1];
    actual={type:'normal',value:record.token.value};normal++;
  } else {
    assert.equal(progress.kind,'runtime.failure',expression);
    actual={type:'throw',errorType:runtime.state.control.a0.failure.completion.errorType};abrupt++;
  }
  assert.deepEqual(actual,expected,expression);
  const archive=JSON.parse(JSON.stringify(runtime.exportRun()));
  assert.equal(Object.keys(archive.effects).length,0);
  assert.equal(validateBundle(archive).valid,true,expression);
  assert.equal(replayExact(archive).valid,true,expression);
  events+=archive.events.length;
}
const report={schema:'owned-arithmetic-differential/1',oracle:pkg.version,
  corpusValues:values.length,operators,cartesianCases:values.length**2*operators.length,
  edgeCases:expressions.length-values.length**2*operators.length,cases:expressions.length,normal,abrupt,events,
  passed:expressions.length,reconstructed:expressions.length,replayed:expressions.length,
  evidence:'finite primitive corpus plus edge probes; not exhaustive ECMA-262, Test262 or native-host conformance'};
const json=JSON.stringify(report,null,2)+'\n';
if(args.length)writeFileSync(args[1],json);
process.stdout.write(json);
