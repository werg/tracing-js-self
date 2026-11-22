import type {SelectedOrchestrationExecutionLease} from './selected-orchestration-execution-lock.js';

export interface NativeV8RequestReceipt {
  readonly schema: 'semantic-native-producer-request-receipt/8';
  readonly ordinal: number;
  readonly digest: string;
  readonly bytes: number;
  readonly sessionId: string;
  readonly streamId: string;
  readonly sessionGeneration: number;
}
export interface NativeV8RequestDurability {
  journal: DurableNativeV8RequestJournal;
  executionLease: SelectedOrchestrationExecutionLease;
}
export declare class DurableNativeV8RequestJournal {
  constructor(options: {directory: string;sessionId: string;streamId: string;
    sessionGeneration?: number;maxBytes?: number;maxRequests?: number;maxLogBytes?: number});
  readonly directory: string;
  readonly scopeDirectory: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly sessionGeneration: number;
  readonly maxBytes: number;
  readonly maxRequests: number;
  readonly maxLogBytes: number;
  append(input: {identity: unknown;requestBase64: string;checkpoint: unknown}): Promise<NativeV8RequestReceipt>;
  read(receipt: NativeV8RequestReceipt, options?: {latest?: boolean}): Promise<any>;
  inspect(ordinal: number): Promise<{receipt: NativeV8RequestReceipt;intent: any}>;
  list(): Promise<Array<{ordinal: number}>>;
}
