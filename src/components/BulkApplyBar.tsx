import React from 'react';
import { Zap, X, SkipForward, Square, Check, Loader2 } from 'lucide-react';
import type { BulkQueue } from '../services/bulkApply';
import { bulkTally } from '../services/bulkApply';

interface BulkApplyBarProps {
  /** How many jobs are ticked, while choosing. */
  selectedCount: number;
  /** Of those, how many can actually be run. */
  eligibleCount: number;
  /** The run in progress, or the one that just finished. Null while choosing. */
  queue: BulkQueue | null;
  onStart: () => void;
  onClear: () => void;
  onSkip: () => void;
  onStop: () => void;
  onDismiss: () => void;
}

/**
 * The floating bar that a bulk run is driven from.
 *
 * It is one bar in three states -- choosing, running, finished -- rather than
 * three components, because they are the same object at three moments and the
 * eye should follow it through. It sits above the mobile tab bar and below the
 * live panel, which is the thing worth watching while this only counts.
 */
export const BulkApplyBar: React.FC<BulkApplyBarProps> = ({
  selectedCount,
  eligibleCount,
  queue,
  onStart,
  onClear,
  onSkip,
  onStop,
  onDismiss,
}) => {
  const running = !!queue?.running;
  const finished = !!queue && !queue.running;
  if (!queue && selectedCount === 0) return null;

  const tally = queue ? bulkTally(queue) : null;
  const current = queue?.items[queue.cursor]?.job;
  const position = queue ? Math.min(queue.cursor + 1, queue.items.length) : 0;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 bottom-24 md:bottom-7 z-[60] w-[calc(100%-1.5rem)] max-w-[560px] animate-airbnb-pop">
      <div className="ic-popover flex items-center gap-3 px-3.5 py-2.5">
        {/* Choosing. */}
        {!queue && (
          <>
            <span className="text-[13px] text-[#f5f5f7] font-medium tracking-[-0.01em] truncate">
              {selectedCount} selected
              {eligibleCount < selectedCount && (
                <span className="text-[rgba(235,235,245,0.42)] font-normal">
                  {' '}· {selectedCount - eligibleCount} can't be applied to
                </span>
              )}
            </span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onClear}
                className="px-3 py-1.5 rounded-full text-[12.5px] font-medium text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={onStart}
                disabled={eligibleCount === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold tracking-[-0.01em] text-white bg-[#0a84ff] hover:bg-[#3b9bff] active:scale-[0.96] disabled:opacity-40 disabled:active:scale-100 transition-[background-color,transform] duration-200 ease-apple-spring cursor-pointer disabled:cursor-default"
                title="Applies to each one in turn, in a real browser. You can watch and stop at any point."
              >
                <Zap className="w-3.5 h-3.5 fill-white" />
                Apply to {eligibleCount}
              </button>
            </div>
          </>
        )}

        {/* Running. Two or three words about where it is, never a URL. */}
        {running && (
          <>
            <Loader2 className="w-4 h-4 shrink-0 animate-spin text-[#0a84ff]" />
            <div className="min-w-0">
              <p className="text-[13px] text-[#f5f5f7] font-medium tracking-[-0.01em] truncate">
                Applying {position} of {tally!.total}
                {current && (
                  <span className="text-[rgba(235,235,245,0.62)] font-normal"> · {current.company}</span>
                )}
              </p>
              <p className="text-[11.5px] text-[rgba(235,235,245,0.42)] tracking-[-0.01em]">
                {tally!.sent} sent · {tally!.failed + tally!.skipped} not · {tally!.pending} to go
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={onSkip}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
                title="Give up on this one and move to the next"
              >
                <SkipForward className="w-3.5 h-3.5" />
                Skip
              </button>
              <button
                type="button"
                onClick={onStop}
                disabled={queue!.stopping}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-semibold text-[#ff453a] hover:bg-[#ff453a]/[0.14] disabled:opacity-40 transition-colors duration-200 cursor-pointer disabled:cursor-default"
                title="Stop this one and cancel the rest of the queue"
              >
                <Square className="w-3 h-3 fill-current" />
                {queue!.stopping ? 'Stopping' : 'Stop'}
              </button>
            </div>
          </>
        )}

        {/* Finished. Stays until dismissed: the summary is the point of a run
          * you walked away from. */}
        {finished && (
          <>
            <Check className="w-4 h-4 shrink-0 text-emerald-400" />
            <p className="text-[13px] text-[#f5f5f7] font-medium tracking-[-0.01em] truncate">
              {tally!.sent} of {tally!.total} sent
              {tally!.failed > 0 && (
                <span className="text-[rgba(235,235,245,0.62)] font-normal"> · {tally!.failed} failed</span>
              )}
              {tally!.skipped > 0 && (
                <span className="text-[rgba(235,235,245,0.62)] font-normal"> · {tally!.skipped} skipped</span>
              )}
            </p>
            <button
              type="button"
              onClick={onDismiss}
              className="ml-auto shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
              title="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
