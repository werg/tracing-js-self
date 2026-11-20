export const HOST_PROTOCOL_FIXTURES_V8=[
  {id:'join-host-join',family:'protocol-host-root-join',entry:'run',args:[],
    source:'"use strict";async function run(){const a=await Promise.all([Promise.resolve(2),Promise.resolve(3)]);const n=await host.readAsync("counter");const b=await Promise.all([Promise.resolve(a[0]+n),Promise.resolve(a[1])]);return b[0]+b[1];}',
    fixture:{calls:[{operation:'demo.readAsync',arguments:['counter'],result:7}]}},
  {id:'join-retained-callback',family:'protocol-host-retained-callback',entry:'run',args:[],
    source:'"use strict";async function run(){let seen=0;await Promise.all([Promise.resolve(1)]);await host.withCallback("value",function(n){seen+=n;host.store("callback",seen);});const a=await Promise.all([Promise.resolve(seen)]);return a[0];}',
    fixture:{calls:[{operation:'demo.withCallback',arguments:['value',{callback:true}],callbacks:[{slot:1,arguments:[3]},{slot:1,arguments:[4]}]},
      {operation:'demo.store',arguments:['callback',3]},{operation:'demo.store',arguments:['callback',7]}]}},
  {id:'callback-owned-join',family:'protocol-host-callback-join',entry:'run',args:[],
    source:'"use strict";async function run(){let seen=0;await Promise.all([Promise.resolve(1)]);await host.withCallback("value",function(n){return Promise.all([Promise.resolve(n).then(x=>x+1),Promise.resolve(2)]).then(function(a){seen+=a[0]+a[1];host.store("callback",seen);return seen;});});const b=await Promise.all([Promise.resolve(seen)]);return b[0];}',
    fixture:{calls:[{operation:'demo.withCallback',arguments:['value',{callback:true}],callbacks:[{slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['callback',6]}]}},
  {id:'callback-owned-join-awaited',family:'protocol-host-callback-join-awaited',entry:'run',args:[],
    source:'"use strict";async function run(){let seen=0;let complete;await Promise.all([Promise.resolve(1)]);await host.withCallback("value",function(n){complete=Promise.all([Promise.resolve(n).then(x=>x+1),Promise.resolve(2)]).then(function(a){seen+=a[0]+a[1];host.store("callback",seen);return seen;});});await complete;const b=await Promise.all([Promise.resolve(seen)]);return b[0];}',
    fixture:{calls:[{operation:'demo.withCallback',arguments:['value',{callback:true}],callbacks:[{slot:1,arguments:[3]}]},
      {operation:'demo.store',arguments:['callback',6]}]}}
];
