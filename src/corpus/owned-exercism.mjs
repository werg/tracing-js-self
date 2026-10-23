// Conservative, provenance-anchored bridge from real Exercism JavaScript proof
// implementations to the strict *owned* direct function-entry profile.
// This is a semantic lowering (not unchanged source or generic ESM support):
// it accepts only effect-free top-level function definitions and refuses all
// data initializers, imports, classes, and lexical arrow receiver capture.
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export const JS_REVISION='ff04f35158cdf61eebfdf18a774010495a1fd6d9';
export const INPUT_REVISION='650bebeb39ad40439175288042aece982b0a90a9';
export const JS_REPO='exercism/javascript';
export const INPUT_REPO='exercism/problem-specifications';
export const PROOF_ROOT='corpus/extension/snapshots/exercism-js';
export const INPUT_ROOT='corpus/extension/snapshots/exercism-js-inputs';

// An explicit binding avoids silently assuming Exercism language-track API
// names, the property schema, or ordering of object keys.
export const bindings=Object.freeze({
  'leap': {'leapYear':['isLeap','year']},
  'darts': {'score':['score','x','y']},
  'hamming': {'distance':['compute','strand1','strand2']},
  'raindrops': {'convert':['convert','number']},
  'collatz-conjecture': {'steps':['steps','number']},
  'isogram': {'isIsogram':['isIsogram','phrase']},
  'space-age': {'age':['age','planet','seconds']},
  'sum-of-multiples': {'sum':['sum','factors','limit']},
  'roman-numerals': {'roman':['toRoman','number']},
  'sieve': {'primes':['primes','limit']},
  'knapsack': {'maximumValue':['knapsack','maximumWeight','items']},
  'luhn': {'valid':['valid','value']},
  'matching-brackets': {'isPaired':['isPaired','value']},
  'largest-series-product': {'largestProduct':['largestProduct','digits','span']},
  'run-length-encoding': {'encode':['encode','string'],decode:['decode','string']},
  'anagram': {'findAnagrams':['findAnagrams','subject','candidates']},
  'binary-search': {'find':['find','array','value']},
  'two-fer': {'twoFer':['twoFer','name']},
  'armstrong-numbers': {'isArmstrongNumber':['isArmstrongNumber','number']},
  'grains': {'square':['square','square'],total:['total']}
});

const sha256=src=>createHash('sha256').update(src).digest('hex');
const sha1blob=bytes=>createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const pathFor=(slug,kind)=>kind==='solution'
  ?'exercises/practice/'+slug+'/.meta/proof.ci.js'
  :'exercises/'+slug+'/canonical-data.json';
export const stableSplit=slug=>{
 const h=parseInt(sha256('exercism/javascript/'+slug).slice(0,8),16)%10;
 return h===0?'test':h<=2?'validation':'train';
};

export function loadPinnedPairs(base=process.cwd()){
 const root=resolve(base),jsRoot=resolve(root,PROOF_ROOT),inRoot=resolve(root,INPUT_ROOT);
 const jsLock=JSON.parse(readFileSync(resolve(jsRoot,'snapshot.lock.json'),'utf8'));
 const inputLock=JSON.parse(readFileSync(resolve(inRoot,'snapshot.lock.json'),'utf8'));
 if(jsLock.repository!==JS_REPO||jsLock.revision!==JS_REVISION||
    inputLock.repository!==INPUT_REPO||inputLock.revision!==INPUT_REVISION)
   throw new Error('Exercism proof/contract upstream revisions are not pinned');
 const slugs=Object.keys(bindings).sort();
 if(Object.keys(jsLock.files).length!==slugs.length||
    Object.keys(inputLock.files).length!==slugs.length)
   throw new Error('Pinned Exercism solution/contract inventory is incomplete or unexpected');
 return slugs.map(slug=>{
   const solutionPath=pathFor(slug,'solution'),canonicalPath=pathFor(slug,'canonical');
   const check=(dir,lock,path)=>{
     if(!(path in lock.files))throw new Error('Unpinned Exercism source '+path);
     const bytes=readFileSync(resolve(dir,path));
     if(sha1blob(bytes)!==lock.files[path])
       throw new Error('Tampered pinned Exercism source '+path);
     return bytes.toString('utf8');
   };
   const source=check(jsRoot,jsLock,solutionPath),
     canonical=check(inRoot,inputLock,canonicalPath);
   return {slug,source,canonical:JSON.parse(canonical),
     provenance:{solution:{repository:JS_REPO,revision:JS_REVISION,
       path:solutionPath,sha256:sha256(source),license:'MIT'},
       canonical:{repository:INPUT_REPO,revision:INPUT_REVISION,
       path:canonicalPath,sha256:sha256(canonical),license:'MIT'}},
     split:stableSplit(slug)};
 });
}

