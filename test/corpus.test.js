import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {cases,sources} from '../corpus/cases.mjs';

test('real-source catalog has pinned distinct production functions and inputs',()=>{
  const known=new Set();
  assert(cases.length>=70);
  for(const item of cases){
    const family=item.project+'/'+item.file+'/'+item.entry;
    assert(!known.has(family),family);
    known.add(family);
    assert.equal(sources[item.project]?.revision.length,40);
    const text=readFileSync('corpus/upstream/'+item.project+'/'+item.file,'utf8');
    assert(text.includes('function '+item.entry),family);
    assert(Array.isArray(item.args(0)));
    if(item.setup)assert.match(item.setup(0),/__testArgs/);
    if(item.project==='vscode'){
      const sf=ts.createSourceFile(item.file,text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
      assert(sf.statements.some(s=>ts.isFunctionDeclaration(s)&&s.name?.text===item.entry),
        'Missing upstream top-level source: '+family);
    }
  }
});
