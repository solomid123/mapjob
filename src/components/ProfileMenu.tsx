import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, ChevronRight, PlusCircle, User } from 'lucide-react';

interface ProfileMenuProps {
  savedCount: number;
  appliedCount: number;
  onShowSaved: () => void;
  onOpenPostJob: () => void;
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
 * Nothing here is invented. There is no account system in this app yet, so
 * the card says so, and the two counts it reports are the only ones that
 * genuinely exist. Both live in localStorage, which is what "on this device"
 * means -- the honest version of the "iCloud" line on Apple's tile.
 *
 * The counts are a readout, not buttons. There is a saved-only filter, so
 * "Saved jobs" below is wired to it; there is no applied-only filter, and a
 * row that looks clickable and does nothing is worse than no row.
 */
export const ProfileMenu: React.FC<ProfileMenuProps> = ({
  savedCount,
  appliedCount,
  onShowSaved,
  onOpenPostJob,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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
          <div className="px-4 pt-5 pb-4 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-white/[0.12] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)] flex items-center justify-center mb-3">
              <User className="w-8 h-8 text-[rgba(235,235,245,0.62)] stroke-[1.6]" />
            </div>
            <span className="text-[17px] font-semibold tracking-[-0.02em] text-[#f5f5f7]">
              Your profile
            </span>
            <span className="text-[12px] text-[rgba(235,235,245,0.42)] mt-0.5">
              No account connected
            </span>
            <span className="text-[12px] font-semibold text-[rgba(235,235,245,0.62)] mt-2">
              Saved on this device
            </span>
          </div>

          {/* The two numbers that actually exist, side by side in their own
            * recessed wells -- the way Apple shows storage on the same tile. */}
          <div className="grid grid-cols-2 gap-1.5 px-1.5 pb-1.5">
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

          <div className="h-px bg-white/10 mx-3 my-1" />

          {[
            { label: 'Saved jobs', Icon: Bookmark, action: onShowSaved },
            { label: 'Post a job', Icon: PlusCircle, action: onOpenPostJob },
          ].map(({ label, Icon, action }) => (
            <button
              key={label}
              type="button"
              onClick={() => run(action)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer hover:bg-white/[0.08] transition-colors duration-200 ease-apple-out"
            >
              <Icon className="w-4 h-4 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span className="text-[13px] font-medium tracking-[-0.01em] text-[#f5f5f7]">
                {label}
              </span>
              <ChevronRight className="w-3.5 h-3.5 ml-auto text-[rgba(235,235,245,0.42)]" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
