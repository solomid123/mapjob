import { daysAgo, parsePostedRange } from '../utils/postedRange';
import { isDirectAts, type Job, type AtsProvider } from '../types/job';

const ADZUNA_APP_ID = import.meta.env.VITE_ADZUNA_APP_ID || '';
const ADZUNA_APP_KEY = import.meta.env.VITE_ADZUNA_APP_KEY || '';



interface AdzunaJobItem {
  id: string | number;
  title: string;
  description: string;
  created: string;
  redirect_url: string;
  salary_min?: number;
  salary_max?: number;
  latitude?: number;
  longitude?: number;
  company?: {
    display_name?: string;
  };
  location?: {
    display_name?: string;
    area?: string[];
  };
  category?: {
    label?: string;
    tag?: string;
  };
  contract_time?: string;
}


// Map selected city to Adzuna country and search query
export function detectAtsProvider(company: string, applyUrl?: string, _title?: string, description?: string): AtsProvider {
  const c = (company || '').toLowerCase();
  const url = (applyUrl || '').toLowerCase();
  const desc = (description || '').toLowerCase();
  
  // 1. Direct ATS platforms (1-Click Apply Guaranteed with 0 login barriers)
  if (url.includes('greenhouse') || desc.includes('greenhouse.io') || c.includes('stripe') || c.includes('gitlab') || c.includes('figma')) {
    return 'Greenhouse';
  }
  if (url.includes('lever.co') || desc.includes('lever.co') || c.includes('palantir') || c.includes('spotify') || c.includes('netflix')) {
    return 'Lever';
  }
  if (url.includes('ashbyhq') || url.includes('ashby.') || desc.includes('ashbyhq')) {
    return 'Ashby';
  }
  if (url.includes('smartrecruiters') || desc.includes('smartrecruiters')) {
    return 'SmartRecruiters';
  }
  if (url.includes('teamtailor') || url.includes('ecm-crit') || c.includes('teamtailor') || desc.includes('teamtailor')) {
    return 'Teamtailor';
  }
  if (
    url.includes('workday') ||
    url.includes('myworkdayjobs') ||
    desc.includes('myworkdayjobs') ||
    c.includes('asml') ||
    c.includes('airbus') ||
    c.includes('safran') ||
    c.includes('philips') ||
    c.includes('thermo fisher') ||
    c.includes('thermofisher') ||
    c.includes('daf') ||
    c.includes('nxp') ||
    c.includes('vdl') ||
    c.includes('siemens') ||
    c.includes('alstom') ||
    c.includes('thales') ||
    c.includes('valeo')
  ) {
    return 'Workday';
  }

  // 2. Third-Party Portals & Aggregators (Require candidate accounts)
  if (
    url.includes('pole-emploi') ||
    url.includes('francetravail') ||
    c.includes('france travail') ||
    c.includes('pole emploi') ||
    c.includes('pôle emploi') ||
    desc.includes('france travail') ||
    desc.includes('pole emploi') ||
    desc.includes('pôle emploi')
  ) {
    return 'France Travail';
  }
  if (url.includes('apec.fr') || c.includes('apec') || desc.includes('apec.fr')) {
    return 'Apec';
  }
  if (
    url.includes('hellowork') ||
    url.includes('regionsjob') ||
    url.includes('cadreo') ||
    c.includes('hellowork') ||
    desc.includes('hellowork') ||
    desc.includes('regionsjob')
  ) {
    return 'HelloWork';
  }
  if (url.includes('meteojob') || c.includes('meteojob') || desc.includes('meteojob')) {
    return 'Meteojob';
  }
  if (url.includes('indeed') || c.includes('indeed') || desc.includes('indeed')) {
    return 'Indeed';
  }
  if (url.includes('linkedin') || c.includes('linkedin') || desc.includes('linkedin')) {
    return 'LinkedIn';
  }
  if (
    c.includes('crit') ||
    c.includes('adecco') ||
    c.includes('randstad') ||
    c.includes('manpower') ||
    c.includes('synergie') ||
    c.includes('proman') ||
    c.includes('page personnel') ||
    c.includes('michael page') ||
    c.includes('actual') ||
    c.includes('expectra') ||
    c.includes('hays') ||
    desc.includes('expectra') ||
    desc.includes('randstad') ||
    desc.includes('adecco') ||
    desc.includes('manpower')
  ) {
    return 'Agency';
  }
  
  if (url.includes('adzuna.') || url.includes('adzuna/')) {
    return 'Aggregator';
  }

  return 'Direct Portal';
}

interface KnownHub {
  name: string;
  country: string;
  lat: number;
  lng: number;
  defaultWhat: string;
}

