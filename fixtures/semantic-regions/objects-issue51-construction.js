// Original-source fixtures for constructor-captured lexical arrows in issue 51.
const withIssue51Lineage=rows=>Object.freeze(rows.map(row=>Object.freeze({...row,
  ancestorIds:Object.freeze(['issue51-original-objects'])})));

export const issue51ConstructionFixtures=withIssue51Lineage([
  Object.freeze({id:'issue51-constructor-arrow-after-super-and-return',
    family:'issue51-constructor-lexical-arrow',
    source:'"use strict";function run(){class A{}class D extends A{#x=5;constructor(){const capture=()=>[this,new.target,this.#x];super();this.capture=capture;}}const d=new D();const result=d.capture();return [result[0]===d,result[1]===D,result[2]===5];}',
    entry:'run',args:[]}),
  Object.freeze({id:'issue51-constructor-arrow-return-substitution',
    family:'issue51-constructor-lexical-arrow',
    source:'"use strict";function run(){class A{}class D extends A{#x=8;constructor(){const capture=()=>[this,new.target,this.#x];super();return {capture};}}const result=new D();const captured=result.capture();return [captured[0]!==result,captured[1]===D,captured[2]===8];}',
    entry:'run',args:[]}),
  Object.freeze({id:'issue51-constructor-arrow-conversion-callback',
    family:'issue51-constructor-lexical-arrow',
    source:'"use strict";function run(){let observed;class A{}class D extends A{#x=9;constructor(){const capture=()=>{observed=[this,new.target,this.#x];return 7;};super();return {valueOf:capture};}}const result=new D();const number=Number(result);return [number,observed[0]!==result,observed[1]===D,observed[2]===9];}',
    entry:'run',args:[]})
]);

export const issue51ConstructionFaultFixtures=withIssue51Lineage([
  Object.freeze({id:'issue51-derived-this-before-super-reference-error',
    family:'issue51-derived-this-fault',
    source:'"use strict";function run(){class A{}class D extends A{constructor(){return this;}}return new D();}',
    entry:'run',args:[]}),
  Object.freeze({id:'issue51-derived-this-captured-arrow-before-super-reference-error',
    family:'issue51-derived-this-fault',
    source:'"use strict";function run(){class A{}class D extends A{constructor(){const read=()=>this;read();super();}}return new D();}',
    entry:'run',args:[]})
]);

export const issue51ConstructionUnsupportedControls=withIssue51Lineage([
  Object.freeze({id:'issue51-control-constructor-arrow-in-promise-reaction',
    family:'issue51-unsupported-control',
    source:'"use strict";function run(){const report={};function C(){this.x=3;const capture=()=>{report.result=[this.x,new.target===C];};Promise.resolve(1).then(capture);}new C();return report;}',
    entry:'run',args:[]})
]);
