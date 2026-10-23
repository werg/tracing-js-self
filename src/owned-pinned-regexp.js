// Owned, deterministic bounded RegExp subset, not a native RegExp fallback.
// The pattern/flag allowlist is intentionally exact and versionable.
export const PINNED_ASCII_PATTERN=String.raw`^[\t\n\r\x20-\x7E]*$`;
export function supportsPinnedRegExp(pattern,flags){
  return (flags==='' && [String.raw`\r\n|\r|\n`,
    String.raw`(\r\n|\r|\n)`,PINNED_ASCII_PATTERN].includes(pattern)) ||
    (flags==='g' && [String.raw`\b`,
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
  if(pattern!==PINNED_ASCII_PATTERN || flags!=='')
    throw new TypeError('Unsupported bounded RegExp.test operation');
  for(let i=0;i<input.length;i++){
    const code=input.charCodeAt(i);
    if(code!==9&&code!==10&&code!==13&&(code<32||code>126))
      return {matched:false,nextIndex:lastIndex};
  }
  return {matched:true,nextIndex:lastIndex};
}