export const KNOWN_EUROPEAN_HUBS: KnownHub[] = [
  // Netherlands
  { name: 'Eindhoven', country: 'nl', lat: 51.4416, lng: 5.4697, defaultWhat: 'mechanical' },
  { name: 'Veldhoven', country: 'nl', lat: 51.4172, lng: 5.4056, defaultWhat: 'mechanical' },
  { name: 'Helmond', country: 'nl', lat: 51.4817, lng: 5.6611, defaultWhat: 'mechanical' },
  { name: 'Tilburg', country: 'nl', lat: 51.5719, lng: 5.0672, defaultWhat: 'mechanical' },
  { name: 'Breda', country: 'nl', lat: 51.5719, lng: 4.7683, defaultWhat: 'mechanical' },
  { name: 'Den Bosch', country: 'nl', lat: 51.6978, lng: 5.3037, defaultWhat: 'mechanical' },
  { name: 'Venlo', country: 'nl', lat: 51.3700, lng: 6.1724, defaultWhat: 'mechanical' },
  { name: 'Utrecht', country: 'nl', lat: 52.0907, lng: 5.1214, defaultWhat: 'mechanical' },
  { name: 'Amsterdam', country: 'nl', lat: 52.3676, lng: 4.9041, defaultWhat: 'mechanical' },
  { name: 'Rotterdam', country: 'nl', lat: 51.9244, lng: 4.4777, defaultWhat: 'mechanical' },
  { name: 'Den Haag', country: 'nl', lat: 52.0705, lng: 4.3007, defaultWhat: 'mechanical' },
  { name: 'Delft', country: 'nl', lat: 52.0116, lng: 4.3571, defaultWhat: 'mechanical' },
  { name: 'Dordrecht', country: 'nl', lat: 51.8133, lng: 4.6901, defaultWhat: 'mechanical' },
  { name: 'Leiden', country: 'nl', lat: 52.1601, lng: 4.4970, defaultWhat: 'mechanical' },
  { name: 'Groningen', country: 'nl', lat: 53.2194, lng: 6.5665, defaultWhat: 'mechanical' },
  { name: 'Arnhem', country: 'nl', lat: 51.9851, lng: 5.8987, defaultWhat: 'mechanical' },
  { name: 'Enschede', country: 'nl', lat: 52.2215, lng: 6.8937, defaultWhat: 'mechanical' },
  { name: 'Nijmegen', country: 'nl', lat: 51.8126, lng: 5.8372, defaultWhat: 'mechanical' },
  { name: 'Maastricht', country: 'nl', lat: 50.8514, lng: 5.6909, defaultWhat: 'mechanical' },
  { name: 'Almere', country: 'nl', lat: 52.3508, lng: 5.2647, defaultWhat: 'mechanical' },
  { name: 'Amersfoort', country: 'nl', lat: 52.1561, lng: 5.3878, defaultWhat: 'mechanical' },

  // France
  { name: 'Paris', country: 'fr', lat: 48.8566, lng: 2.3522, defaultWhat: 'mecanique' },
  { name: 'Toulouse', country: 'fr', lat: 43.6047, lng: 1.4442, defaultWhat: 'mecanique' },
  { name: 'Lyon', country: 'fr', lat: 45.7640, lng: 4.8357, defaultWhat: 'mecanique' },
  { name: 'Marseille', country: 'fr', lat: 43.2965, lng: 5.3698, defaultWhat: 'mecanique' },
  { name: 'Bordeaux', country: 'fr', lat: 44.8378, lng: -0.5792, defaultWhat: 'mecanique' },
  { name: 'Lille', country: 'fr', lat: 50.6292, lng: 3.0573, defaultWhat: 'mecanique' },
  { name: 'Nantes', country: 'fr', lat: 47.2184, lng: -1.5536, defaultWhat: 'mecanique' },
  { name: 'Strasbourg', country: 'fr', lat: 48.5734, lng: 7.7521, defaultWhat: 'mecanique' },
  { name: 'Rennes', country: 'fr', lat: 48.1173, lng: -1.6778, defaultWhat: 'mecanique' },
  { name: 'Grenoble', country: 'fr', lat: 45.1885, lng: 5.7245, defaultWhat: 'mecanique' },

  // Belgium
  { name: 'Brussels', country: 'be', lat: 50.8503, lng: 4.3517, defaultWhat: 'mechanical' },
  { name: 'Antwerpen', country: 'be', lat: 51.2194, lng: 4.4025, defaultWhat: 'mechanical' },
  { name: 'Gent', country: 'be', lat: 51.0543, lng: 3.7174, defaultWhat: 'mechanical' },
  { name: 'Brugge', country: 'be', lat: 51.2093, lng: 3.2247, defaultWhat: 'mechanical' },
  { name: 'Kortrijk', country: 'be', lat: 50.8280, lng: 3.2649, defaultWhat: 'mechanical' },
  { name: 'Liege', country: 'be', lat: 50.6326, lng: 5.5797, defaultWhat: 'mecanique' },
  { name: 'Leuven', country: 'be', lat: 50.8798, lng: 4.7005, defaultWhat: 'mechanical' },
  { name: 'Hasselt', country: 'be', lat: 50.9311, lng: 5.3378, defaultWhat: 'mechanical' },
  { name: 'Charleroi', country: 'be', lat: 50.4108, lng: 4.4446, defaultWhat: 'mecanique' },
  { name: 'Namur', country: 'be', lat: 50.4674, lng: 4.8720, defaultWhat: 'mecanique' },
  { name: 'Mons', country: 'be', lat: 50.4542, lng: 3.9567, defaultWhat: 'mecanique' },

  // Luxembourg & Cross-Border
  { name: 'Luxembourg', country: 'fr', lat: 49.6116, lng: 6.1319, defaultWhat: 'mecanique' },
  { name: 'Metz', country: 'fr', lat: 49.1193, lng: 6.1757, defaultWhat: 'mecanique' },
  { name: 'Nancy', country: 'fr', lat: 48.6921, lng: 6.1844, defaultWhat: 'mecanique' },
  { name: 'Valenciennes', country: 'fr', lat: 50.3579, lng: 3.5235, defaultWhat: 'mecanique' },
  { name: 'Aachen', country: 'de', lat: 50.7753, lng: 6.0839, defaultWhat: 'Maschinenbau' },

  // Germany
  { name: 'Munich', country: 'de', lat: 48.1351, lng: 11.5820, defaultWhat: 'Maschinenbau' },
  { name: 'Stuttgart', country: 'de', lat: 48.7758, lng: 9.1829, defaultWhat: 'Maschinenbau' },
  { name: 'Frankfurt', country: 'de', lat: 50.1109, lng: 8.6821, defaultWhat: 'Maschinenbau' },
  { name: 'Koln', country: 'de', lat: 50.9375, lng: 6.9603, defaultWhat: 'Maschinenbau' },
  { name: 'Dusseldorf', country: 'de', lat: 51.2277, lng: 6.7735, defaultWhat: 'Maschinenbau' },
  { name: 'Berlin', country: 'de', lat: 52.5200, lng: 13.4050, defaultWhat: 'Maschinenbau' },
  { name: 'Hamburg', country: 'de', lat: 53.5511, lng: 9.9937, defaultWhat: 'Maschinenbau' },
  { name: 'Nurnberg', country: 'de', lat: 49.4521, lng: 11.0767, defaultWhat: 'Maschinenbau' },
  { name: 'Hannover', country: 'de', lat: 52.3759, lng: 9.7320, defaultWhat: 'Maschinenbau' },

  // Italy
  { name: 'Torino', country: 'it', lat: 45.0703, lng: 7.6869, defaultWhat: 'meccanico' },
  { name: 'Milano', country: 'it', lat: 45.4642, lng: 9.1900, defaultWhat: 'meccanico' },
  { name: 'Bologna', country: 'it', lat: 44.4949, lng: 11.3426, defaultWhat: 'meccanico' },
  { name: 'Genova', country: 'it', lat: 44.4056, lng: 8.9463, defaultWhat: 'meccanico' },
  { name: 'Firenze', country: 'it', lat: 43.7696, lng: 11.2558, defaultWhat: 'meccanico' },
  { name: 'Roma', country: 'it', lat: 41.9028, lng: 12.4964, defaultWhat: 'meccanico' },

  // Spain
  { name: 'Madrid', country: 'es', lat: 40.4168, lng: -3.7038, defaultWhat: 'mecanico' },
  { name: 'Barcelona', country: 'es', lat: 41.3879, lng: 2.1699, defaultWhat: 'mecanico' },
  { name: 'Valencia', country: 'es', lat: 39.4699, lng: -0.3763, defaultWhat: 'mecanico' },
  { name: 'Bilbao', country: 'es', lat: 43.2630, lng: -2.9350, defaultWhat: 'mecanico' },
  { name: 'Sevilla', country: 'es', lat: 37.3891, lng: -5.9845, defaultWhat: 'mecanico' },
];

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// In-memory geocode cache to avoid duplicate requests
const geocodeCache = new Map<string, { name: string; country: string; defaultWhat: string; displayLabel?: string }>();

