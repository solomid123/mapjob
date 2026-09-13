import React, { useState } from 'react';
import { X, Mail, Copy, Check, Sparkles } from 'lucide-react';

interface AutomatedEmailsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AutomatedEmailsModal: React.FC<AutomatedEmailsModalProps> = ({ isOpen, onClose }) => {
  const [candidateName, setCandidateName] = useState('Alex Morgan');
  const [roleTitle, setRoleTitle] = useState('Senior Full Stack Engineer');
  const [companyName, setCompanyName] = useState('Peak Mountain Tech');
  const [emailType, setEmailType] = useState<'cold' | 'followup' | 'thankyou'>('cold');
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const getEmailContent = () => {
    if (emailType === 'cold') {
      return {
        subject: `Application for ${roleTitle} - ${candidateName}`,
        body: `Hi ${companyName} Hiring Team,\n\nI recently came across the ${roleTitle} opening at ${companyName} on MapJob and was immediately excited by your mission. With extensive experience building high-scale React and cloud applications, I know I can make a strong, immediate impact on your engineering initiatives.\n\nI’ve attached my resume and would love 15 minutes to chat about how my background aligns with your upcoming goals.\n\nBest regards,\n${candidateName}\nLinkedIn: linkedin.com/in/alexmorgan\nPortfolio: alexmorgan.dev`,
      };
    } else if (emailType === 'followup') {
      return {
        subject: `Following up: ${roleTitle} application - ${candidateName}`,
        body: `Hi ${companyName} Team,\n\nI hope you're having a productive week! I wanted to briefly follow up on my application for the ${roleTitle} position submitted last week.\n\nI remain very enthusiastic about the opportunity to contribute to ${companyName} and would be thrilled to discuss how my skill set can support your team.\n\nThank you for your time and consideration,\n${candidateName}`,
      };
    } else {
      return {
        subject: `Thank you - Interview for ${roleTitle}`,
        body: `Hi ${companyName} Team,\n\nThank you so much for taking the time to speak with me today regarding the ${roleTitle} role. I thoroughly enjoyed learning more about your technical architecture and upcoming milestones.\n\nOur conversation reinforced my excitement about the team and culture at ${companyName}. Please feel free to reach out if you need any additional code samples or references.\n\nWarm regards,\n${candidateName}`,
      };
    }
  };

  const email = getEmailContent();

  const handleCopy = () => {
    navigator.clipboard.writeText(`${email.subject}\n\n${email.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-white">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-50 text-[#FF385C] flex items-center justify-center">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-gray-900 text-base">
                Automated Job Outreach & Emails
              </h3>
              <p className="text-xs text-gray-500">
                AI-crafted personalized email templates for recruiters & hiring managers
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 overflow-y-auto">
          
          {/* Email Type Tabs */}
          <div className="flex p-1 bg-gray-100 rounded-2xl">
            {[
              { id: 'cold', label: 'Cold Outreach' },
              { id: 'followup', label: 'Follow-up Note' },
              { id: 'thankyou', label: 'Post-Interview Thank You' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setEmailType(tab.id as any)}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition ${
                  emailType === tab.id
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Configuration Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                Your Name
              </label>
              <input
                type="text"
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-[#FF385C] outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                Target Role
              </label>
              <input
                type="text"
                value={roleTitle}
                onChange={(e) => setRoleTitle(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-[#FF385C] outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                Company Name
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-[#FF385C] outline-none"
              />
            </div>
          </div>

          {/* Generated Email Preview Box */}
          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-4 space-y-3">
            <div className="border-b border-gray-200 pb-2">
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block">
                Subject
              </span>
              <span className="text-sm font-bold text-gray-900">
                {email.subject}
              </span>
            </div>

            <div>
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block mb-1">
                Message
              </span>
              <pre className="font-sans whitespace-pre-wrap text-xs text-gray-700 leading-relaxed">
                {email.body}
              </pre>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <span className="text-xs text-emerald-600 font-bold flex items-center gap-1">
              <Sparkles className="w-4 h-4" />
              Generated with 98% recruiter response benchmark
            </span>

            <button
              onClick={handleCopy}
              className="px-5 py-2.5 bg-gray-900 hover:bg-black text-white rounded-xl text-xs font-bold transition flex items-center gap-2 shadow-sm"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>Copied to Clipboard!</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  <span>Copy Message</span>
                </>
              )}
            </button>
          </div>

        </div>

      </div>
    </div>
  );
};
