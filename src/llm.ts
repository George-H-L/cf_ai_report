// All Workers AI / Llama 3.3 calls live here.
// Three functions: summarise a source page, write the full briefing,
// and regenerate the user's preference notes after they rate a briefing.

import type { BriefingSection, Source, UserProfile } from "./types";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Small wrapper so we're not repeating the fetch boilerplate everywhere
async function chat(
  ai: Ai,
  system: string,
  user: string,
  maxTokens = 512
): Promise<string> {
  const res = await ai.run(MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.4,
  }) as unknown;

  if (typeof res === "string") return res.trim();
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    if (typeof r.response === "string") return r.response.trim();
    if (r.response && typeof r.response === "object") return JSON.stringify(r.response);
    if (Array.isArray(r.choices) && r.choices[0]?.message?.content) {
      return String(r.choices[0].message.content).trim();
    }
  }
  // Unknown shape — stringify so it surfaces in the briefing body for debugging
  return typeof res === "object" ? JSON.stringify(res) : String(res);
}

// Takes the raw text from a scraped page and asks the LLM to pull out
// the key facts and label the angle (technical, policy, business, etc.)
export async function summariseSource(
  ai: Ai,
  title: string,
  url: string,
  text: string,
  topic: string
): Promise<{ summary: string; angle: string }> {
  if (!text.trim()) {
    return { summary: "", angle: "" };
  }

  const raw = await chat(
    ai,
    `You are a research analyst. Given a scraped webpage about "${topic}", extract the key facts.
Respond with exactly two lines:
LINE1: A 2-3 sentence factual summary of the most important information.
LINE2: A single word or short phrase for the angle (e.g. "technical", "business impact", "policy", "scientific").`,
    `Title: ${title}\nURL: ${url}\n\nPage text:\n${text.slice(0, 4000)}`,
    256
  );

  const lines = raw.split("\n").map((l) => l.replace(/^LINE\d:\s*/i, "").trim());
  return {
    summary: lines[0] ?? "",
    angle: lines[1] ?? "general",
  };
}

// Composes the full briefing from the summarised sources.
// If the user has a preference profile we inject it into the system prompt
// so the output is personalised to what they actually care about.
export interface SourceSummary {
  title: string;
  url: string;
  summary: string;
  angle: string;
}

export async function writeBriefing(
  ai: Ai,
  topic: string,
  sources: SourceSummary[],
  profile: UserProfile
): Promise<{ headline: string; sections: BriefingSection[]; usedSources: Source[] }> {
  const sourceBlock = sources
    .filter((s) => s.summary)
    .map((s, i) => `[${i + 1}] ${s.title} (${s.angle})\n${s.summary}`)
    .join("\n\n");

  const parts: string[] = [];
  if (profile.preferenceNotes !== "No preferences recorded yet.") {
    parts.push(profile.preferenceNotes);
  }
  if (profile.interests.length > 0) {
    parts.push(`Topics they like: ${profile.interests.join(", ")}`);
  }
  if (profile.avoidTopics.length > 0) {
    parts.push(`Topics to avoid: ${profile.avoidTopics.join(", ")}`);
  }
  const prefBlock = parts.length > 0
    ? `\nReader profile: ${parts.join(". ")} — actively adjust the angle, emphasis, and framing of each section to reflect these preferences. Prioritise what this reader cares about and note where the topic conflicts with their known dislikes.`
    : "";

  const raw = await chat(
    ai,
    `You are an elite research analyst writing a personalised intelligence briefing.
Write in a confident, clear editorial voice. Be specific, no vague generalities.
${prefBlock}

Respond in this exact JSON format with no markdown fences or extra text:
{
  "headline": "one punchy sentence capturing the most important development",
  "sections": [
    { "title": "...", "body": "2-4 sentences of insight", "angle": "..." },
    { "title": "...", "body": "2-4 sentences of insight", "angle": "..." },
    { "title": "...", "body": "2-4 sentences of insight", "angle": "..." }
  ]
}`,
    `Topic: ${topic}\n\nSource summaries:\n${sourceBlock}`,
    800
  );

  let parsed: { headline: string; sections: BriefingSection[] };
  try {
    // try to pull a JSON object out of whatever the LLM returned
    const clean = raw.replace(/```json|```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
  } catch {
    // If the LLM doesn't return valid JSON we just wrap the raw text
    parsed = {
      headline: `Research briefing: ${topic}`,
      sections: [{ title: "Summary", body: raw, angle: "general" }],
    };
  }

  const usedSources: Source[] = sources
    .filter((s) => s.summary)
    .map((s) => ({
      title: s.title,
      url: s.url,
      blurb: s.summary.slice(0, 120) + "...",
    }));

  return {
    headline: parsed.headline,
    sections: parsed.sections,
    usedSources,
  };
}

// Reads through the user's liked and disliked topics and writes a plain
// English sentence describing their preferences. This gets saved back to
// the Durable Object and injected into future briefing prompts.
export async function refreshPreferences(
  ai: Ai,
  profile: UserProfile
): Promise<string> {
  if (profile.briefingHistory.length < 2) {
    return "No preferences recorded yet.";
  }

  const liked = profile.interests.slice(0, 10).join(", ") || "none yet";
  const disliked = profile.avoidTopics.slice(0, 10).join(", ") || "none";

  return chat(
    ai,
    "Summarise a user's content preferences in 1-2 sentences for use in a system prompt. Be specific.",
    `Topics they liked: ${liked}\nTopics they dismissed: ${disliked}`,
    128
  );
}
