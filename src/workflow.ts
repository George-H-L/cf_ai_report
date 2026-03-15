// The research pipeline. This is the most important file in the project.
//
// When a user requests a briefing, the Worker kicks this Workflow off
// and returns immediately. The pipeline runs in the background across
// up to 8 steps, each one checkpointed by Cloudflare's Workflow runtime.
//
// Checkpointing means: if the Worker is interrupted mid-pipeline (restart,
// timeout, etc.), execution resumes from the last completed step rather
// than starting over. That's the whole point of using Workflows here
// instead of just chaining fetch calls inside a Worker.
//
// Step order:
//   1. Mark the briefing as "processing" in KV
//   2. Load the user's preference profile from their Durable Object
//   3. Search DuckDuckGo for the topic
//   4. Fetch the content of each result page (one step per page)
//   5. Ask the LLM to summarise each page (one step per page)
//   6. Ask the LLM to write the full personalised briefing
//   7. Save the completed briefing to KV
//   8. Record this briefing in the user's history

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { searchWeb, fetchPage } from "./scraper";
import { summariseSource, writeBriefing } from "./llm";
import type { Env, WorkflowParams, Briefing, UserProfile } from "./types";

export class ResearchWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    const { briefingId, userId, topic, preferenceNotes, interests, avoidTopics } = event.payload;

    // Step 1: flip the status to "processing" so the frontend knows we started
    await step.do("mark-processing", async () => {
      const current = await this.env.BRIEFINGS.get(briefingId);
      if (current) {
        const briefing = JSON.parse(current) as Briefing;
        briefing.status = "processing";
        await this.env.BRIEFINGS.put(briefingId, JSON.stringify(briefing), {
          expirationTtl: 60 * 60 * 24 * 7,
        });
      }
    });

    // Step 2: pull the user's profile so we can personalise the briefing.
    // If the DO doesn't have preference notes (can happen in dev after a hot-reload),
    // fall back to the KV copy which is always kept in sync.
    const profile = await step.do("fetch-user-profile", async () => {
      const doId = this.env.USER_PROFILE.idFromName(userId);
      const stub = this.env.USER_PROFILE.get(doId);
      const res = await stub.fetch(`https://internal/profile?userId=${userId}`);
      const p = await res.json<UserProfile>();

      // Preferences passed directly from the browser are the most reliable source —
      // they bypass the DO binding issue in wrangler dev entirely.
      if (preferenceNotes && p.preferenceNotes === "No preferences recorded yet.") p.preferenceNotes = preferenceNotes;
      if (interests?.length && p.interests.length === 0) p.interests = interests;
      if (avoidTopics?.length && p.avoidTopics.length === 0) p.avoidTopics = avoidTopics;

      // Always read from KV — it is the most reliable store across wrangler dev
      // hot-reloads, and GET /profile syncs it on every sidebar load.
      // We prefer KV notes/interests over the DO only when the DO value is the
      // default (empty), so a real DO value is never silently overwritten.
      const kvPrefsRaw = await this.env.BRIEFINGS.get(`prefs:${userId}`);
      if (kvPrefsRaw) {
        const kv = JSON.parse(kvPrefsRaw) as { notes: string; interests: string[]; avoidTopics: string[] };
        if (p.preferenceNotes === "No preferences recorded yet." && kv.notes && kv.notes !== "No preferences recorded yet.") p.preferenceNotes = kv.notes;
        if (p.interests.length === 0 && kv.interests?.length) p.interests = kv.interests;
        if (p.avoidTopics.length === 0 && kv.avoidTopics?.length) p.avoidTopics = kv.avoidTopics;
      }

      return p;
    });

    // Step 3: search DuckDuckGo for relevant pages
    const searchResults = await step.do("search-web", async () => {
      return searchWeb(topic, "", 5);
    });

    // Steps 4a-4e: fetch each page separately so each one is checkpointed.
    // We can't do Promise.all inside a single step because the runtime needs
    // to be able to replay individual steps on retry.
    const pageTexts: string[] = [];
    for (let i = 0; i < searchResults.length; i++) {
      const text = await step.do(`fetch-page-${i}`, async () => {
        return fetchPage(searchResults[i].url);
      });
      pageTexts.push(text);
    }

    // Steps 5a-5e: summarise each page with the LLM
    const sourceSummaries: { title: string; url: string; summary: string; angle: string }[] = [];
    for (let i = 0; i < searchResults.length; i++) {
      const result = searchResults[i];
      const text = pageTexts[i];

      const summary = await step.do(`summarise-source-${i}`, async () => {
        return summariseSource(this.env.AI, result.title, result.url, text, topic);
      });

      sourceSummaries.push({
        title: result.title,
        url: result.url,
        summary: summary.summary,
        angle: summary.angle,
      });
    }

    // Step 6: compose the final briefing from all the summaries.
    // Re-read preferences from KV here as a second attempt — by this point
    // the user's page loadSidebar() will have synced the DO notes to KV,
    // even if step 2 ran before the sync completed.
    const { headline, sections, usedSources } = await step.do(
      "write-briefing",
      async () => {
        const profileForBriefing = { ...profile };
        if (preferenceNotes && profileForBriefing.preferenceNotes === "No preferences recorded yet.") profileForBriefing.preferenceNotes = preferenceNotes;
        if (interests?.length && profileForBriefing.interests.length === 0) profileForBriefing.interests = interests;
        if (avoidTopics?.length && profileForBriefing.avoidTopics.length === 0) profileForBriefing.avoidTopics = avoidTopics;
        return writeBriefing(this.env.AI, topic, sourceSummaries, profileForBriefing);
      }
    );

    // Step 7: write the completed briefing to KV so the frontend can read it
    await step.do("save-briefing", async () => {
      const briefing: Briefing = {
        briefingId,
        userId,
        topic,
        status: "complete",
        createdAt: new Date().toISOString(),
        headline,
        sections,
        sources: usedSources,
      };
      await this.env.BRIEFINGS.put(briefingId, JSON.stringify(briefing), {
        expirationTtl: 60 * 60 * 24 * 7,
      });
    });

    // Step 8: add this briefing to the user's history in their Durable Object
    await step.do("update-user-history", async () => {
      const doId = this.env.USER_PROFILE.idFromName(userId);
      const stub = this.env.USER_PROFILE.get(doId);
      await stub.fetch(`https://internal/save-briefing?userId=${userId}`, {
        method: "POST",
        body: JSON.stringify({
          briefingId,
          topic,
          date: new Date().toISOString(),
          rating: null,
        }),
      });
    });
  }
}
