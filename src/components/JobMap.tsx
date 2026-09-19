import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { Heart, ArrowUpRight, Maximize2, Zap } from 'lucide-react';
import type { Job } from '../types/job';
import { CITIES } from '../data/mockJobs';

const MAPBOX_TOKEN =
  import.meta.env.VITE_MAPBOX_TOKEN ||
  'pk.eyJ1IjoicGVkcm9vMSIsImEiOiJjbXRtOG5oem4wNDlxMnhyM29yd3U5NnJsIn0.mbWylo8UUAhjcwI64BNPSA';

/**
 * Rendering budget. Airbnb never paints more than a couple of hundred pins at
 * once; keeping the marker count bounded is what makes panning stay at 60fps no
 * matter how many jobs the search returned.
 */
const MAX_MARKERS = 220;

/**
 * The budget never falls below this, however far out the map goes.
 *
 * Zooming out is how you ask "where is the work?", and a map that answers with
 * nothing is no answer at all. A handful of the best-ranked pins over a whole
 * country is a readable answer; an empty country is not. Room can still take it
 * lower — two towns' pills cannot both be drawn on the same square centimetre —
 * but the budget will never be the reason a continent shows nothing.
 */
const MIN_MARKERS = 14;

/**
 * How many pins are allowed on screen at this zoom.
 *
 * A flat budget is what made the continent view a wall of labels: 200 pins over
 * Europe is unreadable, while 200 over one city is comfortable. The budget
 * moving with the zoom is half of why pins *appear* as you go in; the other
 * half is that there is physically more room between them.
 *
 * A smooth curve rather than the five steps this used to be: the steps put a
 * cliff at every other zoom level, where one wheel notch would add forty pins
 * at once and the map would flicker rather than fill in. Doubling roughly every
 * two and a half levels gives about 14 pins over a continent, 40 over a
 * country, 130 over a region, and the full budget from city scale up — so each
 * notch of the wheel reveals a few more, which is what "zooming in shows more"
 * is supposed to feel like.
 */
function markerBudget(zoom: number): number {
  const grown = Math.round(MIN_MARKERS * 2 ** ((zoom - 3) / 2.5));
  return Math.max(MIN_MARKERS, Math.min(MAX_MARKERS, grown));
}

/** How far beyond the viewport we keep markers mounted, as a fraction of the view. */
const CULL_PADDING = 0.4;
/** Footprint of the preview card, used to decide whether a pin needs nudging. */
const POPUP_WIDTH_PX = 280;
const POPUP_HEIGHT_PX = 330;
/** Constant identity, for the same reason `openPosition` is memoised below. */
const POPUP_OFFSET: L.PointTuple = [0, -16];

interface JobMapProps {
  jobs: Job[];
  selectedCity: string;
  mapCenterTarget?: { lat: number; lng: number; zoom?: number } | null;
  hoveredJobId: string | null;
  hoveredListJobId?: string | null;
  selectedJobId: string | null;
  onHoverJob: (id: string | null) => void;
  onSelectJob: (job: Job) => void;
  onApplyJob?: (job: Job) => void;
  searchAsMapMoves: boolean;
  setSearchAsMapMoves?: (enabled: boolean) => void;
  onBoundsChange: (bounds: L.LatLngBounds | null) => void;
  onMapMoveStart?: () => void;
  onMapMoveEnd?: (center: { lat: number; lng: number }, bounds: L.LatLngBounds) => void;
  isLoadingMapMove?: boolean;
  savedJobIds: Set<string>;
  onToggleSave: (id: string) => void;
}

const hasCoords = (job: Job) => Number.isFinite(job.lat) && Number.isFinite(job.lng);

/**
 * Leaflet's flight math divides by the container size, so animating a camera
 * across a pane that is `display:none` produces NaN coordinates and throws,
 * which unmounts the whole app. Below the `md` breakpoint the map pane really
 * is hidden while the list is showing, so that is a normal state and not an
 * error: fly when there is something to fly across, otherwise jump, and the
 * view is already right by the time the pane is revealed.
 */
const isVisible = (map: L.Map) => {
  const size = map.getSize();
  return size.x > 0 && size.y > 0;
};

const moveTo = (map: L.Map, center: L.LatLngExpression, zoom: number) => {
  if (isVisible(map)) map.flyTo(center, zoom, { duration: 0.8 });
  else map.setView(center, zoom, { animate: false });
};

const moveToBounds = (map: L.Map, bounds: L.LatLngBounds, maxZoom: number, padding: L.PointTuple) => {
  if (isVisible(map)) map.flyToBounds(bounds, { padding, maxZoom, duration: 0.45 });
  else map.setView(bounds.getCenter(), Math.min(maxZoom, map.getZoom()), { animate: false });
};

/**
 * Tracks the map view, but only produces a new value when the markers actually
 * need to be recomputed: on zoom, or when the viewport leaves the padded window
 * we already rendered. Panning inside that window costs zero React work, so
 * Leaflet just translates the marker pane and the drag stays perfectly smooth.
 */
