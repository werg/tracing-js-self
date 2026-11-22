import type {DurableFencedSelectedServiceJournal,SelectedServiceFenceReceipt}
  from './selected-service-fence-journal.js';

export interface SelectedServiceAdmissionPolicy {
  readonly schema: 'semantic-service-admission-policy/8';
  readonly sessionId: string;
  readonly serviceIds: readonly string[];
}
export interface SelectedServiceAdmissionOwnerSnapshot {
  readonly schema: 'semantic-service-admission-owner-snapshot/8';
  readonly policy: SelectedServiceAdmissionPolicy;
  /** Immutable exact owner receipts configured for this supervisor. */
  ownerSnapshot(): SelectedServiceAdmissionOwnerSnapshot;
  readonly services: ReadonlyArray<{readonly serviceId: string; readonly owner: SelectedServiceFenceReceipt}>;
}
export interface SelectedServiceAdmissionFence {
  schema: 'semantic-service-admission-fence/8';
  sessionId: string;
  reason: string;
  services: Array<{serviceId: string; owner: SelectedServiceFenceReceipt;
    terminal: SelectedServiceFenceReceipt}>;
}
/** Keep this supervisor capability outside the guest/model and service worker. */
export declare class SelectedServiceAdmissionCoordinator {
  constructor(options: {sessionId: string; services: Array<{
    journal: DurableFencedSelectedServiceJournal; owner: SelectedServiceFenceReceipt}>});
  readonly policy: SelectedServiceAdmissionPolicy;
  terminate(options: {sessionId: string; reason: string}): Promise<SelectedServiceAdmissionFence>;
  /** Re-read and sync every service's own terminal authority before acknowledging recovery. */
  verify(fence: SelectedServiceAdmissionFence): Promise<SelectedServiceAdmissionFence>;
  /** Refuse active recovery after a partial/full fence or a changed service owner. */
  assertActive(): Promise<SelectedServiceAdmissionPolicy>;
}
