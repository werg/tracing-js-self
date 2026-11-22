export interface SelectedOrchestrationClockReceipt {
  readonly schema: 'selected-orchestration-clock-receipt/1';
  readonly bootId: string;
  readonly timeNamespace: string;
  readonly issuedMonotonicNs: string;
  readonly consumedElapsedMs: number;
  readonly timeoutMs: number;
  readonly digest: string;
}
export interface SelectedOrchestrationClock {
  capture(options: {elapsedMs: (sampledMonotonicNs: bigint) => number; timeoutMs: number}):
    Promise<SelectedOrchestrationClockReceipt>;
  elapsed(receipt: SelectedOrchestrationClockReceipt, options?: {timeoutMs?: number}): Promise<number>;
}
export declare function createSelectedOrchestrationExecutionClock(): SelectedOrchestrationClock;
export declare function assertSelectedOrchestrationExecutionClock(clock: unknown): true;
export declare function validateSelectedOrchestrationClockReceipt(
  receipt: unknown, options?: {timeoutMs?: number}
): true;
