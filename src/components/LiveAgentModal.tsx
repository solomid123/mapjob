import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Minimize2, 
  Maximize2, 
  Square, 
  ExternalLink, 
  Terminal, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Zap, 
  Eye, 
  RefreshCw,
  Sparkles
} from 'lucide-react';

export interface LiveAgentState {
  is_running: boolean;
  job_title: string;
  company: string;
  target_url: string;
  phase: string;
  current_step: string;
  logs: Array<{
    timestamp: string;
    message: string;
    step: number;
    status: string;
    done: boolean;
    success: boolean;
  }>;
  screenshot: string | null;
  last_result: {
    success: boolean;
    barrier?: boolean;
    message: string;
  } | null;
}

interface LiveAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStop: () => void;
  onReapply?: () => void;
}

export const LiveAgentModal: React.FC<LiveAgentModalProps> = ({
  isOpen,
  onClose,
  onStop,
  onReapply
}) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [state, setState] = useState<LiveAgentState | null>(null);
  const [activeTab, setActiveTab] = useState<'screen' | 'logs'>('screen');
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  // Poll live agent state from backend
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const fetchState = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/api/apply/state');
        if (res.ok && isMounted) {
          const data: LiveAgentState = await res.json();
          setState(data);
        }
      } catch (e) {
        // ignore polling network errors
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 750);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (activeTab === 'logs' && terminalBottomRef.current) {
      terminalBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state?.logs, activeTab]);

  if (!isOpen) return null;

  const isRunning = state?.is_running ?? true;
  const isDone = !isRunning && state?.last_result !== null;
  const isSuccess = state?.last_result?.success ?? false;
  const isBarrier = state?.last_result?.barrier ?? false;
  const hasScreenshot = Boolean(state?.screenshot);

  // Minimized Picture-in-Picture floating view (bottom-right)
  if (isMinimized) {
    return (
      <div className="fixed bottom-6 right-6 z-50 w-84 bg-gray-950 text-white border border-gray-800 rounded-2xl shadow-2xl p-3 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-5">
        <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-gray-800/80">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              {isRunning && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              )}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isRunning ? 'bg-emerald-500' : isSuccess ? 'bg-emerald-400' : 'bg-amber-500'}`}></span>
            </span>
            <span className="text-xs font-bold tracking-tight">
              {isRunning ? 'AI PageAgent Live' : isSuccess ? 'Applied ✓' : 'Agent Finished'}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsMinimized(false)}
              className="p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-800 transition cursor-pointer"
              title="Expand Inspector"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-white rounded-md hover:bg-gray-800 transition cursor-pointer"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Thumbnail Preview */}
        <div 
          onClick={() => setIsMinimized(false)}
          className="relative w-full h-36 bg-gray-900 rounded-lg overflow-hidden border border-gray-800 cursor-pointer group"
        >
          {hasScreenshot ? (
            <img 
              src={state?.screenshot || ''} 
              alt="Live Screen" 
              className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-400 text-xs p-3 text-center">
              <Loader2 className="w-5 h-5 animate-spin text-rose-500" />
              <span>Connecting viewport...</span>
            </div>
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-2">
            <p className="text-[11px] font-medium text-gray-200 truncate w-full">
              {state?.current_step || 'Processing...'}
            </p>
          </div>
        </div>

        {isRunning && (
          <button
            onClick={onStop}
            className="w-full mt-2 py-1.5 px-3 rounded-lg bg-rose-950/80 hover:bg-rose-900 border border-rose-800/80 text-rose-300 text-[11px] font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
          >
            <Square className="w-3 h-3 fill-rose-300" />
            <span>Stop Agent</span>
          </button>
        )}
      </div>
    );
  }

  // Full In-Page Inspector Modal
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-gray-950 border border-gray-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden max-h-[92vh]">
        
        {/* Modal Top Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-500/20 text-white">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Autonomous PageAgent Live Inspector
                </h3>
                <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border bg-emerald-950/80 border-emerald-800 text-emerald-300">
                  <span className="relative flex h-2 w-2">
                    {isRunning && (
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    )}
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${isRunning ? 'bg-emerald-400' : 'bg-emerald-500'}`}></span>
                  </span>
                  {isRunning ? 'LIVE STREAM' : 'COMPLETED'}
                </span>
              </div>
              <p className="text-xs text-gray-400 font-medium">
                Powered by Fuelix Engine (<span className="text-rose-400 font-semibold">gpt-5.6-terra</span>) • Candidate: <span className="text-gray-200 font-medium">Badreddine Barki</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsMinimized(true)}
              className="p-2 text-gray-400 hover:text-white rounded-xl hover:bg-gray-800 transition cursor-pointer"
              title="Minimize to Picture-in-Picture"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-white rounded-xl hover:bg-gray-800 transition cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Current Target & Active Step Bar */}
        <div className="px-6 py-2.5 bg-gray-900/30 border-b border-gray-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-gray-300 truncate max-w-xl">
            <span className="text-gray-500 font-mono">STEP:</span>
            <span className="font-semibold text-rose-400 truncate">
              {state?.current_step || 'Initializing browser automation...'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {state?.target_url && (
              <a
                href={state.target_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white underline underline-offset-2 transition"
              >
                <span>Direct Portal</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}

            {/* View Mode Toggle */}
            <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-0.5">
              <button
                onClick={() => setActiveTab('screen')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'screen'
                    ? 'bg-rose-500 text-white shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Live View</span>
              </button>
              <button
                onClick={() => setActiveTab('logs')}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'logs'
                    ? 'bg-rose-500 text-white shadow-sm'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Console ({state?.logs?.length || 0})</span>
              </button>
            </div>
          </div>
        </div>

        {/* Main Body */}
        <div className="relative flex-1 min-h-[380px] max-h-[520px] bg-black overflow-hidden flex flex-col">
          {activeTab === 'screen' ? (
            <div className="relative w-full h-full flex items-center justify-center p-4 overflow-auto bg-gradient-to-b from-gray-950 to-black">
              {hasScreenshot ? (
                <div className="relative max-w-full max-h-full rounded-xl overflow-hidden border border-gray-800 shadow-2xl bg-gray-900">
                  <img
                    src={state?.screenshot || ''}
                    alt="Live employer portal feed"
                    className="max-h-[460px] w-auto object-contain select-none"
                  />
                  {isRunning && (
                    <div className="absolute top-3 left-3 bg-black/80 backdrop-blur-md border border-gray-700/80 px-3 py-1.5 rounded-full flex items-center gap-2 text-xs font-medium text-emerald-400 shadow-lg">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                      <span>Controlling Form Inputs Live</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-4 text-center p-8 text-gray-400">
                  <div className="relative">
                    <div className="w-16 h-16 rounded-full border-4 border-rose-500/20 border-t-rose-500 animate-spin" />
                    <Sparkles className="w-6 h-6 text-amber-400 absolute inset-0 m-auto" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white mb-1">
                      Launching Live Browser Viewport
                    </h4>
                    <p className="text-xs text-gray-400 max-w-sm">
                      Opening direct portal, dismissing cookie overlays, and streaming live frames...
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Terminal Console Tab
            <div className="w-full h-full p-4 font-mono text-xs overflow-y-auto bg-gray-950 text-gray-300 flex flex-col gap-1.5">
              {state?.logs && state.logs.length > 0 ? (
                state.logs.map((item, idx) => (
                  <div
                    key={idx}
                    className={`flex items-start gap-2.5 px-3 py-1.5 rounded-lg border text-[11px] ${
                      item.success
                        ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                        : item.message.includes('⚠️')
                        ? 'bg-amber-950/40 border-amber-800/60 text-amber-300'
                        : item.message.includes('Action:')
                        ? 'bg-indigo-950/40 border-indigo-800/60 text-indigo-300'
                        : item.message.includes('Result:')
                        ? 'bg-teal-950/40 border-teal-800/60 text-teal-300'
                        : 'bg-gray-900/60 border-gray-800/80 text-gray-300'
                    }`}
                  >
                    <span className="text-gray-500 shrink-0 select-none">[{item.timestamp}]</span>
                    <span className="break-all font-medium leading-relaxed">{item.message}</span>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center my-auto">Awaiting engine execution logs...</p>
              )}
              <div ref={terminalBottomRef} />
            </div>
          )}

          {/* Finished Overlay Banner */}
          {isDone && (
            <div className={`p-4 border-t flex items-center justify-between gap-4 backdrop-blur-md ${
              isSuccess 
                ? 'bg-emerald-950/90 border-emerald-800 text-emerald-200' 
                : isBarrier
                ? 'bg-amber-950/90 border-amber-800 text-amber-200'
                : 'bg-gray-900/95 border-gray-800 text-gray-200'
            }`}>
              <div className="flex items-center gap-3">
                {isSuccess ? (
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                ) : (
                  <AlertCircle className="w-6 h-6 text-amber-400 shrink-0" />
                )}
                <div>
                  <h4 className="text-sm font-bold">
                    {isSuccess ? 'Application Successfully Submitted!' : isBarrier ? 'Employer Portal Barrier' : 'Application Concluded'}
                  </h4>
                  <p className="text-xs opacity-90">
                    {state?.last_result?.message || 'Workflow finished.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {onReapply && !isRunning && (
                  <button
                    onClick={onReapply}
                    className="px-3.5 py-1.5 rounded-xl bg-gray-800 hover:bg-gray-700 text-white text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Re-apply</span>
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="px-4 py-1.5 rounded-xl bg-white text-gray-900 text-xs font-bold hover:bg-gray-100 transition shadow cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-3.5 border-t border-gray-800 bg-gray-900/80 flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-gray-400">
            <span className="font-semibold text-gray-300">Phase:</span>
            <span className="capitalize">{state?.phase?.replace('_', ' ') || 'Active'}</span>
            <span className="text-gray-600">•</span>
            <span>Refreshes automatically</span>
          </div>

          <div className="flex items-center gap-2">
            {isRunning ? (
              <button
                onClick={onStop}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-rose-600/30 transition active:scale-95 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-white" />
                <span>Stop Agent</span>
              </button>
            ) : (
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-white font-bold text-xs transition cursor-pointer"
              >
                Close Window
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
