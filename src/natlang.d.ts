/** Replay-checked natlang subset with data-only live values and retained module bindings; no general native helper execution. */
export interface NatlangEvalRequest {
  code: string;
  scope: Record<string,unknown>;
  body: boolean;
  path: string;
  timeoutMs?: number;
  live?: Record<string,unknown>;
}
export type NatlangHostEvent={operation:string;[key:string]:unknown};
export interface NatlangEvalResult {
  result: unknown;
  events: NatlangHostEvent[];
  logs?: string[];
}
export interface NatlangEvalFailureConstructor {
  new(message:string,events:NatlangHostEvent[],
    debug?:{sourceStack?:string;logs?:string[]}): Error;
}
export interface BoundedNatlangOptions {
  /** Pass natlang's actual EvalFailure constructor for instanceof compatibility. */
  EvalFailure: NatlangEvalFailureConstructor;
  /** Receives the validated/replay-checked generated-JS archive and source-map metadata. */
  onTrace?: ((bundle:Record<string,unknown>,request:NatlangEvalRequest,
    lowering:{compiler:string;originalText:string;javascript:string;
      sourceMap:Record<string,unknown>})=>void)|null;
  maxSteps?: number;
  /** Explicit versioned native operation adapters for replayable async guest calls.
   * No arbitrary host functions or imported packages are allowed. */
  services?:Record<string,(context:import('./host/native-driver.js').NativeHostContext)=>
    string|number|bigint|boolean|null|undefined|
    Promise<string|number|bigint|boolean|null|undefined>>|null;
  mode?: 'fresh'|'retained';
}
export declare class BoundedNatlangEnvironment {
  constructor(options:BoundedNatlangOptions);
  readonly authority: string;
  readonly mode:'fresh'|'retained';
  readonly scopeCapabilities:{readonly allowModules:false;readonly allowNetwork:false};
  execute(request:NatlangEvalRequest):NatlangEvalResult;
  /** Starts an owned async entry; explicit native services are journaled before delivery. */
  executeAsync(request:NatlangEvalRequest):Promise<NatlangEvalResult>;
  /** Retained only: data-only CommonJS exports (require/native helpers fail closed). */
  evaluateModule(code:string,bindings:Record<string,unknown>):unknown;
  declarationOf(name:string):string|undefined;
  fork():BoundedNatlangEnvironment;
  close():void;
}
export declare function createBoundedNatlangEnvironment(
  options:BoundedNatlangOptions
):BoundedNatlangEnvironment;
