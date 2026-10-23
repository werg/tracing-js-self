/** Node/POSIX content-addressed committed-history checkpoints, not VM snapshots. */
import type {BoundedRetainedModuleSession} from './evaluated-module-session.js';
export declare class DurableRetainedModuleStorageError extends Error {}
export declare class DurableRetainedModuleStore {
  constructor(options:{directory:string;maxBytes?:number});
  readonly directory:string;
  readonly maxBytes:number;
  objectPath(id:string):string;
  put(session:BoundedRetainedModuleSession):Promise<Readonly<{
    id:string;bytes:number;calls:number;
  }>>;
  /** Verify the content digest, then reconstruct all calls without native effects. */
  get(id:string):Promise<BoundedRetainedModuleSession>;
  list():Promise<string[]>;
}
export declare function createDurableRetainedModuleStore(
  options:{directory:string;maxBytes?:number}
):DurableRetainedModuleStore;
