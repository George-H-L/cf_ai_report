// Shared types used across the whole project.
// Import from here rather than redefining things in multiple files.

// The Cloudflare bindings available inside every Worker and Workflow.
// wrangler.toml declares these, this interface just gives us type safety.
export interface Env {
  AI: Ai;
  BRIEFINGS: KVNamespace;
  USER_PROFILE: DurableObjectNamespace;
  RESEARCH_WORKFLOW: Workflow;
}

// What we store in the Durable Object for each user.
// Grows over time as they rate more briefings.
export interface UserProfile {
  userId: string;
  interests: string[];
  avoidTopics: string[];
  preferenceNotes: string; // plain English summary written by the LLM
  briefingHistory: BriefingMeta[];
}

// Lightweight record we keep in the history list.
// We don't store the full briefing text here, that lives in KV.
export interface BriefingMeta {
  briefingId: string;
  topic: string;
  date: string;
  rating: "up" | "down" | null;
}

// A full briefing record as stored in KV.
export type BriefingStatus = "pending" | "processing" | "complete" | "error";

export interface Briefing {
  briefingId: string;
  userId: string;
  topic: string;
  status: BriefingStatus;
  createdAt: string;
  headline?: string;
  sections?: BriefingSection[];
  sources?: Source[];
  errorMsg?: string;
}

export interface BriefingSection {
  title: string;
  body: string;
  angle: string; // e.g. "technical", "business", "policy"
}

export interface Source {
  title: string;
  url: string;
  blurb: string; // one sentence on what this source contributed
}

// Params passed into the Workflow when we kick it off
export interface WorkflowParams {
  briefingId: string;
  userId: string;
  topic: string;
  preferenceNotes?: string;
  interests?: string[];
  avoidTopics?: string[];
}
