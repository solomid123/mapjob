import React from 'react';
import { Cloud, Laptop } from 'lucide-react';
import { listApplyEngines, type ApplyEngine } from '../services/directAtsApi';

export type ApplyEngineId = 'local' | 'cloud';

const STORAGE_KEY = 'mapjob.applyEngine';

/**
 * The engines a person is asked to choose between.
 *
 * "This computer" is not one of them any more. It was honest while this app ran
 * on the one machine that owned the Chrome it drove; on a deployment it means
 * the *server's* browser, and nobody signing in from their own laptop is being
 * offered their own computer by that row. So applications run in the cloud, and
 * the local engine stays only as what happens when the cloud is not set up.
 */
const OFFERED: readonly ApplyEngineId[] = ['cloud'];

/**
 * Which browser applications run in, remembered between sessions.
 *
 * A preference rather than a question at each click: the answer is a property
 * of how someone works -- at the desk watching, or away from it -- not of the
 * job being applied to, and a modal in front of every apply would be a tax on
 * the common case for the sake of the rare one.
 *
 * It falls back to the local engine whenever the chosen one is not actually
 * available, which is what happens when the cloud key is missing or has been
 * rotated out. A stored preference must never be able to make the button fail:
 * the fallback is silent here and stated in the chooser, where there is room.
 */
export function useApplyEngine(): {
  engine: ApplyEngineId;
  setEngine: (id: ApplyEngineId) => void;
  engines: ApplyEngine[];
} {
  const [stored, setStored] = React.useState<ApplyEngineId>(() => {
    // A stored engine that is no longer offered is not honoured: someone who
    // ticked "This computer" months ago would otherwise keep applying through
    // a browser this menu no longer shows them, which is the one thing a
    // hidden setting must never do.
    try {
      const kept = localStorage.getItem(STORAGE_KEY) as ApplyEngineId | null;
      return kept && OFFERED.includes(kept) ? kept : OFFERED[0];
    } catch {
      return OFFERED[0];
    }
  });
  const [engines, setEngines] = React.useState<ApplyEngine[]>([]);

  React.useEffect(() => {
    let alive = true;
    listApplyEngines().then((list) => { if (alive) setEngines(list); });
    return () => { alive = false; };
  }, []);

  const setEngine = React.useCallback((id: ApplyEngineId) => {
    setStored(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private browsing. The choice still holds for this session.
    }
  }, []);

  // Not yet asked: honour the stored choice rather than flip to local for the
  // few hundred milliseconds the list takes, which would send an application
  // through the wrong browser if someone clicked immediately.
  const known = engines.find((e) => e.id === stored);
  const engine: ApplyEngineId = known && !known.available ? 'local' : stored;

  return { engine, setEngine, engines };
}

const ICON: Record<ApplyEngineId, React.ComponentType<{ className?: string }>> = {
  local: Laptop,
  cloud: Cloud,
};

/**
 * The offered engines, as rows. Rows rather than a segmented control: each one
 * needs a sentence of its own -- where the browser runs, and what it costs --
 * and a two-word toggle cannot say either of those things.
 *
 * The backend still lists the local engine, and this deliberately does not show
 * it. What it does show, when the cloud is not set up, is that applications are
 * falling back to Chrome on the machine running the service -- a hidden setting
 * may be quiet about which door it prefers, never about which one is open.
 */
export const ApplyEngineChooser: React.FC<{
  engine: ApplyEngineId;
  engines: ApplyEngine[];
  onChoose: (id: ApplyEngineId) => void;
}> = ({ engine, engines, onChoose }) => {
  const offered = engines.filter((e) => OFFERED.includes(e.id));
  if (!offered.length) return null;

  return (
    <div className="px-2.5 pb-1.5" role="radiogroup" aria-label="Where applications run">
      <span className="block px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[rgba(235,235,245,0.42)]">
        Apply with
      </span>

      {offered.map((option) => {
        const Icon = ICON[option.id] || Laptop;
        const chosen = option.id === engine;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={!option.available}
            onClick={() => onChoose(option.id)}
            className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors duration-200 ease-apple-out ${
              option.available ? 'cursor-pointer hover:bg-white/[0.08]' : 'cursor-not-allowed opacity-45'
            } ${chosen ? 'bg-white/[0.10]' : ''}`}
          >
            <Icon className="w-4 h-4 shrink-0 mt-0.5 text-[rgba(235,235,245,0.62)]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium tracking-[-0.01em] text-[#f5f5f7]">
                {option.label}
              </span>
              <span className="block text-[11.5px] leading-snug text-[rgba(235,235,245,0.42)]">
                {/* An unavailable engine says what is missing by name, and what
                    happens meanwhile. The value is never shown anywhere in this
                    app, and it is not shown here either -- only which line of
                    .env is empty. */}
                {option.available
                  ? option.detail
                  : `Needs ${option.requires_env || 'setting up'} in .env. Until then `
                    + 'applications run in Chrome on the machine hosting this app.'}
              </span>
            </span>
            {chosen && (
              <span className="ml-auto mt-1.5 w-1.5 h-1.5 shrink-0 rounded-full bg-sky-400" />
            )}
          </button>
        );
      })}
    </div>
  );
};
