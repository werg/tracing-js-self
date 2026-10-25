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
}
export declare function createNatlangSelectedEnvironment(
  options:SelectedNatlangOptions):SelectedNatlangEnvironment;