function useMapView(padding = CULL_PADDING) {
  const map = useMap();
  const [view, setView] = useState(() => ({
    zoom: map.getZoom(),
    bounds: map.getBounds().pad(padding),
  }));

  useEffect(() => {
    const update = () => {
      const zoom = map.getZoom();
      const visible = map.getBounds();
      setView((prev) => {
        if (prev.zoom === zoom && prev.bounds.contains(visible)) return prev;
        return { zoom, bounds: visible.pad(padding) };
      });
    };
    map.on('moveend', update);
    map.on('zoomend', update);
    map.on('resize', update);
    return () => {
      map.off('moveend', update);
      map.off('zoomend', update);
      map.off('resize', update);
    };
  }, [map, padding]);

  return view;
}

/** One job, at the point the map draws it. There is no other kind of marker. */
interface MapItem {
  key: string;
  lat: number;
  lng: number;
  job: Job;
}

/**
 * Giving every job its own spot on the map.
 *
 * Most employers publish a city, not a street, so the geocoder hands back one
 * town-centre coordinate and forty jobs land on the same pixel. The map then
 * says "40 jobs" and no amount of zooming ever takes it apart, which is the
 * opposite of how Airbnb reads — there, every listing is its own pin and going
 * in further keeps separating them.
 *
 * So a job with no published address is nudged to a stable point near the town
 * centre. Two rules keep that from turning into a lie:
 *
 *   * A job that *does* carry a real address is never touched. Those pins are
 *     the ones worth trusting, and moving them would throw away the only
 *     precise geography in the feed.
 *   * The nudge is at most ~700m, which is inside the same town and nowhere
 *     near the edge of a departement. It changes which pixel a pin sits on, not
 *     which place it is in — and the card still shows "Paris, Ile-de-France"
 *     with no street, so nothing claims a precision that does not exist.
 *
 * Derived from the job id, so a pin keeps the same bearing from its town centre
 * on every render, every pan and every reload. A random offset would make the
 * map crawl with movement.
 *
 * How far out it sits is a function of the zoom, and that is the part worth
 * explaining. A fixed distance on the ground cannot work at both ends: a town's
 * jobs need kilometres of separation to be distinguishable from thirty miles up
 * and a couple of hundred metres to stay on the same screen from street level.
 * 1600m threw every pin off the edges past zoom 15, and 700m — chosen to fix
 * that — left three pins visible over a city of six hundred jobs.
 *
 * So the fan is sized in pixels instead, and the same fan is drawn whatever the
 * zoom: about 180px of radius, which fills a 630px pane without spilling out of
 * it. Zooming in makes a town's pins bloom apart, zooming out draws them back
 * together, and each one keeps its bearing throughout, so the movement reads as
 * a group opening up rather than a reshuffle.
 *
 * Both limits are what keep it honest, in opposite directions.
 *
 * The cap: however far out the pixels say, a pin never moves more than 5km from
 * where the feed put it, which is inside the same municipality — the claim the
 * listing itself makes, and no more.
 *
 * The floor: the fan never shrinks below about a kilometre either, which is what
 * keeps street-level zoom from going blank. Every job in a town shares one
 * geocoded centre point, so a fan that kept shrinking would collapse them onto
 * that single spot and a 200m-wide view a street away would show nothing at all.
 * Holding the fan at town size instead says the true thing: these jobs are
 * somewhere around here, and which street is not something the listing states.
 * It stays well inside the 6km that `inViewOf` in App.tsx is willing to call
 * "this town", so the map never puts a pin somewhere the filter would disown.
 */
const SCATTER_RADIUS_PX = 180;
const SCATTER_MIN_M = 1200;
const SCATTER_MAX_M = 5000;
const METRES_PER_DEGREE_LAT = 111320;

/** Ground distance one screen pixel covers, at this zoom and latitude. */
const metresPerPixel = (zoom: number, lat: number) =>
  (METRES_PER_DEGREE_LAT * 360 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);

/** FNV-1a. Cheap, and well spread for short ids. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function scatterWithinCity(job: Job, zoom: number): Job {
  if (job.locationPrecision === 'exact') return job;

  const wanted = SCATTER_RADIUS_PX * metresPerPixel(zoom, job.lat);
  const spread = Math.min(SCATTER_MAX_M, Math.max(SCATTER_MIN_M, wanted));
  const h = hashId(job.id);
  const angle = ((h & 0xffff) / 0x10000) * 2 * Math.PI;
  // sqrt keeps the points evenly spread over the disc instead of piling up in
  // the middle, which is what a raw uniform radius does.
  const radius = Math.sqrt(((h >>> 16) & 0xffff) / 0x10000) * spread;

  const dLat = (radius * Math.sin(angle)) / METRES_PER_DEGREE_LAT;
  const dLng =
    (radius * Math.cos(angle)) /
    (METRES_PER_DEGREE_LAT * Math.cos((job.lat * Math.PI) / 180) || 1);

  // `lat`/`lng` are left exactly as the feed gave them. Only the map reads
  // these, so nothing else in the app can mistake a nudged pin for an address.
  return { ...job, mapLat: job.lat + dLat, mapLng: job.lng + dLng };
}

/** Where a job is drawn, which is its real coordinate unless it was scattered. */
const atLat = (job: Job) => job.mapLat ?? job.lat;
const atLng = (job: Job) => job.mapLng ?? job.lng;

