import type { Job } from '../types/job';
import type { ApplyOutcome, BrowserApplyRun } from './directAtsApi';
import { runOutcome } from './directAtsApi';

/**
 * Applying to a list of jobs, one after another.
 *
 * The queue lives here, in the client, rather than in the backend, because the
 * backend can only ever run one application at a time and that is not a
 * limitation worth engineering around: there is one Chrome profile, one signed
 * in session per portal, and one candidate. Two agents filling two forms in
 * parallel would be two tabs fighting over the same cookies.
 *
 * So bulk is not a different mechanism from a single apply. It is the same run,
 * repeated, with somewhere to write down how each one ended -- which is the
 * part that actually matters when you set twenty going and walk away.
 */

export type BulkItemState = 'queued' | 'applying' | 'finished' | 'skipped';

export interface BulkItem {
  job: Job;
  state: BulkItemState;
  /** How it ended, once it has. Absent while queued. */
  outcome?: ApplyOutcome;
  /** Why it never ran, for the ones that did not. */
  skipReason?: string;
}

export interface BulkQueue {
  items: BulkItem[];
  /** Index of the job being worked on, or items.length once the run is over. */
  cursor: number;
  running: boolean;
  /** True from the moment Stop is pressed until the current job lets go. */
  stopping: boolean;
  startedAt: number;
}

/** A flag the running loop reads between jobs. Set by the Stop button. */
export interface BulkControl {
  stopRequested: boolean;
}

/**
 * Why a job cannot be part of a bulk run, or null when it can.
 *
 * Checked at selection time and again at run time. The second check is not
 * redundant: a run of twenty takes half an hour, and a job can become
 * "already applied" in the middle of it -- by its own earlier position in the
 * very same queue, if the list has a duplicate.
 */
export function bulkBlocker(job: Job, isApplied: (job: Job) => boolean): string | null {
  if (!job.applyUrl) return 'no application form';
  if (isApplied(job)) return 'already applied';
  return null;
}

export interface BulkHandlers {
  /**
   * Runs one application to completion. The caller supplies this rather than
   * the queue calling the API itself, so a bulk job goes through exactly the
   * same path as a single one -- same panel, same outcome recording, same
   * "applied" bookkeeping -- and there is no second implementation to drift.
   */
  applyOne: (job: Job) => Promise<BrowserApplyRun>;
  /** Called on every state change, with a fresh object to render from. */
  onChange: (queue: BulkQueue) => void;
  /** Consulted before each job, and again after each one finishes. */
  control: BulkControl;
  /** Whether a job counts as already applied, asked fresh before each run. */
  isApplied: (job: Job) => boolean;
  /**
   * Breathing room between applications. Not politeness: the browser needs a
   * moment to close and the backend a moment to mark itself idle, and starting
   * the next run into a still-running one is rejected outright.
   */
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Works through the queue until it is empty or stopped.
 *
 * A job that throws does not end the run. One employer's site being down is
 * not a reason to abandon the other nineteen -- the failure is written against
 * that job and the loop moves on, which is the whole reason for queuing in the
 * first place.
 */
export async function runBulkQueue(
  jobs: Job[],
  handlers: BulkHandlers,
): Promise<BulkQueue> {
  const { applyOne, onChange, control, isApplied, pauseMs = 2500 } = handlers;

  const queue: BulkQueue = {
    items: jobs.map((job) => ({ job, state: 'queued' as BulkItemState })),
    cursor: 0,
    running: true,
    stopping: false,
    startedAt: Date.now(),
  };

  // A new object every time: the panel renders from this, and mutating in
  // place would leave React showing the first tick for the whole run.
  const publish = () => onChange({ ...queue, items: queue.items.map((i) => ({ ...i })) });
  publish();

  for (let i = 0; i < queue.items.length; i += 1) {
    queue.cursor = i;
    const item = queue.items[i];

    if (control.stopRequested) {
      // Everything from here on is untouched, and says so. An abandoned queue
      // that silently reports "finished" is worse than one that admits it.
      for (let j = i; j < queue.items.length; j += 1) {
        queue.items[j].state = 'skipped';
        queue.items[j].skipReason = 'stopped';
      }
      break;
    }

    const blocker = bulkBlocker(item.job, isApplied);
    if (blocker) {
      item.state = 'skipped';
      item.skipReason = blocker;
      publish();
      continue;
    }

    item.state = 'applying';
    publish();

    try {
      const final = await applyOne(item.job);
      item.outcome = runOutcome(final);
    } catch (err: any) {
      item.outcome = {
        status: 'FAILED',
        sent: false,
        note: err?.message || 'Could not be started',
        at: new Date().toISOString(),
      };
    }
    item.state = 'finished';
    publish();

    const more = i < queue.items.length - 1;
    if (more && !control.stopRequested) await sleep(pauseMs);
  }

  queue.cursor = queue.items.length;
  queue.running = false;
  queue.stopping = false;
  publish();
  return queue;
}

/**
 * The tally the bar shows: how many went, how many did not, how many are left.
 *
 * A job that was called off -- by Skip, or by Stop reaching it mid-form --
 * counts as skipped, not failed. Nothing went wrong there and nothing needs
 * looking into; saying "2 failed" about two deliberate decisions sends you
 * hunting for a problem that does not exist.
 */
export function bulkTally(queue: BulkQueue) {
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let pending = 0;
  for (const item of queue.items) {
    if (item.state === 'skipped') skipped += 1;
    else if (item.state === 'finished') {
      if (item.outcome?.sent) sent += 1;
      else if (item.outcome?.status === 'SKIPPED') skipped += 1;
      else failed += 1;
    } else pending += 1;
  }
  return { sent, failed, skipped, pending, total: queue.items.length };
}
