import React from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * The end of the page, in iCloud's two parts: a tall band of information, and
 * a thin legal line under it.
 *
 * iCloud puts that band below the fold -- you scroll past the app tiles to
 * reach "Your Plan / Your Storage / Data Recovery". This app has no page
 * scroll on the explore view: the window is a fixed-height dashboard and the
 * results column scrolls inside it, so a band pinned to the bottom of the
 * window would not be "below the fold", it would be 130px of map taken away
 * on every screen forever.
 *
 * So the band goes where the scrolling actually ends -- under the last job in
 * the list, and under the job page's content -- which is the same gesture and
 * the same reward as iCloud's. The legal line stays pinned to the window,
 * because the Mapbox and OpenStreetMap credit should not depend on anyone
 * scrolling to find it.
 */

const FOOTER_LINK =
  'text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition-colors duration-150';

interface FooterInfoProps {
  savedCount: number;
  appliedCount: number;
  /** Explore only. The job page has no result set to describe. */
  jobCount?: number;
  locationLabel?: string;
  onShowSaved: () => void;
}

/** One column of the band. The chevron is only drawn when the heading leads
 *  somewhere -- iCloud's do, and a decorative one is a promise the row does
 *  not keep. */
const Column: React.FC<{
  title: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ title, onClick, children }) => {
  const heading = (
    <span className="inline-flex items-center gap-0.5 text-[21px] font-semibold tracking-[-0.022em] text-[#f5f5f7]">
      {title}
      {onClick && <ChevronRight className="w-[18px] h-[18px] mt-0.5 stroke-[2.2]" />}
    </span>
  );

  return (
    <div className="min-w-0">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="group cursor-pointer text-left hover:opacity-70 transition-opacity duration-150"
        >
          {heading}
        </button>
      ) : (
        heading
      )}
      <div className="mt-3 space-y-1">{children}</div>
    </div>
  );
};

export const FooterInfo: React.FC<FooterInfoProps> = ({
  savedCount,
  appliedCount,
  jobCount,
  locationLabel,
  onShowSaved,
}) => (
  <section className="ic-tile is-static mt-8 p-7 md:p-9">
    {/* Breakpoints are viewport-wide but this band is not: on the explore view
      * it lives inside a column that is roughly half the window, so the usual
      * sm/xl ladder put three 153px columns side by side at 1280. Everything
      * here is shifted a step up to compensate. */}
    <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-8 xl:gap-10">
      <Column title="Your activity" onClick={onShowSaved}>
        <p className="text-[15px] font-medium text-[#f5f5f7]">
          {savedCount} saved &middot; {appliedCount} applied
        </p>
        <p className="text-[13px] text-[rgba(235,235,245,0.42)] tracking-[-0.01em]">
          Kept in this browser. There is no account to sign in to yet, so
          clearing site data clears these.
        </p>
      </Column>

      {typeof jobCount === 'number' && (
        <Column title="This search">
          <p className="text-[15px] font-medium text-[#f5f5f7]">
            {jobCount} {jobCount === 1 ? 'job' : 'jobs'}
          </p>
          <p className="text-[13px] text-[rgba(235,235,245,0.42)] tracking-[-0.01em]">
            {locationLabel
              ? `Around ${locationLabel}. Move the map to search somewhere else.`
              : 'Move the map to search somewhere else.'}
          </p>
        </Column>
      )}

      <Column title="Where these come from">
        <p className="text-[13px] text-[rgba(235,235,245,0.62)] tracking-[-0.01em] leading-relaxed">
          Listings are pulled from{' '}
          <a
            href="https://www.adzuna.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-[#f5f5f7] transition-colors duration-150"
          >
            Adzuna
          </a>{' '}
          each time you search or move the map. Pins are placed from the
          location the employer wrote down, so some of them are approximate and
          say so on the card.
        </p>
      </Column>
    </div>
  </section>
);

/**
 * The thin legal line, pinned to the bottom of the window.
 *
 * Mostly it exists because of a debt: the map is rendered with
 * `attributionControl={false}`, which means the app has been serving Mapbox
 * tiles built from OpenStreetMap data while crediting neither. Both licences
 * require the credit and Mapbox additionally requires the feedback link, so
 * those three links are the load-bearing part of this component.
 *
 * Hidden below `md` because the phone layout ends in a fixed tab bar and a
 * floating Map/List pill; a third thing stacked under those would be buried.
 *
 * It carries the chrome's glass rather than sitting bare on the wallpaper:
 * white text at 42% over the pale theme was grey on grey, which is no way to
 * publish a credit you are obliged to publish.
 */
export const SiteFooter: React.FC = () => (
  <footer className="ic-footbar hidden md:flex shrink-0 justify-center select-none">
    <div className="w-full max-w-[1760px] px-4 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-6 h-9 text-[11px] tracking-[-0.005em] text-[rgba(235,235,245,0.62)]">
        <div className="flex items-center gap-3">
          <span>&copy; {new Date().getFullYear()} mapjob</span>
          <span className="w-px h-2.5 bg-white/10" />
          <span>
            Listings via{' '}
            <a
              href="https://www.adzuna.com/"
              target="_blank"
              rel="noopener noreferrer"
              className={FOOTER_LINK}
            >
              Adzuna
            </a>
          </span>
        </div>

        {/* Map credits. Required by the tile and data licences, not decoration. */}
        <div className="flex items-center gap-3">
          <a
            href="https://www.mapbox.com/about/maps/"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOTER_LINK}
          >
            &copy; Mapbox
          </a>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOTER_LINK}
          >
            &copy; OpenStreetMap
          </a>
          <a
            href="https://www.mapbox.com/map-feedback/"
            target="_blank"
            rel="noopener noreferrer"
            className={FOOTER_LINK}
          >
            Improve this map
          </a>
        </div>
      </div>
    </div>
  </footer>
);
