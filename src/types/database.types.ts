export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      jobs: {
        Row: {
          id: string;
          title: string;
          company: string;
          location: string | null;
          latitude: number | null;
          longitude: number | null;
          salary_min: number | null;
          salary_max: number | null;
          salary_currency: string;
          contract_type: string | null;
          description: string | null;
          redirect_url: string | null;
          source: string;
          status: string;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          title: string;
          company: string;
          location?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          salary_min?: number | null;
          salary_max?: number | null;
          salary_currency?: string;
          contract_type?: string | null;
          description?: string | null;
          redirect_url?: string | null;
          source?: string;
          status?: string;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          company?: string;
          location?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          salary_min?: number | null;
          salary_max?: number | null;
          salary_currency?: string;
          contract_type?: string | null;
          description?: string | null;
          redirect_url?: string | null;
          source?: string;
          status?: string;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      candidate_profile: {
        Row: {
          id: string;
          full_name: string;
          email: string;
          phone: string | null;
          location: string | null;
          target_roles: string[] | null;
          skills: string[] | null;
          bio: string | null;
          cv_url: string | null;
          cv_parsed_json: Json | null;
          cover_letter_template: string | null;
          linkedin_url: string | null;
          github_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          full_name: string;
          email: string;
          phone?: string | null;
          location?: string | null;
          target_roles?: string[] | null;
          skills?: string[] | null;
          bio?: string | null;
          cv_url?: string | null;
          cv_parsed_json?: Json | null;
          cover_letter_template?: string | null;
          linkedin_url?: string | null;
          github_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string;
          email?: string;
          phone?: string | null;
          location?: string | null;
          target_roles?: string[] | null;
          skills?: string[] | null;
          bio?: string | null;
          cv_url?: string | null;
          cv_parsed_json?: Json | null;
          cover_letter_template?: string | null;
          linkedin_url?: string | null;
          github_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      job_applications: {
        Row: {
          id: string;
          job_id: string | null;
          candidate_id: string | null;
          company: string;
          job_title: string;
          portal_url: string | null;
          status: string;
          cv_used_url: string | null;
          cover_letter_used: string | null;
          form_data: Json | null;
          logs: string[] | null;
          error_message: string | null;
          applied_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          job_id?: string | null;
          candidate_id?: string | null;
          company: string;
          job_title: string;
          portal_url?: string | null;
          status?: string;
          cv_used_url?: string | null;
          cover_letter_used?: string | null;
          form_data?: Json | null;
          logs?: string[] | null;
          error_message?: string | null;
          applied_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          job_id?: string | null;
          candidate_id?: string | null;
          company?: string;
          job_title?: string;
          portal_url?: string | null;
          status?: string;
          cv_used_url?: string | null;
          cover_letter_used?: string | null;
          form_data?: Json | null;
          logs?: string[] | null;
          error_message?: string | null;
          applied_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      interview_sessions: {
        Row: {
          id: string;
          candidate_id: string | null;
          company_name: string | null;
          role_title: string | null;
          language: string;
          started_at: string;
          ended_at: string | null;
          duration_seconds: number;
          summary: string | null;
          feedback_notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          candidate_id?: string | null;
          company_name?: string | null;
          role_title?: string | null;
          language?: string;
          started_at?: string;
          ended_at?: string | null;
          duration_seconds?: number;
          summary?: string | null;
          feedback_notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          candidate_id?: string | null;
          company_name?: string | null;
          role_title?: string | null;
          language?: string;
          started_at?: string;
          ended_at?: string | null;
          duration_seconds?: number;
          summary?: string | null;
          feedback_notes?: string | null;
          created_at?: string;
        };
      };
      interview_transcripts: {
        Row: {
          id: number;
          session_id: string;
          speaker: string;
          text: string;
          is_final: boolean;
          timestamp_ms: number | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          session_id: string;
          speaker?: string;
          text: string;
          is_final?: boolean;
          timestamp_ms?: number | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          session_id?: string;
          speaker?: string;
          text?: string;
          is_final?: boolean;
          timestamp_ms?: number | null;
          created_at?: string;
        };
      };
      interview_qa: {
        Row: {
          id: number;
          session_id: string;
          question: string;
          suggested_answer: string;
          model_used: string;
          copied: boolean;
          created_at: string;
        };
        Insert: {
          id?: number;
          session_id: string;
          question: string;
          suggested_answer: string;
          model_used?: string;
          copied?: boolean;
          created_at?: string;
        };
        Update: {
          id?: number;
          session_id?: string;
          question?: string;
          suggested_answer?: string;
          model_used?: string;
          copied?: boolean;
          created_at?: string;
        };
      };
      interview_screen_analyses: {
        Row: {
          id: number;
          session_id: string;
          image_url: string | null;
          question_context: string | null;
          analysis_text: string;
          created_at: string;
        };
        Insert: {
          id?: number;
          session_id: string;
          image_url?: string | null;
          question_context?: string | null;
          analysis_text: string;
          created_at?: string;
        };
        Update: {
          id?: number;
          session_id?: string;
          image_url?: string | null;
          question_context?: string | null;
          analysis_text?: string;
          created_at?: string;
        };
      };
    };
  };
}
