// Authored source-task families are fixed before any split is inspected. Every
// family remains in the recipe, including held-out ones; expression formatting,
// input variants, callback schedules, recovery and child wrappers inherit its
// identity. Sharing collection scaffolding does not manufacture new ancestry.
export const SEMANTIC_RECIPE_VERSION='semantic-source-recipe/4';
export const SEMANTIC_RECIPE_NAME='training-v4';

export const SEMANTIC_TASK_TEMPLATES=Object.freeze([
  {name:'rectangle-perimeter',expression:'(a+b)*2',answers:[22,14]},
  {name:'rectangular-capacity',expression:'a*b',answers:[24,10]},
  {name:'squared-distance',expression:'a*a+b*b',answers:[73,29]},
  {name:'absolute-distance',expression:'a>b?a-b:b-a',answers:[5,3]},
  {name:'weighted-average',expression:'(a*2+b*3)/5',answers:[5,3.2]},
  {name:'unit-conversion',expression:'a*1000/b',answers:[8000/3,2500]},
  {name:'triangular-series',expression:'a*(a+1)/2+b',answers:[39,17]},
  {name:'modular-clock',expression:'(a*60+b)%24',answers:[3,14]},
  {name:'flag-intersection',expression:'a&b',answers:[0,0]},
  {name:'flag-union',expression:'a|b',answers:[11,7]},
  {name:'inventory-shortfall',expression:'a>b?a-b:0',answers:[5,3]},
  {name:'capped-budget',expression:'a+b>10?10:a+b',answers:[10,7]},
  {name:'overtime-rate',expression:'a>6?6*b+(a-6)*b*2:a*b',answers:[30,10]},
  {name:'midpoint',expression:'(a+b)/2',answers:[5.5,3.5]},
  {name:'relative-growth',expression:'(a-b)/b',answers:[5/3,1.5]},
  {name:'parity-adjustment',expression:'a%2===0?a+b:a-b',answers:[11,3]}
].map(template=>Object.freeze({...template,answers:Object.freeze(template.answers)})));

const inputs=Object.freeze([[8,3],[5,2]].map(Object.freeze));
export function semanticRecipeFamilies({representation='explicit'}={}){
  if(!['explicit','compact'].includes(representation))throw new TypeError('Unknown recipe representation');
  return SEMANTIC_TASK_TEMPLATES.map(template=>{
    const family='semantic-recipe:'+template.name;
    const common={family,ancestorIds:['source-template:'+template.name],entry:'run',
      projectionOptions:{representation}};
    const source='"use strict";async function run(key,b){const a=await host.readAsync(key);'+
      'const answer='+template.expression+';host.store(key,answer);return answer;}';
    const calls=inputs.map(([a,b],index)=>({...common,id:template.name+'-call-'+index,
      source,args:[template.name,b],fixture:{calls:[
        {operation:'demo.readAsync',arguments:[template.name],result:a},
        {operation:'demo.store',arguments:[template.name,template.answers[index]]}
      ]}}));
    return {family,template:template.name,
      pure:{...common,id:template.name+'-pure',args:inputs[0],
        source:'"use strict";function run(a,b){return '+template.expression+';}',fixture:{calls:[]}},
      callbacks:{...common,id:template.name+'-callbacks-recovery',args:[template.name,inputs[0][1]],
        source:'"use strict";async function run(key,b){const a=await host.readAsync(key);'+
          'let answer='+template.expression+';await host.withCallback(key,function(delta){'+
          'answer=answer+delta;host.store(key,answer);});return answer;}',
        projectionOptions:{representation,checkpointAtFirstAwait:true},fixture:{calls:[
          {operation:'demo.readAsync',arguments:[template.name],result:inputs[0][0]},
          {operation:'demo.withCallback',arguments:[template.name,{callback:true}],callbacks:[
            {slot:1,arguments:[2]},{slot:1,arguments:[3]}]},
          {operation:'demo.store',arguments:[template.name,template.answers[0]+2]},
          {operation:'demo.store',arguments:[template.name,template.answers[0]+5]}
        ]}},
      repeated:{id:template.name+'-repeated',family,cases:calls}
    };
  });
}
