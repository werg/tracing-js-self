/** A live Linux flock lease. The descriptor is borrowed and may only be
 * duplicated into a child process stdio entry; callers must never close it
 * directly. Closing the lease releases this process's descriptor reference.
 */
export interface SelectedOrchestrationExecutionLease {
  readonly sessionId: string;
  readonly streamId: string;
  readonly lockPath: string;
  readonly fileDescriptor: number;
  assertHeld(): true;
  release(): Promise<void>;
}

/** Trusted-local Linux kernel exclusion primitive. It is a prerequisite for
 * future recovery integration and does not itself authorize restore or replay.
 */
export declare class DurableSelectedOrchestrationExecutionLock {
  constructor(options: {
    /** Existing, trusted owner-private directory. */
    directory: string;
    sessionId: string;
    streamId: string;
    /** Absolute trusted system flock binary path. Defaults to /usr/bin/flock. */
    flockPath?: string;
  });
  readonly directory: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly lockPath: string;
  acquire(): Promise<SelectedOrchestrationExecutionLease>;
}
