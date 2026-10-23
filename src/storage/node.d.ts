/** POSIX/Node-only persistence for replayable sealed semantic-tracing-run/2 bundles. */
export interface TraceArchiveReceipt {
  readonly id: string;
  readonly bytes: number;
  readonly eventCount: number;
  readonly chunkCount: number;
}
export interface DurableTraceStoreOptions {
  directory: string;
  maxBytes?: number;
}
export declare class TraceStorageError extends Error {}
export declare class DurableTraceStore {
  constructor(options: DurableTraceStoreOptions);
  readonly directory: string;
  readonly maxBytes: number;
  objectPath(id: string): string;
  put(bundle: unknown): Promise<TraceArchiveReceipt>;
  get(id: string): Promise<any>;
  list(): Promise<string[]>;
}
export declare function createDurableTraceStore(options: DurableTraceStoreOptions): DurableTraceStore;

export {DurableRetainedModuleStore,DurableRetainedModuleStorageError,
  createDurableRetainedModuleStore} from './retained-session.js';
