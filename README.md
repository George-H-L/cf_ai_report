# cf_ai_research-briefing

Type in any topic and get a personalised AI-written intelligence briefing. The system searches the web, reads the pages, and composes a structured briefing styled like a newspaper front page. Rate briefings over time and it learns what you care about, personalising future results.

## How it works

When you submit a topic the Worker kicks off a background Workflow that searches DuckDuckGo, fetches the top 5 pages, asks Llama 3.3 to summarise each one, then writes the full briefing from those summaries. Each step is checkpointed so if anything fails mid-pipeline it resumes from where it left off rather than starting over.

Your ratings get stored in a Durable Object. After every 3 ratings the LLM reads your liked and disliked topics and writes a plain English preference summary, which gets injected into the prompt the next time you request a briefing.

The frontend polls for the result every 3 seconds and renders it when done.

## Requirements

- Cloudflare account (free tier works)
- Node 18+
- No other accounts or API keys needed

## Running locally

```bash
npm install
npx wrangler login

# Create the KV namespace
npx wrangler kv namespace create BRIEFINGS
npx wrangler kv namespace create BRIEFINGS --preview

# Paste both IDs into wrangler.toml — use the same ID for both id and preview_id
[[kv_namespaces]]
binding    = "BRIEFINGS"
id         = "your-id-here"
preview_id = "your-id-here"

npm run dev
# Worker runs at http://localhost:8787
# Open frontend/index.html directly in your browser
```

## Deploying

```bash
npm run deploy
# Then update the API variable at the bottom of frontend/index.html
# to point at your deployed Worker URL
# Deploy the frontend/ folder to Cloudflare Pages
```

## API

| Method | Path | Body |
|--------|------|------|
| POST | /briefing | `{ topic, userId }` |
| GET | /briefing/:id | |
| POST | /feedback | `{ briefingId, userId, topic, rating }` |
| GET | /profile/:userId | |
| GET | /history/:userId | |
