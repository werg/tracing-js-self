// Public-only integrity check for the bounded portable input graph.
// It uses neither the archived heap nor a reference evaluation.
const exactKeys=(value,names)=>value!==null&&typeof value==='object'&&
  !Array.isArray(value)&&Object.keys(value).length===names.length&&
  names.every(name=>Object.hasOwn(value,name));
const specials=new Set(['-0','NaN','+Infinity','-Infinity']);
const bigint=/^(?:0|-?[1-9][0-9]*)$/;
const indexOfKey=key=>{
  const n=Number(key);
  return Number.isInteger(n)&&n>=0&&n<4294967295&&String(n)===key?n:null;
};

export function validatePublishedGraph(graph) {
  if(!exactKeys(graph,['roots','objects'])||
     !Array.isArray(graph.roots)||!Array.isArray(graph.objects)||
     graph.objects.length>256)
    throw new Error('Invalid published input graph shape or node budget');
  const ids=new Set();
  for(const obj of graph.objects) {
    if(!exactKeys(obj,['id','kind','shapeVersion','properties'])||
       typeof obj.id!=='string'||!obj.id||ids.has(obj.id)||
       !['object','array'].includes(obj.kind)||
       !Number.isSafeInteger(obj.shapeVersion)||obj.shapeVersion<0||
       !Array.isArray(obj.properties))
      throw new Error('Invalid or duplicate published input graph identity');
    ids.add(obj.id);
  }
  function value(v) {
    if(!Array.isArray(v))throw new Error('Invalid published input graph value');
    const kind=v[0],arg=v[1];
    if(kind==='undefined'||kind==='null') {
      if(v.length===1)return;
    }else if(v.length===2){
      if(kind==='ref'&&typeof arg==='string'&&ids.has(arg))return;
      if(kind==='bool'&&typeof arg==='boolean')return;
      if(kind==='str'&&typeof arg==='string')return;
      if(kind==='bigint'&&typeof arg==='string'&&bigint.test(arg))return;
      if(kind==='num'&&((typeof arg==='number'&&Number.isFinite(arg)&&
         !Object.is(arg,-0))||specials.has(arg)))return;
    }
    throw new Error('Unpublished reference or noncanonical input graph value');
  }
  let totalProperties=0;
  for(const obj of graph.objects) {
    const keys=new Set(),items=new Map();
    for(const prop of obj.properties) {
      if(!exactKeys(prop,['key','value','version'])||
         typeof prop.key!=='string'||prop.key==='__proto__'||keys.has(prop.key)||
         !Number.isSafeInteger(prop.version)||prop.version<0||
         ++totalProperties>4096)
        throw new Error('Invalid published input graph property or budget');
      keys.add(prop.key);items.set(prop.key,prop.value);
      value(prop.value);
    }
    if(obj.kind==='array') {
      const length=items.get('length');
      if(!Array.isArray(length)||length.length!==2||length[0]!=='num'||
         !Number.isSafeInteger(length[1])||length[1]<0||length[1]>4096)
        throw new Error('Invalid published input graph array length');
      for(let i=0;i<length[1];i++)
        if(!keys.has(String(i)))
          throw new Error('Sparse published input graph array');
      for(const key of keys) {
        const n=indexOfKey(key);
        if(n!==null&&n>=length[1])
          throw new Error('Published input graph array index exceeds length');
      }
    }
  }
  for(const root of graph.roots)value(root);
  return true;
}
