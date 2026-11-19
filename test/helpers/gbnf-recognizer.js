// Independent recognizer for the literal, character-class, sequence,
// alternative, group and repetition subset of GBNF emitted by the bridge.
// It reads the emitted grammar text; it knows nothing about trace records.
export function compileGrammar(grammar){
  const rules=new Map(),references=[];let serial=0;
  const node=(kind,fields={})=>({id:serial++,kind,...fields});
  for(const line of grammar.split('\n').filter(line=>line.trim())){
    const declaration=/^([a-z][a-z0-9-]*) ::= (.*)$/.exec(line);
    if(!declaration||rules.has(declaration[1]))throw new Error('Malformed or duplicate grammar rule');
    const text=declaration[2];let offset=0;
    const space=()=>{while(text[offset]===' ')offset++;};
    const take=expected=>{
      if(!text.startsWith(expected,offset))throw new Error('Expected grammar '+expected);
      offset+=expected.length;
    };
    function atom(){
      space();let result;
      if(text[offset]==='"'){
        const start=offset++;let escaped=false;
        for(;;){
          const char=text[offset++];
          if(char===undefined)throw new Error('Unterminated grammar literal');
          if(escaped)escaped=false;
          else if(char==='\\')escaped=true;
          else if(char==='"')break;
        }
        result=node('literal',{text:JSON.parse(text.slice(start,offset))});
      }else if(text[offset]==='['){
        const start=offset++;let escaped=false;
        for(;;){
          const char=text[offset++];
          if(char===undefined)throw new Error('Unterminated grammar class');
          if(escaped)escaped=false;
          else if(char==='\\')escaped=true;
          else if(char===']')break;
        }
        result=node('class',{pattern:new RegExp('^(?:'+text.slice(start,offset)+')','u')});
      }else if(text[offset]==='('){
        offset++;result=alternatives();space();take(')');
      }else{
        const name=/^[a-z][a-z0-9-]*/.exec(text.slice(offset))?.[0];
        if(!name)throw new Error('Unknown grammar atom at '+text.slice(offset));
        offset+=name.length;references.push(name);result=node('reference',{name});
      }
      if(['?','*','+'].includes(text[offset]))result=node('repeat',{child:result,mode:text[offset++]});
      return result;
    }
    function alternatives(){
      const choices=[];
      for(;;){
        const children=[];space();
        while(offset<text.length&&!['|',')'].includes(text[offset])){children.push(atom());space();}
        choices.push(node('sequence',{children}));
        if(text[offset]!=='|')break;
        offset++;
      }
      return node('choice',{children:choices});
    }
    const rule=alternatives();space();
    if(offset!==text.length)throw new Error('Unexpected grammar suffix');
    rules.set(declaration[1],rule);
  }
  if(!rules.has('root')||references.some(name=>!rules.has(name)))throw new Error('Unresolved grammar rule');
  return input=>{
    const memo=new Map(),active=new Set();
    const union=(target,values)=>{for(const value of values)target.add(value);};
    function match(rule,offset){
      const key=rule.id+':'+offset;
      if(memo.has(key))return memo.get(key);
      if(active.has(key))throw new Error('Left recursion is outside this GBNF test subset');
      active.add(key);const result=new Set();
      if(rule.kind==='literal'){
        if(input.startsWith(rule.text,offset))result.add(offset+rule.text.length);
      }else if(rule.kind==='class'){
        const found=rule.pattern.exec(input.slice(offset));
        if(found)result.add(offset+found[0].length);
      }else if(rule.kind==='reference')union(result,match(rules.get(rule.name),offset));
      else if(rule.kind==='choice')for(const child of rule.children)union(result,match(child,offset));
      else if(rule.kind==='sequence'){
        let positions=new Set([offset]);
        for(const child of rule.children){
          const next=new Set();for(const position of positions)union(next,match(child,position));
          positions=next;if(!positions.size)break;
        }
        union(result,positions);
      }else if(rule.kind==='repeat'){
        if(rule.mode!=='+' )result.add(offset);
        const pending=[...match(rule.child,offset)];
        while(pending.length){
          const end=pending.shift();
          if(result.has(end))continue;
          result.add(end);
          if(rule.mode!=='?')for(const next of match(rule.child,end))if(next>end&&!result.has(next))pending.push(next);
        }
      }
      active.delete(key);memo.set(key,result);return result;
    }
    return match(rules.get('root'),0).has(input.length);
  };
}
