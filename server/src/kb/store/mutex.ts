/**
 * G4.S10.T1 — a minimal async mutex for the graph write phase.
 *
 * Parallel uploads run their LINK reads concurrently, but every merge/edge/
 * provenance write passes through ONE shared critical section so read-modify-
 * write sequences on shared entities can never interleave (no lost merges).
 * The lock is held for milliseconds per document — no throughput cost.
 */

/** FIFO async mutual exclusion around an async callback. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively: queued callers execute strictly one at a time. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // The chain only tracks the LOCK (never the callback's fate): a rejected
    // section must not poison subsequent holders.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** True while a critical section is executing (diagnostics/tests). */
  get locked(): boolean {
    let locked = true;
    this.tail.then(() => {
      locked = false;
    });
    return locked;
  }
}

/**
 * The process-wide write-phase mutex shared by ingest + wiki-edit overwrite
 * (and any future LINK writer). Module singleton = the "global" lock.
 */
export const globalGraphWriteMutex = new AsyncMutex();
