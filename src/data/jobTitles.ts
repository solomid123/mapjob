/**
 * Job titles as employers actually write them.
 *
 * The dropdown used to offer category labels -- "FEA / Simulation (Ansys)",
 * "Manufacturing / Industry 4.0". They read well and searched badly: the
 * backend scores a query by counting its tokens inside a posting's title,
 * company, description and category, so "Manufacturing / Industry 4.0" spent
 * three of its four tokens on words no posting contains, and "(Ansys)" matched
 * a tool mentioned halfway down a description rather than the role itself.
 *
 * Every entry below is a phrase that appears verbatim in real postings, in the
 * language the posting is written in. That matters on this map: a vacancy in
 * Toulouse says "Ingénieur Bureau d'Études" and one in Eindhoven says
 * "Werktuigbouwkundig Ingenieur", and neither of them says "Mechanical Design".
 */

export interface JobTitleSuggestion {
  /** The exact phrase to search for. */
  title: string;
  /** Language tag, shown as a hint so a French title is not mistaken for a typo. */
  lang: 'EN' | 'FR' | 'NL';
  /** Shown first, before anything is typed. */
  popular?: boolean;
}

export const JOB_TITLES: JobTitleSuggestion[] = [
  // --- English: the lingua franca of Dutch and Belgian engineering postings --
  { title: 'Mechanical Engineer', lang: 'EN', popular: true },
  { title: 'Design Engineer', lang: 'EN', popular: true },
  { title: 'Mechanical Design Engineer', lang: 'EN', popular: true },
  { title: 'Project Engineer', lang: 'EN', popular: true },
  { title: 'R&D Engineer', lang: 'EN', popular: true },
  { title: 'Manufacturing Engineer', lang: 'EN' },
  { title: 'Process Engineer', lang: 'EN' },
  { title: 'Production Engineer', lang: 'EN' },
  { title: 'Product Development Engineer', lang: 'EN' },
  { title: 'Mechatronics Engineer', lang: 'EN' },
  { title: 'Systems Engineer', lang: 'EN' },
  { title: 'Automation Engineer', lang: 'EN' },
  { title: 'Simulation Engineer', lang: 'EN' },
  { title: 'CAE Engineer', lang: 'EN' },
  { title: 'Structural Engineer', lang: 'EN' },
  { title: 'Thermal Engineer', lang: 'EN' },
  { title: 'Materials Engineer', lang: 'EN' },
  { title: 'Quality Engineer', lang: 'EN' },
  { title: 'Test Engineer', lang: 'EN' },
  { title: 'Validation Engineer', lang: 'EN' },
  { title: 'Maintenance Engineer', lang: 'EN' },
  { title: 'Commissioning Engineer', lang: 'EN' },
  { title: 'Field Service Engineer', lang: 'EN' },
  { title: 'Application Engineer', lang: 'EN' },
  { title: 'Sales Engineer', lang: 'EN' },
  { title: 'Piping Engineer', lang: 'EN' },
  { title: 'HVAC Engineer', lang: 'EN' },
  { title: 'Tooling Engineer', lang: 'EN' },
  { title: 'Industrialization Engineer', lang: 'EN' },
  { title: 'Graduate Engineer', lang: 'EN' },
  { title: 'Junior Mechanical Engineer', lang: 'EN' },
  { title: 'Engineering Intern', lang: 'EN' },

  // --- French ---------------------------------------------------------------
  { title: 'Ingénieur Mécanique', lang: 'FR', popular: true },
  { title: "Ingénieur Bureau d'Études", lang: 'FR', popular: true },
  { title: 'Ingénieur Conception Mécanique', lang: 'FR' },
  { title: 'Ingénieur Calcul', lang: 'FR' },
  { title: 'Ingénieur Méthodes', lang: 'FR' },
  { title: 'Ingénieur Procédés', lang: 'FR' },
  { title: 'Ingénieur Production', lang: 'FR' },
  { title: 'Ingénieur Qualité', lang: 'FR' },
  { title: 'Ingénieur R&D', lang: 'FR' },
  { title: 'Ingénieur Projet', lang: 'FR' },
  { title: 'Ingénieur Maintenance', lang: 'FR' },
  { title: 'Ingénieur Industrialisation', lang: 'FR' },
  { title: 'Ingénieur Automatisme', lang: 'FR' },
  { title: 'Ingénieur Thermique', lang: 'FR' },
  { title: 'Ingénieur Structure', lang: 'FR' },
  { title: 'Ingénieur Essais', lang: 'FR' },
  { title: 'Ingénieur Matériaux', lang: 'FR' },
  { title: 'Dessinateur Projeteur', lang: 'FR' },
  { title: "Technicien Bureau d'Études", lang: 'FR' },
  { title: "Chargé d'Affaires", lang: 'FR' },
  { title: 'Alternance Ingénieur', lang: 'FR' },
  { title: 'Stage Ingénieur', lang: 'FR' },

  // --- Dutch ----------------------------------------------------------------
  { title: 'Werktuigbouwkundig Ingenieur', lang: 'NL', popular: true },
  { title: 'Constructeur', lang: 'NL' },
  { title: 'Ontwerper Werktuigbouwkunde', lang: 'NL' },
  { title: 'Projectleider Techniek', lang: 'NL' },
  { title: 'Technisch Specialist', lang: 'NL' },
  { title: 'Onderhoudstechnicus', lang: 'NL' },
];

/**
 * Strips accents so a keyboard without them still finds the title.
 *
 * Someone typing "mecanique" on a Dutch layout means "Mécanique", and someone
 * typing "etudes" means "Études". Matching the raw strings would fail both.
 */
const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Titles matching what has been typed so far, best first.
 *
 * Matching is per word rather than on the whole string, so "ing meca" finds
 * "Ingénieur Mécanique" -- which is how people actually type into a search box,
 * abbreviating as they go. A title is a hit only when *every* typed word
 * appears in it, so each further keystroke narrows the list instead of
 * widening it.
 *
 * Ranking puts a prefix match of the whole query first ("mech" -> "Mechanical
 * Engineer" above "Junior Mechanical Engineer"), then a match at the start of
 * any word, then anything else. Shorter titles win ties, because the shorter
 * one is the broader search and returns the superset.
 */
export function searchJobTitles(query: string, limit = 8): JobTitleSuggestion[] {
  const q = fold(query).trim();
  if (!q) return JOB_TITLES.filter((t) => t.popular);

  const words = q.split(/\s+/).filter(Boolean);

  return JOB_TITLES.map((entry) => {
    const folded = fold(entry.title);
    if (!words.every((w) => folded.includes(w))) return null;

    const startsWhole = folded.startsWith(q);
    const startsWord = folded.split(/[\s/&'-]+/).some((part) => part.startsWith(words[0]));
    const rank = startsWhole ? 0 : startsWord ? 1 : 2;
    return { entry, rank };
  })
    .filter((hit): hit is { entry: JobTitleSuggestion; rank: number } => hit !== null)
    .sort((a, b) => a.rank - b.rank || a.entry.title.length - b.entry.title.length)
    .slice(0, limit)
    .map((hit) => hit.entry);
}
