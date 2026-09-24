import React from 'react';
import { Paperclip, Layers, Files, X, FileText, AlertTriangle } from 'lucide-react';
import {
  fetchDocuments,
  rememberedChoice,
  rememberChoice,
  prettyKind,
  prettySize,
  NO_ATTACHMENTS,
  type AttachmentChoice,
  type HeldDocument,
} from '../services/documentsApi';
import { useCurrentUser, usePerson } from '../services/account';

/**
 * "Which of your documents go with this one, and as how many files?"
 *
 * The same question for both products, asked in one place, because it is the
 * same question: a transcript is a transcript whether it is uploaded to a form
 * by the cloud agent or attached to an email. Two copies of this dialog would
 * have drifted within a week -- one of them would have grown the fused option
 * and the other would not.
 *
 * It does not open when there is nothing to choose. Someone who holds no
 * documents should never meet this modal; the apply button stays a button.
 *
 * Fused means one PDF. What goes into it differs by product, and the modal says
 * so rather than pretending otherwise: an email binds the letter, the CV and
 * the documents into a single file, while a form has a CV field of its own, so
 * there the binding covers the supporting documents only.
 */

export type AttachmentContext = 'apply' | 'email';

export interface AttachmentAsk {
  context: AttachmentContext;
  /** How many applications this one answer covers. Above one it is a bulk run. */
  count?: number;
  /** Named so the modal can say who this is going to, when it is just the one. */
  target?: string;
  /** The local engine uploads the CV and nothing else, and the modal admits it. */
  engine?: 'local' | 'cloud';
}

interface Pending extends AttachmentAsk {
  resolve: (choice: AttachmentChoice | null) => void;
}

/**
 * Ask, and get an answer back as a promise.
 *
 * A promise rather than a pile of "pendingJob" state in every caller: applying
 * is already a sequence of awaited steps, and this is one more of them, so the
 * apply path reads as one function instead of being cut in half by a modal.
 * `null` means cancelled, and cancelled means nothing is sent.
 */
