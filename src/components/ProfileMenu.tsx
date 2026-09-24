import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, ChevronRight, LogOut, User } from 'lucide-react';
import { ApplyEngineChooser, type ApplyEngineId } from './ApplyEngineChooser';
import type { ApplyEngine } from '../services/directAtsApi';
import { signOut, usePerson } from '../services/account';

interface ProfileMenuProps {
  savedCount: number;
  appliedCount: number;
  onShowSaved: () => void;
  /** Opens the full profile: the record every part of the app speaks from. */
  onOpenProfile: () => void;
  /** Which browser applications run in, and the ones on offer. */
  applyEngine: ApplyEngineId;
  applyEngines: ApplyEngine[];
  onChooseApplyEngine: (id: ApplyEngineId) => void;
}

/**
 * The account glyph in the ribbon, and the card it opens.
 *
 * Modelled on the profile tile on the iCloud dashboard: a large circular
 * avatar, the name, the address under it, and the service it belongs to --
 * all of it one block, generously padded, no dividers between the lines.
 * What makes that read as a *card* rather than as a menu is that the identity
 * is the content, not a header bolted above a list of commands.
 *
 * Nothing here is invented. The name on the card is the account signed in,
 * the two counts it reports are the only ones that genuinely exist, and both
 * live in localStorage under that account -- which is what "on this device"
 * means, the honest version of the "iCloud" line on Apple's tile.
 *
 * Signing out is the last row rather than a button beside the name: it is the
 * way to hand the app to the other person, and it is not something to press by
 * accident on the way to the saved list.
 *
 * The counts are a readout, not buttons. There is a saved-only filter, so
 * "Saved jobs" below is wired to it; there is no applied-only filter, and a
 * row that looks clickable and does nothing is worse than no row.
 */
export const ProfileMenu: React.FC<ProfileMenuProps> = ({
  savedCount,
  appliedCount,
  onShowSaved,
  onOpenProfile,
  applyEngine,
  applyEngines,
  onChooseApplyEngine,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const person = usePerson();

  // Outside click and Escape both close it. A menu that only its own button
  // can dismiss is a trap on touch, where there is no Escape key.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void) => {
    fn();
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`ic-fill w-8 h-8 rounded-full flex items-center justify-center cursor-pointer ${
          open ? 'is-on' : ''
        }`}
        title="Your profile"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <User className="w-4 h-4 text-[#f5f5f7]" />
      </button>

      {open && (
        <div className="ic-popover animate-airbnb-pop absolute right-0 top-11 w-[286px] p-1.5 z-50">
          {/* Identity block. The avatar is oversized on purpose -- it is the
            * subject of the card, not a bullet beside a name. */}
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenProfile(); }}
            className="w-full px-4 pt-5 pb-4 flex flex-col items-center text-center rounded-[18px] cursor-pointer hover:bg-white/[0.05] transition-colors duration-150 group"
            title="Your details, your CV and what has been sent"
          >
            <div className="w-16 h-16 rounded-full bg-white/[0.12] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)] flex items-center justify-center mb-3 group-hover:bg-white/[0.16] transition-colors duration-150">
              {person ? (
                <span className="text-[20px] font-semibold tracking-[-0.02em] text-[rgba(235,235,245,0.78)]">
                  {person.display_name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((part) => part[0].toUpperCase())
                    .join('')}
                </span>
              ) : (
                <User className="w-8 h-8 text-[rgba(235,235,245,0.62)] stroke-[1.6]" />
              )}
            </div>
            <span className="text-[17px] font-semibold tracking-[-0.02em] text-[#f5f5f7] inline-flex items-center gap-1">
              {person?.display_name || 'Your profile'}
              <ChevronRight className="w-3.5 h-3.5 text-[rgba(235,235,245,0.42)] group-hover:translate-x-0.5 transition-transform duration-150" />
            </span>
            <span className="text-[12px] text-[rgba(235,235,245,0.42)] mt-0.5">
              {person?.focus || 'Details, CV and documents'}
            </span>
            <span className="text-[12px] font-semibold text-[rgba(235,235,245,0.62)] mt-2">
              Saved on this device
            </span>
          </button>

          <div className="h-px bg-white/10 mx-4 my-1" />

          {/* The two numbers that actually exist, side by side in their own
            * recessed wells -- the way Apple shows storage on the same tile.
            *
            * Everything below the identity block shares one inset, 16px from
            * the card's edge: the wells, the engine rows, the commands and the
            * dividers between them. Flush against the edge they read as the
            * card's own lining rather than as things sitting inside it. */}
          <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-1.5 pb-2">
            {[
              { n: savedCount, label: 'Saved' },
              { n: appliedCount, label: 'Applied' },
            ].map(({ n, label }) => (
              <div key={label} className="rounded-2xl bg-white/[0.06] px-3 py-2.5">
                <span className="block text-[19px] font-semibold tracking-[-0.02em] text-[#f5f5f7] leading-tight">
                  {n}
                </span>
                <span className="block text-[11px] text-[rgba(235,235,245,0.42)]">{label}</span>
              </div>
            ))}
          </div>

          <div className="h-px bg-white/10 mx-4 my-1" />

          {/* The choice of engine lives with the identity rather than beside the
            * Apply button: it is a standing preference, and putting it on the
            * button would ask it again on every job. */}
          <ApplyEngineChooser
            engine={applyEngine}
            engines={applyEngines}
            onChoose={onChooseApplyEngine}
          />

          <div className="h-px bg-white/10 mx-4 my-1" />

          {/* One command, not two. "Post a job" was here and on the ribbon, and
            * the ribbon is where it belongs: this card is about the person
            * signed in, and posting a vacancy is the one thing in it done as an
            * employer rather than as a candidate. */}
          <div className="px-2.5 py-0.5">
            <button
              type="button"
              onClick={() => run(onShowSaved)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white/[0.08] transition-colors duration-200 ease-apple-out"
            >
              <Bookmark className="w-4 h-4 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span className="text-[13px] font-medium tracking-[-0.01em] text-[#f5f5f7]">
                Saved jobs
              </span>
              <ChevronRight className="w-3.5 h-3.5 ml-auto text-[rgba(235,235,245,0.42)]" />
            </button>
          </div>

          <div className="h-px bg-white/10 mx-4 my-1" />

          {/* Out, and back to the door. Nothing of this account is deleted --
            * it is unlocked again by signing in as the same person -- but none
            * of it is on screen for whoever signs in next. */}
          <div className="px-2.5 py-0.5">
            <button
              type="button"
              onClick={() => { setOpen(false); signOut(); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white/[0.08] transition-colors duration-200 ease-apple-out"
            >
              <LogOut className="w-4 h-4 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span className="text-[13px] font-medium tracking-[-0.01em] text-[#f5f5f7]">
                Sign out{person ? ' of ' + person.display_name.split(' ')[0] + "’s account" : ''}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
