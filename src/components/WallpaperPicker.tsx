import React, { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';

/**
 * Which wallpaper the canvas is wearing.
 *
 * The value lives on <html data-wallpaper> rather than in React state that
 * something renders from: the background belongs to <body>, which is outside
 * the React tree, and every colour that depends on it is already a custom
 * property. So the switch is one attribute write and the CSS does the rest --
 * no re-render, and nothing to keep in sync.
 */
export type WallpaperId = 'azure' | 'crimson' | 'sage';

const STORAGE_KEY = 'mapjob.wallpaper';

const WALLPAPERS: { id: WallpaperId; name: string; swatch: string }[] = [
  { id: 'azure', name: 'Azure', swatch: 'linear-gradient(135deg,#2d7bef,#0a2e8f 55%,#05164a)' },
  { id: 'crimson', name: 'Crimson', swatch: 'linear-gradient(135deg,#a03050,#4a1226 55%,#1c0510)' },
  { id: 'sage', name: 'Sage', swatch: 'linear-gradient(135deg,#8a9c8b,#3d4c41 55%,#151f18)' },
];

export const readWallpaper = (): WallpaperId =>
  (document.documentElement.getAttribute('data-wallpaper') as WallpaperId) || 'azure';

export const applyWallpaper = (id: WallpaperId) => {
  document.documentElement.setAttribute('data-wallpaper', id);
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private mode, or storage disabled. The choice just will not survive a
    // reload, which is not worth breaking the click over.
  }
};

export const WallpaperPicker: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<WallpaperId>('azure');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setCurrent(readWallpaper()), []);

  // Close on an outside click or Escape. Both, because a menu you can only
  // dismiss by clicking its own button is a trap on touch.
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

  const choose = (id: WallpaperId) => {
    applyWallpaper(id);
    setCurrent(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ic-fill w-8 h-8 rounded-full flex items-center justify-center cursor-pointer"
        title="Change the background"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Palette className="w-4 h-4 text-[#f5f5f7]" />
      </button>

      {open && (
        <div
          role="menu"
          className="ic-popover animate-airbnb-pop absolute right-0 top-11 w-52 p-1.5 z-50"
        >
          {WALLPAPERS.map((w) => (
            <button
              key={w.id}
              type="button"
              role="menuitemradio"
              aria-checked={current === w.id}
              onClick={() => choose(w.id)}
              className="w-full flex items-center gap-3 px-2.5 py-2 rounded-xl cursor-pointer hover:bg-white/[0.08] transition-colors duration-200 ease-apple-out"
            >
              <span
                className="w-7 h-7 rounded-lg shrink-0 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)]"
                style={{ backgroundImage: w.swatch }}
              />
              <span className="text-[13px] font-medium tracking-[-0.01em] text-[#f5f5f7]">
                {w.name}
              </span>
              {current === w.id && (
                <Check className="w-4 h-4 ml-auto text-[#0a84ff] stroke-[2.5]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
