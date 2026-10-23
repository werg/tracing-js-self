import type {BoundedRetainedModuleSession} from './evaluated-module-session.js';
/** Host-usable synchronous functions; all invocations use owned bytecode and exact replay. */
export interface BoundedModuleFacade {
  readonly exports:Readonly<Record<string,(...args:unknown[])=>unknown>>;
  readonly session:BoundedRetainedModuleSession;
  close():void;
}
export function createBoundedModuleFacade(options:{
  modules:Record<string,string>;
  entryModule:string;
  exportNames:string[];
  maxSteps?:number;
}):BoundedModuleFacade;
