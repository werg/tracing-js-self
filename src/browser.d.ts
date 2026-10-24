/** Browser-safe bounded execution; host object imports/native services unavailable. */
export interface BrowserSource {
  text:string;
  url?:string;
  goal?:'script';
  trainingProfile?:boolean;
}
export interface BrowserRuntime {
  registerSource(source:BrowserSource):unknown;
  start(source:string|unknown):this;
  startEntry(entry:{source:unknown;functionName:string;args?:unknown[];allowAsync?:boolean}):this;
  drive():{kind:string;[key:string]:unknown};
  exportRun():Record<string,unknown>;
  readonly state:Record<string,unknown>;
}
export function createRuntime(options?:{maxSteps?:number;randomSeed?:number|null}):BrowserRuntime;
export function encode(value:undefined|null|string|boolean|number|bigint):unknown[];
export function decode(value:unknown[]):unknown;
export function causalPrefix(bundle:Record<string,unknown>,
  options?:{throughEventId?:string|null}):unknown;
