import React from 'react';
import { Loader2, Trash2, Upload, FileText, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  fetchDocuments, uploadDocument, editDocument, deleteDocument, documentUrl,
  prettyKind, prettySize, type HeldDocument as Held,
} from '../services/documentsApi';
import { useCurrentUser } from '../services/account';

/**
 * The documents that are not written per application, but held.
 *
 * A transcript, a degree certificate, a residence permit, a reference letter:
 * the same file every time, asked for by name, and until now attached by hand
 * or forgotten. An application missing the transcript it asked for is not a
 * slower application, it is a rejected one.
 *
 * Kept here so both products can reach them. The chooser that opens before a
 * cloud application or an email send reads this list, which is why the kind
 * matters more than it looks: the cloud agent is told "this one is a
 * transcript" so it goes in the field marked transcript rather than in the
 * first upload box on the page.
 *
 * The list belongs to one of the two accounts. Both people keep documents with
 * the same names -- a Lebenslauf, a diploma, an ID -- and attaching hers to his
 * application is not an inconvenience, it is sending a stranger's passport scan
 * to an employer. So every call here says who is asking, and the list is thrown
 * away and fetched again when that changes rather than relabelled.
 *
 * The file itself is kept in a private bucket and reached through short-lived
 * signed links minted on the server. It is not in one of the project's public
 * buckets, and it is not in git.
 */

const INPUT =
  'w-full rounded-lg bg-black/25 px-2.5 py-1.5 text-[12.5px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.28)] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] focus:outline-none focus:shadow-[inset_0_0_0_1px_rgba(120,170,255,0.6)]';

