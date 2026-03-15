// Main Worker entry point. Handles all HTTP routing.
//
// We re-export UserProfile and ResearchWorkflow here so wrangler can
// find the class names it needs to bind them as DO and Workflow.
//
// Endpoints:
//   POST /briefing            start a new research request
//   GET  /briefing/:id        poll for the result
//   GET  /history/:userId     last 20 briefings from the user's DO
//   POST /feedback            submit a thumbs up or down
//   GET  /profile/:userId     full preference profile
//   GET  /health              sanity check

import type { Env, Briefing, BriefingMeta, UserProfile } from "./types";
import { UserProfileDO } from "./memory";
import { ResearchWorkflow } from "./workflow";
import { refreshPreferences } from "./llm";

export { UserProfileDO, ResearchWorkflow };

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Start a new briefing. Creates a pending KV record, fires the Workflow,
    // and returns the briefingId immediately so the frontend can start polling.
    if (path === "/briefing" && request.method === "POST") {
      const body = (await request.json()) as {
        topic?: string;
        userId?: string;
        preferenceNotes?: string;
        interests?: string[];
        avoidTopics?: string[];
      };
      const topic = body.topic?.trim();
      const userId = body.userId?.trim();

      if (!topic || !userId) {
        return json({ error: "topic and userId are both required" }, 400);
      }

      const briefingId = randomId();
      const pending: Briefing = {
        briefingId,
        userId,
        topic,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      // Write the pending record before we kick off the Workflow so there's
      // something to poll immediately. Otherwise the first poll would 404.
      await env.BRIEFINGS.put(briefingId, JSON.stringify(pending), {
        expirationTtl: 60 * 60 * 24 * 7,
      });

      await env.RESEARCH_WORKFLOW.create({
        params: {
          briefingId,
          userId,
          topic,
          preferenceNotes: body.preferenceNotes,
          interests: body.interests,
          avoidTopics: body.avoidTopics,
        },
      });

      return json({ briefingId, status: "pending" });
    }

    // Poll for a briefing result. The frontend calls this every 3 seconds
    // until status flips from pending/processing to complete or error.
    const briefingMatch = path.match(/^\/briefing\/([a-z0-9]+)$/i);
    if (briefingMatch && request.method === "GET") {
      const briefingId = briefingMatch[1];
      const raw = await env.BRIEFINGS.get(briefingId);
      if (!raw) return json({ error: "briefing not found" }, 404);
      const briefing = JSON.parse(raw) as Briefing;

      // Save to history when first seen as complete.
      // We write to both the DO and a KV list — KV survives wrangler dev
      // hot-reloads whereas the SQLite-backed DO does not.
      if (briefing.status === "complete" && briefing.userId) {
        const meta: BriefingMeta = {
          briefingId: briefing.briefingId,
          topic: briefing.topic,
          date: briefing.createdAt,
          rating: null,
        };

        // KV history list
        const histKey = `h:${briefing.userId}`;
        const histRaw = await env.BRIEFINGS.get(histKey);
        const kvHist: BriefingMeta[] = histRaw ? JSON.parse(histRaw) : [];
        if (!kvHist.some((h) => h.briefingId === meta.briefingId)) {
          kvHist.unshift(meta);
          await env.BRIEFINGS.put(histKey, JSON.stringify(kvHist.slice(0, 50)), {
            expirationTtl: 60 * 60 * 24 * 30,
          });
        }

        // DO history (best-effort)
        const doId = env.USER_PROFILE.idFromName(briefing.userId);
        const stub = env.USER_PROFILE.get(doId);
        await stub.fetch(`https://internal/save-briefing?userId=${briefing.userId}`, {
          method: "POST",
          body: JSON.stringify(meta),
        });
      }

      return json(briefing);
    }

    // Returns the last 20 briefings from the user's Durable Object
    const historyMatch = path.match(/^\/history\/(.+)$/);
    if (historyMatch && request.method === "GET") {
      const userId = historyMatch[1];
      const doId = env.USER_PROFILE.idFromName(userId);
      const stub = env.USER_PROFILE.get(doId);
      const res = await stub.fetch(`https://internal/profile?userId=${userId}`);
      const profile = (await res.json()) as { briefingHistory: unknown[] };
      return json({ history: profile.briefingHistory?.slice(0, 20) ?? [] });
    }

    // Record a thumbs up or down on a briefing.
    // After every 3 ratings we regenerate the preference notes with the LLM
    // so future briefings get more personalised over time.
    if (path === "/feedback" && request.method === "POST") {
      const { briefingId, userId, topic, rating } = (await request.json()) as {
        briefingId: string;
        userId: string;
        topic: string;
        rating: "up" | "down";
      };

      if (!briefingId || !userId || !topic || !rating) {
        return json(
          { error: "briefingId, userId, topic and rating are all required" },
          400
        );
      }

      const doId = env.USER_PROFILE.idFromName(userId);
      const stub = env.USER_PROFILE.get(doId);

      await stub.fetch(`https://internal/feedback?userId=${userId}`, {
        method: "POST",
        body: JSON.stringify({ briefingId, topic, rating }),
      });

      // Keep KV history in sync so ratings survive DO hot-reload loss.
      // We hold the updated array in memory so we don't have to re-read KV
      // (KV is eventually consistent — a read right after a write can return
      // the old value, which would make ratedCount wrong).
      const histKey = `h:${userId}`;
      const histRaw = await env.BRIEFINGS.get(histKey);
      let kvHistSynced: BriefingMeta[] = [];
      if (histRaw) {
        const kvHist: BriefingMeta[] = JSON.parse(histRaw);
        const entry = kvHist.find((h) => h.briefingId === briefingId);
        if (entry) entry.rating = rating;
        await env.BRIEFINGS.put(histKey, JSON.stringify(kvHist), {
          expirationTtl: 60 * 60 * 24 * 30,
        });
        kvHistSynced = kvHist; // already has the updated rating in memory
      }

      // Check if we should regenerate the preference notes.
      // Merge KV history into the profile so the rating count is accurate
      // even if the DO lost history entries across a dev hot-reload.
      const profileRes = await stub.fetch(
        `https://internal/profile?userId=${userId}`
      );
      const profile = (await profileRes.json()) as UserProfile;

      const doIds2 = new Set(profile.briefingHistory.map((h) => h.briefingId));
      const mergedHistory = [
        ...profile.briefingHistory,
        ...kvHistSynced.filter((h) => !doIds2.has(h.briefingId)),
      ];

      // Use interests+avoidTopics length as the rating signal — these are always
      // maintained by the DO feedback handler regardless of whether briefing
      // history survived a dev hot-reload or KV sync.
      const totalRated = profile.interests.length + profile.avoidTopics.length;
      const noNotesYet = profile.preferenceNotes === "No preferences recorded yet.";

      if (totalRated > 0 && (noNotesYet || totalRated % 3 === 0)) {
        const notes = await refreshPreferences(env.AI, { ...profile, briefingHistory: mergedHistory });
        await stub.fetch(
          `https://internal/update-preferences?userId=${userId}`,
          {
            method: "POST",
            body: JSON.stringify({ preferenceNotes: notes }),
          }
        );
        // Also store in KV so the Workflow can read it reliably —
        // DO bindings inside Workflow steps can access a different instance in dev.
        await env.BRIEFINGS.put(
          `prefs:${userId}`,
          JSON.stringify({
            notes,
            interests: profile.interests,
            avoidTopics: profile.avoidTopics,
          }),
          { expirationTtl: 60 * 60 * 24 * 30 }
        );
      }

      return json({ ok: true });
    }

    // Returns the full preference profile for a user.
    // Merges KV history into the profile so history survives DO state loss in dev.
    const profileMatch = path.match(/^\/profile\/(.+)$/);
    if (profileMatch && request.method === "GET") {
      const userId = profileMatch[1];
      const doId = env.USER_PROFILE.idFromName(userId);
      const stub = env.USER_PROFILE.get(doId);
      const res = await stub.fetch(`https://internal/profile?userId=${userId}`);
      const profile = await res.json() as UserProfile;

      // Merge KV prefs into the profile BEFORE anything else.
      // If the DO lost preference notes across a dev hot-reload but KV still has
      // them, we restore them here — and this also prevents the write below from
      // overwriting the KV copy with the blank DO value.
      const kvPrefsRaw = await env.BRIEFINGS.get(`prefs:${userId}`);
      if (kvPrefsRaw) {
        const kv = JSON.parse(kvPrefsRaw) as { notes: string; interests: string[]; avoidTopics: string[] };
        if (profile.preferenceNotes === "No preferences recorded yet." && kv.notes && kv.notes !== "No preferences recorded yet.") {
          profile.preferenceNotes = kv.notes;
        }
        if (profile.interests.length === 0 && kv.interests?.length) profile.interests = kv.interests;
        if (profile.avoidTopics.length === 0 && kv.avoidTopics?.length) profile.avoidTopics = kv.avoidTopics;
      }

      // Always merge KV history with DO history — KV is the reliable long-term
      // store, DO may have only the most recent entries after a dev hot-reload.
      const histRaw = await env.BRIEFINGS.get(`h:${userId}`);
      const kvHist: BriefingMeta[] = histRaw ? JSON.parse(histRaw) : [];
      const doIds = new Set(profile.briefingHistory.map((h) => h.briefingId));
      const merged = [
        ...profile.briefingHistory,
        ...kvHist.filter((h) => !doIds.has(h.briefingId)),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
       .slice(0, 50);
      profile.briefingHistory = merged;

      // Sync the merged preferences back to KV so the Workflow always has
      // the latest data, including any notes just restored from KV above.
      if (
        profile.interests.length > 0 ||
        profile.avoidTopics.length > 0 ||
        profile.preferenceNotes !== "No preferences recorded yet."
      ) {
        await env.BRIEFINGS.put(
          `prefs:${userId}`,
          JSON.stringify({
            notes: profile.preferenceNotes,
            interests: profile.interests,
            avoidTopics: profile.avoidTopics,
          }),
          { expirationTtl: 60 * 60 * 24 * 30 }
        );
      }

      return json(profile);
    }

    if (path === "/health") {
      return json({ status: "ok", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
