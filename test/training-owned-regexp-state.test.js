import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTrainingCase,recheckIndependentTrainingEvidence,
  validateTrainingExport} from '../src/training/index.js';
import {validateBundle,replayExact} from '../src/index.js';
import {restoreLines,decodeRecord} from '../src/training/format.js';

function verified(source,entry,args){
  const result=verifyTrainingCase({source:'"use strict";\n'+source,
    entry,args,maxGenerated:1024});
  assert.equal(result.status,'locally_verified',JSON.stringify(result));
  const episode=JSON.parse(JSON.stringify(result.exported));
  assert.equal(validateTrainingExport(episode).valid,true);
  assert.equal(recheckIndependentTrainingEvidence(episode).valid,true);
  assert.equal(validateBundle(episode.sidecar.archive).valid,true);
  assert.equal(replayExact(episode.sidecar.archive).valid,true);
  return episode;
}

test('owned static pinned ASCII RegExp is deterministic model-visible source context',()=>{
  const source=String.raw`const ASCII = /^[\t\n\r\x20-\x7E]*$/;
    function f(s){return ASCII.test(s);}`;
  for(const value of ['basicASCII\r\n\t','A😀B','éç','',String.fromCharCode(0)]){
    const episode=verified(source,'f',[value]);
    const lines=restoreLines(episode.public.groups
      .filter(x=>x.mode==='observed').map(x=>x.events[0].record));
    const code=decodeRecord(lines[0]);
    assert.equal(code.fields.staticRegExps.length,1);
    assert.equal(code.fields.staticRegExps[0].name,'ASCII');
  }
});

test('bounded word-boundary g scanner records actual lastIndex property changes',()=>{
  const source=String.raw`function f(s){const re=/\b/g;let n=0;let p=[];
    while(re.test(s)){p.push(re.lastIndex);re.lastIndex+=1;n++;
      if(n>20)throw new Error('Loop budget');}
    return [p,re.lastIndex];}`;
  const episode=verified(source,'f',[' abc-def ']);
  const writes=episode.sidecar.semantic.events.flatMap(e=>e.writes??[])
    .filter(w=>w.kind==='property'&&w.key==='lastIndex');
  assert(writes.length>=5,'lastIndex must remain an effective visible state mutation');
});

test('unmodeled regexp patterns, flags and custom receivers are refused',()=>{
  for(const source of [
    String.raw`function f(s){return /a+/g.test(s);}`,
    String.raw`function f(s){return /\b/i.test(s);}`,
    String.raw`function f(s){return /\b/g.test(s.toString());}`
  ]){
    const result=verifyTrainingCase({source:'"use strict";\n'+source,
      entry:'f',args:['alpha']});
    assert.notEqual(result.status,'locally_verified');
  }
});
