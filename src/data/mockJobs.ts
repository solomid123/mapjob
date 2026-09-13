import type { Job } from '../types/job';

export const CITIES = [
  { id: 'eindhoven', name: 'Eindhoven', subtitle: 'Brainport High-Tech (NL)', lat: 51.4416, lng: 5.4697, zoom: 12 },
  { id: 'luxembourg', name: 'Luxembourg', subtitle: 'Financial & Greater Region (LU)', lat: 49.6116, lng: 6.1319, zoom: 12 },
  { id: 'paris', name: 'Paris', subtitle: 'Île-de-France Aerospace & Energy (FR)', lat: 48.8566, lng: 2.3522, zoom: 12 },
  { id: 'toulouse', name: 'Toulouse', subtitle: 'Airbus & Aerospace Valley (FR)', lat: 43.6047, lng: 1.4442, zoom: 12 },
  { id: 'brussels', name: 'Brussels', subtitle: 'EU Capital & High-Tech (BE)', lat: 50.8503, lng: 4.3517, zoom: 12 },
  { id: 'munich', name: 'Munich', subtitle: 'BMW, Siemens & Bavaria Tech (DE)', lat: 48.1351, lng: 11.5820, zoom: 12 },
  { id: 'stuttgart', name: 'Stuttgart', subtitle: 'Porsche, Bosch & Automotive (DE)', lat: 48.7758, lng: 9.1829, zoom: 12 },
  { id: 'amsterdam', name: 'Amsterdam', subtitle: 'Randstad Fintech & Tech (NL)', lat: 52.3676, lng: 4.9041, zoom: 12 },
  { id: 'rotterdam', name: 'Rotterdam', subtitle: 'Maritime Gateway (NL)', lat: 51.9244, lng: 4.4777, zoom: 12 },
  { id: 'utrecht', name: 'Utrecht', subtitle: 'Central Tech & Creative (NL)', lat: 52.0907, lng: 5.1214, zoom: 12 },
  { id: 'lyon', name: 'Lyon', subtitle: 'Auvergne-Rhône-Alpes (FR)', lat: 45.7640, lng: 4.8357, zoom: 12 },
  { id: 'turin', name: 'Turin', subtitle: 'Motor Valley & Industry (IT)', lat: 45.0703, lng: 7.6869, zoom: 12 },
  { id: 'milan', name: 'Milan', subtitle: 'Lombardy Industry & Tech (IT)', lat: 45.4642, lng: 9.1900, zoom: 12 },
  { id: 'madrid', name: 'Madrid', subtitle: 'Aerospace & Tech Hub (ES)', lat: 40.4168, lng: -3.7038, zoom: 12 },
  { id: 'barcelona', name: 'Barcelona', subtitle: 'Catalonia Innovation (ES)', lat: 41.3879, lng: 2.1699, zoom: 12 },
];

export const CATEGORIES = [
  { id: 'all', name: 'All Disciplines', icon: 'Briefcase' },
  { id: 'Precision & Mechatronics', name: 'Precision & Mechatronics (ASML)', icon: 'Cpu' },
  { id: 'Aerospace & Defense', name: 'Aerospace & Defense (Airbus/Safran)', icon: 'Rocket' },
  { id: 'Mechanical Design (CAD)', name: 'CAD & Design (CATIA/NX/SolidWorks)', icon: 'Layers' },
  { id: 'Simulation & FEA', name: 'FEA, CFD & Thermal (Ansys/Abaqus)', icon: 'Activity' },
  { id: 'Automotive & EV', name: 'Automotive, Powertrain & Battery', icon: 'Zap' },
  { id: 'Automation & Robotics', name: 'Automation & Industry 4.0', icon: 'Bot' },
  { id: 'Materials & Metallurgy', name: 'Advanced Materials & Steel', icon: 'Shield' },
];

// No hardcoded jobs - MapJob displays 100% live Adzuna data
export const INITIAL_JOBS: Job[] = [];
