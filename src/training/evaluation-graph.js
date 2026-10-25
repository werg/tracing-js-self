// Reference archives use tuple properties; semantic-trace/4 graph records use
// named properties. Keep this conversion at the evaluation boundary only.
export const traceGraph=graph=>{
  if(!graph||typeof graph!=='object'||!Array.isArray(graph.roots)||!Array.isArray(graph.objects))
    throw new TypeError('Reference outcome must contain a complete owned graph');
  return {...structuredClone(graph),objects:graph.objects.map(node=>{
    if(!node||typeof node!=='object'||!Array.isArray(node.properties))
      throw new TypeError('Reference outcome graph has invalid properties');
    const seen=new Set();
    const properties=node.properties.map(property=>{
      const pair=Array.isArray(property)&&property.length===2?
        {key:property[0],value:property[1]}:property;
      if(!pair||typeof pair!=='object'||Array.isArray(pair)||Object.keys(pair).length!==2||
        typeof pair.key!=='string'||!Object.hasOwn(pair,'value')||seen.has(pair.key))
        throw new TypeError('Reference outcome graph has invalid or duplicate properties');
      seen.add(pair.key);return {key:pair.key,value:structuredClone(pair.value)};
    });
    return {...structuredClone(node),properties};
  })};
};