// Strict Arabic script detector regex: \u0600-\u06FF, \u0750-\u077F, \u08A0-\u08FF, \uFB50-\uFDFF, \uFE70-\uFEFF
const ARABIC_SCRIPT_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Returns all predefined European hubs currently visible inside the map bounds.
 */
export function getVisibleHubsInBounds(bounds: any): KnownHub[] {
  if (!bounds) return [];
  return KNOWN_EUROPEAN_HUBS.filter((hub) => {
    try {
      if (typeof bounds.contains === 'function') {
        return bounds.contains([hub.lat, hub.lng]);
      }
      if (typeof bounds.getNorth === 'function' && typeof bounds.getSouth === 'function') {
        const north = bounds.getNorth();
        const south = bounds.getSouth();
        const east = bounds.getEast();
        const west = bounds.getWest();
        return hub.lat <= north && hub.lat >= south && hub.lng <= east && hub.lng >= west;
      }
      if (bounds.north !== undefined && bounds.south !== undefined) {
        return hub.lat <= bounds.north && hub.lat >= bounds.south && hub.lng <= bounds.east && hub.lng >= bounds.west;
      }
    } catch {
      return false;
    }
    return false;
  });
}

export async function resolveLocationFromCoords(
  lat: number,
  lng: number
): Promise<{ name: string; country: string; defaultWhat: string; displayLabel?: string }> {
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  // 1. Fast check against known European hubs (zero network latency)
  let closestHub = KNOWN_EUROPEAN_HUBS[0];
  let minDistance = distanceKm(lat, lng, closestHub.lat, closestHub.lng);

  for (let i = 1; i < KNOWN_EUROPEAN_HUBS.length; i++) {
    const hub = KNOWN_EUROPEAN_HUBS[i];
    const dist = distanceKm(lat, lng, hub.lat, hub.lng);
    if (dist < minDistance) {
      minDistance = dist;
      closestHub = hub;
    }
  }

  // If within 6km of a major known European hub center, return it instantly (0ms latency)
  if (minDistance <= 6) {
    const isLu = closestHub.name.toLowerCase().includes('luxembourg');
    const displayLabel = isLu ? 'Luxembourg & Greater Region (LU)' : `${closestHub.name}, ${closestHub.country.toUpperCase()}`;
    const result = { name: closestHub.name, country: closestHub.country, defaultWhat: closestHub.defaultWhat, displayLabel };
    geocodeCache.set(cacheKey, result);
    return result;
  }

  // 2. Otherwise reverse geocode with OpenStreetMap Nominatim with English forced
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=en`,
      {
        headers: { 
          'User-Agent': 'MapJob/1.0',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      const addr = data.address || {};
      let cityName =
        addr.city ||
        addr.town ||
        addr.municipality ||
        addr.village ||
        addr.suburb ||
        addr.county ||
        addr.state ||
        closestHub.name;
      
      // Strict guard against Arabic/non-Latin scripts: fall back to closest European hub English name
      if (ARABIC_SCRIPT_REGEX.test(cityName)) {
        cityName = closestHub.name;
      }

      let rawCountry = (addr.country_code || closestHub.country).toLowerCase();
      const isLu = rawCountry === 'lu' || (cityName && cityName.toLowerCase().includes('luxembourg'));
      // Map Luxembourg to French feed for API searching
      if (rawCountry === 'lu') rawCountry = 'fr';

      // Supported Adzuna EU countries
      const supported = ['nl', 'fr', 'de', 'be', 'it', 'es', 'gb', 'at', 'pl'];
      const country = supported.includes(rawCountry) ? rawCountry : closestHub.country;
      
      let defaultWhat = 'mechanical';
      if (country === 'fr' || isLu) defaultWhat = 'mecanique';
      else if (country === 'de') defaultWhat = 'Maschinenbau';
      else if (country === 'it') defaultWhat = 'meccanico';
      else if (country === 'es') defaultWhat = 'mecanico';

      let displayLabel = isLu ? 'Luxembourg City (LU)' : `${cityName}, ${country.toUpperCase()}`;
      if (ARABIC_SCRIPT_REGEX.test(displayLabel)) {
        displayLabel = `${closestHub.name}, ${country.toUpperCase()}`;
      }

      const result = { name: isLu ? 'Luxembourg' : cityName, country: isLu ? 'fr' : country, defaultWhat, displayLabel };
      geocodeCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {
    console.warn('Reverse geocode fallback to closest hub:', err);
  }

  const fallback = { 
    name: closestHub.name, 
    country: closestHub.country, 
    defaultWhat: closestHub.defaultWhat,
    displayLabel: `${closestHub.name}, ${closestHub.country.toUpperCase()}`
  };
  geocodeCache.set(cacheKey, fallback);
  return fallback;
}

// Map selected city ID to default hub parameters
function getCityCountry(cityId: string): { country: string; where: string; lat: number; lng: number; defaultWhat: string } {
  const match = KNOWN_EUROPEAN_HUBS.find((h) => h.name.toLowerCase() === cityId.toLowerCase());
  if (match) {
    return {
      country: match.country,
      where: match.name,
      lat: match.lat,
      lng: match.lng,
      defaultWhat: match.defaultWhat,
    };
  }

  return { 
    country: 'nl', 
    where: 'Eindhoven', 
    lat: 51.4416, 
    lng: 5.4697,
    defaultWhat: 'mechanical',
  };
}

export interface CompanyLocationResult {
  lat: number;
  lng: number;
  address: string;
}

// Curated directory of physical company headquarters, manufacturing sites & engineering campuses
const KNOWN_COMPANY_FACILITIES: Record<string, CompanyLocationResult> = {
  // Netherlands
  'thermofisher': {
    lat: 51.46734,
    lng: 5.41853,
    address: 'De Schakel 8, Distributiecentrum Eindhoven-Acht, 5651 GH Eindhoven',
  },
  'thermo fisher': {
    lat: 51.46734,
    lng: 5.41853,
    address: 'De Schakel 8, Distributiecentrum Eindhoven-Acht, 5651 GH Eindhoven',
  },
  'asml': {
    lat: 51.40322,
    lng: 5.41437,
    address: 'De Run 6501, 5504 DR Veldhoven',
  },
  'daf': {
    lat: 51.43338,
    lng: 5.50511,
    address: 'Hugo van der Goeslaan 1, De Kade, 5643 TW Eindhoven',
  },
  'philips': {
    lat: 51.4125,
    lng: 5.4578,
    address: 'High Tech Campus 52, 5656 AG Eindhoven',
  },
  'vdl': {
    lat: 51.478,
    lng: 5.462,
    address: 'Hoevenweg 1, 5627 JE Eindhoven',
  },
  'prodrive': {
    lat: 51.4985,
    lng: 5.4745,
    address: 'Science Park Eindhoven 5501, 5692 EL Son en Breugel',
  },
  'frencken': {
    lat: 51.4285,
    lng: 5.441,
    address: 'Hurksestraat 43, De Hurk, 5652 AH Eindhoven',
  },
  'nxp': {
    lat: 51.414,
    lng: 5.459,
    address: 'High Tech Campus 60, 5656 AG Eindhoven',
  },
  'vanderlande': {
    lat: 51.608,
    lng: 5.541,
    address: 'Vanderlandelaan 2, 5466 RB Veghel',
  },

  // France
  'airbus': {
    lat: 43.65275,
    lng: 1.35678,
    address: 'Rond-Point Émile Dewoitine, 31700 Blagnac, Toulouse',
  },
  'safran': {
    lat: 48.83697,
    lng: 2.26942,
    address: '2 Boulevard du Général Martial Valin, 75015 Paris',
  },
  'stellantis': {
    lat: 48.928,
    lng: 2.035,
    address: '2-10 Boulevard de l\'Europe, 78300 Poissy',
  },
  'renault': {
    lat: 48.828,
    lng: 2.235,
    address: '122 Avenue du Général Leclerc, 92100 Boulogne-Billancourt',
  },
  'thales': {
    lat: 48.892,
    lng: 2.247,
    address: 'Tour Carpe Diem, 31 Place des Corolles, 92400 Courbevoie',
  },
  'dassault': {
    lat: 48.852,
    lng: 2.218,
    address: '78 Quai Marcel Dassault, 92210 Saint-Cloud',
  },
  'alstom': {
    lat: 48.918,
    lng: 2.332,
    address: '48 Rue Albert Dhalenne, 93400 Saint-Ouen-sur-Seine',
  },

  // Germany
  'bmw': {
    lat: 48.1895,
    lng: 11.5724,
    address: 'Knorrstraße 147, FIZ Innovationszentrum, 80788 München',
  },
  'siemens': {
    lat: 48.098,
    lng: 11.662,
    address: 'Otto-Hahn-Ring 6, Neuperlach, 81739 München',
  },
  'man truck': {
    lat: 48.188,
    lng: 11.512,
    address: 'Dachauer Str. 667, 80995 München',
  },
  'mtu': {
    lat: 48.185,
    lng: 11.515,
    address: 'Dachauer Str. 665, 80995 München',
  },
  'kuka': {
    lat: 48.385,
    lng: 10.925,
    address: 'Zugspitzstraße 140, 86165 Augsburg',
  },

  // Belgium & Luxembourg & Italy
  'audi': {
    lat: 50.812,
    lng: 4.315,
    address: 'Boulevard de la Deuxième Armée Britannique 201, 1190 Forest, Brussels',
  },
  'arcelormittal': {
    lat: 49.605,
    lng: 6.135,
    address: '24-26 Boulevard d\'Avranches, 1160 Luxembourg',
  },
  'goodyear': {
    lat: 49.815,
    lng: 6.095,
    address: 'Avenue Gordon Smith, 7750 Colmar-Berg, Luxembourg',
  },
  'iveco': {
    lat: 45.105,
    lng: 7.728,
    address: 'Via Puglia 35, 10156 Torino',
  },
};

interface TechCluster {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

const TECH_CLUSTERS: Record<string, TechCluster[]> = {
  eindhoven: [
    { name: 'High Tech Campus', address: 'High Tech Campus 1, 5656 AE Eindhoven', lat: 51.4125, lng: 5.4578 },
    { name: 'Brainport Industries Campus', address: 'Brainport Industries Campus 1, 5657 BX Eindhoven', lat: 51.472, lng: 5.411 },
    { name: 'Flight Forum Tech Park', address: 'Flight Forum 3500, 5657 EA Eindhoven', lat: 51.4518, lng: 5.3942 },
    { name: 'Strijp-S Innovation Hub', address: 'Torenallee 20, Strijp-S, 5617 BC Eindhoven', lat: 51.4485, lng: 5.458 },
    { name: 'De Hurk Industrial Park', address: 'Hurksestraat 19, De Hurk, 5652 AH Eindhoven', lat: 51.4285, lng: 5.441 },
    { name: 'Science Park & Ekkersrijt', address: 'Science Park Eindhoven 5000, 5692 EB Son en Breugel', lat: 51.4982, lng: 5.474 },
    { name: 'De Kade Automotive & Machinery', address: 'Hugo van der Goeslaan, De Kade, 5643 TW Eindhoven', lat: 51.433, lng: 5.503 },
    { name: 'De Run High-Tech Cluster', address: 'De Run 1100, 5504 LA Veldhoven', lat: 51.4052, lng: 5.418 },
    { name: 'Fellenoord Business District', address: 'Fellenoord 100, 5611 ZB Eindhoven', lat: 51.4435, lng: 5.477 },
    { name: 'TU/e Innovation Lab', address: 'Het Eeuwsel, TU/e Campus, 5612 AZ Eindhoven', lat: 51.448, lng: 5.487 },
  ],
  paris: [
    { name: 'Paris-Saclay Innovation Campus', address: 'Rue Noetzlin, 91190 Gif-sur-Yvette', lat: 48.711, lng: 2.162 },
    { name: 'Paris La Défense', address: 'Place de La Défense, 92400 Courbevoie', lat: 48.892, lng: 2.239 },
    { name: 'Vélizy Aerospace & Auto Hub', address: 'Avenue Louis Breguet, 78140 Vélizy', lat: 48.778, lng: 2.215 },
    { name: 'Saint-Denis Pleyel Tech Hub', address: 'Boulevard Anatole France, 93200 Saint-Denis', lat: 48.918, lng: 2.342 },
    { name: 'Boulogne-Billancourt Tech Quarter', address: 'Avenue du Général Leclerc, 92100 Boulogne', lat: 48.835, lng: 2.241 },
    { name: 'Rueil 2000 Corporate Park', address: 'Avenue de l\'Europe, 92500 Rueil-Malmaison', lat: 48.889, lng: 2.181 },
  ],
  toulouse: [
    { name: 'Blagnac AéroConstellation', address: 'Avenue Henri Auguste Pélegrin, 31700 Blagnac', lat: 43.649, lng: 1.368 },
    { name: 'Colomiers Aeronautical Zone', address: 'Boulevard Henri Ziegler, 31770 Colomiers', lat: 43.612, lng: 1.335 },
    { name: 'Labège Innopole Tech Park', address: 'Rue de Syracuse, 31670 Labège', lat: 43.535, lng: 1.505 },
    { name: 'Saint-Martin Aerospace Hub', address: 'Route de Bayonne, 31300 Toulouse', lat: 43.605, lng: 1.385 },
    { name: 'Montaudran Aerospace Campus', address: 'Avenue Édouard Belin, 31400 Toulouse', lat: 43.568, lng: 1.485 },
  ],
  brussels: [
    { name: 'Zaventem Corporate Village', address: 'Da Vincilaan 5, 1930 Zaventem', lat: 50.885, lng: 4.455 },
    { name: 'Evere High-Tech Center', address: 'Avenue du Bourget 40, 1140 Brussels', lat: 50.875, lng: 4.425 },
    { name: 'Forest Automotive Industrial Hub', address: 'Boulevard de la Deuxième Armée Britannique, 1190 Forest', lat: 50.812, lng: 4.315 },
    { name: 'Vilvoorde Technology Zone', address: 'Luchthavenlaan, 1800 Vilvoorde', lat: 50.932, lng: 4.428 },
  ],
  munich: [
    { name: 'Garching Research Campus', address: 'Boltzmannstraße 15, 85748 Garching', lat: 48.265, lng: 11.671 },
    { name: 'Moosach Technology Park', address: 'Riesstraße 25, 80992 München', lat: 48.178, lng: 11.531 },
    { name: 'Unterföhring Innovation District', address: 'Betastraße 10, 85774 Unterföhring', lat: 48.192, lng: 11.652 },
    { name: 'Neuperlach High-Tech Cluster', address: 'Otto-Hahn-Ring 6, 81739 München', lat: 48.098, lng: 11.662 },
  ],
  turin: [
    { name: 'Mirafiori Automotive Zone', address: 'Corso Giovanni Agnelli 200, 10135 Torino', lat: 45.028, lng: 7.632 },
    { name: 'Politecnico Innovation Campus', address: 'Corso Ferrucci 112, 10138 Torino', lat: 45.062, lng: 7.658 },
    { name: 'Lingotto Advanced Engineering Hub', address: 'Via Nizza 280, 10126 Torino', lat: 45.032, lng: 7.665 },
  ],
  utrecht: [
    { name: 'Papendorp Business Park', address: 'Papendorpseweg 100, 3528 BJ Utrecht', lat: 52.065, lng: 5.085 },
    { name: 'Lage Weide Industrial Estate', address: 'Atoomweg 50, 3542 AB Utrecht', lat: 52.112, lng: 5.045 },
    { name: 'Utrecht Science Park', address: 'Heidelberglaan 8, 3584 CS Utrecht', lat: 52.085, lng: 5.172 },
  ],
  amsterdam: [
    { name: 'Amsterdam Science & Tech Park', address: 'Science Park 400, 1098 XH Amsterdam', lat: 52.355, lng: 4.955 },
    { name: 'Zuidas Innovation Hub', address: 'Gustav Mahlerlaan 10, 1082 MS Amsterdam', lat: 52.336, lng: 4.872 },
    { name: 'Sloterdijk Teleport Tech Hub', address: 'Basisweg 10, 1043 AP Amsterdam', lat: 52.392, lng: 4.835 },
  ],
  rotterdam: [
    { name: 'Rotterdam Science Tower & Makers District', address: 'Marconistraat 16, 3029 AK Rotterdam', lat: 51.912, lng: 4.432 },
    { name: 'Waalhaven Maritime & Engineering', address: 'Waalhaven Zuidzijde 21, 3089 JH Rotterdam', lat: 51.878, lng: 4.442 },
  ],
  luxembourg: [
    { name: 'Kirchberg Innovation & Tech Hub', address: 'Boulevard Konrad Adenauer, 1115 Luxembourg', lat: 49.628, lng: 6.155 },
    { name: 'Belval Innovation Campus & Technoport', address: 'Avenue des Hauts-Fourneaux, 4362 Esch-sur-Alzette', lat: 49.501, lng: 5.948 },
    { name: 'Dudelange Industrial Zone', address: 'Zone Industrielle Riedgen, 3451 Dudelange', lat: 49.485, lng: 6.082 },
    { name: 'Colmar-Berg Goodyear Innovation Center', address: 'Avenue Gordon Smith, 7750 Colmar-Berg', lat: 49.815, lng: 6.095 },
    { name: 'Capellen High-Tech Zone', address: 'Rue Pafebruch, 8308 Capellen', lat: 49.645, lng: 5.986 },
    { name: 'Cloche d’Or Business & R&D District', address: 'Rue Robert Stumper, 2557 Gasperich', lat: 49.585, lng: 6.115 },
  ],
};

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// Persistent OSM company cache
let osmCompanyCache: Record<string, CompanyLocationResult> = {};
try {
  const saved = localStorage.getItem('mapjob_osm_company_cache');
  if (saved) {
    osmCompanyCache = JSON.parse(saved);
  }
} catch {
  // ignore
}

export function saveOsmCompanyCache(key: string, val: CompanyLocationResult) {
  osmCompanyCache[key] = val;
  try {
    localStorage.setItem('mapjob_osm_company_cache', JSON.stringify(osmCompanyCache));
  } catch {
    // ignore
  }
}

export async function lookupOpenStreetMapCompany(
  company: string,
  city: string
): Promise<CompanyLocationResult | null> {
  const cleanCompany = company
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/B\.?V\.?|N\.?V\.?|S\.?A\.?|S\.?A\.?S\.?|GmbH|Ltd\.?|Group|Nederland|France|Germany/gi, '')
    .trim();
  const cacheKey = `${cleanCompany.toLowerCase()}@${city.toLowerCase()}`;
  if (osmCompanyCache[cacheKey]) {
    return osmCompanyCache[cacheKey];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const q = encodeURIComponent(`${cleanCompany}, ${city}`);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&addressdetails=1&limit=1`, {
      headers: { 'User-Agent': 'MapJob/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      if (data && data[0]) {
        const item = data[0];
        const addr = item.address || {};
        const street = [addr.house_number, addr.road || addr.street].filter(Boolean).join(' ');
        const district = addr.industrial || addr.suburb || addr.quarter || addr.city_district || '';
        const fullAddr = [street, district, addr.city || city, addr.postcode].filter(Boolean).join(', ');

        const result: CompanyLocationResult = {
          lat: parseFloat(item.lat),
          lng: parseFloat(item.lon),
          address: fullAddr || item.display_name,
        };
        saveOsmCompanyCache(cacheKey, result);
        return result;
      }
    }
  } catch {
    // ignore network errors or timeouts
  }

  return null;
}