export const HeldDocuments: React.FC = () => {
  const [user] = useCurrentUser();
  const [documents, setDocuments] = React.useState<Held[]>([]);
  const [masterCv, setMasterCv] = React.useState<Held | null>(null);
  const [kinds, setKinds] = React.useState<string[]>([]);
  const [accepts, setAccepts] = React.useState<string[]>([]);
  const [maxBytes, setMaxBytes] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [dropping, setDropping] = React.useState(false);
  const [error, setError] = React.useState('');
  const chooser = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      const library = await fetchDocuments(user);
      setDocuments(library.documents || []);
      setMasterCv(library.master_cv || null);
      setKinds(library.kinds || []);
      setAccepts(library.accepts || []);
      setMaxBytes(library.max_bytes || 0);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The documents could not be listed.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => {
    // Emptied before the fetch, so the other account's list is never on screen
    // beside this account's name while the request is in the air.
    setDocuments([]);
    setMasterCv(null);
    setLoading(true);
    void load();
  }, [load]);

  /**
   * Take a file in.
   *
   * The title defaults to the filename without its extension, because a list
   * of "scan_0007.pdf" is a list nobody can choose from -- and the kind
   * defaults to "other" rather than being guessed from the name: a wrong kind
   * sends a payslip to the field asking for a diploma.
   */
  const take = async (files: FileList | File[] | null) => {
    const chosen = Array.from(files || []);
    if (!chosen.length) return;
    setBusy(true);
    setError('');
    try {
      for (const file of chosen) {
        await uploadDocument(file, {
          title: file.name.replace(/\.[^.]+$/, ''),
          kind: 'other',
          user,
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file was not kept.');
    } finally {
      setBusy(false);
    }
  };

  /* Written through to the server and then reloaded, rather than edited in
   * place and saved later: there is no Save button on this card, so a title
   * left in a box would be a title nobody stored. */
  const change = async (id: string, patch: { title?: string; kind?: string; attach_by_default?: boolean }) => {
    setDocuments((current) => current.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    try {
      await editDocument(id, patch, user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change did not stick.');
      await load();
    }
  };

  /* A title is saved while it is being typed, a moment after the typing stops,
   * and again on the way out of the box. Saving only on the way out sounds
   * tidier and loses work: someone renames a transcript, switches to another
   * tab of this page without clicking anywhere first, and the box never blurs.
   * The timer is per document so renaming two in a row cannot cancel the
   * first, and anything still waiting is written when the card goes away. */
  const pending = React.useRef<Map<string, { timer: number; title: string }>>(new Map());

  const flush = React.useCallback((id: string) => {
    const waiting = pending.current.get(id);
    if (!waiting) return;
    window.clearTimeout(waiting.timer);
    pending.current.delete(id);
    void change(id, { title: waiting.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rename = (id: string, title: string) => {
    setDocuments((current) => current.map((d) => (d.id === id ? { ...d, title } : d)));
    const waiting = pending.current.get(id);
    if (waiting) window.clearTimeout(waiting.timer);
    pending.current.set(id, {
      title,
      timer: window.setTimeout(() => flush(id), 700),
    });
  };

  React.useEffect(() => {
    const waiting = pending.current;
    return () => {
      waiting.forEach((entry, id) => {
        window.clearTimeout(entry.timer);
        void editDocument(id, { title: entry.title }, user).catch(() => undefined);
      });
      waiting.clear();
    };
    // Also on the way out of an account: a rename typed under one name must be
    // written under that name, not the next one.
  }, [user]);

  const drop = async (id: string) => {
    setBusy(true);
    try {
      await deleteDocument(id, user);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That document is still there.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={chooser}
        type="file"
        multiple
        accept={accepts.join(',')}
        className="hidden"
        onChange={(e) => {
          void take(e.target.files);
          // Cleared so choosing the same file twice uploads it twice, which is
          // what someone re-adding a corrected scan means by it.
          e.target.value = '';
        }}
      />

      {/* The CV the tailored ones are cut from. It lives in the same library
          but is not offered in the chooser: it is not an attachment you tick,
          it is the source. Uploading another replaces it, which is why it is
          shown -- so nobody has to wonder which file that was. */}
      {masterCv && (
        <div className="rounded-xl bg-sky-400/[0.07] px-3 py-2.5 shadow-[inset_0_0_0_0.5px_rgba(120,180,255,0.22)] flex items-start gap-3">
          <FileText className="w-4 h-4 mt-0.5 shrink-0 text-sky-200/70" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-[#f5f5f7] truncate">
              Master CV · {masterCv.title || masterCv.filename}
            </p>
            <p className="text-[11.5px] text-[rgba(235,235,245,0.45)] truncate">
              {masterCv.filename}
              {masterCv.pages ? ' · ' + masterCv.pages + (masterCv.pages === 1 ? ' page' : ' pages') : ''}
              {masterCv.bytes ? ' · ' + prettySize(masterCv.bytes) : ''}
              {' · every tailored CV is cut from this one'}
            </p>
          </div>
          <a
            href={documentUrl(masterCv.id, user)}
            target="_blank"
            rel="noreferrer"
            title="Open it"
            className="p-1.5 rounded-lg text-[rgba(235,235,245,0.5)] hover:text-[#f5f5f7] hover:bg-white/[0.08]"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => { e.preventDefault(); setDropping(false); void take(e.dataTransfer.files); }}
        onClick={() => chooser.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooser.current?.click(); }
        }}
        className={'rounded-2xl px-5 py-6 text-center cursor-pointer transition-colors duration-150 ' + (
          dropping
            ? 'bg-sky-400/10 shadow-[inset_0_0_0_1px_rgba(120,180,255,0.5)]'
            : 'bg-black/20 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] hover:bg-black/25')}
      >
        {busy ? (
          <Loader2 className="w-5 h-5 mx-auto animate-spin text-[rgba(235,235,245,0.5)]" />
        ) : (
          <Upload className="w-5 h-5 mx-auto text-[rgba(235,235,245,0.45)]" />
        )}
        <p className="mt-3 text-[13.5px] text-[#f5f5f7]">
          {busy ? 'Keeping it' : 'Drop documents here, or choose files'}
        </p>
        <p className="mt-1 text-[12.5px] text-[rgba(235,235,245,0.45)]">
          {(accepts.length ? accepts.join(', ').replace(/\./g, '').toUpperCase() : 'PDF, DOCX, PNG, JPG')}
          {maxBytes ? ', up to ' + Math.round(maxBytes / (1024 * 1024)) + ' MB each.' : '.'}
        </p>
      </div>

      {error && (
        <p className="flex items-start gap-2 text-[12.5px] text-amber-300/90">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {loading ? (
        <p className="text-[13px] text-[rgba(235,235,245,0.45)]">Reading the list…</p>
      ) : documents.length === 0 ? (
        <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
          Nothing held yet. Whatever goes here can be attached to an application without
          being found again: a transcript, a diploma, a reference, a residence permit.
        </p>
      ) : (
        <ul className="space-y-2">
          {documents.map((document) => (
            <li
              key={document.id}
              className="rounded-xl bg-black/20 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] px-3 py-2.5"
            >
              <div className="flex items-start gap-3">
                <FileText className="w-4 h-4 mt-2 shrink-0 text-[rgba(235,235,245,0.45)]" />
                <div className="min-w-0 flex-1 grid sm:grid-cols-[1fr,150px] gap-2">
                  <input
                    className={INPUT}
                    value={document.title}
                    placeholder={document.filename}
                    onChange={(e) => rename(document.id, e.target.value)}
                    onBlur={() => flush(document.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') flush(document.id); }}
                  />
                  <select
                    className={INPUT}
                    value={document.kind}
                    onChange={(e) => void change(document.id, { kind: e.target.value })}
                  >
                    {kinds.map((kind) => (
                      <option key={kind} value={kind} className="bg-[#1c1c1e]">
                        {prettyKind(kind)}
                      </option>
                    ))}
                  </select>
                </div>
                <a
                  href={documentUrl(document.id, user)}
                  target="_blank"
                  rel="noreferrer"
                  title="Open it"
                  className="mt-1.5 p-1.5 rounded-lg text-[rgba(235,235,245,0.5)] hover:text-[#f5f5f7] hover:bg-white/[0.08]"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button
                  type="button"
                  onClick={() => void drop(document.id)}
                  title="Remove it"
                  className="mt-1.5 p-1.5 rounded-lg text-[rgba(235,235,245,0.5)] hover:text-rose-300 hover:bg-white/[0.08]"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="mt-1.5 pl-7 flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex items-center gap-2 text-[12px] text-[rgba(235,235,245,0.62)] cursor-pointer">
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-sky-500"
                    checked={document.attach_by_default}
                    onChange={(e) => void change(document.id, { attach_by_default: e.target.checked })}
                  />
                  Ticked by default
                </label>
                <span className="text-[11.5px] text-[rgba(235,235,245,0.38)] truncate">
                  {document.filename}
                  {document.pages ? ' · ' + document.pages + (document.pages === 1 ? ' page' : ' pages') : ''}
                  {document.bytes ? ' · ' + prettySize(document.bytes) : ''}
                  {document.mergeable ? '' : ' · cannot be bound into a shared PDF'}
                </span>
                {document.missing && (
                  <span className="text-[11.5px] text-amber-300/90">
                    The file is gone from disk; upload it again.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[13.5px] text-[rgba(235,235,245,0.62)] leading-relaxed">
        These are offered every time you apply or send, in a list you tick -- individually or for a
        whole batch -- and you choose there whether they go as separate files or bound into one PDF.
        "Ticked by default" only decides how that list opens.
      </p>
    </div>
  );
};
