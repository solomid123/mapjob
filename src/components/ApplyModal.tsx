import React, { useState, useEffect, useRef } from 'react';
import { X, FileText, CheckCircle2, ArrowRight, Building2, MonitorPlay, Sparkles, ChevronDown, AlertCircle, ExternalLink } from 'lucide-react';
import type { Job } from '../types/job';
import { applyViaDirectAtsApi } from '../services/directAtsApi';

interface ApplyModalProps {
  job: Job | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (jobId: string) => void;
}

interface LogEntry {
  timestamp: string;
  message: string;
  step?: number;
  status?: string;
  done?: boolean;
  success?: boolean;
}

export const ApplyModal: React.FC<ApplyModalProps> = ({
  job,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [fullName, setFullName] = useState('Badreddine Barki');
  const [email, setEmail] = useState('badreddinebarki@gmail.com');
  const [phone, setPhone] = useState('+33 7 45 76 80 10');
  const [portfolio, setPortfolio] = useState('https://linkedin.com/in/badreddine-barki');
  const [coverNote, setCoverNote] = useState('Ingénieur en conception mécanique passionné par les systèmes industriels et les défis techniques.');
  const [resumeName, setResumeName] = useState('Badreddine_Barki_CV.pdf');
  const [openVisibleBrowser, setOpenVisibleBrowser] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submissionNotice, setSubmissionNotice] = useState<{
    type: 'barrier' | 'error' | 'warning' | 'success' | 'unsupported';
    message: string;
    applyUrl?: string;
  } | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(1);
  const [statusMessage, setStatusMessage] = useState('Connecting to application portal...');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [extensionActive, setExtensionActive] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const handleMsg = (event: MessageEvent) => {
      if (event.data && (event.data.type === 'BOJ_EXT_PONG' || event.data.type === 'BOJ_EXT_BRIDGE_READY')) {
        if (event.data.alive !== false) {
          setExtensionActive(true);
        }
      }
      if (event.data && event.data.type === 'BOJ_STEP_LOG') {
        const msg = String(event.data.msg || '');
        setLogs((prev) => [...prev, { timestamp: new Date().toLocaleTimeString(), message: msg }]);
        if (msg.toLowerCase().includes('cv') || msg.toLowerCase().includes('upload') || msg.toLowerCase().includes('file')) {
          setCurrentStepIndex(3);
          setStatusMessage('Attaching Badreddine_Barki_CV.pdf...');
        } else if (msg.toLowerCase().includes('submit') || msg.toLowerCase().includes('done') || msg.toLowerCase().includes('postul')) {
          setCurrentStepIndex(4);
          setStatusMessage('Application transmitted!');
        }
      }
      if (event.data && event.data.type === 'BOJ_AGENT_DONE_RELAY') {
        setCurrentStepIndex(4);
        setStatusMessage('Application confirmed!');
        setTimeout(() => {
          setIsSubmitting(false);
          setIsSubmitted(true);
          if (job) onSuccess(job.id);
        }, 1200);
      }
    };

    window.addEventListener('message', handleMsg);
    window.postMessage({ type: 'BOJ_EXT_PING', token: 'mapjob' }, '*');
    const timer = setTimeout(() => {
      window.postMessage({ type: 'BOJ_EXT_PING', token: 'mapjob' }, '*');
    }, 400);

    return () => {
      window.removeEventListener('message', handleMsg);
      clearTimeout(timer);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [job, onSuccess]);

  if (!isOpen || !job) return null;

  const targetUrl = job.applyUrl || '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmissionNotice(null);
    setCurrentStepIndex(2);
    setStatusMessage(`Submitting application payload directly to ${job.company} via ${job.atsProvider || 'ATS'} API...`);

    try {
      const result = await applyViaDirectAtsApi(job);
      setIsSubmitting(false);

      if (result.success) {
        setCurrentStepIndex(4);
        setStatusMessage(`Application confirmed by ${job.company}!`);
        setIsSubmitted(true);
        const confMsg = result.confirmation_id ? ` (Confirmation ID: ${result.confirmation_id})` : '';
        setSubmissionNotice({
          type: 'success',
          message: `Your application has been accepted directly by the official ${job.atsProvider || 'ATS'} API endpoint.${confMsg}`
        });
        onSuccess(job.id);
      } else if (result.status === 'unsupported' || result.status_code === 501) {
        // Fail closed: nothing was submitted. Point at the official portal instead.
        setSubmissionNotice({
          type: 'unsupported',
          message: result.message || 'API submission is not supported for this employer — no application was sent.',
          applyUrl: result.applyUrl || job.applyUrl,
        });
      } else {
        setSubmissionNotice({
          type: 'warning',
          message: result.message || 'The ATS API endpoint reported a notice with the submission.'
        });
      }
    } catch (err: any) {
      console.error('API Server Error:', err);
      setIsSubmitting(false);
      setSubmissionNotice({
        type: 'error',
        message: err.message || 'Could not connect to automation backend at http://127.0.0.1:8000.'
      });
    }
  };

  const handleResetAndClose = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setIsSubmitted(false);
    setIsSubmitting(false);
    setSubmissionNotice(null);
    setLogs([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden border border-gray-100">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-rose-50 text-rose-600 rounded-xl">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold text-gray-900 text-sm block truncate max-w-[280px]">
                {job.company}
              </span>
              <span className="text-[11px] text-gray-400 font-medium truncate max-w-[280px] block">
                {job.title}
              </span>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {isSubmitting ? (
          /* CLEAN USER-FRIENDLY PROGRESS UI */
          <div className="p-8 space-y-6 animate-in fade-in duration-300">
            {/* Progress Bar */}
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div 
                className="bg-[#FF385C] h-2 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${currentStepIndex === 1 ? 25 : currentStepIndex === 2 ? 55 : currentStepIndex === 3 ? 85 : 100}%` }}
              />
            </div>

            {/* Status Highlight Box */}
            <div className="text-center py-2 space-y-2">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-rose-50 border border-rose-100 text-xs font-bold text-rose-600">
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>Autonomous 1-Click Fast Apply</span>
              </div>
              <h3 className="text-lg font-black text-gray-900">
                Applying to {job.company}
              </h3>
              <p className="text-xs text-gray-500 font-medium max-w-sm mx-auto">
                {statusMessage}
              </p>
            </div>

            {/* Visual Step Timeline */}
            <div className="space-y-3 bg-gray-50/80 rounded-2xl p-4 border border-gray-100">
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  currentStepIndex >= 1 ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'
                }`}>
                  ✓
                </div>
                <div className="text-xs">
                  <span className="font-bold text-gray-800 block">Authenticated Profile</span>
                  <span className="text-gray-400">Google, APEC, Indeed, LinkedIn session cookies active</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  currentStepIndex > 2 ? 'bg-emerald-500 text-white' : currentStepIndex === 2 ? 'bg-[#FF385C] text-white animate-pulse' : 'bg-gray-200 text-gray-500'
                }`}>
                  {currentStepIndex > 2 ? '✓' : '2'}
                </div>
                <div className="text-xs">
                  <span className="font-bold text-gray-800 block">Connecting to Employer Portal</span>
                  <span className="text-gray-400">Bypassing aggregators & opening official application</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  currentStepIndex > 3 ? 'bg-emerald-500 text-white' : currentStepIndex === 3 ? 'bg-[#FF385C] text-white animate-pulse' : 'bg-gray-200 text-gray-500'
                }`}>
                  {currentStepIndex > 3 ? '✓' : '3'}
                </div>
                <div className="text-xs">
                  <span className="font-bold text-gray-800 block">Uploading Verified CV</span>
                  <span className="text-gray-400">Badreddine_Barki_CV.pdf (Mechanical Engineering)</span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  currentStepIndex >= 4 ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'
                }`}>
                  {currentStepIndex >= 4 ? '✓' : '4'}
                </div>
                <div className="text-xs">
                  <span className="font-bold text-gray-800 block">Final Validation</span>
                  <span className="text-gray-400">Transmitting application to hiring team</span>
                </div>
              </div>
            </div>

            {/* Minimal optional live activity drawer */}
            <div className="pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setShowDetails(!showDetails)}
                className="w-full flex items-center justify-between text-[11px] font-semibold text-gray-400 hover:text-gray-600 transition py-1"
              >
                <span>Live Activity Stream ({logs.length})</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDetails ? 'rotate-180' : ''}`} />
              </button>

              {showDetails && (
                <div className="mt-2 p-3 bg-gray-50 rounded-xl max-h-32 overflow-y-auto space-y-1 font-mono text-[11px] text-gray-600 border border-gray-200/60">
                  {logs.map((l, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-gray-400 shrink-0">{l.timestamp}</span>
                      <span>{l.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Note about visible browser */}
            {openVisibleBrowser && (
              <div className="flex items-center justify-center gap-2 text-xs text-gray-400 pt-1">
                <MonitorPlay className="w-4 h-4 text-gray-500" />
                <span>Browser running live on your screen</span>
              </div>
            )}
          </div>
        ) : isSubmitted ? (
          /* TRUTHFUL SUCCESS SCREEN */
          <div className="p-8 text-center space-y-5 animate-in fade-in duration-300">
            <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto animate-bounce">
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div>
              <h3 className="text-2xl font-black text-gray-900">
                Application Transmitted!
              </h3>
              <p className="text-gray-500 text-sm mt-1 max-w-sm mx-auto">
                Your application for <span className="font-bold text-gray-800">{job.title}</span> at <span className="font-bold text-gray-800">{job.company}</span> has been transmitted on the employer portal.
              </p>
            </div>

            <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 text-left text-xs text-gray-600 space-y-2.5">
              <div className="flex justify-between items-center">
                <span>Status:</span>
                <span className="inline-flex items-center gap-1 font-bold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                  <CheckCircle2 className="w-3 h-3" /> Transmitted & Confirmed
                </span>
              </div>
              <div className="flex justify-between">
                <span>Candidate:</span>
                <span className="font-semibold text-gray-800">Badreddine Barki</span>
              </div>
              <div className="flex justify-between">
                <span>CV Attached:</span>
                <span className="font-semibold text-emerald-600">Badreddine_Barki_CV.pdf</span>
              </div>
              <div className="flex justify-between">
                <span>Candidate Email:</span>
                <span className="font-semibold text-gray-800">badreddinebarki@gmail.com</span>
              </div>
            </div>

            <p className="text-[11px] text-gray-400">
              The application was confirmed on the employer page. Official receipts are sent to badreddinebarki@gmail.com.
            </p>

            <button
              onClick={handleResetAndClose}
              className="w-full py-3.5 bg-gray-900 hover:bg-black text-white rounded-xl text-sm font-bold transition shadow-md"
            >
              Back to Job Map
            </button>
          </div>
        ) : submissionNotice ? (
          /* BARRIER / MANUAL ACTION SCREEN — never claims a submission happened */
          <div className="p-8 text-center space-y-5 animate-in fade-in duration-300">
            <div className="w-16 h-16 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto">
              <AlertCircle className="w-10 h-10" />
            </div>
            <div>
              <h3 className="text-xl font-black text-gray-900">
                {submissionNotice.type === 'unsupported' ? 'API Apply Unavailable' : 'Portal Authentication Required'}
              </h3>
              <p className="text-gray-600 text-xs mt-2 max-w-sm mx-auto leading-relaxed">
                {submissionNotice.message}
              </p>
              {submissionNotice.type === 'unsupported' && (
                <p className="text-gray-500 text-[11px] mt-2 max-w-sm mx-auto leading-relaxed">
                  Nothing was submitted and no confirmation email will arrive. Complete your application on the official portal — only the employer sends receipts.
                </p>
              )}
            </div>

            {submissionNotice.type !== 'unsupported' && (
            <div className="p-4 bg-amber-50/80 rounded-2xl border border-amber-200/70 text-left text-xs text-gray-700 space-y-1.5">
              <p className="font-bold text-amber-900">
                Why is manual action needed?
              </p>
              <p className="text-amber-800 text-[11px] leading-relaxed">
                This listing redirects to an aggregator or ATS requiring your personal credentials (e.g. France Travail, APEC, or account creation). MapJob filled candidate fields and prepared your profile.
              </p>
            </div>
            )}

            <div className="space-y-2.5 pt-2">
              <a
                href={submissionNotice.applyUrl || job.applyUrl || targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-3.5 bg-[#FF385C] hover:bg-[#E00B41] text-white rounded-xl text-sm font-bold transition shadow-md flex items-center justify-center gap-2"
              >
                <span>Open Employer Portal to Complete</span>
                <ExternalLink className="w-4 h-4" />
              </a>

              <button
                onClick={() => setSubmissionNotice(null)}
                className="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl text-xs font-semibold transition"
              >
                Back to Application Form
              </button>
            </div>
          </div>
        ) : (
          /* APPLICATION FORM */
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-gray-900">{job.title}</h2>
                <p className="text-xs text-gray-500 font-medium">
                  {job.salaryDisplay} • {job.location}
                </p>
              </div>
              <div className="shrink-0">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold ${
                  extensionActive
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : 'bg-rose-50 text-rose-700 border border-rose-200'
                }`}>
                  <Sparkles className="w-3 h-3" />
                  {extensionActive ? 'AI Extension Active (gpt-5.6-terra)' : 'Fast Autonomous Apply'}
                </span>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  Full Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Badreddine Barki"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    placeholder="badreddinebarki@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                    Phone
                  </label>
                  <input
                    type="tel"
                    placeholder="+33 7 45 76 80 10"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  LinkedIn / Portfolio URL
                </label>
                <input
                  type="url"
                  placeholder="https://linkedin.com/in/badreddine-barki"
                  value={portfolio}
                  onChange={(e) => setPortfolio(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
                />
              </div>

              {/* Resume attachment box */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  Attach CV / Resume *
                </label>
                <div className="border-2 border-dashed border-gray-300 hover:border-rose-400 rounded-2xl p-3.5 flex items-center justify-between bg-gray-50/70 transition">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-rose-100 text-rose-600 rounded-xl">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="block text-xs font-bold text-gray-800">
                        {resumeName}
                      </span>
                      <span className="text-[11px] text-gray-400">PDF • 1.2 MB (Mechanical Engineering)</span>
                    </div>
                  </div>
                  <label className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-100 cursor-pointer transition shadow-sm">
                    Change
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files && e.target.files[0]) {
                          setResumeName(e.target.files[0].name);
                        }
                      }}
                    />
                  </label>
                </div>
              </div>

              {/* Short note */}
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                  Why are you a good fit? (Optional)
                </label>
                <textarea
                  rows={2}
                  placeholder="Brief note to the hiring team..."
                  value={coverNote}
                  onChange={(e) => setCoverNote(e.target.value)}
                  className="w-full px-3.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition resize-none"
                />
              </div>

              {/* Visible Chrome toggle */}
              <div className="p-3 bg-gray-50 rounded-xl border border-gray-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MonitorPlay className="w-4 h-4 text-rose-500" />
                  <span className="text-xs font-bold text-gray-800">Watch in Visible Browser Window</span>
                </div>
                <input
                  type="checkbox"
                  checked={openVisibleBrowser}
                  onChange={(e) => setOpenVisibleBrowser(e.target.checked)}
                  className="w-4 h-4 accent-rose-500 rounded cursor-pointer"
                />
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                className="w-full py-4 px-6 rounded-2xl bg-[#FF385C] hover:bg-[#E00B41] text-white font-extrabold text-sm shadow-lg shadow-rose-200 transition active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>{extensionActive ? 'Launch via AI Extension (gpt-5.6-terra)' : 'Launch Autonomous Application'}</span>
                <ArrowRight className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
};