export function extractCanonicalCases(record){
 const output=[],seen=new Set();
 function walk(value,desc=[]){
   if(Array.isArray(value)){for(const item of value)walk(item,desc);return;}
   if(!value||typeof value!=='object')return;
   const path=[...desc,...(typeof value.description==='string'?[value.description]:[])];
   if(Object.hasOwn(value,'input')&&Object.hasOwn(value,'expected')){
     const property=value.property;
     const mapping=bindings[record.slug]?.[property];
     const id=String(value.uuid??path.join('/'));
     const caseId=record.slug+'/'+id;
     if(seen.has(caseId))throw new Error('Duplicate canonical case id '+caseId);
     seen.add(caseId);
     if(!mapping){output.push({caseId,property,status:'unsupported_property',description:path});return;}
     const [entry,...keys]=mapping;
     if(!value.input||typeof value.input!=='object'||
        keys.some(k=>!Object.hasOwn(value.input,k))){
       output.push({caseId,property,status:'unsupported_input_shape',description:path});return;
     }
     output.push({caseId,property,entry,args:keys.map(k=>value.input[k]),
       expected:value.expected,description:path,status:'candidate'});
   }
   if(Array.isArray(value.cases))walk(value.cases,path);
 }
 walk(record.canonical.cases??[]);
 return output;
}
function reservedArrowSyntax(node){
 let found=false;
 function visit(n){
  if(n.kind===ts.SyntaxKind.ThisKeyword||n.kind===ts.SyntaxKind.SuperKeyword||
     n.kind===ts.SyntaxKind.MetaProperty||
     ts.isIdentifier(n)&&n.text==='arguments'){found=true;return;}
  ts.forEachChild(n,visit);
 }
 visit(node);
 return found;
}
function modifiers(node){
 return node.modifiers?.map(m=>m.kind)??[];
}
export function lowerPinnedProof(source){
 const sf=ts.createSourceFile('proof.ci.js',source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
 if(sf.parseDiagnostics.length)throw new SyntaxError('Invalid upstream proof source');
 const functions=[],exported=new Set(),definitions=new Set();
 for(const statement of sf.statements){
   if(ts.isFunctionDeclaration(statement)){
     if(!statement.name||statement.asteriskToken||
       modifiers(statement).includes(ts.SyntaxKind.AsyncKeyword))
       throw new SyntaxError('Unsupported function declaration');
     const name=statement.name.text;
     if(definitions.has(name))throw new SyntaxError('Duplicate top-level binding '+name);
     definitions.add(name);
     if(modifiers(statement).includes(ts.SyntaxKind.ExportKeyword))exported.add(name);
     const body=statement.getText(sf).replace(/^export\s+/,'');
     functions.push(body);
     continue;
   }
   if(ts.isVariableStatement(statement)&&
      (statement.declarationList.flags & ts.NodeFlags.Const) &&
      statement.declarationList.declarations.length>=1){
     for(const decl of statement.declarationList.declarations){
       if(!ts.isIdentifier(decl.name)||!decl.initializer||
          !ts.isArrowFunction(decl.initializer))
         throw new SyntaxError('Top-level non-function initialization is not owned');
       const fn=decl.initializer,name=decl.name.text;
       if(definitions.has(name))throw new SyntaxError('Duplicate top-level binding '+name);
       if(fn.modifiers?.length||reservedArrowSyntax(fn))
         throw new SyntaxError('Arrow receiver/arguments semantics not safe for lowering');
       definitions.add(name);
       if(modifiers(statement).includes(ts.SyntaxKind.ExportKeyword))exported.add(name);
       const params=fn.parameters.map(p=>p.getText(sf)).join(', ');
       const body=fn.body.getText(sf);
       functions.push('function '+name+'('+params+') '+
         (ts.isBlock(fn.body)?body:'{ return ('+body+'); }'));
     }
     continue;
   }
   throw new SyntaxError('Unsupported top-level ESM construct '+ts.SyntaxKind[statement.kind]);
 }
 if(!functions.length||!exported.size)
   throw new SyntaxError('No owned-entry-compatible original exports');
 return {source:'"use strict";\n'+functions.join('\n\n')+'\n',
   exported:[...exported].sort(),lowering:'static-top-level-function-only/1',
   semanticLimits:'Top-level arrow to function conversion requires no lexical receiver/arguments; original module output independently compared'};
}