/**
 * Which jobs get a pin when they cannot all have one, in priority order.
 *
 * Every job in view competes for screen space, and something has to decide who
 * wins. The order has to be *stable* — independent of zoom, of the viewport and
 * of the render — because that is what makes zooming feel like reveal rather
 * than reshuffle: a pin that earned its spot at zoom 11 still outranks its
 * neighbours at zoom 14, so it stays exactly where it was while new ones appear
 * around it. Sorting by anything the camera affects would make pins swap places
 * under the cursor on every scroll.
 *
 * A published salary comes first because it is the pin worth reading, then a
 * real street address over a town centroid, then the job id purely as a
 * tie-break that never changes.
 */
const jobRank = (job: Job): number => {
  let rank = hashId(job.id) / 0xffffffff; // 0..1, stable, breaks ties evenly
  if (job.salaryBadge && job.salaryBadge !== 'Direct ATS' && job.salaryBadge !== '€?') rank += 4;
  if (job.locationPrecision === 'exact') rank += 2;
  return rank;
};

/**
 * Stop pills from sitting on top of each other.
 *
 * A greedy pass in screen space: walk the jobs in priority order, keep the ones
 * that still have room, and drop the ones that do not.
 *
 * Dropping is the point. This used to fold the loser into the winner and relabel
 * it "15 jobs", which is how the map ended up covered in grey count bubbles that
 * hid the actual jobs behind them and did nothing useful when clicked. Airbnb
 * has no such thing: it shows individual pins and simply shows fewer of them
 * when there is no room, which is honest — the count in the results column is
 * already the authority on how many jobs are here, and the map's job is to place
 * the ones it can place.
 *
 * Nothing is lost, because the ranking above is fixed: zoom in, the same pins
 * stay put, and the ones that lost come back as the gaps between them widen.
 */
const PILL_HEIGHT_PX = 30;
const PILL_GAP_PX = 6;

const pillWidth = (job: Job): number => pinLabel(job).length * 7.1 + 26;

/**
 * Every pin is a labelled pill, at every zoom.
 *
 * Below zoom 11 these used to shrink to 14px dots, which is where "it stops
 * showing pills very early" came from — and it was worse than it sounds. The
 * rule that drew the dot's body had gone from the stylesheet at some point, so
 * what the map actually rendered under zoom 11 was a zero-sized empty div per
 * job: the pins did not shrink, they disappeared. Zooming out to ask the
 * broadest question — where is this work? — cleared the map.
 *
 * A pill is five times the width of a dot, so far fewer fit over a country, and
 * that is the right trade: a dozen pins you can read beats eighty you cannot.
 * No zoom threshold is needed to arrange it, either. The collision test below
 * already thins the pins to what the space will hold, and it does so at every
 * scale, which is why they now come back gradually as you go in instead of
 * switching on all at once at zoom 11.
 */
function declutter(jobs: Job[], zoom: number, map: L.Map, budget: number): MapItem[] {
  const halfHeight = PILL_HEIGHT_PX / 2 + PILL_GAP_PX;

  const kept: { x: number; y: number; halfWidth: number; item: MapItem }[] = [];

  for (const job of jobs) {
    if (kept.length >= budget) break;

    const lat = atLat(job);
    const lng = atLng(job);
    const point = map.project([lat, lng], zoom);
    const halfWidth = pillWidth(job) / 2 + PILL_GAP_PX;

    const clash = kept.some(
      (other) =>
        Math.abs(other.x - point.x) < other.halfWidth + halfWidth &&
        Math.abs(other.y - point.y) < halfHeight * 2
    );
    if (clash) continue;

    kept.push({ x: point.x, y: point.y, halfWidth, item: { key: job.id, lat, lng, job } });
  }

  return kept.map(({ item }) => item);
}

// Divicons are pure functions of their label + state, so they are cached and
// shared across markers instead of being rebuilt on every render.
const iconCache = new Map<string, L.DivIcon>();

const cachedIcon = (key: string, build: () => L.DivIcon): L.DivIcon => {
  const hit = iconCache.get(key);
  if (hit) return hit;
  const icon = build();
  if (iconCache.size > 400) iconCache.clear();
  iconCache.set(key, icon);
  return icon;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );

/**
 * Deliberately unaware of hover. Rebuilding the icon on hover makes Leaflet
 * destroy and recreate the marker's DOM node *under the cursor*, which fires
 * mouseout on the dead node and mouseover on the new one, forever. Mouse hover
 * is pure CSS (`.salary-pill:hover`); hover driven by the list is applied to
 * the live element in an effect further down.
 */
