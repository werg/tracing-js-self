// Rebuild candidates from reviewed, pinned source bytes. A diagnostic/local
// episode is never promoted by copying its old admitted/verified flag.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {cases as utilities,sources as utilityPins} from '../../corpus/cases.mjs';
import {original,lowerPinnedCharCode} from '../../corpus/pinned-source.mjs';
import {buildOwnedFixtureEntry} from '../../corpus/owned-fixture-adapter.mjs';
import {loadPinnedPairs,lowerPinnedProof,extractCanonicalCases} from './owned-exercism.mjs';
import {buildOwnedSourceMap} from './original-sites.mjs';
import {generateInputVariations} from './variation-exercism.mjs';
import {OWNED_PRODUCTION_HELPERS,OWNED_PRODUCTION_CLOSURE_CASES,extractPinnedHelper,
  extractPinnedTypeOfTestClosure} from './production-owned.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const packageSource=text=>text.replace(/\bexport\s+(?=(?:async\s+)?function\b)/g,'')
  .replace(/\bexport\s+(?=(?:const|let|var)\b)/g,'')
  .replace(/^\s*module\.exports\s*=\s*[\w$]+\s*;?\s*$/gm,'');
const transpile=(text,file)=>ts.transpileModule(packageSource(text),{fileName:file,
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function originalExercism(source){
  const tree=ts.createSourceFile('proof.js',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  let end=0,parts=['"use strict";\n'];
  for(const statement of tree.statements)for(const modifier of statement.modifiers??[])
    if(modifier.kind===ts.SyntaxKind.ExportKeyword){parts.push(source.slice(end,modifier.getStart(tree)));end=modifier.end;}
  return parts.join('')+source.slice(end);
}
function candidate({stream,family,index,source,entry,args,originalSource,provenance,refusal=null}){
  const id='real-'+stream+'-'+sha(JSON.stringify([family,index,provenance.upstream])).slice(0,24);
  return {id,family,source,entry,args,fixture:{calls:[]},license:provenance.license,
    trustTier:'trusted-owned-source',ancestorIds:['upstream:'+provenance.upstream.repository+':'+provenance.upstream.path],
    provenance:{...provenance,sourceStream:stream,inputIndex:index,
      originalSourceSha256:sha(originalSource),transformedSourceSha256:sha(source),
      originalSource,transformedSource:source},
    originalReferenceSource:originalSource,
    ...(refusal?{preflightFailure:refusal}:{}),
    projectionOptions:{maxGenerated:4096},maxSteps:20000,timeoutMs:10000};
}
function lockUtilities(root){
  const lock=JSON.parse(readFileSync(resolve(root,'corpus/utility-source-lock.json'),'utf8'));
  if(lock.schema!=='pinned-utility-source-lock/1')throw new Error('Missing pinned utility source lock');
  for(const [path,digest] of Object.entries(lock.files)){
    if(!/^(vscode|lodash)\/[\w.-]+$/.test(path)||
      sha(readFileSync(resolve(root,'corpus/upstream',path)))!==digest)
      throw new Error('Pinned utility source bytes changed: '+path);
  }
  return lock;
}
function utilityCandidates(root,perFamily){
  lockUtilities(root);const output=[];
  for(const spec of utilities){
    const pinned=original(spec,{root}),pin=utilityPins[spec.project],family='utility:'+spec.project+'/'+spec.file+'/'+spec.entry;
    const repository=spec.project==='vscode'?'microsoft/vscode':'lodash/lodash';
    const noticePath='corpus/upstream/'+spec.project+'/'+(spec.project==='vscode'?'LICENSE.txt':'LICENSE');
    const notice=readFileSync(resolve(root,noticePath),'utf8');
    const lowered=lowerPinnedCharCode(spec,pinned.text,{root});
    const originalJS=spec.project==='vscode'?transpile(pinned.text,spec.file):packageSource(pinned.text);
    const transformedJS=spec.project==='vscode'?transpile(lowered.text,spec.file):packageSource(lowered.text);
    for(let index=0;index<Math.min(perFamily,12);index++){
      let source='"use strict";\n'+transformedJS,originalSource='"use strict";\n'+originalJS,
        entry=spec.entry,args=spec.args(index),refusal=null;
      if(spec.setup){
        try{const wrapper=buildOwnedFixtureEntry(spec.setup(index),entry);
          source+='\n'+wrapper.source;originalSource+='\n'+wrapper.source;entry=wrapper.entry;args=[];}
        catch(error){refusal={status:'guest_fixture_not_portable',reason:String(error.message)};}
      }
      output.push(candidate({stream:'utilities',family,index,source,entry,args,originalSource,refusal,
        provenance:{upstream:{repository,revision:pin.revision,path:pin.sourcePrefix+spec.file,
          sha256:sha(pinned.sourceFile)},license:pin.license,notice,noticePath,
          originalFile:pinned.sourceFile,sourceURL:pinned.sourceURL,
          transform:{schema:'pinned-utility-projection/1',packaging:'remove-export-and-commonjs-assignment',
            typescript:spec.project==='vscode'?ts.version:null,lowering:lowered.lowering,
            ownedCallbackWrapper:!!spec.setup},inputOrigin:'pinned-deterministic-invocation'}}));
      if(spec.entry==='quickSelect')output.at(-1).seeds={guestRng:42};
    }
  }
  return output;
}
function exercismCandidates(root,perFamily,mutationsPerFamily){
  const output=[],noticePath='corpus/extension/snapshots/exercism-js/LICENSE';
  const notice=readFileSync(resolve(root,noticePath),'utf8');
  const canonicalNoticePath='corpus/extension/snapshots/exercism-js-inputs/LICENSE';
  const canonicalNotice=readFileSync(resolve(root,canonicalNoticePath),'utf8');
  for(const pair of loadPinnedPairs(root)){
    const canonical=extractCanonicalCases(pair),variations=generateInputVariations(pair.slug,canonical,{limit:mutationsPerFamily});
    let lowered=null,refusal=null,originalSites={status:'unavailable',reason:'No supported source lowering'};
    try{lowered=lowerPinnedProof(pair.source);}catch(error){refusal={status:'source_unsupported',reason:String(error.message)};}
    if(lowered){
      try{originalSites={status:'mapped',scope:'unchanged-spans-only',map:buildOwnedSourceMap(pair.source,lowered.source)};}
      catch(error){originalSites={status:'unavailable',reason:String(error.message)};}
    }
    for(const fixture of [...canonical.slice(0,perFamily),...variations]){
      const entry=fixture.entry??'unsupportedEntry',source=lowered?.source??originalExercism(pair.source);
      let rejected=refusal;
      if(fixture.status!=='candidate')rejected={status:'fixture_unsupported',reason:fixture.status};
      else if(lowered&&!lowered.exported.includes(entry))rejected={status:'fixture_unsupported',reason:'Entry not exported by original pinned source'};
      output.push(candidate({stream:'exercism',family:'exercism/javascript:'+pair.slug,index:fixture.caseId,
        source,entry,args:fixture.args??[],originalSource:originalExercism(pair.source),refusal:rejected,
        provenance:{upstream:pair.provenance.solution,canonical:pair.provenance.canonical,
          license:'MIT',notice,noticePath,originalFile:pair.source,
          canonicalNotice:{repository:pair.provenance.canonical.repository,revision:pair.provenance.canonical.revision,
            license:pair.provenance.canonical.license,path:canonicalNoticePath,sha256:sha(canonicalNotice),text:canonicalNotice},
          transform:{schema:'pinned-exercism-projection/1',lowering:lowered?.lowering??null,originalSites},
          inputOrigin:fixture.generator??'upstream-canonical',derivedFrom:fixture.derivedFrom??null,
          canonicalInput:fixture.generator?null:(fixture.canonicalInput??null),
          ...(fixture.inputPrecision?{canonicalInputPrecision:fixture.inputPrecision,
            canonicalScenarios:fixture.scenarios,canonicalComments:fixture.canonicalComments}:{}),
          canonicalInputBinding:fixture.generator?null:(fixture.inputBinding??null),
          canonicalArgumentBinding:fixture.generator?null:(fixture.argumentBinding??null),
          canonicalExpectedBinding:fixture.generator?null:(fixture.expectedBinding??null),
          canonicalReimplements:fixture.generator?null:(fixture.reimplements??null),
          canonicalSelection:'active-reimplementations/1',
          canonicalExpected:fixture.generator?null:(fixture.expected??null),canonicalProperty:fixture.property??null}}));
    }
  }
  return output;
}
function productionCandidates(root,perFamily){
  const output=[];
  const append=(artifact,index,args)=>{
    const pin=artifact.provenance,noticePath='corpus/stateful/upstream/axios/LICENSE';
    let notice;
    // The vendor tree names are pinned by production-owned; missing notices
    // are explicit metadata, never silently replaced by an invented license.
    try{notice=readFileSync(resolve(root,noticePath),'utf8');}catch{notice=null;}
    output.push(candidate({stream:'production',family:'production:'+pin.repository+':'+pin.path+':'+artifact.entry,
      index,source:artifact.projected,entry:artifact.entry,args,
      originalSource:artifact.originalArrow?'"use strict";\n'+artifact.originalArrow:artifact.projected,
      provenance:{upstream:{repository:pin.repository,revision:pin.revision,path:pin.path,sha256:pin.sha256},
        license:pin.license,notice,noticePath:notice?noticePath:null,
        transform:{schema:'pinned-production-projection/1',sourceSpan:pin.sourceSpan,
          projectionStart:pin.projectionStart,extraction:pin.extraction},inputOrigin:'pinned-helper-invocation'}}));
  };
  for(const item of OWNED_PRODUCTION_HELPERS){const artifact=extractPinnedHelper(item.module,item.function,{root});
    item.cases.slice(0,perFamily).forEach((args,index)=>append(artifact,index,args));}
  const closure=extractPinnedTypeOfTestClosure({root});
  OWNED_PRODUCTION_CLOSURE_CASES.slice(0,perFamily).forEach((args,index)=>append(closure,index,args));
  return output;
}
export function trustedRealSourceCases({root=process.cwd(),streams=['utilities','exercism','production'],
    perFamily=2,mutationsPerFamily=0}={}){
  if(!Array.isArray(streams)||!streams.length||new Set(streams).size!==streams.length||
    streams.some(stream=>!['utilities','exercism','production'].includes(stream))||
    !Number.isSafeInteger(perFamily)||perFamily<1||perFamily>100||
    !Number.isSafeInteger(mutationsPerFamily)||mutationsPerFamily<0||mutationsPerFamily>512)
    throw new TypeError('Invalid trusted real-source candidate bounds');
  return streams.flatMap(stream=>stream==='utilities'?utilityCandidates(root,perFamily):
    stream==='exercism'?exercismCandidates(root,perFamily,mutationsPerFamily):productionCandidates(root,perFamily));
}
