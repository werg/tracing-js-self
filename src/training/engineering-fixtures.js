// Source families are fixed before input, outcome and schedule expansion.
// These are deterministic engineering fixtures, never learned-success claims.
const counter='"use strict";async function run(key){const current=await host.readAsync(key);const next=current+1;host.store(key,next);return next;}';
const compoundPure='"use strict";function run(a,b,c,d){return (a+b)*(c+d)+1;}';
const compoundEffectful='"use strict";async function run(key){const value=await host.readAsync(key);const next=(value+2)*(value-1)+3;host.store(key,next);return next;}';
export const EFFECTFUL_ENGINEERING_FIXTURES=Object.freeze([
  ...[7,21].map((value,index)=>({id:'counter-'+index,family:'async-counter',source:counter,
    entry:'run',args:['counter'],fixture:{calls:[
      {operation:'demo.readAsync',arguments:['counter'],result:value},
      {operation:'demo.store',arguments:['counter',value+1]}
    ]}})),
  {id:'checkpoint-source-reread',family:'async-counter',fixtureFamily:'checkpoint-recovery',
    source:counter,entry:'run',args:['counter'],projectionOptions:{checkpointAtFirstAwait:true},
    fixture:{calls:[{operation:'demo.readAsync',arguments:['counter'],result:7},
      {operation:'demo.store',arguments:['counter',8]}]}},
  {id:'two-pending-reversed',family:'two-outstanding',
    source:'"use strict";async function run(){const a=host.readAsync("a");const b=host.readAsync("b");return (await a)+(await b);}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['a'],result:2},
      {operation:'demo.readAsync',arguments:['b'],result:5}],settlementOrder:[1,0]}},
  ...[2,8].map((value,index)=>({id:'branch-'+index,family:'observed-branch',
    source:'"use strict";async function run(){const n=await host.readAsync("value");if(n>3){host.store("chosen",n);return n;}host.store("chosen",0);return 0;}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['value'],result:value},
      {operation:'demo.store',arguments:['chosen',value>3?value:0]}]}})),
  {id:'rejection-finally',family:'async-cleanup',
    source:'"use strict";async function run(){try{return await host.readAsync("bad");}catch(error){host.store("error",error);return 11;}finally{host.store("cleanup",1);}}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['bad'],status:'rejected',result:'missing'},
      {operation:'demo.store',arguments:['error','missing']},{operation:'demo.store',arguments:['cleanup',1]}]}},
  {id:'uncaught-rejection-finally',family:'async-cleanup',
    source:'"use strict";async function run(){try{return await host.readAsync("bad");}finally{host.store("cleanup",1);}}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['bad'],status:'rejected',result:'missing'},
      {operation:'demo.store',arguments:['cleanup',1]}]}},
  {id:'callback-captured-write',family:'owned-callback',
    source:'"use strict";async function run(){let seen=0;await host.withCallback("value",function(n){seen=seen+n;host.store("callback",seen);});host.store("result",seen);return seen;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'demo.withCallback',arguments:['value',{callback:true}],callbacks:[
        {slot:1,arguments:[3]},{slot:1,arguments:[4]}]},
      {operation:'demo.store',arguments:['callback',3]},
      {operation:'demo.store',arguments:['callback',7]},
      {operation:'demo.store',arguments:['result',7]}]}},
  {id:'long-callback-retained-tail',family:'long-callback-retained-tail',
    source:'"use strict";async function run(){let seen=0;await host.withCallback("tick",function(n){seen+=n;for(let i=0;i<40;i++){const ignored=i+1;}host.store("callback",seen);});return seen;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'demo.withCallback',arguments:['tick',{callback:true}],callbacks:[{slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['callback',3]}]}},
  {id:'sync-rejection',family:'synchronous-error',
    source:'"use strict";function run(){try{return host.readNumber("bad");}catch(error){host.store("error",error);return 4;}}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readNumber',arguments:['bad'],status:'rejected',result:'missing'},
      {operation:'demo.store',arguments:['error','missing']}]}},
  {id:'promise-reaction',family:'promise-reaction',
    source:'"use strict";async function run(){const p=host.readAsync("x");const q=p.then(function(n){host.store("reaction",n);return n+1;});return await q;}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['x'],result:3},
      {operation:'demo.store',arguments:['reaction',3]}]}},
  {id:'promise-rejection-finally',family:'promise-cleanup',
    source:'"use strict";async function run(){return await host.readAsync("x").then(function(v){return v;},function(error){host.store("handled",error);return 9;}).finally(function(){host.store("cleanup",1);});}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.readAsync',arguments:['x'],status:'rejected',result:'missing'},
      {operation:'demo.store',arguments:['handled','missing']},{operation:'demo.store',arguments:['cleanup',1]}]}},
  {id:'owned-microtask',family:'owned-microtask',
    source:'"use strict";function run(){queueMicrotask(function(){host.store("microtask",1);});return 3;}',
    entry:'run',args:[],fixture:{calls:[{operation:'demo.store',arguments:['microtask',1]}]}},
  {id:'clock-console',family:'platform-observation',
    source:'"use strict";function run(){const now=Date.now();console.log(now);return now;}',
    entry:'run',args:[],fixture:{calls:[{operation:'platform.dateNow',arguments:[],result:1700000000000},
      {operation:'platform.console.log',arguments:[1700000000000]}]}},
  {id:'http-response-stream',family:'http-response-stream',
    source:'"use strict";async function run(){const response=await host.httpRequest("https://fixture.invalid/data","GET","{}","");const status=await host.httpStatus(response);const chunk=await host.httpReadChunk(response);await host.httpClose(response);return chunk;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'http.request',arguments:['https://fixture.invalid/data','GET','{}',''],result:'http:fixture:1'},
      {operation:'http.responseStatus',arguments:['http:fixture:1'],result:200},
      {operation:'http.responseReadChunk',arguments:['http:fixture:1'],result:'b2s='},
      {operation:'http.responseClose',arguments:['http:fixture:1']}]}},
  {id:'filesystem-stream-copy',family:'filesystem-stream-copy',
    source:'"use strict";async function run(){const reader=await host.openRead("input.txt");const chunk=await host.readChunk(reader);const writer=await host.openWrite("output.txt");await host.writeChunk(writer,chunk);await host.closeWrite(writer);await host.closeStream(reader);return chunk;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'fs.openRead',arguments:['input.txt'],result:'stream:read:1'},
      {operation:'fs.readChunk',arguments:['stream:read:1'],result:'b2s='},
      {operation:'fs.openWrite',arguments:['output.txt'],result:'stream:write:1'},
      {operation:'fs.writeChunk',arguments:['stream:write:1','b2s='],result:2},
      {operation:'fs.closeWrite',arguments:['stream:write:1']},
      {operation:'fs.close',arguments:['stream:read:1']}]}},
  {id:'socket-round-trip',family:'socket-round-trip',
    source:'"use strict";async function run(){const socket=await host.socketConnect("fixture.invalid",9000);await host.socketWrite(socket,"b2s=");const reply=await host.socketRead(socket);await host.socketClose(socket);return reply;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'net.connect',arguments:['fixture.invalid',9000],result:'socket:fixture:1'},
      {operation:'net.write',arguments:['socket:fixture:1','b2s='],result:2},
      {operation:'net.read',arguments:['socket:fixture:1'],result:'b2s='},
      {operation:'net.close',arguments:['socket:fixture:1']}]}},
  {id:'dom-mutation-release',family:'dom-mutation-release',
    source:'"use strict";async function run(){const node=await host.domQuery("#message");await host.domSetText(node,"updated");const value=await host.domGetText(node);await host.domRelease(node);return value;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'dom.query',arguments:['#message'],result:'dom:fixture:1'},
      {operation:'dom.setText',arguments:['dom:fixture:1','updated']},
      {operation:'dom.getText',arguments:['dom:fixture:1'],result:'updated'},
      {operation:'dom.release',arguments:['dom:fixture:1']}]}},
  {id:'natlang-cell-call',family:'natlang-cell-call',
    source:'"use strict";async function run(){const n=host.natlangReadCell("cell:fixture");host.natlangWriteCell("cell:fixture",n+1);return await host.natlangCall("call:fixture",null,[n+1]);}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'natlang.readCell',arguments:['cell:fixture'],result:4},
      {operation:'natlang.writeCell',arguments:['cell:fixture',5]},
      {operation:'natlang.call',arguments:['call:fixture',null,[5]],result:10}]}},
  {id:'native-result-graph',family:'native-result-graph',
    source:'"use strict";async function run(){const value=await host.natlangCall("graph:fixture",null,[]);value.left.n=value.left.n+1;host.natlangWriteCell("graph:output",value);host.store("alias",value.left===value.right);return value;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'natlang.call',arguments:['graph:fixture',null,[]],resultGraph:{
        schema:'owned-graph/1',roots:[['ref','o0']],objects:[
          {id:'o0',kind:'object',properties:[{key:'left',value:['ref','o1']},
            {key:'right',value:['ref','o1']},{key:'self',value:['ref','o0']}]},
          {id:'o1',kind:'object',properties:[{key:'n',value:['num',3]}]}
        ]}},
      {operation:'natlang.writeCell',argumentGraph:{schema:'owned-graph/1',
        roots:[['str','graph:output'],['ref','o0']],objects:[
          {id:'o0',kind:'object',properties:[{key:'left',value:['ref','o1']},
            {key:'right',value:['ref','o1']},{key:'self',value:['ref','o0']}]},
          {id:'o1',kind:'object',properties:[{key:'n',value:['num',4]}]}
        ]}},
      {operation:'demo.store',arguments:['alias',true]}]}},
  ...[
    {id:'compound-pure',family:'compound-pure',source:compoundPure,
      entry:'run',args:[1,2,3,4],fixture:{calls:[]},},
    {id:'compound-effectful',family:'compound-effectful',source:compoundEffectful,
      entry:'run',args:['compound'],,fixture:{calls:[
        {operation:'demo.readAsync',arguments:['compound'],result:5},
        {operation:'demo.store',arguments:['compound',31]}
      ]}}
  ],
  {id:'persistent-external-trigger',family:'persistent-external-trigger',
    source:'"use strict";async function run(){let seen=0;const token=await host.listen("tick",n=>{seen+=n;host.store("event",seen);});await host.readAsync("events-complete");await host.unlisten(token);return seen;}',
    entry:'run',args:[],fixture:{calls:[
      {operation:'demo.listen',arguments:['tick',{callback:true}],result:'callback1'},
      {operation:'demo.readAsync',arguments:['events-complete'],callbacks:[
        {call:0,slot:1,arguments:[2]},{call:0,slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['event',2]},
      {operation:'demo.store',arguments:['event',5]},
      {operation:'demo.unlisten',arguments:['callback1']}
    ]}},
]);
