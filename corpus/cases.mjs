// Pinned real-source function inventory. Sources are vendored without rewriting;
// the generator extracts the exact top-level function declaration by TypeScript
// AST and uses the original unmodified body for both executions.
const n=i=>((i*13+7)%31)-15;
const a=i=>[n(i),0,i%3+1,n(i+1),null,4+i%5];
const dense=i=>[n(i),i+1,2*i+1,(i%5)-2,7];
const b=i=>[n(i+1),i+2,2*i+1,(i%5)-2,7];
const str=i=>[
  '  Hello world  ','abcABCabc','a\nb\r\nc','\t  alpha\t',
  'zero 00 zero','étude Δ abc','A😀BC','\uFEFFbom sample',
  'one two three','foo.bar[baz]','AaAaAa','z-42-z'
][i%12]+String(i);
const needle=i=>['a',' ','o','0','z','-','!','A'][i%8];
const S=(file,entry,args,extra={})=>({project:'vscode',file,entry,args,...extra});
const L=(file,entry,args,extra={})=>({project:'lodash',file,entry,args,...extra});
const callback=(values,callbackExpression)=>'globalThis.__testArgs=['+
  JSON.stringify(values).slice(1,-1)+','+callbackExpression+'];';
const numericPairs=i=>[n(i),n(i+1)];
const strings=[
  S('strings.ts','isFalsyOrWhitespace',i=>[str(i)]),
  S('strings.ts','format',i=>['value={0}, more={1}',n(i),n(i+1)]),
  S('strings.ts','format2',i=>['name={name}, n={n}',{name:str(i),n:n(i)}]),
  S('strings.ts','escape',i=>['<a href="x&y">'+str(i)+'</a>']),
  S('strings.ts','escapeRegExpCharacters',i=>[str(i)+'[]()?$^']),
  S('strings.ts','count',i=>[str(i)+'aa',needle(i)]),
  S('strings.ts','trim',i=>[' '+str(i)+' ',i%3===0?' ':'a']),
  S('strings.ts','ltrim',i=>['--'+str(i),'--']),
  S('strings.ts','rtrim',i=>[str(i)+'--','--']),
  S('strings.ts','joinStrings',i=>[[str(i),null,false,'x',undefined,'y'],needle(i)]),
  S('strings.ts','splitLines',i=>[str(i)+'\nx']),
  S('strings.ts','splitLinesIncludeSeparators',i=>[str(i)+'\r\nx']),
  S('strings.ts','firstNonWhitespaceIndex',i=>['   '+str(i)]),
  S('strings.ts','getLeadingWhitespace',i=>[' \t  '+str(i)]),
  S('strings.ts','lastNonWhitespaceIndex',i=>[str(i)+' \t']),
  S('strings.ts','getIndentationLength',i=>['\t  '+str(i)]),
  S('strings.ts','compare',i=>[str(i),str(i+1)]),
  S('strings.ts','compareSubstring',i=>[str(i),str(i+1),1,Math.min(4,str(i).length),0,3]),
  S('strings.ts','commonPrefixLength',i=>['abc'+str(i),'abcd'+str(i+1)]),
  S('strings.ts','commonSuffixLength',i=>[str(i)+'tail',str(i+1)+'tail']),
  S('strings.ts','isBasicASCII',i=>[str(i)]),
  S('strings.ts','containsRTL',i=>[str(i)]),
  S('strings.ts','lcut',i=>[str(i),i%6,'...']),
  S('strings.ts','rcut',i=>[str(i),i%6,'...']),
  S('strings.ts','fuzzyContains',i=>[str(i),needle(i)]),
  S('strings.ts','containsUppercaseCharacter',i=>[str(i)]),
  S('strings.ts','uppercaseFirstLetter',i=>[str(i).trim()]),
  S('strings.ts','getNLines',i=>[str(i)+'\nhello\nworld',(i%3)+1])
];
const arrays=[
  S('arrays.ts','tail',i=>[dense(i)]),
  S('arrays.ts','equals',i=>[dense(i),i%2?dense(i):b(i)]),
  S('arrays.ts','removeFastWithoutKeepingOrder',i=>[dense(i),i%5],{mutatesInput:true}),
  S('arrays.ts','concatArrays',i=>[dense(i),b(i)]),
  S('arrays.ts','coalesce',i=>[a(i)]),
  S('arrays.ts','coalesceInPlace',i=>[a(i)],{mutatesInput:true}),
  S('arrays.ts','move',i=>[dense(i),i%5,(i+2)%5],{mutatesInput:true}),
  S('arrays.ts','isFalsyOrEmpty',i=>[i%4===0?null:i%4===1?[]:dense(i)]),
  S('arrays.ts','distinct',i=>[[1,2,1,i%4,2,5]]),
  S('arrays.ts','commonPrefixLength',i=>[[1,2,3,i%4],[1,2,i%3,5]]),
  S('arrays.ts','range',i=>[2+i%8]),
  S('arrays.ts','remove',i=>[dense(i),i%2?dense(i)[0]:99],{mutatesInput:true}),
  S('arrays.ts','arrayInsert',i=>[dense(i),i%6,b(i)],{mutatesInput:true}),
  S('arrays.ts','pushToStart',i=>[dense(i),n(i)],{mutatesInput:true}),
  S('arrays.ts','pushToEnd',i=>[dense(i),n(i)],{mutatesInput:true}),
  S('arrays.ts','pushMany',i=>[dense(i),b(i)],{mutatesInput:true}),
  S('arrays.ts','withoutDuplicates',i=>[[1,2,3,1,i%4,2,4]]),
  S('arrays.ts','asArray',i=>[i%2?dense(i):n(i)]),
  S('arrays.ts','insertInto',i=>[dense(i),i%5,b(i)],{mutatesInput:true}),
  S('arrays.ts','splice',i=>[dense(i),i%5,2,b(i)],{mutatesInput:true}),
  S('arrays.ts','sum',i=>[dense(i)]),
  S('arrays.ts','sumBy',i=>[],{setup:i=>callback([dense(i)],'(x)=>x*x')}),
  S('arrays.ts','mapFilter',i=>[],{setup:i=>callback([dense(i)],'(x)=>x%2===0?x*3:undefined')}),
  S('arrays.ts','groupBy',i=>[],{setup:i=>callback([dense(i)],'(x,y)=>x-y')}),
  S('arrays.ts','binarySearch',i=>[],{setup:i=>callback([[1,2,4,6,9],i%10],'(x,y)=>x-y')}),
  S('arrays.ts','mapArrayOrNot',i=>[],{setup:i=>callback([i%2?dense(i):n(i)],'(x)=>x+1')}),
  S('arrays.ts','quickSelect',i=>[],{setup:i=>callback([i%5,dense(i)],'(x,y)=>x-y')})
];
const numbers=[
  S('numbers.ts','clamp',i=>[n(i),-5+i%3,5+i%4]),
  S('numbers.ts','rot',i=>[n(i),2+i%9]),
  S('numbers.ts','formatTokenCount',i=>[Math.abs(n(i))*1000+i])
];
const lodash=[
  L('_arrayEach.js','arrayEach',i=>[],{setup:i=>callback([dense(i)],'(x)=>x+1')}),
  L('_arrayEachRight.js','arrayEachRight',i=>[],{setup:i=>callback([dense(i)],'(x)=>x-1')}),
  L('_arrayEvery.js','arrayEvery',i=>[],{setup:i=>callback([dense(i)],'(x)=>x>=0')}),
  L('_arrayFilter.js','arrayFilter',i=>[],{setup:i=>callback([dense(i)],'(x)=>x%2===0')}),
  L('_arrayIncludesWith.js','arrayIncludesWith',i=>[],{setup:i=>callback([dense(i),i%3],'(a,b)=>a===b')}),
  L('_arrayMap.js','arrayMap',i=>[],{setup:i=>callback([dense(i)],'(x)=>x*x')}),
  L('_arrayPush.js','arrayPush',i=>[dense(i),b(i)],{mutatesInput:true}),
  L('_arrayReduce.js','arrayReduce',i=>[],{setup:i=>'globalThis.__testArgs=['+
    JSON.stringify(dense(i))+',(acc,x)=>acc+x,0,false];'}),
  L('_arrayReduceRight.js','arrayReduceRight',i=>[],{setup:i=>'globalThis.__testArgs=['+
    JSON.stringify(dense(i))+',(acc,x)=>acc+x,0,false];'}),
  L('_arraySome.js','arraySome',i=>[],{setup:i=>callback([dense(i)],'(x)=>x<0')}),
  L('_baseClamp.js','baseClamp',i=>[n(i),-3+i%2,3+i%3]),
  L('_baseRange.js','baseRange',i=>[n(i),n(i)+4,1,i%2===0]),
  L('_baseRepeat.js','baseRepeat',i=>[str(i).slice(0,5),i%7]),
  L('_baseTimes.js','baseTimes',i=>[],{setup:i=>'globalThis.__testArgs=['+
    (i%8+1)+',(index)=>index*2];'}),
  L('_baseSum.js','baseSum',i=>[],{setup:i=>callback([dense(i)],'(x)=>x')}),
  L('_baseGt.js','baseGt',numericPairs),
  L('_baseLt.js','baseLt',numericPairs),
  L('_strictIndexOf.js','strictIndexOf',i=>[dense(i),i%2?dense(i)[0]:n(i+4),i%5]),
  L('_strictLastIndexOf.js','strictLastIndexOf',i=>[dense(i),i%2?dense(i)[0]:n(i+4),4]),
  L('_baseFindIndex.js','baseFindIndex',i=>[],{setup:i=>callback([dense(i)],'(x)=>x>0')+
    'globalThis.__testArgs.push(0,false);'})
];
export const sources={
  vscode:{revision:'2bc7d5ab6919c62e60379e5e1f840bd80846dbdb',
    license:'MIT',sourcePrefix:'src/vs/base/common/'},
  lodash:{revision:'c6e281b878b315c7a10d90f9c2af4cdb112d9625',
    license:'MIT',sourcePrefix:''}
};
export const cases=[...numbers,...arrays,...strings,...lodash];