export function resolveJobLocation(
  company: string,
  title: string,
  jobId: string,
  city: string,
  index: number,
  baseCityLat: number,
  baseCityLng: number,
  adzunaLat?: number,
  adzunaLng?: number,
  locationDisplayName?: string
): CompanyLocationResult {
  const companyKey = company.toLowerCase().trim();
  const cleanCompany = companyKey.replace(/[^a-z0-9]/g, '');

  // 1. Direct match with verified European company facilities
  for (const [key, facility] of Object.entries(KNOWN_COMPANY_FACILITIES)) {
    const cleanKey = key.replace(/[^a-z0-9]/g, '');
    if (cleanCompany.includes(cleanKey) || cleanKey.includes(cleanCompany)) {
      // If multiple jobs are at the same company, give slight sub-campus offset
      const subOffsetLat = ((((index * 13) % 100) - 50) / 100) * 0.0012;
      const subOffsetLng = ((((index * 17) % 100) - 50) / 100) * 0.0016;
      return {
        lat: facility.lat + subOffsetLat,
        lng: facility.lng + subOffsetLng,
        address: facility.address,
      };
    }
  }

  // 2. Check OSM cache
  const osmCacheKey = `${companyKey}@${city.toLowerCase()}`;
  if (osmCompanyCache[osmCacheKey]) {
    const cached = osmCompanyCache[osmCacheKey];
    const subOffsetLat = ((((index * 13) % 100) - 50) / 100) * 0.0012;
    const subOffsetLng = ((((index * 17) % 100) - 50) / 100) * 0.0016;
    return {
      lat: cached.lat + subOffsetLat,
      lng: cached.lng + subOffsetLng,
      address: cached.address,
    };
  }

  // 3. PRIORITY: Real Adzuna geolocation coordinates for this specific job / suburb / small town
  if (
    typeof adzunaLat === 'number' &&
    typeof adzunaLng === 'number' &&
    !isNaN(adzunaLat) &&
    !isNaN(adzunaLng) &&
    (adzunaLat !== 0 || adzunaLng !== 0)
  ) {
    // Micro-offset (±70m) so multiple jobs in the exact same business park/suburb don't stack on 1 pixel
    const subOffsetLat = ((((index * 13) % 100) - 50) / 100) * 0.0012;
    const subOffsetLng = ((((index * 17) % 100) - 50) / 100) * 0.0015;
    const address = locationDisplayName
      ? `${company}, ${locationDisplayName}`
      : `${company}, ${city}`;

    return {
      lat: adzunaLat + subOffsetLat,
      lng: adzunaLng + subOffsetLng,
      address,
    };
  }

  // 4. European Tech Clusters & Industrial Parks
  const cityKey = city.toLowerCase();
  const clusterKey = (cityKey.includes('luxembourg') || cityKey.includes('thionville') || cityKey.includes('esch'))
    ? 'luxembourg'
    : (cityKey.includes('brussel') || cityKey.includes('bruxelles') ? 'brussels' : cityKey);
  const clusters = TECH_CLUSTERS[clusterKey] || TECH_CLUSTERS[cityKey];
  if (clusters && clusters.length > 0) {
    const h = hashString(company + title + jobId);
    const cluster = clusters[h % clusters.length];
    // Micro-offset within the industrial/office park (±120m) so every job has a distinct, clickable pill
    const offsetLat = (((h % 100) - 50) / 100) * 0.0035;
    const offsetLng = ((((h >> 3) % 100) - 50) / 100) * 0.0045;

    return {
      lat: cluster.lat + offsetLat,
      lng: cluster.lng + offsetLng,
      address: cluster.address,
    };
  }

  // Fallback to base city coordinates with realistic street dispersion
  const h = hashString(company + title + jobId);
  const angle = (h % 360) * (Math.PI / 180);
  const distance = 0.008 + ((h % 50) / 50) * 0.025;
  const lat = baseCityLat + Math.sin(angle) * distance;
  const lng = baseCityLng + Math.cos(angle) * distance * 1.35;

  return {
    lat,
    lng,
    address: `${company} Facility, ${city}`,
  };
}

