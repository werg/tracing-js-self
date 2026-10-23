/** Replay-backed data-only ESM session. Every accepted call is reproduced
 * from the immutable module sources and complete prior primitive call history,
 * so no native effects can be duplicated and exact interpreter replay remains
 * available. This is not a suspended VM, native module loader or complete realm. */
export interface BoundedRetainedModuleSessionOptions {
  modules:Record<string,string>;
  entryModule:string;
  maxSteps?:number;
}
export interface BoundedRetainedModuleCallResult {
  result:unknown;
  bundle:Record<string,unknown>;
  metadata:Record<string,unknown>;
}
export declare class BoundedRetainedModuleSession {
  constructor(options:BoundedRetainedModuleSessionOptions);
  readonly entryModule:string;
  readonly history:Array<{exportName:string;args:unknown[]}>;
  readonly lastArchive:Record<string,unknown>|null;
  readonly closed:boolean;
  invoke(exportName:string,args?:Array<string|number|boolean|bigint|null|undefined>):
    Promise<BoundedRetainedModuleCallResult>;
  close():void;
}
export declare function createBoundedRetainedModuleSession(
  options:BoundedRetainedModuleSessionOptions
):BoundedRetainedModuleSession;
