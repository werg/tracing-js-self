/** Replay-backed data-only ESM session. Every accepted call is reproduced
 * from the immutable module sources and complete prior primitive call history,
 * so no native effects can be duplicated and exact interpreter replay remains
 * available. This is not a suspended VM, native module loader or complete realm. */
export interface BoundedRetainedModuleSessionOptions {
  modules:Record<string,string>;
  entryModule:string;
  maxSteps?:number;
  /** Invoked on a validated archive before committing an invocation. */
  onTrace?:(bundle:Record<string,unknown>,
    call:{exportName:string;args:unknown[];callCount:number},
    metadata:Record<string,unknown>)=>void;
}
export interface BoundedRetainedModuleCallResult {
  result:unknown;
  bundle:Record<string,unknown>;
  metadata:Record<string,unknown>;
}
export interface BoundedRetainedModuleSnapshot {
  schema:'bounded-retained-module-session/1';
  modules:Record<string,string>;
  entryModule:string;
  maxSteps:number;
  calls:Array<{exportName:string;args:Array<Array<string|number|boolean>>}>;
}
export declare class BoundedRetainedModuleSession {
  constructor(options:BoundedRetainedModuleSessionOptions);
  readonly entryModule:string;
  readonly history:Array<{exportName:string;args:unknown[]}>;
  readonly lastArchive:Record<string,unknown>|null;
  readonly closed:boolean;
  invoke(exportName:string,args?:Array<string|number|boolean|bigint|null|undefined>):
    Promise<BoundedRetainedModuleCallResult>;
  /** Synchronous host invocation of a replay-backed, effect-free owned realm. */
  invokeSync(exportName:string,args?:Array<string|number|boolean|bigint|null|undefined>):
    BoundedRetainedModuleCallResult;
  /** JSON-portable committed-call history; not a suspended guest continuation. */
  snapshot():BoundedRetainedModuleSnapshot;
  close():void;
}
export declare function createBoundedRetainedModuleSession(
  options:BoundedRetainedModuleSessionOptions
):BoundedRetainedModuleSession;

/** Rebuild a bounded observational session by replaying its JSON history. */
export declare function restoreBoundedRetainedModuleSession(
  snapshot:BoundedRetainedModuleSnapshot
):Promise<BoundedRetainedModuleSession>;
