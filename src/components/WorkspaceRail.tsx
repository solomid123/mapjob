import { useEffect } from 'react';

/**
 * The three things this page is for, as one rail across the top of it.
 *
 * The map used to be the page. It is now one of three: find the work, prepare
 * the documents for it, read back what was sent. They share a canvas rather
 * than becoming three routes because they are one task -- you tailor the job
 * you just found, and you check the PDF that went with it -- and because the
 * search, the filters and the results all belong to the same session.
 *
 * Drawn as segments of a rail rather than as tabs: it is a strip of progress
 * through a piece of work, and the segment that is lit is where you are.
 */

export type Workspace = 'map' | 'tailor' | 'history';

interface RailItem {
  id: Workspace;
  label: string;
  hint: string;
  /** Shown as a small count beside the label when there is one worth showing. */
  count?: number;
}

interface WorkspaceRailProps {
  active: Workspace;
  onChange: (next: Workspace) => void;
  jobCount?: number;
  tailoredCount?: number;
  appliedCount?: number;
}

export function WorkspaceRail({
  active, onChange, jobCount, tailoredCount, appliedCount,
}: WorkspaceRailProps) {
  const items: RailItem[] = [
    { id: 'map', label: 'Map', hint: 'Find the work', count: jobCount },
    { id: 'tailor', label: 'Tailoring', hint: 'CV and letter per job', count: tailoredCount },
    { id: 'history', label: 'Applied', hint: 'What was sent, and with which PDF', count: appliedCount },
  ];

  // Left and right move along the rail once it has been used once, because a
  // three-way switch that can only be clicked is a switch you stop using.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      const order: Workspace[] = ['map', 'tailor', 'history'];
      const here = order.indexOf(active);
      if (event.key === 'ArrowRight' && here < order.length - 1) {
        event.preventDefault();
        onChange(order[here + 1]);
      } else if (event.key === 'ArrowLeft' && here > 0) {
        event.preventDefault();
        onChange(order[here - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onChange]);

  return (
    // The search island ends a few pixels above this. With `pt-1` the labels
    // sat against its bottom edge and read as part of the field; the rail is a
    // separate thing you choose, so it gets air above it.
    <div className="w-full max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 pt-3.5 pb-2">
      <div className="flex items-stretch gap-2 sm:gap-3" role="tablist" aria-label="Workspace">
        {items.map((item) => {
          const on = item.id === active;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(item.id)}
              title={item.hint}
              className="group flex-1 min-w-0 text-left cursor-pointer focus:outline-none"
            >
              <div className="flex items-baseline gap-2 px-0.5 pb-1.5">
                <span
                  className={`text-[12.5px] tracking-[-0.01em] transition-colors duration-200 ${
                    on
                      ? 'text-[#f5f5f7] font-medium'
                      : 'text-[rgba(235,235,245,0.45)] group-hover:text-[rgba(235,235,245,0.75)]'
                  }`}
                >
                  {item.label}
                </span>
                {typeof item.count === 'number' && item.count > 0 && (
                  <span
                    className={`text-[11px] tabular-nums transition-colors duration-200 ${
                      on ? 'text-[rgba(235,235,245,0.55)]' : 'text-[rgba(235,235,245,0.3)]'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
                <span className="hidden lg:block truncate text-[11px] text-[rgba(235,235,245,0.28)] group-hover:text-[rgba(235,235,245,0.4)] transition-colors duration-200">
                  {item.hint}
                </span>
              </div>
              {/* The rail itself. Thin on purpose: it is a separator that
                * happens to be clickable, not a row of buttons competing with
                * the search field above it. */}
              <span
                className={`block h-[3px] rounded-full transition-all duration-300 ease-apple-spring ${
                  on
                    ? 'bg-[#0a84ff] shadow-[0_0_12px_rgba(10,132,255,0.55)]'
                    : 'bg-white/[0.11] group-hover:bg-white/[0.2]'
                }`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