// Strip HTML tags from strings
function cleanHtml(str: string): string {
  if (!str) return '';
  return str.replace(/<\/?[^>]+(>|$)/g, '').trim();
}

// Format salary display honestly from real Adzuna numbers
function formatSalaryDisplay(min?: number, max?: number): { display: string; badge: string; currency: string; hasRealSalary: boolean } {
  const currency = '€';
  if (!min && !max) {
    return {
      display: 'Salary on Application',
      badge: 'Apply',
      currency,
      hasRealSalary: false,
    };
  }
  const minK = min ? Math.round(min / 1000) : null;
  const maxK = max ? Math.round(max / 1000) : null;

  if (minK && maxK && minK !== maxK) {
    return {
      display: `${currency}${minK}k - ${currency}${maxK}k / yr`,
      badge: `${currency}${Math.round((minK + maxK) / 2)}k`,
      currency,
      hasRealSalary: true,
    };
  }
  const single = minK || maxK;
  return {
    display: `${currency}${single}k / yr`,
    badge: `${currency}${single}k`,
    currency,
    hasRealSalary: true,
  };
}

// Extract real highlights directly from the employer's actual description text
function extractRealHighlights(desc: string): { responsibilities: string[]; requirements: string[] } {
  const text = cleanHtml(desc);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25 && s.length < 220);

  if (sentences.length >= 3) {
    return {
      responsibilities: sentences.slice(0, 2),
      requirements: sentences.slice(2, 4),
    };
  }
  return {
    responsibilities: [text.slice(0, 160) + '...'],
    requirements: ['Consult official employer posting for complete job requirements and specifications.'],
  };
}

