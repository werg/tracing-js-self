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

function integerExpectedLexemes(text){
 // JSON.parse rounds large JSON integers. Read the expected-value token from
 // TypeScript's JSON syntax tree before interpreting the language-track type.
 // This works on the pinned Node 20 lane too; it needs no JSON reviver context.
 const tree=ts.parseJsonText('canonical-data.json',text),integers={};
 function visit(node){
  if(ts.isObjectLiteralExpression(node)){
   const fields=new Map(node.properties.filter(ts.isPropertyAssignment).map(property=>
     [property.name.text,property.initializer]));
   const id=fields.get('uuid'),expected=fields.get('expected');
   if(id&&ts.isStringLiteral(id)&&expected){
    const raw=expected.getText(tree);
    if(/^-?(?:0|[1-9][0-9]*)$/.test(raw))integers[id.text]=raw;
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(tree);return integers;
}

export function canonicalJavaScriptExpected(expected,binding=null){
 if(binding===null||binding===undefined)return expected;
 const knownBinding=binding.schema==='exercism-javascript-expected/1'&&binding.kind==='bigint'||
   binding.schema==='exercism-grains-bigint/1';
 if(!knownBinding||
    typeof binding.decimal!=='string'||binding.decimal.length>10000||
    !/^-?(?:0|[1-9][0-9]*)$/.test(binding.decimal)||typeof expected!=='number'||
    !Number.isInteger(expected)||Number(binding.decimal)!==expected)
   throw new TypeError('Invalid exact canonical JavaScript expected-value binding');
 return BigInt(binding.decimal);
}

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
   const expectedIntegerLexemes=integerExpectedLexemes(canonical);
   return {slug,source,canonical:JSON.parse(canonical),expectedIntegerLexemes,
     canonicalIntegerExpectations:Object.fromEntries(Object.entries(expectedIntegerLexemes).map(([uuid,decimal])=>[slug+'/'+uuid,decimal])),
     provenance:{solution:{repository:JS_REPO,revision:JS_REVISION,
       path:solutionPath,sha256:sha256(source),license:'MIT'},
       canonical:{repository:INPUT_REPO,revision:INPUT_REVISION,
       path:canonicalPath,sha256:sha256(canonical),license:'MIT'}},
     split:stableSplit(slug)};
 });
}

export function extractCanonicalCases(record,{includeSuperseded=false}={}){
 const output=[],seen=new Set(),replacements=new Map();
 function collectReplacements(value){
   if(Array.isArray(value)){for(const item of value)collectReplacements(item);return;}
   if(!value||typeof value!=='object')return;
   if(typeof value.reimplements==='string'){
     const replaced=record.slug+'/'+value.reimplements;
     replacements.set(replaced,[...(replacements.get(replaced)??[]),record.slug+'/'+value.uuid]);
   }
   if(Array.isArray(value.cases))collectReplacements(value.cases);
 }
 collectReplacements(record.canonical.cases??[]);
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
     const replacedBy=replacements.get(caseId)??null;
     if(replacedBy&&!includeSuperseded)return;
     if(!mapping){output.push({caseId,property,status:'unsupported_property',description:path});return;}
     const [entry,...keys]=mapping;
     if(!value.input||typeof value.input!=='object'||
        keys.some(k=>!Object.hasOwn(value.input,k))){
       output.push({caseId,property,status:'unsupported_input_shape',description:path});return;
     }
     let args=keys.map(k=>value.input[k]),argumentBinding=null,inputBinding=null,expectedBinding=null;
     // Problem specifications are language-neutral. These two explicit track
     // bindings preserve the original canonical input alongside the JS call.
     // No expected outcome is used to choose or alter an argument.
     if(record.slug==='two-fer'&&property==='twoFer'&&value.input.name===null){
       args=[];argumentBinding='two-fer-null-name-as-omitted-argument/1';
       inputBinding={schema:'exercism-two-fer-omitted-name/1',canonicalName:null,argumentCount:0};
     }
     if(record.slug==='knapsack'&&property==='maximumValue'&&value.input.items&&
        !Array.isArray(value.input.items)&&typeof value.input.items==='object'&&
        Object.keys(value.input.items).length===0){
       args=[value.input.maximumWeight,[]];argumentBinding='knapsack-empty-record-as-empty-items/1';
     }
     if(record.slug==='grains'&&typeof value.expected==='number'){
       const decimal=record.expectedIntegerLexemes?.[value.uuid]??
         (Number.isSafeInteger(value.expected)?String(value.expected):null);
       if(decimal===null){output.push({caseId,property,status:'unsupported_expected_precision',description:path});return;}
       expectedBinding={schema:'exercism-grains-bigint/1',decimal};
       canonicalJavaScriptExpected(value.expected,expectedBinding);
     }
     output.push({caseId,property,entry,args,canonicalInput:structuredClone(value.input),argumentBinding,inputBinding,
       reimplements:value.reimplements??null,expected:value.expected,expectedBinding,description:path,
       status:replacedBy?'superseded_canonical_case':'candidate',...(replacedBy?{replacedBy}:{})});
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
