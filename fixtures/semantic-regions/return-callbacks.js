// Source-first return callback cases. The external fixture derives its result
// from the executed callback; no scripted answer can repair a guest mismatch.
const shared={value:4};shared.self=shared;
const callback={callback:true};
export const RETURN_CALLBACK_FIXTURES=[
  {
    family:'return-callback-receiver-alias-source',entry:'run',args:[],
    source:'"use strict";function run(){let count=0;return host.natlangCall("aliases",null,{visit:function(a,b){'+
      'count=count+1;if(this!==a||a!==b||a.self!==a)throw 99;a.value=a.value+count;return a.value;}});}',
    fixture:{calls:[{operation:'natlang.call',arguments:['aliases',null,{visit:callback}],
      callbacks:[{path:[2,'visit'],receiver:shared,arguments:[shared,shared]},
        {path:[2,'visit'],receiver:shared,arguments:[shared,shared]}],resultFromCallback:1}]},
    expected:{kind:'return',value:['num',6]},callbacks:2
  },
  {
    family:'return-callback-throw-source',entry:'run',args:[],
    source:'"use strict";function run(){return host.natlangCall("throw",null,function(value){throw value+3;});}',
    fixture:{calls:[{operation:'natlang.call',arguments:['throw',null,callback],
      callbacks:[{path:[2],arguments:[4]}],resultFromCallback:0}]},
    expected:{kind:'throw',value:['num',7]},callbacks:1
  },
  {
    family:'return-callback-async-source',entry:'run',args:[],
    source:'"use strict";function run(){return host.natlangCall("async",null,async function(value){'+
      'const next=await Promise.resolve(value+2);return next+1;});}',
    fixture:{calls:[{operation:'natlang.call',arguments:['async',null,callback],
      callbacks:[{path:[2],arguments:[4]}],resultFromCallback:0}]},
    expected:{kind:'return',value:['num',7]},callbacks:1
  },
  {
    family:'return-callback-reentrant-host-source',entry:'run',args:[],
    source:'"use strict";function run(){return host.natlangCall("outer",null,async function(value){'+
      'return value+await host.natlangCall("inner",null,function(next){return next*2;});});}',
    fixture:{calls:[{operation:'natlang.call',arguments:['outer',null,callback],
      callbacks:[{path:[2],arguments:[3]}],resultFromCallback:0},
    {operation:'natlang.call',arguments:['inner',null,callback],
      callbacks:[{path:[2],arguments:[5]}],resultFromCallback:0}]},
    expected:{kind:'return',value:['num',13]},callbacks:2
  }
];
