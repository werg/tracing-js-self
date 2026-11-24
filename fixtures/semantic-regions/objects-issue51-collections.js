// Original issue #51 collection, iteration, spread and nested-binding witnesses.
// All rows retain the common original-object lineage when joined by the cohort owner.
const withIssue51Lineage=rows=>Object.freeze(rows.map(row=>Object.freeze({...row,
  ancestorIds:Object.freeze(['issue51-original-objects'])})));

export const issue51CollectionFixtures=withIssue51Lineage([
  Object.freeze({id:'issue51-set-live-iterator-delete-readd',family:'issue51-collection-iteration',
    source:'"use strict";function run(x){const values=new Set([x,x+1]);const iterator=values.values();const first=iterator.next().value;const deleted=values.delete(x+1);values.add(x+2);const second=iterator.next().value;const done=iterator.next().done;values.add(x+3);const stillDone=iterator.next().done;return [first,deleted,second,done,stillDone,values.size];}',
    entry:'run',args:[4]}),
  Object.freeze({id:'issue51-map-live-entries-overwrite-delete-append',family:'issue51-collection-iteration',
    source:'"use strict";function run(x){const values=new Map([[x,"old"],[x+1,"removed"]]);const iterator=values.entries();values.set(x,"updated");const deleted=values.delete(x+1);values.set(x+2,"new");const first=iterator.next().value;const second=iterator.next().value;return [deleted,first,second,values.size];}',
    entry:'run',args:[4]}),
  Object.freeze({id:'issue51-map-same-value-zero-size-clear',family:'issue51-collection-mutation',
    source:'"use strict";function run(x){const values=new Map([[-0,"first"],[0,"updated"],[NaN,"nan"]]);const initial=values.size;const zero=values.get(+0);const nan=values.get(NaN);const present=values.has(NaN);const deleted=values.delete(-0);values.clear();return [initial,zero,nan,present,deleted,values.size];}',
    entry:'run',args:[4]}),
  Object.freeze({id:'issue51-array-spread-snapshot-and-mutation',family:'issue51-array-spread',
    source:'"use strict";function run(x){const values=[x,x+1];return [0,...values,values.push(x+2),...values];}',
    entry:'run',args:[4]}),
  Object.freeze({id:'issue51-string-spread-code-points-and-holes',family:'issue51-array-spread',
    source:'"use strict";function run(){return [..."A𝄞é\\ud800",0,...[],,3];}',
    entry:'run',args:[]}),
  Object.freeze({id:'issue51-nested-array-default-and-rest-order',family:'issue51-array-destructuring',
    source:'"use strict";function run(x){const [[first=x+1,...tail],[last=7]]=[[undefined,x+2,x+3],[]];return [first,tail,last];}',
    entry:'run',args:[4]}),
  Object.freeze({id:'issue51-nested-array-default-abrupt-closes-outer-iterator',family:'issue51-iterator-cleanup',
    source:'"use strict";function run(){let log="";const source={index:0,[Symbol.iterator](){return this;},next(){return this.index++===0?{done:false,value:[undefined]}:{done:true};},return(){log+="c";return {};}};function fail(){throw 7;}try{const [[value=fail()]]=source;return value;}catch(error){log+=error;}return log;}',
    entry:'run',args:[]})
]);