export function useAttachmentChooser(): {
  ask: (options: AttachmentAsk) => Promise<AttachmentChoice | null>;
  chooser: React.ReactNode;
} {
  // Whose documents are on offer. The chooser opens from the apply and the
  // send paths, and the account it reads must be the account the application
  // goes out under: there is no good way to attach one person's diploma to the
  // other's application, and several ways to do it by accident.
  const [user] = useCurrentUser();
  const [documents, setDocuments] = React.useState<HeldDocument[]>([]);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const held = React.useRef<HeldDocument[]>([]);

  const load = React.useCallback(async () => {
    try {
      const library = await fetchDocuments(user);
      held.current = library.documents || [];
      setDocuments(held.current);
    } catch {
      // No library, no question. An unreachable backend is about to fail the
      // apply anyway, and it will say so there rather than here.
      held.current = [];
      setDocuments([]);
    }
  }, [user]);

  React.useEffect(() => { void load(); }, [load]);

  const ask = React.useCallback(async (options: AttachmentAsk) => {
    // Read again on every ask: a document added on the profile page a minute
    // ago belongs on this list, and this hook was mounted when the app booted.
    await load();
    if (held.current.length === 0) return NO_ATTACHMENTS;
    return new Promise<AttachmentChoice | null>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, [load]);

  const settle = React.useCallback((choice: AttachmentChoice | null) => {
    setPending((current) => {
      current?.resolve(choice);
      return null;
    });
  }, []);

  const chooser = pending ? (
    <AttachmentDialog
      documents={documents}
      ask={pending}
      onCancel={() => settle(null)}
      onConfirm={(choice) => {
        rememberChoice(choice);
        settle(choice);
      }}
    />
  ) : null;

  return { ask, chooser };
}

const AttachmentDialog: React.FC<{
  documents: HeldDocument[];
  ask: AttachmentAsk;
  onCancel: () => void;
  onConfirm: (choice: AttachmentChoice) => void;
}> = ({ documents, ask, onCancel, onConfirm }) => {
  // The photograph is held like everything else and offered like nothing else:
  // it is printed into the Deckblatt, not attached beside it. An employer who
  // receives a loose passport photo has received a mistake.
  const usable = documents.filter((d) => !d.missing && d.kind !== 'photo');

  // Opened on the last answer where it still makes sense, and on the
  // attach-by-default flags the first time. A document deleted since is simply
  // not in the list, so a remembered id cannot tick a box that is not there.
  const [ticked, setTicked] = React.useState<Set<string>>(() => {
    const last = rememberedChoice();
    const known = new Set(usable.map((d) => d.id));
    const from = (last?.documentIds || []).filter((id) => known.has(id));
    if (from.length) return new Set(from);
    return new Set(usable.filter((d) => d.attach_by_default).map((d) => d.id));
  });
  const [merge, setMerge] = React.useState<boolean>(() => !!rememberedChoice()?.merge);

  const chosen = usable.filter((d) => ticked.has(d.id));
  const unbindable = chosen.filter((d) => !d.mergeable);
  // A German application is one bound file whatever anybody ticks: a Deckblatt
  // sent as a loose attachment is page one of nothing. So for that account the
  // question is not asked, and what will happen is stated instead -- offering a
  // choice the sender does not have is worse than offering none.
  const person = usePerson();
  const bound = person?.application_style === 'german_dossier';
  const local = ask.engine === 'local';

  const toggle = (id: string) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const many = (ask.count || 1) > 1;
  const heading = ask.context === 'email' ? 'Attach to this email' : 'Attach to this application';
  const line = many
    ? 'The same documents go with every one of them.'
    : ask.target
      ? 'Going to ' + ask.target + '.'
      : 'Your CV and covering letter go either way; these are what goes with them.';

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#1c1c1e]/95 shadow-2xl overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <Paperclip className="w-4 h-4 mt-0.5 shrink-0 text-sky-400" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#f5f5f7]">
              {many ? 'Attach to these ' + ask.count + ' applications' : heading}
            </h2>
            <p className="mt-0.5 text-[12px] leading-snug text-[rgba(235,235,245,0.5)]">{line}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="ml-auto -mr-1 -mt-1 p-1.5 rounded-lg text-[rgba(235,235,245,0.5)] hover:text-[#f5f5f7] hover:bg-white/[0.08]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[42vh] overflow-y-auto px-3 pb-1">
          {usable.map((document) => {
            const on = ticked.has(document.id);
            return (
              <label
                key={document.id}
                className={'flex items-start gap-3 px-2.5 py-2.5 rounded-xl cursor-pointer transition-colors ' +
                  (on ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05]')}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(document.id)}
                  className="mt-1 w-4 h-4 shrink-0 accent-sky-500"
                />
                <FileText className="w-4 h-4 mt-0.5 shrink-0 text-[rgba(235,235,245,0.45)]" />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-[#f5f5f7] truncate">
                    {document.title || document.filename}
                  </span>
                  <span className="block text-[11.5px] text-[rgba(235,235,245,0.42)] truncate">
                    {prettyKind(document.kind)}
                    {' · ' + document.filename}
                    {document.pages ? ' · ' + document.pages + (document.pages === 1 ? ' page' : ' pages') : ''}
                    {document.bytes ? ' · ' + prettySize(document.bytes) : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {bound ? (
          <div className="px-5 pt-3 pb-2">
            <span className="block pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[rgba(235,235,245,0.42)]">
              Sent as
            </span>
            <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-white/10 bg-white/[0.05]">
              <Layers className="w-4 h-4 mt-0.5 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span>
                <span className="block text-[12.5px] font-medium text-[#f5f5f7]">
                  One bound dossier
                </span>
                <span className="block text-[11px] leading-snug text-[rgba(235,235,245,0.42)]">
                  Deckblatt, Anschreiben, Lebenslauf, then what you tick above — in that
                  order, in one PDF. Only the Anschreiben and the post on the cover sheet
                  are written for this employer.
                </span>
              </span>
            </div>
          </div>
        ) : (
        <div className="px-5 pt-3 pb-2" role="radiogroup" aria-label="How they are attached">
          <span className="block pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[rgba(235,235,245,0.42)]">
            Send them as
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={!merge}
              onClick={() => setMerge(false)}
              className={'flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-left border transition-colors ' +
                (!merge ? 'border-sky-400/60 bg-white/[0.08]' : 'border-white/10 hover:bg-white/[0.05]')}
            >
              <Files className="w-4 h-4 mt-0.5 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span>
                <span className="block text-[12.5px] font-medium text-[#f5f5f7]">Separate files</span>
                <span className="block text-[11px] leading-snug text-[rgba(235,235,245,0.42)]">
                  {ask.context === 'email'
                    ? 'One attachment each.'
                    : 'Each goes in the field that asks for it.'}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={merge}
              onClick={() => setMerge(true)}
              className={'flex items-start gap-2.5 px-3 py-2.5 rounded-xl text-left border transition-colors ' +
                (merge ? 'border-sky-400/60 bg-white/[0.08]' : 'border-white/10 hover:bg-white/[0.05]')}
            >
              <Layers className="w-4 h-4 mt-0.5 shrink-0 text-[rgba(235,235,245,0.62)]" />
              <span>
                <span className="block text-[12.5px] font-medium text-[#f5f5f7]">One PDF (fused)</span>
                <span className="block text-[11px] leading-snug text-[rgba(235,235,245,0.42)]">
                  {ask.context === 'email'
                    ? 'Letter, CV and documents bound together.'
                    : 'Documents bound into one; the CV stays its own file.'}
                </span>
              </span>
            </button>
          </div>
        </div>
        )}

        {!bound && merge && unbindable.length > 0 && (
          <p className="mx-5 mb-1 flex items-start gap-2 text-[11.5px] leading-snug text-amber-300/80">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {unbindable.map((d) => d.title || d.filename).join(', ')}
              {unbindable.length === 1 ? ' is not a PDF, so it' : ' are not PDFs, so they'}
              {' cannot be bound, and will go alongside the bound file.'}
            </span>
          </p>
        )}

        {local && chosen.length > 0 && (
          <p className="mx-5 mb-1 flex items-start gap-2 text-[11.5px] leading-snug text-amber-300/80">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              The browser on this computer attaches the CV and nothing else. To send these with the
              application, apply with the cloud engine.
            </span>
          </p>
        )}

        <div className="flex items-center gap-2 px-5 py-4">
          <span className="text-[11.5px] text-[rgba(235,235,245,0.42)]">
            {chosen.length === 0
              ? 'Nothing extra: the CV and the letter only.'
              : chosen.length + (chosen.length === 1 ? ' document going with it.' : ' documents going with it.')}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto px-3.5 py-2 rounded-xl text-[12.5px] font-medium text-[rgba(235,235,245,0.62)] hover:bg-white/[0.08]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ documentIds: chosen.map((d) => d.id), merge: bound || merge })}
            className="px-4 py-2 rounded-xl text-[12.5px] font-semibold text-white bg-sky-500 hover:bg-sky-400"
          >
            {ask.context === 'email' ? 'Send' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
};
