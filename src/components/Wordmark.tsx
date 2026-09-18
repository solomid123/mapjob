import React from 'react';

/* The mark, drawn rather than borrowed from the icon set.
 *
 * Apple's is a solid silhouette with a bite cut out of it -- one filled shape,
 * no strokes, legible at 16px and at 160. The lucide MapPin is a 2px outline,
 * which is the vocabulary of a UI glyph, not of a logotype: set beside a 20px
 * wordmark it reads as a button someone left in the header. So this is the
 * same pin as a filled teardrop with the hole wound the other way, which the
 * nonzero fill rule punches straight through.
 *
 * It lives in its own file because a logo that is declared twice is a logo
 * that will differ twice: the job page had its own -- a white outline pin in
 * a rose rounded square beside a two-tone "map/job" -- and the two headers
 * looked like two products. There is one lockup, and this is it. */
export const MapMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
    <path d="M12 1.7a7.4 7.4 0 0 0-7.4 7.4c0 5.6 6.62 12.83 6.9 13.13a.68.68 0 0 0 1 0c.28-.3 6.9-7.53 6.9-13.13A7.4 7.4 0 0 0 12 1.7Zm0 10.25a2.85 2.85 0 1 1 0-5.7 2.85 2.85 0 0 1 0 5.7Z" />
  </svg>
);

/**
 * The whole lockup — mark plus wordmark — as one button.
 *
 * `onClick` is what the name does here: in the ribbon it clears the search and
 * goes home, on a job page it closes the page. Same drawing either way.
 */
export const Wordmark: React.FC<{
  onClick?: () => void;
  title?: string;
  className?: string;
}> = ({ onClick, title, className }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    className={`ic-wordmark shrink-0 cursor-pointer${className ? ` ${className}` : ''}`}
  >
    <MapMark className="w-[17px] h-[17px] shrink-0" />
    <span className="ic-wordmark-text">mapjob</span>
  </button>
);
