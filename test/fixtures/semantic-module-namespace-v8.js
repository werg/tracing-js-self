export const namespaceModules={
  'main.js':"import * as view from './view.js';import {update} from './state.js';export function run(key){const before=view[key];const keys=Object.keys(view);update(9);const after=Object.getOwnPropertyDescriptor(view,'value').value;return {before,after,keys};}",
  'state.js':"export let value=1;export const fixed=2;export function update(next){value=next;}",
  'view.js':"export {value,fixed} from './state.js';"
};
export const namespaceEntry='main.js';
export const namespaceExport='run';
export const namespaceArgs=['value'];
export const namespaceMaxGenerated=20000;
