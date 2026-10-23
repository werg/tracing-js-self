// Owned, deterministic bounded RegExp subset, not a native RegExp fallback.
// The pattern/flag allowlist is intentionally exact and versionable.
import {RTL_PATTERN} from './owned-rtl-pattern.js';
export const PINNED_ASCII_PATTERN=String.raw`^[\t\n\r\x20-\x7E]*$`;
export function supportsPinnedRegExp(pattern,flags){
  return (flags==='' && [String.raw`\r\n|\r|\n`,
    String.raw`(\r\n|\r|\n)`,PINNED_ASCII_PATTERN,RTL_PATTERN].includes(pattern)) ||
    (flags==='g' && [String.raw`\b`,String.raw`{(\d+)}`,String.raw`{([^}]+)}`,String.raw`[<>&]`,
      String.raw`[\\\{\}\*\+\?\|\^\$\.\[\]\(\)]`].includes(pattern));
}
export function testPinnedRegExp(pattern,flags,input,lastIndex=0){
  if(typeof input!=='string'||input.length>10000 ||
    !Number.isSafeInteger(lastIndex)||lastIndex<0||lastIndex>10001)
    throw new TypeError('Unsupported bounded RegExp.test operation');
  if(pattern===String.raw`\b` && flags==='g'){
    const word=i=>i>=0&&i<input.length&&(
      input.charCodeAt(i)>=65&&input.charCodeAt(i)<=90 ||
      input.charCodeAt(i)>=97&&input.charCodeAt(i)<=122 ||
      input.charCodeAt(i)>=48&&input.charCodeAt(i)<=57 ||
      input.charCodeAt(i)===95);
    for(let i=lastIndex;i<=input.length;i++){
      if(word(i-1)!==word(i))return {matched:true,nextIndex:i};
    }
    return {matched:false,nextIndex:0};
  }
  if(pattern===RTL_PATTERN && flags===''){
    const ranges=rtlRanges();
    for(let i=0;i<input.length;i++){
      const point=input.charCodeAt(i),next=input.charCodeAt(i+1);
      for(const term of ranges)if(term.prefix===null &&
        term.ranges.some(([min,max])=>point>=min&&point<=max) ||
        term.prefix===point && term.ranges.some(([min,max])=>next>=min&&next<=max))
        return {matched:true,nextIndex:lastIndex};
    }
    return {matched:false,nextIndex:lastIndex};
  }
  if(pattern!==PINNED_ASCII_PATTERN || flags!=='')
    throw new TypeError('Unsupported bounded RegExp.test operation');
  for(let i=0;i<input.length;i++){
    const code=input.charCodeAt(i);
    if(code!==9&&code!==10&&code!==13&&(code<32||code>126))
      return {matched:false,nextIndex:lastIndex};
  }
  return {matched:true,nextIndex:lastIndex};
}

// Exact global replacement scanners. Captures are produced from owned
// source-ordered matching, not from a host RegExp evaluation.
export function scanPinnedReplacement(pattern,flags,input){
  if(flags!=='g'||typeof input!=='string'||input.length>10000||
    ![String.raw`{(\d+)}`,String.raw`{([^}]+)}`,String.raw`[<>&]`].includes(pattern))
    throw new TypeError('Unsupported owned callback replacement pattern');
  const result=[];
  for(let i=0;i<input.length;i++){
    if(pattern===String.raw`[<>&]`){
      if(!'<>&'.includes(input[i]))continue;
      result.push({start:i,end:i+1,match:input[i],group:null});
    }else if(input[i]==='{'){
      const end=input.indexOf('}',i+1);
      if(end<0||end===i+1)continue;
      const group=input.slice(i+1,end);
      if(pattern===String.raw`{(\d+)}` && ![...group].every(c=>c>='0'&&c<='9'))continue;
      result.push({start:i,end:end+1,match:input.slice(i,end+1),group});
      i=end;
    }
    if(result.length>1024)throw new RangeError('Owned replacement callback budget exceeded');
  }
  return result;
}
function rtlRanges(){
  // Parse ranges in the exact pinned source literal, never match guest input
  // with the host regexp engine.
  const body=RTL_PATTERN.slice(3,-1);
  const terms=[];
  const hex=(offset)=>{
    if(body.slice(offset,offset+2)!=='\\u')throw new SyntaxError('Invalid pinned RTL range');
    const digits=body.slice(offset+2,offset+6);
    if(digits.length!==4||![...digits].every(c=>'0123456789abcdefABCDEF'.includes(c)))
      throw new SyntaxError('Invalid RTL character escape');
    return parseInt(digits,16);
  };
  let pos=0;
  while(pos<body.length){
    let prefix=null;
    if(body[pos]!=='['){prefix=hex(pos);pos+=6;}
    if(body[pos++]!=='[')throw new SyntaxError('Invalid RTL character group');
    const close=body.indexOf(']',pos);
    if(close<0)throw new SyntaxError('Unterminated RTL character group');
    const ranges=[];
    while(pos<close){
      const low=hex(pos);pos+=6;
      let high=low;
      if(body[pos]==='-'){pos++;high=hex(pos);pos+=6;}
      if(high<low)throw new SyntaxError('Descending RTL character range');
      ranges.push([low,high]);
    }
    terms.push({prefix,ranges});
    pos=close+1;
    if(pos<body.length && body[pos++]!=='|')throw new SyntaxError('Unexpected RTL alternative');
  }
  return terms;
}
