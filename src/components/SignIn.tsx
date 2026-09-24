import React from 'react';
import { ArrowLeft, ArrowRight, Loader2, Lock } from 'lucide-react';
import { fetchPeople, signInWithPassword, type Person } from '../services/account';

/**
 * The door. Nothing of the app is rendered until somebody comes through it.
 *
 * Two people use this app from the same machine, and they are not two modes of
 * one user: one applies for mechanical engineering posts in France, the other
 * for Ausbildung places in Germany. Everything downstream -- the profile, the
 * held documents, the master CV, the language a letter is written in, whether
 * an application is a letter plus a CV or one bound Bewerbung -- belongs to
 * whoever is signed in. A control that relabelled a shared app would leave the
 * other person's transcript one tick away from an employer's inbox.
 *
 * So the account is chosen once, here, and then it is simply who you are: the
 * app mounts fresh underneath it and everything it remembers is filed under
 * that name. Signing out brings this page back.
 *
 * Two steps, and the second one is a password. The server checks it -- an
 * answer the browser knows is an answer anybody can read out of the bundle --
 * and only a right one calls `signIn`. The reach of that lock is the front
 * door and no further: every API route still answers for whatever account it
 * is handed, so this keeps two people who share a machine out of each other's
 * profiles and drafts, and is not a defence against someone who can reach the
 * service itself. That is a session token on every route, and it is the next
 * thing this seam grows.
 */

/** Two letters for the disc: a face is not on file, and initials read fine. */
const initials = (name: string): string =>
  (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?';

const LANGUAGE: Record<string, string> = {
  fr: 'French', de: 'German', en: 'English', es: 'Spanish', it: 'Italian', nl: 'Dutch',
};

export const SignIn: React.FC = () => {
  const [people, setPeople] = React.useState<Person[] | null>(null);
  /** The card that was clicked, waiting on a password. Null means nobody yet. */
  const [asking, setAsking] = React.useState<Person | null>(null);
  const [password, setPassword] = React.useState('');
  const [checking, setChecking] = React.useState(false);
  const [refused, setRefused] = React.useState('');
  const fieldRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    void fetchPeople().then((r) => setPeople(r.people));
  }, []);

  // The field is the only thing on the step, so the cursor belongs in it.
  React.useEffect(() => {
    if (asking) fieldRef.current?.focus();
  }, [asking]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!asking || checking) return;
    setChecking(true);
    setRefused('');
    const answer = await signInWithPassword(asking.id, password);
    if (answer.ok) return;   // The tree is being torn down and rebuilt; leave it.
    setRefused(answer.reason);
    // Cleared, not left standing. A wrong password still in the box invites
    // hitting Enter again, which fails the same way a third of a second later.
    setPassword('');
    setChecking(false);
    fieldRef.current?.focus();
  };

  const back = () => {
    setAsking(null);
    setPassword('');
    setRefused('');
  };

  if (asking) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center px-5 text-[#f5f5f7] font-sans antialiased">
        <form onSubmit={submit} className="w-full max-w-[380px]">
          <div className="ic-popover p-6 rounded-[22px]">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-white/[0.12] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)] flex items-center justify-center text-[16px] font-semibold tracking-[-0.02em] text-[rgba(235,235,245,0.78)]">
                {initials(asking.display_name)}
              </div>
              <div className="min-w-0">
                <p className="text-[16px] font-semibold tracking-[-0.02em] truncate">
                  {asking.display_name}
                </p>
                <p className="text-[12.5px] text-[rgba(235,235,245,0.52)] truncate">
                  {asking.focus}
                </p>
              </div>
            </div>

            <label
              htmlFor="mapjob-password"
              className="mt-5 block text-[12px] font-semibold tracking-[0.04em] uppercase text-[rgba(235,235,245,0.42)]"
            >
              Password
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-2xl bg-white/[0.07] px-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.14)] focus-within:shadow-[inset_0_0_0_1px_rgba(120,170,255,0.65)] transition-shadow">
              <Lock className="w-4 h-4 shrink-0 text-[rgba(235,235,245,0.42)]" />
              <input
                id="mapjob-password"
                ref={fieldRef}
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setRefused(''); }}
                autoComplete="current-password"
                className="flex-1 bg-transparent py-3 text-[15px] tracking-[0.12em] outline-none placeholder:tracking-normal placeholder:text-[rgba(235,235,245,0.32)]"
                placeholder="••••"
              />
            </div>

            {refused ? (
              <p role="alert" className="mt-2 text-[12.5px] text-rose-300">{refused}</p>
            ) : null}

            <button
              type="submit"
              disabled={checking || !password}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-white text-[#14101f] py-3 text-[14px] font-semibold tracking-[-0.01em] transition-colors hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {checking ? 'Checking…' : 'Sign in'}
            </button>

            <button
              type="button"
              onClick={back}
              className="mt-2 w-full inline-flex items-center justify-center gap-1.5 py-2 text-[13px] text-[rgba(235,235,245,0.55)] hover:text-[#f5f5f7] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Someone else
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col items-center justify-center px-5 text-[#f5f5f7] font-sans antialiased">
      <div className="w-full max-w-[640px]">
        <header className="text-center mb-8">
          <p className="text-[12px] font-semibold tracking-[0.18em] uppercase text-[rgba(235,235,245,0.42)]">
            MapJOB
          </p>
          <h1 className="mt-2 text-[30px] sm:text-[34px] font-semibold tracking-[-0.03em]">
            Who is signing in?
          </h1>
          <p className="mt-2 text-[14px] text-[rgba(235,235,245,0.55)] leading-relaxed">
            Each account has its own profile, documents, saved jobs and letters. Nothing crosses
            between them.
          </p>
        </header>

        {people === null ? (
          <div className="flex items-center justify-center gap-2 py-12 text-[rgba(235,235,245,0.5)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-[13.5px]">Looking up the accounts…</span>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                onClick={() => setAsking(person)}
                className="ic-popover group text-left p-5 rounded-[22px] cursor-pointer transition-transform duration-200 ease-apple-out hover:-translate-y-0.5 focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(120,170,255,0.6)]"
              >
                <div className="w-14 h-14 rounded-full bg-white/[0.12] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.18)] flex items-center justify-center text-[18px] font-semibold tracking-[-0.02em] text-[rgba(235,235,245,0.78)] group-hover:bg-white/[0.17] transition-colors duration-150">
                  {initials(person.display_name)}
                </div>
                <p className="mt-4 text-[17px] font-semibold tracking-[-0.02em] inline-flex items-center gap-1">
                  {person.display_name}
                  <ArrowRight className="w-3.5 h-3.5 text-[rgba(235,235,245,0.42)] group-hover:translate-x-0.5 transition-transform duration-150" />
                </p>
                <p className="mt-1 text-[13px] text-[rgba(235,235,245,0.62)] leading-snug">
                  {person.focus}
                </p>
                <p className="mt-3 text-[11.5px] text-[rgba(235,235,245,0.42)]">
                  {[person.country, LANGUAGE[person.letter_language] ? 'writes in ' + LANGUAGE[person.letter_language] : '']
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </button>
            ))}
          </div>
        )}

        <p className="mt-6 text-center text-[12px] text-[rgba(235,235,245,0.38)]">
          This machine remembers the choice until you sign out.
        </p>
      </div>
    </div>
  );
};
