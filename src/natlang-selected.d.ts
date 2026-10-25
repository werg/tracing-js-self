/**
 * Explicit selected semantic entry/module evaluator for Natlang.
 * A supplied actual Megatoken selected-group adapter produces semantic work;
 * this code never executes guest source with the native JavaScript engine.
 */
export interface SelectedNatlangRequest {
  code: string;
  scope: Record<string, unknown>;
  body: boolean;
  path: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  live?: Record<string, unknown>;
}
export type SelectedNatlangEvent = {operation:string;[key:string]:unknown};
export interface SelectedNatlangEnvironment {
  readonly authority: 'selected-semantic/4';
  readonly mode: 'fresh'|'retained';
  readonly scopeCapabilities: {allowModules:true;allowNetwork:false};
  execute(request: SelectedNatlangRequest): never;
  executeAsync(request: SelectedNatlangRequest): Promise<{
    result: unknown;events:SelectedNatlangEvent[];logs: string[];
  }>;
  evaluateModule(code:string,bindings:Record<string,unknown>):never;
  evaluateModuleAsync(code:string,bindings:Record<string,unknown>):Promise<unknown>;
  configureNativeBindings(configuration:{adaptValue(value:unknown):unknown;resourceIdentity?(value:unknown):object|null;
    resourceCleanup?(value:object):(()=>void)|null}):void;
  fork(): SelectedNatlangEnvironment;
  close():void;
  selectedHarness():unknown;
  selectedDriver():unknown;
}
export interface SelectedNatlangOptions {
  mode?:'fresh'|'retained';
  select:(prefix:Record<string,unknown>)=>Promise<string|object>|string|object;
  services?:Record<string,(args:unknown[],context:unknown)=>unknown>;
  transpile?:(source:string,options:{path:string;body:boolean})=>string;
  capabilities?:string[];
  maxSelections?:number;
  sessionId?:string;
  onClose?:()=>void;
  EvalFailure?:new(message:string,events:SelectedNatlangEvent[],debug?:{
    sourceStack?:string;logs?:string[]})=>Error;
  /** Exact published binding paths, for example `__live["read"]`. */
  callKinds?:Record<string,'promise'|'synchronous'>;
  /** Explicit package/service namespace grants. No ambient package loader. */
  modules?:Record<string,unknown>;
  /** Constructor-registered native resource surfaces; arbitrary proxies are not probed. */
  adaptValue?:(value:unknown)=>unknown;
  resourceIdentity?:(value:unknown)=>object|null;
  resourceCleanup?:(value:object)=>(()=>void)|null;
}
export declare function selectedCallable(invoke:(...args:unknown[])=>unknown,
  options?:{kind?:'promise'|'synchronous';name?:string}):object;
export declare function selectedCell(get:()=>unknown,set?:((value:unknown)=>void)|null,
  options?:{name?:string}):object;
export declare function createNatlangSelectedEnvironment(
  options:SelectedNatlangOptions):SelectedNatlangEnvironment;
