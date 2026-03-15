// Durable Object that stores a user's preference profile.
// One instance per user, keyed by userId.
//
// Named UserProfileDO to avoid conflicting with the UserProfile interface in types.ts.
//
// Routes handled internally (not exposed to the public):
//   GET  /profile              returns the full profile
//   POST /save-briefing        appends a BriefingMeta to the history
//   POST /feedback             records a rating and updates interest lists
//   POST /update-preferences   saves the LLM-generated preference notes

import type { UserProfile, BriefingMeta } from "./types";

function emptyProfile(userId: string): UserProfile {
  return {
    userId,
    interests: [],
    avoidTopics: [],
    preferenceNotes: "No preferences recorded yet.",
    briefingHistory: [],
  };
}

export class UserProfileDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async getProfile(userId: string): Promise<UserProfile> {
    return (
      (await this.state.storage.get<UserProfile>("profile")) ??
      emptyProfile(userId)
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId") ?? "unknown";

    if (url.pathname === "/profile") {
      const profile = await this.getProfile(userId);
      return Response.json(profile);
    }

    if (url.pathname === "/save-briefing" && request.method === "POST") {
      const meta = (await request.json()) as BriefingMeta;
      const profile = await this.getProfile(userId);

      // Idempotent — skip if this briefing is already in history
      const alreadySaved = profile.briefingHistory.some(
        (b) => b.briefingId === meta.briefingId
      );
      if (!alreadySaved) {
        profile.briefingHistory = [meta, ...profile.briefingHistory].slice(0, 50);
        await this.state.storage.put("profile", profile);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/feedback" && request.method === "POST") {
      const { briefingId, topic, rating } = (await request.json()) as {
        briefingId: string;
        topic: string;
        rating: "up" | "down";
      };

      const profile = await this.getProfile(userId);

      // Update the rating on the matching history entry if it exists
      const entry = profile.briefingHistory.find(
        (b) => b.briefingId === briefingId
      );
      if (entry) entry.rating = rating;

      // Move topic to the appropriate list, removing it from the other if present
      profile.interests    = profile.interests.filter(t => t !== topic);
      profile.avoidTopics  = profile.avoidTopics.filter(t => t !== topic);
      if (rating === "up") {
        profile.interests = [topic, ...profile.interests].slice(0, 20);
      } else {
        profile.avoidTopics = [topic, ...profile.avoidTopics].slice(0, 20);
      }

      await this.state.storage.put("profile", profile);
      return Response.json({ ok: true, profile });
    }

    if (url.pathname === "/update-preferences" && request.method === "POST") {
      const { preferenceNotes } = (await request.json()) as {
        preferenceNotes: string;
      };
      const profile = await this.getProfile(userId);
      profile.preferenceNotes = preferenceNotes;
      await this.state.storage.put("profile", profile);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
