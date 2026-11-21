// These maps are host invocation metadata. The first case redundantly names
// the positional source parameters; the others add names absent from source.
// They therefore preserve the independently executed original function.
export const BINDING_ORDER_FIXTURES_V8=Object.freeze([
  {id:'declared-parameter-order',source:'"use strict";function run(z,a){return z-a;}',
    entry:'run',args:[9,4],bindings:{a:1,z:0},declaredParameters:['z','a'],
    expectedAliases:[['z','a0b0'],['a','a0b1']],expectedValues:[['num',9],['num',4]]},
  {id:'additional-binding-order',source:'"use strict";function run(){return 7;}',
    entry:'run',args:[9,4],bindings:{z:0,a:1},declaredParameters:[],
    expectedAliases:[['a','a0b0'],['z','a0b1']],expectedValues:[['num',4],['num',9]]},
  {id:'additional-utf16-order',source:'"use strict";function run(){return 7;}',
    entry:'run',args:[9,4],bindings:{'\uFF21':1,'\u{10000}':0},declaredParameters:[],
    expectedAliases:[['\u{10000}','a0b0'],['\uFF21','a0b1']],expectedValues:[['num',9],['num',4]]}
]);
