/**
 * Does this job's title answer the search, or merely share a word with it?
 *
 * Searching "ingénieur mécanique" was returning maintenance technicians and
 * electrical engineers, and there were two reasons, one at each end.
 *
 * Adzuna's `what` is a relevance search, not a filter. Where there are plenty
 * of exact matches -- Paris -- the first pages are clean and the looseness
 * never shows. Over a thin rural area there are only a handful, so the engine
 * fills the rest of the page with ads that matched one word out of two, and
 * those arrive looking exactly like the real ones. `title_only` is the fix at
 * that end: a title match is the one signal that reliably means "this is the
 * job you asked for".
 *
 * At this end, the client asked whether ANY query word appeared ANYWHERE in
 * the title, company, location, description or category. "Ingénieur" appears
 * in the description of nearly every engineering ad ever written, so that
 * test passed everything it was shown. This module replaces it with a
 * question about the title alone: how much of what you asked for does this
 * title actually say?
 *
 * It is deliberately shallow -- folding, prefixes, and a table of equivalents
 * across the five languages the app searches in. No stemmer, no synonym
 * expansion by embedding: over-clever matching here fails in the direction
 * that caused the complaint.
 */

/** é -> e, ü -> u. Employers write the same word both ways in the same ad. */
export function fold(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Words that carry no discipline. Gender tags (h/f, m/w), contract types and
 * seniority are dropped from the *requirement* -- asking for "senior" in the
 * title would throw away the job the person wants over a word the employer
 * happened not to print.
 */
const NOISE = new Set([
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'en', 'au', 'aux', 'pour', 'sur',
  'the', 'of', 'and', 'in', 'for', 'to', 'with', 'at', 'an', 'a',
  'der', 'die', 'das', 'und', 'fur', 'im', 'von', 'zur',
  'van', 'voor', 'met', 'het', 'een',
  'di', 'del', 'della', 'per', 'con', 'el', 'los', 'las', 'para',
  'hf', 'fh', 'mf', 'fm', 'mw', 'wm', 'mwd', 'fmd', 'hfd',
  'cdi', 'cdd', 'fte', 'uur', 'wtf',
  'senior', 'junior', 'medior', 'confirme', 'confirmee', 'experimente', 'experimentee',
  'debutant', 'stage', 'stagiaire', 'alternance', 'apprenti', 'intern', 'internship',
  'freelance', 'interim', 'vast', 'fulltime', 'parttime',
]);

/**
 * Words that mean the same job in the languages this app searches.
 *
 * This is what lets "ingénieur mécanique" still find "Mechanical Engineer" at
 * a French site, and -- more to the point -- what lets the filter tell an
 * engineer from a technician instead of seeing two words that both start with
 * "t-e-c". Each row is one concept; every spelling in it folds to the row's
 * name before anything is compared.
 */
const CONCEPTS: Record<string, string[]> = {
  engineer: ['engineer', 'engineering', 'ingenieur', 'ingenieure', 'ingenieurin', 'ingegnere',
    'ingeniero', 'ingeniera', 'enginyer', 'inginer'],
  technician: ['technician', 'technicien', 'technicienne', 'techniker', 'technicus', 'tecnico',
    'tecnica', 'monteur', 'monteuse'],
  mechanic: ['mechanic', 'mecanicien', 'mecanicienne', 'meccanico', 'mecanico', 'monteur'],
  /* 'meccanico' and 'mecanico' appear here AND under `mechanic` on purpose:
   * Italian and Spanish use the one word for both the trade and the
   * discipline, and "ingegnere meccanico" is simply how "mechanical engineer"
   * is written. French keeps them apart -- mécanicien is not mécanique -- and
   * so does this table. */
  mechanical: ['mechanical', 'mecanique', 'mecanica', 'meccanica', 'meccanico', 'mecanico',
    'mechanisch', 'mechanische', 'maschinenbau', 'werktuigbouwkunde', 'werktuigbouw',
    'werktuigkundig'],
  electrical: ['electrical', 'electrique', 'electricite', 'elektrisch', 'elektrische', 'elektro',
    'elettrico', 'elettrica', 'electrico', 'elektrotechniek', 'elektrotechnik'],
  electronics: ['electronics', 'electronique', 'elektronica', 'elektronik', 'elettronica'],
  software: ['software', 'logiciel', 'logiciels', 'informatique', 'softwareontwikkelaar'],
  civil: ['civil', 'genie civil', 'bouwkunde', 'bauingenieur', 'civiele'],
  design: ['design', 'designer', 'conception', 'concepteur', 'konstruktion', 'konstrukteur',
    'ontwerp', 'ontwerper', 'progettazione', 'progettista', 'diseno'],
  simulation: ['simulation', 'simulatie', 'calcul', 'calculs', 'fea', 'fem', 'cfd', 'berechnung'],
  maintenance: ['maintenance', 'onderhoud', 'wartung', 'instandhaltung', 'manutenzione',
    'mantenimiento'],
  production: ['production', 'productie', 'produktion', 'fertigung', 'produzione', 'produccion',
    'manufacturing', 'fabrication'],
  quality: ['quality', 'qualite', 'kwaliteit', 'qualitat', 'qualita', 'calidad', 'qa'],
  automation: ['automation', 'automatisation', 'automatisering', 'automatisierung',
    'automatisme', 'automatismes', 'automazione'],
  robotics: ['robotics', 'robotique', 'robotica', 'robotik', 'robot'],
  project: ['project', 'projet', 'projekt', 'progetto', 'proyecto'],
  manager: ['manager', 'responsable', 'chef', 'leiter', 'leider', 'leidinggevende', 'hoofd',
    'gestionnaire', 'directeur', 'head', 'responsabile', 'jefe', 'encargado'],
  developer: ['developer', 'developpeur', 'ontwikkelaar', 'entwickler', 'sviluppatore'],
  thermal: ['thermal', 'thermique', 'thermisch', 'termico', 'warmte'],
  hydraulic: ['hydraulic', 'hydraulique', 'hydraulisch', 'idraulico'],
  welding: ['welding', 'welder', 'soudure', 'soudeur', 'soudeuse', 'lassen', 'lasser',
    'schweisser', 'schweissen', 'saldatura', 'saldatore'],
  logistics: ['logistics', 'logistique', 'logistiek', 'logistik', 'logistica'],
  sales: ['sales', 'commercial', 'vertrieb', 'verkoop', 'ventas', 'vendite'],
  nurse: ['nurse', 'infirmier', 'infirmiere', 'verpleegkundige', 'krankenpfleger'],
  driver: ['driver', 'chauffeur', 'conducteur', 'fahrer', 'autista'],
};

/**
 * variant -> concepts, built once. A list rather than one value because a few
 * words honestly mean two things at once (see 'meccanico' above), and picking
 * one of them would be picking which half of the language to get wrong.
 */
const CONCEPT_OF = new Map<string, string[]>();
function link(word: string, concept: string): void {
  const already = CONCEPT_OF.get(word);
  if (!already) CONCEPT_OF.set(word, [concept]);
  else if (!already.includes(concept)) already.push(concept);
}
for (const [concept, words] of Object.entries(CONCEPTS)) {
  link(concept, concept);
  for (const word of words) link(fold(word), concept);
}

/** Splits on anything that is not a letter or digit, folds, drops the noise. */
export function terms(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
}

/** The long variants, for the prefix pass below. */
const LONG_VARIANTS: Array<[string, string[]]> = [...CONCEPT_OF.entries()].filter(
  ([word]) => word.length >= 6
);

/**
 * The concepts a word belongs to, or the word itself when it names none.
 *
 * The table cannot list every derived form a language will build -- Dutch and
 * German in particular glue them together, and "werktuigbouwkundig" is the
 * adjective of a word that is already a compound. So a word that is not in the
 * table is tried as a prefix of one, and vice versa, at six characters or
 * more: long enough that the shared opening is the shared root and not a
 * coincidence.
 */
const CONCEPT_CACHE = new Map<string, string[]>();
function conceptsOf(word: string): string[] {
  const exact = CONCEPT_OF.get(word);
  if (exact) return exact;
  const cached = CONCEPT_CACHE.get(word);
  if (cached !== undefined) return cached;
  let found = [word];
  if (word.length >= 6) {
    for (const [variant, concepts] of LONG_VARIANTS) {
      if (word.startsWith(variant) || variant.startsWith(word)) {
        found = concepts;
        break;
      }
    }
  }
  CONCEPT_CACHE.set(word, found);
  return found;
}

/**
 * Whether one query word is present in a title's words.
 *
 * Prefix matching in both directions handles plurals and the feminine forms
 * French job titles are full of ("ingénieure", "mécaniques"), with a floor of
 * four characters so that short words are not matched on their first letters.
 * Note what it deliberately does NOT match: "mecanique" against "mecanicien"
 * -- they share seven characters and neither is a prefix of the other, and
 * the difference between them is a different job.
 *
 * The last pass looks inside compounds, where the word wanted is buried in the
 * middle rather than at the front: "Maschinenbauingenieur" is one word that
 * says both halves of "ingénieur mécanique". It needs the containing word to
 * be four characters longer, so this only ever fires on a real compound.
 */
function present(word: string, titleWords: string[], titleConcepts: Set<string>): boolean {
  if (titleWords.includes(word)) return true;
  const concepts = conceptsOf(word);
  /* No "unless the word is its own concept" exception here: the concept names
   * are English, so that exception silently switched this pass off for exactly
   * the English queries -- "nurse" did not find "Infirmier". A word that names
   * no concept stands for itself, and then this only repeats the test above. */
  if (concepts.some((c) => titleConcepts.has(c))) return true;
  if (word.length < 4) return false;
  if (titleWords.some((t) => t.length >= 4 && (t.startsWith(word) || word.startsWith(t)))) {
    return true;
  }
  const inside = (needle: string) =>
    titleWords.some((t) => t.length >= needle.length + 4 && t.includes(needle));
  if (inside(word)) return true;
  return concepts.some((c) => (CONCEPTS[c] || []).some((v) => inside(fold(v))));
}

export interface TitleMatch {
  /** How many of the query's words the title accounts for. */
  covered: number;
  /** How many it was asked for. */
  wanted: number;
  /** The title says everything the query asked for. */
  full: boolean;
}

/**
 * How much of the query this title actually answers.
 *
 * A query with no usable words -- punctuation, or only noise -- returns a full
 * match for everything, because an empty question cannot be answered wrongly
 * and the alternative is an empty screen.
 */
export function matchTitle(title: string, queryTerms: string[]): TitleMatch {
  if (queryTerms.length === 0) return { covered: 0, wanted: 0, full: true };
  const titleWords = terms(title);
  const titleConcepts = new Set(titleWords.flatMap(conceptsOf));
  let covered = 0;
  for (const word of queryTerms) {
    if (present(word, titleWords, titleConcepts)) covered += 1;
  }
  return { covered, wanted: queryTerms.length, full: covered === queryTerms.length };
}
