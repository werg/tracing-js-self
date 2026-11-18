import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {syntaxOnlyV6Grammar} from '../src/training/causal-lm-bridge.js';
import {compileGrammar} from './helpers/gbnf-recognizer.js';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/semantic-trace-v6.json',import.meta.url),'utf8'));
const observedOrTransport=new Set(['code','input','observe','value-open','value-part','value-close']);

test('the independent GBNF reader recognizes grouping, alternatives, classes and repetition',()=>{
  const accepts=compileGrammar('root ::= "a" ("b" | [0-9])+ "c"?\n');
  for(const value of ['ab','a1','ab123bc'])assert.equal(accepts(value),true,value);
  for(const value of ['a','ac','ba','abx','abcc'])assert.equal(accepts(value),false,value);
  assert.throws(()=>compileGrammar('root ::= missing\n'),/Unresolved/);
});

test('the actual constrained-decoder grammar accepts every canonical generated V6 fixture',()=>{
  const accepts=compileGrammar(syntaxOnlyV6Grammar());
  for(const row of fixtures.canonical){
    if(observedOrTransport.has(row.kind))continue;
    assert.equal(accepts(row.line),true,row.name+': '+row.line);
  }
});

test('constrained decoding cannot emit old JSON envelopes or observed/transport records',()=>{
  const accepts=compileGrammar(syntaxOnlyV6Grammar());
  for(const row of fixtures.canonical){
    if(observedOrTransport.has(row.kind))assert.equal(accepts(row.line),false,row.name);
    else assert.equal(accepts(row.kind+' '+JSON.stringify(row.fields)),false,'old '+row.name);
  }
  for(const line of ['return 6 ', 'compute {"result":6}', 'return 6\nend return',
    'evaluate twice(3) = 6','evaluate twice(3) => 6 choosing 1..2:then'])
    assert.equal(accepts(line),false,line);
});

test('form-only grammar contains no task-specific source, values or identity choices',()=>{
  const grammar=syntaxOnlyV6Grammar();
  assert.match(grammar,/summarize ::= "evaluate "/);
  assert.match(grammar,/" choosing "/);
  assert.match(grammar,/" items into "/);
  assert(!grammar.includes('@call1'));
  assert(!grammar.includes('"num"'));
  assert(!grammar.includes('sourceDigest'));
  assert(!grammar.includes('expected'));
});
