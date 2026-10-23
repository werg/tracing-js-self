/** Opt-in native Node I/O transport; guest execution remains owned and bounded. */
export interface NativeHostContext {
  readonly effectId:string;
  readonly operation:string;
  readonly args:readonly unknown[];
  readonly request:Readonly<{schema:string;operation:string;signature:string;
    codec:string;payload:string;byteLength:number}>;
  readonly signal?:AbortSignal;
}
export type NativeHostService=(context:NativeHostContext)=>
  string|number|bigint|boolean|null|undefined|
  Promise<string|number|bigint|boolean|null|undefined>;
export declare function executeWithNativeServices(options:{
  /** Legacy bounded script, mutually exclusive with entry. */
  text?:string;
  /** Acorn strict profile function entry with a recorded, owned host binding. */
  entry?:{text:string;url?:string;functionName:string;args?:unknown[]};
  services?:Record<string,NativeHostService>;
  maxSteps?:number;
  signal?:AbortSignal;
}):Promise<{
  progress:{kind:string;[key:string]:unknown};
  bundle:Record<string,unknown>;
  runtime:import('../runtime.js').Runtime;
}>;
