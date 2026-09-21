import React from 'react';
import {
  ArrowLeft, Check, Loader2, Plus, Trash2, User, Briefcase, GraduationCap,
  Wrench, Languages as LanguagesIcon, FileText, History, AlertTriangle,
  Upload, Undo2, Sparkles, Cloud, KeyRound, ShieldCheck, RefreshCw, DownloadCloud,
} from 'lucide-react';
import {
  fetchProfile, saveProfile, importProfileFromCv,
  type CandidateProfile, type ProfileExperience, type ProfileEducation,
  type ProfileImport,
} from '../services/profileApi';
import {
  getCloudAccount, setCloudKey, seedCloudBrowser, harvestCloudCookies,
  type CloudAccount,
} from '../services/directAtsApi';
import { HeldDocuments } from './HeldDocuments';
import { useCurrentUser, userKey, fetchPeople, type Person } from '../services/account';

/**
 * The profile: one record, edited in one place.
 *
 * Every part of this app already speaks for the candidate -- it fills
 * application forms, answers interview questions, signs letters, and is about
 * to decide what a tailored CV may claim -- and all of it read from a Python
 * dict that only an editor could change. So the facts were right by accident
 * and stale by default.
 *
 * The page is built around that use rather than as a settings screen: each
 * section says where its contents actually end up, because a field whose
 * effect is invisible is a field nobody keeps current. Experience and skills
 * get real editors rather than a JSON textarea for the same reason -- they are
 * the material the tailoring step selects from, and material you cannot see is
 * material you cannot trust.
 *
 * What is not here: passwords. The server neither sends nor stores them from
 * this page. A profile page that could show one is a profile page that shows
 * it to every screen share and browser cache.
 */

type SectionId =
  | 'identity' | 'professional' | 'experience' | 'education'
  | 'skills' | 'preferences' | 'documents' | 'applying' | 'history';

/** A language code as a person would say it, for the one line that shows one. */
const language = (code: string): string => (
  { de: 'German', fr: 'French', en: 'English', es: 'Spanish', it: 'Italian', nl: 'Dutch' }[code] || code || 'French'
);

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ElementType; hint: string }> = [
  { id: 'identity',     label: 'Identity',     icon: User,          hint: 'Name, contact, address' },
  { id: 'professional', label: 'Professional', icon: Briefcase,     hint: 'Title, summary, seniority' },
  { id: 'experience',   label: 'Experience',   icon: Briefcase,     hint: 'Roles the CV draws on' },
  { id: 'education',    label: 'Education',    icon: GraduationCap, hint: 'Degrees and schools' },
  { id: 'skills',       label: 'Skills',       icon: Wrench,        hint: 'Tools, methods, languages' },
  { id: 'preferences',  label: 'Preferences',  icon: LanguagesIcon, hint: 'Availability, mobility, pay' },
  { id: 'documents',    label: 'Documents',    icon: FileText,      hint: 'CV, transcripts, diplomas' },
  { id: 'applying',     label: 'Applying',     icon: Cloud,         hint: 'The browser that applies for you' },
  { id: 'history',      label: 'History',      icon: History,       hint: 'What was sent, and with what' },
];

/**
 * Which section a field belongs to, so that a CV import can point at the four
 * cards it changed instead of leaving forty boxes to be hunted through.
 */
const SECTION_OF: Record<string, SectionId> = {};
for (const [id, keys] of Object.entries({
  identity: ['first_name', 'last_name', 'full_name', 'email', 'phone', 'phone_formatted',
    'address', 'postal_code', 'city', 'country', 'full_address', 'linkedin', 'website',
    'github', 'portfolio', 'nationality', 'date_of_birth', 'gender'],
  professional: ['current_title', 'headline', 'summary', 'years_of_experience'],
  experience: ['experiences'],
  education: ['education'],
  skills: ['technical_skills', 'soft_skills', 'languages', 'certifications', 'projects',
    'awards', 'interests'],
  preferences: ['availability', 'notice_period', 'salary_expectation', 'contract_types',
    'willing_to_relocate', 'driving_licence', 'work_authorisation', 'cover_letter_notes'],
  documents: ['master_cv_html'],
} as Record<string, string[]>)) {
  for (const key of keys) SECTION_OF[key] = id as SectionId;
}

const INPUT =
  'w-full rounded-xl bg-black/25 px-3 py-2.5 text-[13.5px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.28)] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(120,170,255,0.6)]';
const LABEL =
  'block text-[11px] font-semibold uppercase tracking-[0.07em] text-[rgba(235,235,245,0.45)] mb-1.5';

/* Shared field primitives, so that forty inputs do not each drift a pixel. */