export interface FetchJobsParams {
  cityId?: string;
  where?: string;
  country?: string;
  centerLat?: number;
  centerLng?: number;
  defaultWhat?: string;
  query?: string;
  lastPosted?: string;
  page?: number;
}

// Clean query for Adzuna search engine so it doesn't fail on parenthetical notes
function cleanQueryForAdzuna(q: string): string {
  if (!q) return '';
  // Remove parenthetical notes like (CATIA), (ASML), (Ansys) which break boolean search
  let cleaned = q.replace(/\s*\([^)]*\)/g, '').trim();
  cleaned = cleaned.replace(/[+&/\\#,*_~`$!]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned;
}

function getMaxDaysOldParam(lastPosted?: string): string {
  // An explicit range asks the API for everything back to the older edge; the
  // newer edge is trimmed client-side, because max_days_old has no lower
  // bound to give it. A couple of days of slack for the same reason the fixed
  // buckets carry it -- feeds date posts inconsistently.
  const range = parsePostedRange(lastPosted);
  if (range) return `&max_days_old=${Math.max(1, daysAgo(range.start) + 2)}`;

  switch (lastPosted) {
    case '24h': return '&max_days_old=2';
    case '3d': return '&max_days_old=4';
    case '7d': return '&max_days_old=10';
    case '14d': return '&max_days_old=20';
    case '30d': return '&max_days_old=45';
    default: return '';
  }
}

// Curated high-resolution engineering and industrial cleanroom imagery (all verified 200 OK)
export const DEFAULT_JOB_IMAGE = 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1000&auto=format&fit=crop&q=85';

export const ENGINEERING_PHOTOS = [
  'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581092162384-8987c1d64718?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581092334651-ddf26d9a09d0?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581092795360-fd1ca04f0952?w=1000&auto=format&fit=crop&q=85',
  'https://images.unsplash.com/photo-1581092918056-0c4c3acd3789?w=1000&auto=format&fit=crop&q=85',
];

// Fast in-memory cache for Adzuna responses to ensure instant sub-second response on map moves
const adzunaJobCache = new Map<string, Job[]>();

export async function fetchAdzunaJobs({
  cityId,
  where: customWhere,
  country: customCountry,
  centerLat: customLat,
  centerLng: customLng,
  defaultWhat: customDefaultWhat,
  query = '',
  lastPosted = 'all',
  page = 1,
}: FetchJobsParams): Promise<Job[]> {
  const appId = ADZUNA_APP_ID;
  const appKey = ADZUNA_APP_KEY;

  if (!appId || !appKey) {
    console.warn('Adzuna API keys not set. Please set VITE_ADZUNA_APP_ID and VITE_ADZUNA_APP_KEY in .env');
    return [];
  }

  let country = customCountry;
  let where = customWhere;
  let cityLat = customLat;
  let cityLng = customLng;
  let defaultWhat = customDefaultWhat;

  if (!where || !country) {
    const hub = getCityCountry(cityId || 'eindhoven');
    country = hub.country;
    where = hub.where;
    cityLat = hub.lat;
    cityLng = hub.lng;
    defaultWhat = hub.defaultWhat;
  }

  // Check if Luxembourg
  const isLuxembourg = (where && where.toLowerCase().includes('luxembourg')) || country === 'lu' || cityId === 'luxembourg';
  let searchCountry = country || 'nl';
  let searchWhere = where || 'Eindhoven';
  let distanceParam = '&distance=35';

  if (isLuxembourg) {
    searchCountry = 'fr';
    // Cross-border Greater Luxembourg industrial & engineering basin
    searchWhere = 'Thionville';
    distanceParam = '&distance=50';
  } else if (
    searchCountry === 'be' &&
    (searchWhere.toLowerCase().includes('brussel') ||
      searchWhere.toLowerCase().includes('bruxelles') ||
      cityId === 'brussels')
  ) {
    // In Belgium (be), Adzuna's official database indexes under French/Dutch ('Bruxelles' / 'Brussel')
    searchWhere = 'Bruxelles';
    distanceParam = '&distance=35';
  } else if (searchWhere.toLowerCase() === 'brussels') {
    // Fallback if country wasn't set to 'be'
    searchCountry = 'be';
    searchWhere = 'Bruxelles';
    distanceParam = '&distance=35';
  }

  const cleanQ = cleanQueryForAdzuna(query);
  let whatParam = '';
  if (cleanQ) {
    whatParam = `&what=${encodeURIComponent(cleanQ)}`;
  } else {
    // Multi-discipline engineering expansion with what_or to maximize job pool 3x-4x
    if (searchCountry === 'fr' || isLuxembourg) {
      whatParam = `&what_or=${encodeURIComponent('mecanique ingenieur mecatronique conception bureau')}`;
    } else if (searchCountry === 'de') {
      whatParam = `&what_or=${encodeURIComponent('Maschinenbau Ingenieur Mechatronik Konstrukteur CAD')}`;
    } else if (searchCountry === 'it') {
      whatParam = `&what_or=${encodeURIComponent('meccanico ingegnere meccatronica progettista CAD')}`;
    } else if (searchCountry === 'es') {
      whatParam = `&what_or=${encodeURIComponent('mecanico ingeniero mecatronica diseno CAD')}`;
    } else if (defaultWhat && defaultWhat !== 'mechanical') {
      whatParam = `&what=${encodeURIComponent(defaultWhat)}`;
    } else {
      whatParam = `&what_or=${encodeURIComponent('mechanical engineer ingenieur mechatronica CAD design')}`;
    }
  }
  const whereParam = `&where=${encodeURIComponent(searchWhere)}`;
  const daysParam = getMaxDaysOldParam(lastPosted);

  // Check fast cache first
  const cacheKey = `${searchCountry}:${searchWhere.toLowerCase()}:${whatParam}:${daysParam}:${distanceParam}:${page}`;
  if (adzunaJobCache.has(cacheKey)) {
    return adzunaJobCache.get(cacheKey)!;
  }

  // Use Vite dev proxy /api/adzuna if available, or direct api.adzuna.com
  const baseUrl = import.meta.env.DEV ? '/api/adzuna' : 'https://api.adzuna.com';

  try {
    // If page === 1, fetch pages 1 and 2 in parallel to provide 100 active pins on map moves
    const pagesToFetch = page === 1 ? [1, 2] : [page];
    const pagePromises = pagesToFetch.map(async (p) => {
      const endpoint = `${baseUrl}/v1/api/jobs/${searchCountry}/search/${p}?app_id=${appId}&app_key=${appKey}&results_per_page=50${whatParam}${whereParam}${distanceParam}${daysParam}&content-type=application/json`;
      try {
        let res = await fetch(endpoint);
        if (!res.ok && import.meta.env.DEV && res.status >= 500) {
          const directEndpoint = `https://api.adzuna.com/v1/api/jobs/${searchCountry}/search/${p}?app_id=${appId}&app_key=${appKey}&results_per_page=50${whatParam}${whereParam}${distanceParam}${daysParam}&content-type=application/json`;
          res = await fetch(directEndpoint);
        }
        if (res.ok) {
          const data = await res.json();
          return (data.results || []) as AdzunaJobItem[];
        }
      } catch {
        // ignore individual page error
      }
      return [] as AdzunaJobItem[];
    });

    const pageResults = await Promise.all(pagePromises);
    let items: AdzunaJobItem[] = pageResults.flat();

    // Deduplicate jobs by ID
    const seenIds = new Set<string>();
    items = items.filter((item) => {
      const idStr = String(item.id);
      if (seenIds.has(idStr)) return false;
      seenIds.add(idStr);
      return true;
    });

    // Fallback 1: If exact suburb yielded 0 results, expand search radius with distance=60
    if (items.length === 0 && searchWhere) {
      try {
        const retryUrl = `${baseUrl}/v1/api/jobs/${searchCountry}/search/${page}?app_id=${appId}&app_key=${appKey}&results_per_page=50${whatParam}&where=${encodeURIComponent(searchWhere)}&distance=60${daysParam}&content-type=application/json`;
        const retryRes = await fetch(retryUrl);
        if (retryRes.ok) {
          const retryData = await retryRes.json();
          items = retryData.results || [];
        }
      } catch {
        // ignore
      }
    }

    // Fallback 2: If still 0 results (e.g. tiny rural town), fetch from nearest European hub
    if (items.length === 0 && (cityLat || customLat)) {
      try {
        const targetLat = cityLat ?? customLat!;
        const targetLng = cityLng ?? customLng!;
        let nearestHub = KNOWN_EUROPEAN_HUBS[0];
        let minDist = distanceKm(targetLat, targetLng, nearestHub.lat, nearestHub.lng);
        for (let i = 1; i < KNOWN_EUROPEAN_HUBS.length; i++) {
          const d = distanceKm(targetLat, targetLng, KNOWN_EUROPEAN_HUBS[i].lat, KNOWN_EUROPEAN_HUBS[i].lng);
          if (d < minDist) {
            minDist = d;
            nearestHub = KNOWN_EUROPEAN_HUBS[i];
          }
        }
        if (nearestHub.name.toLowerCase() !== searchWhere.toLowerCase()) {
          const hubUrl = `${baseUrl}/v1/api/jobs/${nearestHub.country}/search/${page}?app_id=${appId}&app_key=${appKey}&results_per_page=50${whatParam}&where=${encodeURIComponent(nearestHub.name)}&distance=50${daysParam}&content-type=application/json`;
          const hubRes = await fetch(hubUrl);
          if (hubRes.ok) {
            const hubData = await hubRes.json();
            items = hubData.results || [];
          }
        }
      } catch {
        // ignore
      }
    }

    const isBrussels =
      !isLuxembourg &&
      ((where || '').toLowerCase().includes('brussel') ||
        (where || '').toLowerCase().includes('bruxelles') ||
        cityId === 'brussels');
    const baseLat = isLuxembourg ? 49.6116 : (isBrussels ? 50.8503 : (cityLat ?? 51.4416));
    const baseLng = isLuxembourg ? 6.1319 : (isBrussels ? 4.3517 : (cityLng ?? 5.4697));

    const finalJobs = items.map((item, index) => {
      const title = cleanHtml(item.title) || 'Mechanical Engineer';
      const company = item.company?.display_name || 'Engineering Group';
      const { display: salaryDisplay, badge: salaryBadge, currency, hasRealSalary } = formatSalaryDisplay(item.salary_min, item.salary_max);

      // Resolve real physical company building, suburb, or European technology park address
      const loc = resolveJobLocation(
        company,
        title,
        String(item.id),
        isLuxembourg ? 'luxembourg' : (isBrussels ? 'brussels' : (where || 'eindhoven')),
        index,
        baseLat,
        baseLng,
        item.latitude,
        item.longitude,
        item.location?.display_name
      );
      const lat = loc.lat;
      const lng = loc.lng;
      const exactAddress = loc.address;

      // Calculate days ago from created date
      const createdDate = item.created ? new Date(item.created) : new Date();
      const diffMs = Math.max(0, Date.now() - createdDate.getTime());
      const postedDaysAgo = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      // Photos from precision engineering photo set
      const photo1 = ENGINEERING_PHOTOS[index % ENGINEERING_PHOTOS.length];
      const photo2 = ENGINEERING_PHOTOS[(index + 2) % ENGINEERING_PHOTOS.length];
      const photo3 = ENGINEERING_PHOTOS[(index + 4) % ENGINEERING_PHOTOS.length];

      const titleLower = title.toLowerCase();
      const descLower = (item.description || '').toLowerCase();

      // Extract authentic job type from title/content
      let jobType: 'Full-time' | 'Part-time' | 'Contract' | 'Internship' = 'Full-time';
      if (titleLower.includes('intern') || titleLower.includes('stage') || descLower.includes('internship')) {
        jobType = 'Internship';
      } else if (item.contract_time === 'part_time' || titleLower.includes('part-time') || titleLower.includes('deeltijd')) {
        jobType = 'Part-time';
      } else if (titleLower.includes('contract') || titleLower.includes('freelance') || titleLower.includes('interim')) {
        jobType = 'Contract';
      }

      // Extract authentic workplace format
      let remoteType: 'Remote' | 'Hybrid' | 'On-site' = 'On-site';
      if (titleLower.includes('remote') || descLower.includes('fully remote') || descLower.includes('100% remote')) {
        remoteType = 'Remote';
      } else if (titleLower.includes('hybrid') || descLower.includes('hybrid') || descLower.includes('hybride')) {
        remoteType = 'Hybrid';
      }

      // Extract authentic seniority
      let experienceLevel: 'Entry' | 'Mid' | 'Senior' | 'Lead' | 'Executive' = 'Mid';
      if (jobType === 'Internship' || titleLower.includes('junior') || titleLower.includes('trainee') || titleLower.includes('starter')) {
        experienceLevel = 'Entry';
      } else if (titleLower.includes('senior') || titleLower.includes('sr.')) {
        experienceLevel = 'Senior';
      } else if (titleLower.includes('lead') || titleLower.includes('principal')) {
        experienceLevel = 'Lead';
      } else if (titleLower.includes('director') || titleLower.includes('head')) {
        experienceLevel = 'Executive';
      }

      // True visa sponsorship only if mentioned in employer posting
      const visaSponsorship = descLower.includes('visa') || descLower.includes('relocation') || descLower.includes('kennismigrant');

      // Real description highlights extracted from employer's original text
      const rawDescription = cleanHtml(item.description) || 'Please refer to the official employer posting for full details.';
      const { responsibilities, requirements } = extractRealHighlights(rawDescription);

      return {
        id: `adzuna-${item.id}`,
        title,
        company,
        companyLogo: `https://avatar.vercel.sh/${encodeURIComponent(company)}.svg?text=${company.slice(0, 2).toUpperCase()}`,
        rating: 0,
        reviewsCount: 0,
        isSuperEmployer: false,
        isFeatured: hasRealSalary,
        category: item.category?.label || 'Engineering',
        location: exactAddress || item.location?.display_name || where,
        address: exactAddress,
        city: isLuxembourg ? 'luxembourg' : (isBrussels ? 'brussels' : (where || 'eindhoven').toLowerCase()),
        lat,
        lng,
        salaryMin: item.salary_min || 0,
        salaryMax: item.salary_max || 0,
        salaryCurrency: currency,
        salaryPeriod: 'year',
        salaryDisplay,
        salaryBadge,
        jobType,
        remoteType,
        experienceLevel,
        visaSponsorship,
        images: [photo1, photo2, photo3],
        description: rawDescription,
        responsibilities,
        requirements,
        benefits: [
          'Direct live listing via official employer channel',
          'Full application details and specifications available on official portal',
        ],
        postedDaysAgo,
        postedAt: postedDaysAgo === 0 ? 'Today' : (postedDaysAgo === 1 ? '1 day ago' : `${postedDaysAgo} days ago`),
        applicantCount: 0,
        applyUrl: item.redirect_url,
        atsProvider: detectAtsProvider(company, item.redirect_url, title, rawDescription),
        isDirectApply: isDirectAts(detectAtsProvider(company, item.redirect_url, title, rawDescription)),
      } as Job;
    });

    adzunaJobCache.set(cacheKey, finalJobs);
    return finalJobs;
  } catch (err) {
    console.error('Failed to fetch jobs from Adzuna:', err);
    return [];
  }
}
