/** The natlang-shaped, fail-closed subset; not a general EvalEnvironment replacement. */
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
  mode?: 'fresh';
}
export declare class BoundedNatlangEnvironment {
  constructor(options:BoundedNatlangOptions);
  readonly authority: string;
  readonly mode:'fresh';
  readonly scopeCapabilities:{readonly allowModules:false;readonly allowNetwork:false};
  execute(request:NatlangEvalRequest):NatlangEvalResult;
  executeAsync(request:NatlangEvalRequest):Promise<NatlangEvalResult>;
  evaluateModule(code:string,bindings:Record<string,unknown>):unknown;
  declarationOf(name:string):string|undefined;
  fork():BoundedNatlangEnvironment;
  close():void;
}
export declare function createBoundedNatlangEnvironment(
  options:BoundedNatlangOptions
):BoundedNatlangEnvironment;
