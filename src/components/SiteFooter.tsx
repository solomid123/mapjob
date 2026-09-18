import React from 'react';

/**
 * The strip along the bottom of the window.
 *
 * Mostly it exists because of a debt: the map is rendered with
 * `attributionControl={false}`, which means the app has been serving Mapbox
 * tiles built from OpenStreetMap data while crediting neither. Both licences
 * require the credit and Mapbox additionally requires the feedback link, so
 * those three links are the load-bearing part of this component -- the
 * copyright line is just what keeps them company.
 *
 * Leaflet's own control was switched off for a good reason (a white pill
 * floating over the corner of a dark rounded map, fighting the design), and
 * putting the same words down here satisfies the terms without it.
 *
 * Hidden below `md` because the phone layout ends in a fixed tab bar and a
 * floating Map/List pill; a third thing stacked under those would be buried.
 */
const FOOTER_LINK =
  'text-[rgba(235,235,245,0.42)] hover:text-[rgba(235,235,245,0.75)] transition-colors duration-150';

export const SiteFooter: React.FC = () => (
  <footer className="hidden md:flex shrink-0 justify-center select-none">
    <div className="w-full max-w-[1760px] px-4 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-6 h-8 text-[11px] tracking-[-0.005em] text-[rgba(235,235,245,0.42)] border-t border-white/[0.07]">
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