/**
 * What a pin says.
 *
 * Airbnb can put a price on every pin because every listing has one. Most
 * employers publish no salary at all, and the app used to fill that silence
 * with a number derived from a hash of the job title — a figure you would make
 * decisions on that nobody had ever stated. So: the real figure when the
 * employer gave one, and the company name when they did not. A pin reading
 * "Datadog" is less exciting than a pin reading "€75k" and has the advantage
 * of being true.
 */
const pinLabel = (job: Job): string => {
  const badge = (job.salaryBadge || '').trim();
  if (badge && badge !== 'Direct ATS' && badge !== '€?') return badge;
  const company = (job.company || '').trim();
  if (!company) return job.title || 'Job';
  // Long names blow the pill out to the width of a city, so clip rather than
  // let one employer cover its neighbours.
  return company.length > 18 ? company.slice(0, 17).trimEnd() + '…' : company;
};

const pillIcon = (label: string, isActive: boolean, isSaved: boolean) => {
  const classes = [
    'salary-pill',
    isActive ? 'is-active' : '',
    isSaved ? 'is-saved' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Zero-size icon plus a CSS translate, so the pill centres on its coordinate
  // whatever it says. A fixed 64px box was fine for "€75k" and would hang a
  // company name off to one side.
  return cachedIcon(`pill:${classes}:${label}`, () =>
    L.divIcon({
      className: 'salary-pill-wrapper',
      html: `<div class="${classes} is-centered">${escapeHtml(label)}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
      popupAnchor: [0, -16],
    })
  );
};

/**
 * The card that opens off a pin.
 *
 * Rewritten because the old one was a 264px box carrying nine competing
 * elements at 9.5-11px: category chip, "New" chip, heart, employer, date,
 * title, ATS badge, apply button, salary and a "Details" link. Airbnb's map
 * card shows a photo and four lines. Everything below either identifies the
 * job or lets you act on it; the rest went.
 */
const JobPreviewCard = React.memo<{
  job: Job;
  isSaved: boolean;
  onSelectJob: (job: Job) => void;
  onApplyJob?: (job: Job) => void;
  onToggleSave: (id: string) => void;
}>(({ job, isSaved, onSelectJob, onApplyJob, onToggleSave }) => {
  const isNew = job.postedDaysAgo !== undefined && job.postedDaysAgo <= 3;
  // An aggregator pin is a town centre, not the employer's door. The list card
  // already says so; the map card is where it matters most, because here the
  // location *is* the thing being looked at.
  const approximate = job.locationPrecision && job.locationPrecision !== 'exact';

  return (
    /* No cover image. On the map the photograph was the largest thing in the
     * card and it carried no information -- it is a stock shot, not the
     * office. What the reader is comparing between pins is company, role and
     * pay, so the card is now only those. It also lets the popup match the
     * translucent tiles in the list instead of being a white box on a dark
     * page, and halves its height, which matters when it has to sit over the
     * pin it belongs to without covering its neighbours. */
    <div
      onClick={() => onSelectJob(job)}
      className="w-[268px] cursor-pointer font-sans p-3.5"
    >
      <div className="flex items-baseline justify-between gap-2 pr-6">
        <span className="text-[13px] font-semibold text-[#f5f5f7] truncate">{job.company}</span>
        <span className="text-[11.5px] text-[rgba(235,235,245,0.42)] shrink-0">{job.postedAt}</span>
      </div>

      <h4 className="mt-1 text-[13.5px] font-medium text-[#f5f5f7] leading-snug line-clamp-2">
        {job.title}
      </h4>

      <p className="mt-1 text-[12px] text-[rgba(235,235,245,0.62)] truncate">
        {job.location}
        {approximate ? ' · approximate' : ''}
      </p>

      {isNew && (
        <span className="inline-flex mt-2 px-2 py-0.5 rounded-full bg-white/[0.14] text-[10.5px] font-semibold text-[#f5f5f7]">
          New
        </span>
      )}

      <div className="mt-2.5 pt-2.5 border-t border-white/[0.09] flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-[#f5f5f7] truncate">
            {job.salaryDisplay || 'Salary not published'}
          </span>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSave(job.id);
            }}
            className="shrink-0 p-1.5 rounded-full hover:bg-white/[0.12] transition"
            aria-label={isSaved ? 'Remove from saved jobs' : 'Save job'}
          >
            <Heart
              className={`w-4 h-4 ${
                isSaved ? 'fill-rose-500 text-rose-500' : 'text-[rgba(235,235,245,0.62)]'
              }`}
            />
          </button>

          {job.applyUrl && onApplyJob ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApplyJob(job);
              }}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-[#0a84ff] hover:bg-[#3b9bff] transition active:scale-95"
            >
              <Zap className="w-3 h-3 fill-white" />
              Apply
            </button>
          ) : job.applyUrl ? (
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-[#0a84ff] hover:bg-[#3b9bff] transition active:scale-95"
            >
              Apply
              <ArrowUpRight className="w-3 h-3" />
            </a>
          ) : null}
      </div>
    </div>
  );
});

const MarkerLayer: React.FC<{
  jobs: Job[];
  hoveredJobId: string | null;
  hoveredListJobId?: string | null;
  selectedJobId: string | null;
  savedJobIds: Set<string>;
  onHoverJob: (id: string | null) => void;
  onSelectJob: (job: Job) => void;
  onApplyJob?: (job: Job) => void;
  onToggleSave: (id: string) => void;
  isProgrammaticFlyRef: React.MutableRefObject<boolean>;
  suppressBoundsRef: React.MutableRefObject<boolean>;
}> = ({
  jobs,
  hoveredJobId: _hoveredJobId,
  hoveredListJobId,
  selectedJobId,
  savedJobIds,
  onHoverJob: _onHoverJob,
  onSelectJob,
  onApplyJob,
  onToggleSave,
  isProgrammaticFlyRef,
  suppressBoundsRef,
}) => {
  const map = useMap();
  const view = useMapView();
  const [openJob, setOpenJob] = useState<{ job: Job; lat: number; lng: number } | null>(null);
  const openJobId = openJob?.job.id ?? null;
  const markerRefs = useRef(new Map<string, L.Marker>());

  /**
   * Ranked once. A pure function of the job list, so panning and zooming never
   * redo it — and the fixed order is what lets `declutter` produce a stable
   * result at every zoom: which pins survive a collision never depends on how
   * you arrived at the view.
   */
  const placed = useMemo(
    () => jobs.filter(hasCoords).sort((a, b) => jobRank(b) - jobRank(a)),
    [jobs]
  );

  // Hover state is deliberately absent from this memo: re-running the layout for
  // hundreds of jobs every time the cursor crosses a pin is exactly what made
  // the map lag. Hovering only swaps a class, further down.
  const items = useMemo(() => {
    const pinned = new Set([selectedJobId, openJobId].filter(Boolean) as string[]);

    // Scatter before culling, not after: a pin's offset is what decides whether
    // it is on screen, and the offset is only known once the zoom is.
    const scattered = placed.map((job) => scatterWithinCity(job, view.zoom));

    // Cull to the padded viewport: everything else is invisible anyway. The open
    // and selected jobs jump the queue, so the card you are reading can never
    // lose its own pin to a collision.
    const visible = scattered.filter(
      (job) => view.bounds.contains([atLat(job), atLng(job)]) || pinned.has(job.id)
    );
    const ordered = pinned.size
      ? [...visible].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)))
      : visible;

    return declutter(ordered, view.zoom, map, markerBudget(view.zoom));
  }, [placed, view, map, selectedJobId, openJobId]);

  const popupRef = useRef<L.Popup | null>(null);

  /**
   * Where the open card points, read from the live layout rather than from
   * wherever the pin was when it was clicked. The scatter widens as you zoom,
   * so a card that remembered its opening coordinates would drift off its own
   * pin the moment the map moved under it. The open job is always in `items` —
   * it is pinned there — so the fallback is only for the frame before that.
   */
  const openItem = openJobId ? items.find((item) => item.key === openJobId) : undefined;
  const openLat = openItem?.lat ?? openJob?.lat;
  const openLng = openItem?.lng ?? openJob?.lng;

  /**
   * A stable tuple, and it matters more than it looks.
   *
   * react-leaflet's Popup lifecycle effect lists `position` in its dependency
   * array, and compares it by identity. Passing `[openJob.lat, openJob.lng]`
   * inline built a fresh array on every render, so every render ran the effect's
   * cleanup — `map.removeLayer(popup)` — and then re-opened it. The card was
   * being destroyed and rebuilt, image and all, each time the cursor moved onto
   * another pin or across a row in the list. That is the flicker. Memoising on
   * the two numbers keeps one array alive for as long as the pin sits still.
   */
  const openPosition = useMemo<L.LatLngTuple | undefined>(
    () => (openLat != null && openLng != null ? [openLat, openLng] : undefined),
    [openLat, openLng]
  );

  useEffect(() => {
    if (!openJob) return;
    const onClose = (event: L.PopupEvent) => {
      const closed = event.popup;
      requestAnimationFrame(() => {
        if (closed.isOpen()) return;
        if (popupRef.current && popupRef.current !== closed) return;
        setOpenJob(null);
      });
    };
    map.on('popupclose', onClose);
    return () => {
      map.off('popupclose', onClose);
    };
  }, [map, openJob]);

  /**
   * Airbnb holds the map still when you open a card. Only nudge it when the
   * card would be clipped, and only by as much as it takes to reveal it -
   * moving the viewport further would change which jobs are in view, which is
   * not something opening a card should ever do.
   */
  const revealPopup = useCallback(
    (lat: number, lng: number, popupHeight: number) => {
      const size = map.getSize();
      const pt = map.latLngToContainerPoint([lat, lng]);
      const margin = 14;
      let dx = 0;
      let dy = 0;
      if (pt.y - popupHeight < margin) dy = pt.y - popupHeight - margin;
      else if (pt.y > size.y - margin) dy = pt.y - (size.y - margin);
      if (pt.x - POPUP_WIDTH_PX / 2 < margin) dx = pt.x - POPUP_WIDTH_PX / 2 - margin;
      else if (pt.x + POPUP_WIDTH_PX / 2 > size.x - margin) {
        dx = pt.x + POPUP_WIDTH_PX / 2 - (size.x - margin);
      }
      if (!dx && !dy) return;

      isProgrammaticFlyRef.current = true;
      suppressBoundsRef.current = true;
      map.panBy([dx, dy], { animate: true, duration: 0.25 });
    },
    [map, isProgrammaticFlyRef, suppressBoundsRef]
  );

  const handlePinClick = useCallback(
    (item: { job: Job; lat: number; lng: number }) => {
      setOpenJob({ job: item.job, lat: item.lat, lng: item.lng });
      revealPopup(item.lat, item.lng, POPUP_HEIGHT_PX);
    },
    [revealPopup]
  );

  // List hover is painted straight onto the existing marker element. Going
  // through `icon` would remount the node and restart Leaflet's hover tracking.
  useEffect(() => {
    const id = hoveredListJobId;
    if (!id) return;
    const element = markerRefs.current.get(id)?.getElement()?.firstElementChild;
    if (!element) return;
    element.classList.add('is-hovered');
    return () => element.classList.remove('is-hovered');
  }, [hoveredListJobId, items]);

  // One stable callback per key: a fresh function identity on every render would
  // make React detach and re-attach every marker ref on every pan.
  const [refCallbacks] = useState(() => new Map<string, (instance: L.Marker | null) => void>());
  const registerRef = useCallback(
    (key: string) => {
      const existing = refCallbacks.get(key);
      if (existing) return existing;
      const callback = (instance: L.Marker | null) => {
        if (instance) markerRefs.current.set(key, instance);
        else markerRefs.current.delete(key);
      };
      if (refCallbacks.size > 2000) refCallbacks.clear();
      refCallbacks.set(key, callback);
      return callback;
    },
    [refCallbacks]
  );

  return (
    <>
      {items.map((item) => {
        const { job } = item;
        const isActive = selectedJobId === job.id || openJobId === job.id;
        const isSaved = savedJobIds.has(job.id);

        return (
          <Marker
            key={job.id}
            ref={registerRef(job.id)}
            position={[item.lat, item.lng]}
            icon={pillIcon(pinLabel(job), isActive, isSaved)}
            zIndexOffset={isActive ? 1000 : 0}
            eventHandlers={{
              click: () => handlePinClick(item),
            }}
          />
        );
      })}

      {openJob && (
        <Popup
          key={`job-${openJob.job.id}`}
          ref={popupRef}
          position={openPosition}
          offset={POPUP_OFFSET}
          /* No close button. It was a grey circle sitting on the card's own
           * title, and it was the only chrome on an otherwise clean preview.
           * Leaflet already closes a popup on a click anywhere on the map, on
           * Escape, and on opening another pin -- all three are defaults and
           * all three are left on, so nothing is lost but the button. */
          closeButton={false}
          autoPan={false}
          className="job-map-popup"
        >
          <JobPreviewCard
            job={openJob.job}
            isSaved={savedJobIds.has(openJob.job.id)}
            onSelectJob={onSelectJob}
            onApplyJob={onApplyJob}
            onToggleSave={onToggleSave}
          />
        </Popup>
      )}

    </>
  );
};

/**
 * Bridges React props to imperative Leaflet camera commands, and reports the
 * viewport back exactly once per settled move. Programmatic flights (clicking a
 * pin, jumping to a city) are flagged so they never trigger a new search.
 */
const MapController: React.FC<{
  selectedCity: string;
  mapCenterTarget?: { lat: number; lng: number; zoom?: number } | null;
  onBoundsChange: (bounds: L.LatLngBounds | null) => void;
  onMapMoveStart?: () => void;
  onMapMoveEnd?: (center: { lat: number; lng: number }, bounds: L.LatLngBounds) => void;
  isProgrammaticFlyRef: React.MutableRefObject<boolean>;
  suppressBoundsRef: React.MutableRefObject<boolean>;
}> = ({
  selectedCity,
  mapCenterTarget,
  onBoundsChange,
  onMapMoveStart,
  onMapMoveEnd,
  isProgrammaticFlyRef,
  suppressBoundsRef,
}) => {
  const map = useMap();
  // Latest callbacks without re-subscribing the Leaflet listeners on every render.
  const handlersRef = useRef({ onBoundsChange, onMapMoveStart, onMapMoveEnd });
  useEffect(() => {
    handlersRef.current = { onBoundsChange, onMapMoveStart, onMapMoveEnd };
  });

  // The map lives in a flex pane that resizes with the sidebar and the window.
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  useEffect(() => {
    const started = () => {
      if (isProgrammaticFlyRef.current) return;
      handlersRef.current.onMapMoveStart?.();
    };
    const ended = () => {
      const bounds = map.getBounds();
      if (suppressBoundsRef.current) {
        // A card-revealing nudge. It must not narrow the result set, or opening
        // one job would silently drop its neighbours out of the list.
        suppressBoundsRef.current = false;
        isProgrammaticFlyRef.current = false;
        return;
      }
      handlersRef.current.onBoundsChange(bounds);
      if (isProgrammaticFlyRef.current) {
        isProgrammaticFlyRef.current = false;
        return;
      }
      const c = map.getCenter();
      handlersRef.current.onMapMoveEnd?.({ lat: c.lat, lng: c.lng }, bounds);
    };
    map.on('movestart', started);
    map.on('moveend', ended);
    handlersRef.current.onBoundsChange(map.getBounds());
    return () => {
      map.off('movestart', started);
      map.off('moveend', ended);
    };
  }, [map, isProgrammaticFlyRef, suppressBoundsRef]);

  useEffect(() => {
    if (!mapCenterTarget) return;
    isProgrammaticFlyRef.current = true;
    moveTo(map, [mapCenterTarget.lat, mapCenterTarget.lng], mapCenterTarget.zoom ?? map.getZoom());
  }, [map, mapCenterTarget, isProgrammaticFlyRef]);

  useEffect(() => {
    const city = CITIES.find((c) => c.id === selectedCity);
    if (!city) return;
    isProgrammaticFlyRef.current = true;
    moveTo(map, [city.lat, city.lng], city.zoom ?? 12);
  }, [map, selectedCity, isProgrammaticFlyRef]);

  return null;
};

const AirbnbMapControls: React.FC<{
  jobs: Job[];
  searchAsMapMoves: boolean;
  setSearchAsMapMoves?: (enabled: boolean) => void;
  isProgrammaticFlyRef: React.MutableRefObject<boolean>;
}> = ({ jobs, searchAsMapMoves, setSearchAsMapMoves, isProgrammaticFlyRef }) => {
  const map = useMap();

  const fitToJobs = useCallback(() => {
    const placed = jobs.filter(hasCoords);
    if (!placed.length) return;
    isProgrammaticFlyRef.current = true;
    moveToBounds(
      map,
      L.latLngBounds(placed.map((j) => [j.lat, j.lng] as L.LatLngTuple)),
      14,
      [60, 60]
    );
  }, [jobs, map, isProgrammaticFlyRef]);

  return (
    <div className="absolute top-4 right-4 z-[1000] flex flex-col items-end gap-2">
      {setSearchAsMapMoves && (
        <label className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/95 backdrop-blur shadow-[0_2px_8px_rgba(0,0,0,0.18)] text-[11px] font-bold text-gray-900 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={searchAsMapMoves}
            onChange={(e) => setSearchAsMapMoves(e.target.checked)}
            className="w-3.5 h-3.5 accent-rose-600 cursor-pointer"
          />
          <span>Search as I move the map</span>
        </label>
      )}

      <div className="flex flex-col rounded-xl overflow-hidden bg-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]">
        <button
          type="button"
          onClick={() => map.zoomIn()}
          aria-label="Zoom in"
          className="w-9 h-9 flex items-center justify-center text-lg font-bold text-gray-800 hover:bg-gray-100 transition"
        >
          +
        </button>
        <span className="h-px bg-gray-200" />
        <button
          type="button"
          onClick={() => map.zoomOut()}
          aria-label="Zoom out"
          className="w-9 h-9 flex items-center justify-center text-lg font-bold text-gray-800 hover:bg-gray-100 transition"
        >
          −
        </button>
        <span className="h-px bg-gray-200" />
        <button
          type="button"
          onClick={fitToJobs}
          aria-label="Fit all jobs in view"
          className="w-9 h-9 flex items-center justify-center text-gray-800 hover:bg-gray-100 transition"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

const DEFAULT_CENTER: L.LatLngTuple = [51.4416, 5.4697];

export const JobMap: React.FC<JobMapProps> = ({
  jobs,
  selectedCity,
  mapCenterTarget,
  hoveredJobId,
  hoveredListJobId,
  selectedJobId,
  onHoverJob,
  onSelectJob,
  onApplyJob,
  searchAsMapMoves,
  setSearchAsMapMoves,
  onBoundsChange,
  onMapMoveStart,
  onMapMoveEnd,
  isLoadingMapMove,
  savedJobIds,
  onToggleSave,
}) => {
  // Set while the app itself moves the camera, so those moves are not mistaken
  // for the user exploring and do not kick off a fresh search.
  const isProgrammaticFlyRef = useRef(false);
  // Set for the small pan that reveals a preview card: that move must not be
  // allowed to change which jobs the viewport is considered to contain.
  const suppressBoundsRef = useRef(false);

  const initial = useMemo(() => {
    const city = CITIES.find((c) => c.id === selectedCity);
    return {
      center: city ? ([city.lat, city.lng] as L.LatLngTuple) : DEFAULT_CENTER,
      zoom: city?.zoom ?? 12,
    };
    // Only the very first mount matters; later changes are handled by flyTo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative w-full h-full">
      <MapContainer
        center={initial.center}
        zoom={initial.zoom}
        minZoom={3}
        /**
         * Deliberately short of the 18 the tiles go to.
         *
         * Employers publish a town, not a street. Zoom past a kilometre or so
         * across and there is simply nothing left to show at that scale: the
         * pins thin out to one or two, not because the jobs went away — the
         * column beside the map still counts hundreds — but because no listing
         * claims to be on the street you are looking at. Letting the map keep
         * going only draws an emptier and emptier picture of the same jobs.
         *
         * 16 is roughly a 900m-wide view, which is the finest scale the data can
         * honestly fill.
         */
        maxZoom={16}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom
        /**
         * One wheel notch used to cross a whole zoom level, which is a 2x jump in
         * scale — you aim at a street and land on a region. Leaflet's default
         * makes that unavoidable: it computes a fractional step and then rounds it
         * *up* to the next `zoomSnap`, so with a snap of 1 the smallest possible
         * movement is a full level however gently you scroll.
         *
         * Half-levels, at 180px of wheel travel each, put one notch at exactly
         * 0.5 — measured, and stable whether the mouse reports 100 or 120 per
         * notch. Two notches per level instead of one.
         *
         * Fractional zoom is free in sharpness here: the `@2x` tile arrives
         * 1024px for the 512px box below, so a whole level is supersampled 2:1
         * and even a half level still has 1.41x the pixels it needs.
         * `zoomDelta` is left at 1 so the +/- buttons and the keyboard still move
         * a full, definite step.
         */
        zoomSnap={0.5}
        zoomDelta={1}
        wheelPxPerZoomLevel={180}
        // The marker pane animates as one CSS transform, which stays cheap
        // because the budget above keeps the pin count in the low hundreds.
        markerZoomAnimation
        zoomAnimationThreshold={3}
        className="w-full h-full"
        style={{ background: '#e8e6e1' }}
      >
        {/*
          * (512, -1): the native pairing, where a Mapbox tile is drawn at the
          * size it was rendered for.
          *
          * A raster layer lines up only while `tileSize * 2^zoomOffset === 256`,
          * which admits (256, 0), (512, -1), (1024, -2)... and each step along
          * that list draws a tile from one zoom level further out at twice the
          * size. Label size and cartographic detail are therefore the same
          * knob, turned in opposite directions, in steps of 2 -- there is no
          * "slightly smaller" on a raster layer, and no text-size parameter
          * either.
          *
          * This was at (1024, -2) to answer "I can't read the location", and
          * the bill came due: doubling the type also meant always drawing the
          * cartography of two zoom levels out. A city view was rendered with a
          * region's map -- no street names, no parks worth the word, no shops
          * or stations, since Mapbox only draws those from about z14 -- so the
          * page carried enormous labels over an empty country road. "The text
          * is very big" and "make the map more alive" are one fault, not two.
          *
          * What changed in between is the pane. Those labels were measured in a
          * 560px column beside the listings, where 11px did read as small; the
          * map is the whole canvas now, and at this width it is the label size
          * every map product uses, with several times as many of them. `@2x`
          * puts a 1024px image in the 512px box, so the small type is drawn
          * from four physical pixels per logical one -- sharper than the old
          * arrangement ever was, which is most of what makes small type
          * legible.
          */}
        <TileLayer
          url={`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`}
          tileSize={512}
          zoomOffset={-1}
          detectRetina={false}
          // Skip intermediate tile requests mid-gesture and keep a ring of
          // off-screen tiles either side so panning never exposes grey.
          updateWhenZooming={false}
          updateWhenIdle
          keepBuffer={2}
          maxZoom={18}
        />

        <MapController
          selectedCity={selectedCity}
          mapCenterTarget={mapCenterTarget}
          onBoundsChange={onBoundsChange}
          onMapMoveStart={onMapMoveStart}
          onMapMoveEnd={onMapMoveEnd}
          isProgrammaticFlyRef={isProgrammaticFlyRef}
          suppressBoundsRef={suppressBoundsRef}
        />

        <MarkerLayer
          jobs={jobs}
          hoveredJobId={hoveredJobId}
          hoveredListJobId={hoveredListJobId}
          selectedJobId={selectedJobId}
          savedJobIds={savedJobIds}
          onHoverJob={onHoverJob}
          onSelectJob={onSelectJob}
          onApplyJob={onApplyJob}
          onToggleSave={onToggleSave}
          isProgrammaticFlyRef={isProgrammaticFlyRef}
          suppressBoundsRef={suppressBoundsRef}
        />

        <AirbnbMapControls
          jobs={jobs}
          searchAsMapMoves={searchAsMapMoves}
          setSearchAsMapMoves={setSearchAsMapMoves}
          isProgrammaticFlyRef={isProgrammaticFlyRef}
        />
      </MapContainer>

      {isLoadingMapMove && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
          <span className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-white/95 backdrop-blur shadow-[0_2px_8px_rgba(0,0,0,0.18)] text-[11px] font-bold text-gray-900">
            <span className="w-3 h-3 rounded-full border-2 border-gray-300 border-t-gray-900 animate-spin" />
            Updating jobs…
          </span>
        </div>
      )}
    </div>
  );
};

export default JobMap;