const Field: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  wide?: boolean;
  multiline?: boolean;
  rows?: number;
}> = ({ label, value, onChange, placeholder, hint, wide, multiline, rows = 4 }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className={LABEL}>{label}</span>
    {multiline ? (
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT} resize-y leading-relaxed`}
      />
    ) : (
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
    )}
    {hint && <span className="block mt-1 text-[11.5px] text-[rgba(235,235,245,0.4)]">{hint}</span>}
  </label>
);

/**
 * A field with a fixed set of answers, where typing one would be a spelling
 * test. Blank is always first and always allowed: "not stated" is an answer,
 * and forcing a choice here would mean forcing one on a form that asks nothing.
 */
const Choice: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
  hint?: string;
  wide?: boolean;
}> = ({ label, value, options, onChange, hint, wide }) => (
  <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
    <span className={LABEL}>{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      {options.map(([key, text]) => (
        <option key={key} value={key} className="bg-[#1c1c1e]">{text}</option>
      ))}
    </select>
    {hint && <span className="block mt-1 text-[11.5px] text-[rgba(235,235,245,0.4)]">{hint}</span>}
  </label>
);

/**
 * One section of the record, in a card the same size as every other section's.
 *
 * It used to be a card that grew to fit its contents, which made the page jump:
 * Identity is eight short fields and Experience is three jobs with their
 * achievements, so moving between them resized the panel, moved the menu beside
 * it and -- because the app itself does not scroll -- cut the longer sections
 * off at the bottom of the window with no way to reach the rest. The card now
 * fills the space it is given and scrolls inside itself, so the furniture stays
 * where it was put and nothing is out of reach.
 */
const Block: React.FC<{
  title: string;
  says: string;
  children: React.ReactNode;
  /** False when this card shares the column with another and the column scrolls. */
  grow?: boolean;
}> = ({ title, says, children, grow = true }) => (
  <section className={`ic-popover rounded-[22px] flex flex-col overflow-hidden ${
    grow ? 'h-full min-h-0' : 'shrink-0'
  }`}>
    <header className="shrink-0 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
      <h2 className="text-[17px] font-semibold text-[#f5f5f7] tracking-[-0.01em]">{title}</h2>
      <p className="text-[12.5px] text-[rgba(235,235,245,0.5)] mt-0.5">{says}</p>
    </header>
    <div className={`px-5 sm:px-6 pb-5 sm:pb-6 space-y-5 ${
      grow ? 'flex-1 min-h-0 overflow-y-auto custom-scrollbar' : ''
    }`}>
      {children}
    </div>
  </section>
);

/** Chips with a text box: skills, achievements, anything that is a flat list. */
const ChipList: React.FC<{
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}> = ({ items, onChange, placeholder }) => {
  const [draft, setDraft] = React.useState('');

  const add = () => {
    // Pasting a comma-separated list should add the list, not one long chip:
    // that is how a skills section actually gets filled the first time.
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...items];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft('');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] pl-3 pr-1.5 py-1 text-[12.5px] text-[#f5f5f7]"
          >
            {item}
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="w-5 h-5 rounded-full flex items-center justify-center text-[rgba(235,235,245,0.4)] hover:text-rose-300 hover:bg-white/10 cursor-pointer"
              aria-label={`Remove ${item}`}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </span>
        ))}
        {!items.length && (
          <span className="text-[12.5px] text-[rgba(235,235,245,0.35)]">Nothing yet.</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          className={INPUT}
        />
        <button
          type="button"
          onClick={add}
          className="ic-fill shrink-0 px-3 rounded-xl text-[13px] font-medium text-[#f5f5f7] cursor-pointer inline-flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>
    </div>
  );
};

/** One card in a repeatable list, with its own delete. */
const Repeatable: React.FC<{
  title: string;
  onRemove: () => void;
  children: React.ReactNode;
}> = ({ title, onRemove, children }) => (
  <div className="rounded-2xl bg-black/20 p-4 space-y-4 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.08)]">
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-[rgba(235,235,245,0.45)] truncate">
        {title}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="w-7 h-7 rounded-full flex items-center justify-center text-[rgba(235,235,245,0.4)] hover:text-rose-300 hover:bg-white/10 cursor-pointer shrink-0"
        aria-label={`Remove ${title}`}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
    {children}
  </div>
);

/**
 * The browser that applies on your behalf, and the account it is rented from.
 *
 * This exists because of one moment: the credit runs out halfway through a
 * search. Everything else about that moment is fine -- the CV is here, the
 * jobs are here, the sessions are here -- and the only thing standing between
 * you and the next application is a line in a file on a server. So the key is
 * typed here instead, and the four things that have to happen after it are not
 * left as homework: the key is checked, the old account's profile id is
 * dropped (profiles do not cross organisations), a profile is found or made on
 * the new account, and this machine's signed-in sessions are copied into its
 * browser. The last one is the difference between an application and a login
 * wall, and it is why a new account is a paste rather than an afternoon.
 *
 * The key is never shown back. Four characters of tail tell two accounts apart,
 * which is the only question this card has to answer about it.
 */
const CloudAccountCard: React.FC = () => {
  const [account, setAccount] = React.useState<CloudAccount | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState<'' | 'key' | 'seed' | 'harvest'>('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(async () => {
    setAccount(await getCloudAccount());
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  // Seeding starts a real browser and takes half a minute, so it runs on the
  // server and this watches it. Polling stops the moment it is over.
  const seeding = account?.seeding?.running;
  React.useEffect(() => {
    if (!seeding) return;
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [seeding, refresh]);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy('key'); setError(''); setNote('');
    try {
      const next = await setCloudKey(key);
      setAccount(next);
      setDraft('');
      setNote(next.message || 'Key saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That key did not work.');
    } finally {
      setBusy('');
    }
  };

  const signIn = async () => {
    setBusy('seed'); setError(''); setNote('');
    try { await seedCloudBrowser(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'It could not be signed in.'); }
    finally { setBusy(''); }
  };

  const bringHome = async () => {
    setBusy('harvest'); setError(''); setNote('');
    try {
      const r = await harvestCloudCookies();
      setNote(r.status === 'harvested'
        ? `Brought home ${r.count} cookies: ${r.added} new, ${r.replaced} refreshed.`
        : r.message || 'That browser had nothing to bring home.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The cookies could not be read.');
    } finally { setBusy(''); }
  };

  const domains = account?.domains || [];
  const vault = account?.vault_domains || [];

  return (
    <>
      <Block
        grow={false}
        title="The browser that applies"
        says="Applications run in a rented browser. This is the account it is rented from."
      >
        {account?.configured ? (
          <div className="flex items-center gap-3 rounded-2xl bg-black/20 px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)]">
            <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-300/80" />
            <span className="text-[13.5px] text-[#f5f5f7]">
              A key ending <span className="font-mono">{account.tail}</span> is in use
            </span>
            <span className="ml-auto text-[12px] text-[rgba(235,235,245,0.42)]">
              {account.source === 'settings' ? 'typed here' : 'from .env'}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-2xl bg-black/20 px-4 py-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)]">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-300/80" />
            <span className="text-[13.5px] text-[#f5f5f7]">No cloud account yet</span>
          </div>
        )}

        <div>
          <label className={LABEL} htmlFor="bu-key">Browser Use API key</label>
          <div className="flex gap-2">
            <input
              id="bu-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
              placeholder="bu_..."
              className={INPUT}
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={!draft.trim() || busy === 'key'}
              className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-white/[0.1] px-4 text-[13px] font-medium text-[#f5f5f7] hover:bg-white/[0.16] disabled:opacity-40 disabled:hover:bg-white/[0.1] transition-colors duration-150 cursor-pointer disabled:cursor-default"
            >
              {busy === 'key' ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              Use this key
            </button>
          </div>
          <p className="mt-2 text-[12.5px] text-[rgba(235,235,245,0.5)] leading-relaxed">
            When the credit runs out, make an account at cloud.browser-use.com and paste its key
            here. It takes effect at once -- no restart -- and the new browser is signed into your
            sites before the next application.
          </p>
        </div>

        {(note || error) && (
          <p className={`text-[13px] leading-relaxed ${error ? 'text-amber-300/90' : 'text-emerald-300/85'}`}>
            {error || note}
          </p>
        )}
      </Block>

      <Block
        grow={false}
        title="Signed-in sessions"
        says="Cookies from this machine, kept in the rented browser so boards show it an apply button."
      >
        {account?.seeding?.running ? (
          <p className="flex items-center gap-2 text-[13.5px] text-[#f5f5f7]">
            <Loader2 className="w-4 h-4 animate-spin text-[rgba(235,235,245,0.6)]" />
            {account.seeding.message || 'Signing the cloud browser in...'}
          </p>
        ) : domains.length ? (
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <span key={d} className="rounded-full bg-white/[0.07] px-3 py-1 text-[12.5px] text-[#f5f5f7]">
                {d}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[13.5px] text-[rgba(235,235,245,0.62)]">
            That browser is signed into nothing yet.
          </p>
        )}

        <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
          This machine can sign it into {vault.length} site{vault.length === 1 ? '' : 's'}
          {vault.length ? ` -- ${vault.slice(0, 4).join(', ')}${vault.length > 4 ? ` and ${vault.length - 4} more` : ''}` : ''}.
          Google and Gmail are held back on purpose: a board session is what an application needs,
          and the mail account is the key to everything else.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void signIn()}
            disabled={!account?.configured || busy === 'seed' || account?.seeding?.running}
            className="inline-flex items-center gap-2 rounded-xl bg-white/[0.1] px-4 py-2.5 text-[13px] font-medium text-[#f5f5f7] hover:bg-white/[0.16] disabled:opacity-40 transition-colors duration-150 cursor-pointer disabled:cursor-default"
          >
            {busy === 'seed' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Sign it in again
          </button>
          <button
            type="button"
            onClick={() => void bringHome()}
            disabled={!account?.configured || busy === 'harvest'}
            className="inline-flex items-center gap-2 rounded-xl bg-white/[0.1] px-4 py-2.5 text-[13px] font-medium text-[#f5f5f7] hover:bg-white/[0.16] disabled:opacity-40 transition-colors duration-150 cursor-pointer disabled:cursor-default"
          >
            {busy === 'harvest' ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
            Bring its cookies home
          </button>
        </div>
        {/* The one with a deadline on it. Reading a profile means starting a
            browser on it, and an account with no credit left cannot start one:
            whatever the cloud signed itself into is lost with the account
            unless it was brought home first. */}
        <p className="text-[12.5px] text-[rgba(235,235,245,0.45)] leading-relaxed">
          Bring them home before an account runs dry, not after -- reading that browser needs
          credit too. Sites it registered on by itself live only there until you do.
        </p>
      </Block>
    </>
  );
};

export const ProfilePage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [profile, setProfile] = React.useState<CandidateProfile | null>(null);
  const [error, setError] = React.useState('');
  /**
   * Which section is open, kept where a reload can find it.
   *
   * This page is eight pages wearing one hat. Losing the open one on every
   * refresh -- and being dropped back on Identity while you were halfway
   * through the documents -- is the kind of small rudeness that makes a page
   * feel like it is not listening. `?section=` rides in the same query as
   * `?tab=`, so the whole view is one link; localStorage catches the case
   * where the app is reopened without the query at all.
   *
   * Replaced in the history rather than pushed: the back button should leave
   * the profile, not walk back through every section visited on the way.
   */
  const [section, setSection] = React.useState<SectionId>(() => {
    const ids = new Set(SECTIONS.map((s) => s.id as string));
    const asked = new URLSearchParams(window.location.search).get('section') || '';
    if (ids.has(asked)) return asked as SectionId;
    try {
      const last = localStorage.getItem(userKey('mapjob.profile.section')) || '';
      if (ids.has(last)) return last as SectionId;
    } catch { /* storage off */ }
    return 'identity';
  });

  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('section') !== section) {
      url.searchParams.set('section', section);
      window.history.replaceState(window.history.state, '', url.toString());
    }
    try { localStorage.setItem(userKey('mapjob.profile.section'), section); } catch { /* storage off */ }
  }, [section]);

  // Leaving the profile takes the section marker with it: a `?section=` left
  // on the map view is a query that means nothing to the page showing it.
  React.useEffect(() => () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('section')) {
      url.searchParams.delete('section');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, []);

  // Whose profile this is: the account signed in, and no way to reach the
  // other one from here. Switching is signing out and signing in again, which
  // is the point -- a control that changed whose CV this page was editing,
  // mid-edit, is one misclick from an application signed with the wrong name.
  const [user] = useCurrentUser();
  const [people, setPeople] = React.useState<Person[]>([]);
  React.useEffect(() => { void fetchPeople().then((r) => setPeople(r.people)); }, []);
  const person = people.find((p) => p.id === user) || null;

  // What has been touched since the last save. A patch, not the whole record:
  // sending everything back would make this page the author of fields it never
  // showed, and quietly overwrite whatever else has changed them.
  const [dirty, setDirty] = React.useState<Record<string, unknown>>({});
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState(0);
  const [refused, setRefused] = React.useState<string[]>([]);

  // The CV import. What comes back from the server is a proposal: it lands in
  // the boxes, it counts as unsaved changes like anything else typed here, and
  // it can be taken straight back out again. A reader that wrote to the record
  // directly would be one bad two-column PDF away from replacing a real work
  // history with a mangled one.
  const chooser = React.useRef<HTMLInputElement | null>(null);
  const before = React.useRef<{ profile: CandidateProfile | null; dirty: Record<string, unknown> } | null>(null);
  const [reading, setReading] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  const [report, setReport] = React.useState<ProfileImport | null>(null);

  /* Refetched whenever the account changes, and the page emptied first: a
     switch that left the previous person's name in the boxes while the new
     record was in flight would invite a save of one person's address onto the
     other's record. */
  React.useEffect(() => {
    let current = true;
    setProfile(null);
    setDirty({});
    setReport(null);
    setRefused([]);
    setSavedAt(0);
    before.current = null;
    fetchProfile(user)
      .then((r) => { if (current) { setProfile(r.profile); setError(''); } })
      .catch((e) => { if (current) setError(e.message || 'The profile could not be loaded.'); });
    return () => { current = false; };
  }, [user]);

  const set = React.useCallback((key: string, value: unknown) => {
    setProfile((p) => (p ? { ...p, [key]: value } : p));
    setDirty((d) => ({ ...d, [key]: value }));
    setSavedAt(0);
  }, []);

  const str = (key: string) => String((profile?.[key] as string | number | undefined) ?? '');

  const save = React.useCallback(async () => {
    if (!Object.keys(dirty).length || saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await saveProfile(dirty, user);
      setProfile(res.profile);
      setDirty({});
      setRefused(res.refused || []);
      setSavedAt(Date.now());
      // Once it is stored, the import is not a proposal any more: the banner
      // goes, and with it an Undo that would now only re-dirty the form.
      before.current = null;
      setReport(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The save did not go through.');
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, user]);

  const readCv = React.useCallback(async (file: File | null) => {
    if (!file || reading) return;
    setReading(true);
    setError('');
    setReport(null);
    try {
      const result = await importProfileFromCv(file, user);
      const fields = result.fields || {};
      if (Object.keys(fields).length) {
        // The way back, kept before anything is overwritten.
        before.current = { profile, dirty };
        setProfile((p) => (p ? { ...p, ...fields } : (fields as CandidateProfile)));
        setDirty((d) => ({ ...d, ...fields }));
        setSavedAt(0);
      }
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That CV could not be read.');
    } finally {
      setReading(false);
    }
  }, [profile, dirty, reading, user]);

  const undoImport = React.useCallback(() => {
    const snapshot = before.current;
    if (!snapshot) return;
    setProfile(snapshot.profile);
    setDirty(snapshot.dirty);
    before.current = null;
    setReport(null);
  }, []);

  /** The same control in two places: the header, and the Documents card. */
  const pick = React.useCallback(() => chooser.current?.click(), []);

  // Ctrl/Cmd+S, because this is a form people leave open while reading a job
  // ad, and the reflex is already in their hands.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save]);

  const experiences: ProfileExperience[] = (profile?.experiences as ProfileExperience[]) || [];
  const education: ProfileEducation[] = (profile?.education as ProfileEducation[]) || [];
  const skills: string[] = (profile?.technical_skills as string[]) || [];
  const languages: Record<string, string> = (profile?.languages as Record<string, string>) || {};
  const pending = Object.keys(dirty).length;

  const filled = report?.found || [];
  const touched = SECTIONS.filter((s) => filled.some((key) => SECTION_OF[key] === s.id));
  const touchedIds = new Set(touched.map((s) => s.id));

  return (
    /* A frame the height of what is left of the window, not of its contents:
       the app shell does not scroll, so a page that grows past the bottom of
       the screen simply loses the rest of itself. */
    <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 lg:px-10 py-6 max-w-[1180px] w-full mx-auto">
      <header className="shrink-0 flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={onClose}
          className="ic-fill w-9 h-9 rounded-full flex items-center justify-center text-[#f5f5f7] cursor-pointer shrink-0"
          aria-label="Back to the map"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] sm:text-[26px] font-semibold text-[#f5f5f7] tracking-[-0.02em] truncate">
            {profile?.full_name || person?.display_name || 'Your profile'}
          </h1>
          <p className="text-[12.5px] text-[rgba(235,235,245,0.5)] truncate">
            {person?.focus
              ? person.focus + ' · letters in ' + language(person.letter_language)
              : 'Everything the app says about you: forms, interview answers, letters, and the tailored CV.'}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Cleared on every pick, so uploading the same file twice reads it
              twice -- a corrected CV has the same name as the one it corrects. */}
          <input
            ref={chooser}
            type="file"
            accept=".pdf,.docx,application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              e.target.value = '';
              void readCv(file);
            }}
          />
          <button
            type="button"
            onClick={pick}
            disabled={reading}
            title="Read a CV and fill these fields from it"
            className="ic-fill px-3.5 h-9 rounded-full text-[13.5px] font-medium text-[#f5f5f7] cursor-pointer disabled:opacity-50 disabled:cursor-wait inline-flex items-center gap-2"
          >
            {reading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{reading ? 'Reading the CV' : 'Fill from a CV'}</span>
          </button>
          {savedAt > 0 && !pending && (
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[12.5px] text-emerald-300">
              <Check className="w-3.5 h-3.5" /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!pending || saving}
            className="ic-fill px-4 h-9 rounded-full text-[13.5px] font-medium text-[#f5f5f7] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {pending ? `Save ${pending} change${pending > 1 ? 's' : ''}` : 'Saved'}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-5 rounded-2xl bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200 shadow-[inset_0_0_0_0.5px_rgba(255,120,120,0.25)]">
          {error}
        </div>
      )}
      {refused.length > 0 && (
        <div className="mb-5 rounded-2xl bg-amber-400/10 px-4 py-3 text-[13px] text-amber-100 shadow-[inset_0_0_0_0.5px_rgba(255,200,120,0.25)] flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The server would not store {refused.join(', ')}. Passwords are kept out of this page on
            purpose: they live in the environment file, not in a browser.
          </span>
        </div>
      )}

      {report && (
        <div className="mb-5 rounded-2xl bg-sky-400/10 px-4 py-3 text-[13px] text-sky-100 shadow-[inset_0_0_0_0.5px_rgba(120,180,255,0.25)] flex items-start gap-2.5">
          <Sparkles className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1">
            {filled.length > 0 ? (
              <p>
                <span className="font-semibold">{filled.length} field{filled.length > 1 ? 's' : ''}</span>
                {' '}read from {report.filename}
                {touched.length > 0 && <> in {touched.map((s) => s.label).join(', ')}</>}. Check
                them, change what is wrong, then save -- nothing is stored until you do.
              </p>
            ) : (
              <p>Nothing came out of {report.filename}.</p>
            )}
            {report.source === 'patterns' && filled.length > 0 && (
              <p className="text-[12.5px] text-sky-200/70">
                Only the contact block could be read this time; the rest of the page is still yours to fill.
              </p>
            )}
            {report.notes.map((note, i) => (
              <p key={i} className="text-[12.5px] text-sky-200/70">{note}</p>
            ))}
          </div>
          {before.current && (
            <button
              type="button"
              onClick={undoImport}
              className="shrink-0 rounded-full px-3 h-7 text-[12.5px] text-sky-100 bg-white/[0.07] hover:bg-white/[0.12] cursor-pointer inline-flex items-center gap-1.5"
            >
              <Undo2 className="w-3.5 h-3.5" /> Undo
            </button>
          )}
          <button
            type="button"
            onClick={() => setReport(null)}
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sky-100/50 hover:text-sky-100 hover:bg-white/10 cursor-pointer"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 grid lg:grid-cols-[220px_1fr] gap-5">
        {/* The menu is the one thing on this page that must not move: its own
            height, at the top, whatever is beside it. */}
        <nav className="ic-popover rounded-[22px] p-2 self-start shrink-0 flex lg:block gap-1 overflow-x-auto">
          {SECTIONS.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`w-full text-left rounded-2xl px-3 py-2.5 cursor-pointer transition-colors duration-150 shrink-0 ${
                section === id ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'
              }`}
              aria-current={section === id}
            >
              <span className="flex items-center gap-2.5">
                <Icon className={`w-4 h-4 shrink-0 ${section === id ? 'text-[#f5f5f7]' : 'text-[rgba(235,235,245,0.45)]'}`} />
                <span className={`text-[13.5px] whitespace-nowrap ${section === id ? 'text-[#f5f5f7] font-medium' : 'text-[rgba(235,235,245,0.7)]'}`}>
                  {label}
                </span>
                {/* Where the CV landed, until it is saved or undone. */}
                {touchedIds.has(id) && (
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-300 shrink-0" aria-label="Filled from your CV" />
                )}
              </span>
              <span className="hidden lg:block text-[11.5px] text-[rgba(235,235,245,0.38)] pl-[26px] leading-tight mt-0.5">
                {hint}
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 min-h-0 h-full">
          {!profile && !error && (
            <div className="ic-popover rounded-[22px] h-full flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-[rgba(235,235,245,0.4)]" />
            </div>
          )}

          {profile && section === 'identity' && (
            <Block title="Identity" says="Typed into every application form, and used to address letters.">
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="First name" value={str('first_name')} onChange={(v) => set('first_name', v)} />
                <Field label="Last name" value={str('last_name')} onChange={(v) => set('last_name', v)} />
                <Field label="Full name" value={str('full_name')} onChange={(v) => set('full_name', v)} wide />
                <Field label="Email" value={str('email')} onChange={(v) => set('email', v)} />
                <Field label="Phone" value={str('phone_formatted')} onChange={(v) => set('phone_formatted', v)}
                       hint="As a person reads it. The dialling form is kept separately." />
                <Field label="Street" value={str('address')} onChange={(v) => set('address', v)} wide />
                <Field label="Postal code" value={str('postal_code')} onChange={(v) => set('postal_code', v)} />
                <Field label="City" value={str('city')} onChange={(v) => set('city', v)} />
                <Field label="Country" value={str('country')} onChange={(v) => set('country', v)} />
                <Field label="Full address" value={str('full_address')} onChange={(v) => set('full_address', v)}
                       hint="One line, for forms with a single address box." />
                <Choice
                  label="German wording"
                  value={str('gender')}
                  onChange={(v) => set('gender', v)}
                  options={[['', 'Leave the advert’s wording alone'], ['female', 'Feminine — Kauffrau, zur'], ['male', 'Masculine — Kaufmann, zum']]}
                  hint="German job titles are gendered and adverts write both halves: Kaufmann/-frau, Ausbildung zum/zur. This decides which half goes on your cover sheet. Nothing infers it from your name, so leaving it blank simply keeps the advert’s own wording."
                  wide
                />
                <Field label="LinkedIn" value={str('linkedin')} onChange={(v) => set('linkedin', v)} wide />
                <Field label="Website" value={str('website')} onChange={(v) => set('website', v)} wide />
              </div>
            </Block>
          )}

          {profile && section === 'professional' && (
            <Block title="Professional" says="The headline a tailored CV starts from, and how the interview helper introduces you.">
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Current title" value={str('current_title')} onChange={(v) => set('current_title', v)} wide />
                <Field label="Headline" value={str('headline')} onChange={(v) => set('headline', v)} wide
                       hint="The line under your name on the CV. Left empty, the master CV keeps its own." />
                <Field label="Years of experience" value={str('years_of_experience')}
                       onChange={(v) => set('years_of_experience', v === '' ? '' : Number(v))} />
                <Field label="Summary" value={str('summary')} onChange={(v) => set('summary', v)} wide multiline
                       hint="Tailoring may shorten and re-angle this for a job. It will not add to it." />
              </div>
            </Block>
          )}

          {profile && section === 'experience' && (
            <Block title="Experience" says="The only facts a tailored CV may draw on. What is not written here cannot be claimed.">
              <div className="space-y-4">
                {experiences.map((job, i) => (
                  <Repeatable
                    key={i}
                    title={job.company || job.title || `Role ${i + 1}`}
                    onRemove={() => set('experiences', experiences.filter((_, j) => j !== i))}
                  >
                    <div className="grid sm:grid-cols-2 gap-4">
                      {/* The record calls this `role`; `title` is only there
                          because an older shape used it. Read either, write the
                          one the rest of the app reads, or the box comes up
                          empty on a profile that plainly has a job in it. */}
                      <Field label="Role" value={job.role || job.title || ''}
                             onChange={(v) => set('experiences', experiences.map((x, j) => (j === i ? { ...x, role: v } : x)))} />
                      <Field label="Company" value={job.company || ''}
                             onChange={(v) => set('experiences', experiences.map((x, j) => (j === i ? { ...x, company: v } : x)))} />
                      <Field label="Location" value={job.location || ''}
                             onChange={(v) => set('experiences', experiences.map((x, j) => (j === i ? { ...x, location: v } : x)))} />
                      <Field label="Period" value={job.period || ''}
                             onChange={(v) => set('experiences', experiences.map((x, j) => (j === i ? { ...x, period: v } : x)))} />
                    </div>
                    <div>
                      <span className={LABEL}>What you did</span>
                      <ChipList
                        items={job.highlights || []}
                        placeholder="One achievement, then Enter"
                        onChange={(next) => set('experiences', experiences.map((x, j) => (j === i ? { ...x, highlights: next } : x)))}
                      />
                    </div>
                  </Repeatable>
                ))}
                <button
                  type="button"
                  onClick={() => set('experiences', [...experiences, { title: '', company: '', period: '', highlights: [] }])}
                  className="ic-fill w-full rounded-2xl py-3 text-[13.5px] text-[#f5f5f7] cursor-pointer inline-flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Add a role
                </button>
              </div>
            </Block>
          )}

          {profile && section === 'education' && (
            <Block title="Education" says="Used on the CV, and to answer the degree questions forms ask.">
              <div className="space-y-4">
                {education.map((ed, i) => (
                  <Repeatable
                    key={i}
                    title={ed.institution || ed.degree || `Entry ${i + 1}`}
                    onRemove={() => set('education', education.filter((_, j) => j !== i))}
                  >
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Field label="Degree" value={ed.degree || ''} wide
                             onChange={(v) => set('education', education.map((x, j) => (j === i ? { ...x, degree: v } : x)))} />
                      <Field label="Institution" value={ed.institution || ''} wide
                             onChange={(v) => set('education', education.map((x, j) => (j === i ? { ...x, institution: v } : x)))} />
                      <Field label="Location" value={ed.location || ''}
                             onChange={(v) => set('education', education.map((x, j) => (j === i ? { ...x, location: v } : x)))} />
                      <Field label="Period" value={ed.period || ''}
                             onChange={(v) => set('education', education.map((x, j) => (j === i ? { ...x, period: v } : x)))} />
                    </div>
                  </Repeatable>
                ))}
                <button
                  type="button"
                  onClick={() => set('education', [...education, { degree: '', institution: '', period: '' }])}
                  className="ic-fill w-full rounded-2xl py-3 text-[13.5px] text-[#f5f5f7] cursor-pointer inline-flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Add a degree
                </button>
              </div>
            </Block>
          )}

          {profile && section === 'skills' && (
            /* Two cards in one column, so the column scrolls rather than each
               card fighting the other for the same height. */
            <div className="h-full min-h-0 overflow-y-auto custom-scrollbar space-y-5 pr-0.5">
              <Block grow={false} title="Technical skills" says="What tailoring may pull forward when a job asks for it.">
                <ChipList
                  items={skills}
                  placeholder="SolidWorks, Ansys, Python -- commas or Enter"
                  onChange={(next) => set('technical_skills', next)}
                />
              </Block>
              <Block grow={false} title="Languages" says="Asked for on most European forms, and used to pick the language a letter is written in.">
                <div className="space-y-3">
                  {Object.entries(languages).map(([name, level], i) => (
                    <div key={`${name}-${i}`} className="grid sm:grid-cols-[1fr_1.4fr_auto] gap-2 items-end">
                      <Field label="Language" value={name} onChange={(v) => {
                        // Rebuilt in order rather than deleted and re-added, so
                        // renaming a language does not send it to the bottom
                        // under the cursor.
                        const next: Record<string, string> = {};
                        for (const [k, val] of Object.entries(languages)) next[k === name ? v : k] = val;
                        set('languages', next);
                      }} />
                      <Field label="Level" value={level} onChange={(v) => set('languages', { ...languages, [name]: v })} />
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...languages };
                          delete next[name];
                          set('languages', next);
                        }}
                        className="h-[42px] w-10 rounded-xl flex items-center justify-center text-[rgba(235,235,245,0.4)] hover:text-rose-300 hover:bg-white/10 cursor-pointer"
                        aria-label={`Remove ${name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => set('languages', { ...languages, '': '' })}
                    className="ic-fill w-full rounded-2xl py-3 text-[13.5px] text-[#f5f5f7] cursor-pointer inline-flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" /> Add a language
                  </button>
                </div>
              </Block>
            </div>
          )}

          {profile && section === 'preferences' && (
            <Block title="Preferences" says="The questions application forms ask that have nothing to do with your CV.">
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Availability" value={str('availability')} onChange={(v) => set('availability', v)}
                       placeholder="Immediately / from 1 March" />
                <Field label="Notice period" value={str('notice_period')} onChange={(v) => set('notice_period', v)} />
                <Field label="Salary expectation" value={str('salary_expectation')} onChange={(v) => set('salary_expectation', v)}
                       hint="Left empty, the agent skips the question rather than inventing a number." />
                <Field label="Willing to relocate" value={str('willing_to_relocate')} onChange={(v) => set('willing_to_relocate', v)} />
                <Field label="Driving licence" value={str('driving_licence')} onChange={(v) => set('driving_licence', v)} />
                <Field label="Right to work" value={str('work_authorisation')} onChange={(v) => set('work_authorisation', v)} />
                <Field label="Notes for cover letters" value={str('cover_letter_notes')} onChange={(v) => set('cover_letter_notes', v)}
                       wide multiline rows={3}
                       hint="Anything a letter should always mention, or never." />
              </div>
            </Block>
          )}

          {profile && section === 'documents' && (
            /* Two cards in one column, like Skills: the page itself does not
               scroll, so a second card below a full-height first one is a card
               nobody can reach. */
            <div className="h-full min-h-0 overflow-y-auto custom-scrollbar space-y-5 pr-0.5">
            <Block grow={false} title="Documents" says="The master CV every tailored version is cut from.">
              <div
                onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
                onDragLeave={() => setDropping(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropping(false);
                  void readCv(e.dataTransfer.files?.[0] || null);
                }}
                onClick={pick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
                className={`rounded-2xl px-5 py-8 text-center cursor-pointer transition-colors duration-150 ${
                  dropping
                    ? 'bg-sky-400/10 shadow-[inset_0_0_0_1px_rgba(120,180,255,0.5)]'
                    : 'bg-black/20 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] hover:bg-black/25'
                }`}
              >
                {reading ? (
                  <Loader2 className="w-5 h-5 mx-auto animate-spin text-[rgba(235,235,245,0.5)]" />
                ) : (
                  <Upload className="w-5 h-5 mx-auto text-[rgba(235,235,245,0.45)]" />
                )}
                <p className="mt-3 text-[13.5px] text-[#f5f5f7]">
                  {reading ? 'Reading your CV' : 'Drop a CV here, or choose a file'}
                </p>
                <p className="mt-1 text-[12.5px] text-[rgba(235,235,245,0.45)]">
                  PDF or DOCX. Every field it states is filled in for you.
                </p>
              </div>
              {/* Said plainly, because it stopped being true the day the upload
                  was kept: the fields are a proposal, the file is not. */}
              <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
                Two things happen to a CV dropped here. Its fields fill this page as a proposal --
                they reach the record only when you save, and Undo puts back what was there. The
                file itself is kept as your master CV, and every tailored version is cut from it.
                Uploading another replaces it.
              </p>
              <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
                The master CV is the only source of facts the tailoring step may use, which is why
                it is worth keeping current: nothing a tailored CV claims can come from anywhere else.
              </p>
            </Block>

            <Block
              grow={false}
              title="Your documents"
              says="Held once, offered every time you apply: transcripts, diplomas, references, permits."
            >
              <HeldDocuments />
            </Block>
            </div>
          )}

          {section === 'applying' && (
            <div className="h-full min-h-0 overflow-y-auto custom-scrollbar space-y-5 pr-0.5">
              <CloudAccountCard />
            </div>
          )}

          {profile && section === 'history' && (
            <Block title="History" says="What was sent, to whom, and with which documents.">
              <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
                Applications are already recorded with their outcome. This is where the CV and letter
                that went with each one will hang off it, so an interview call can be answered with the
                version they actually read.
              </p>
            </Block>
          )}
        </div>
      </div>
    </div>
  );
};
