# Development Log

---

**Prompt 1**
"getting a naming conflict error on the UserProfile class, it's being imported as a type
and also exported as the DO class in the same file, how do I fix this"

**Answer**
TypeScript was seeing two things called `UserProfile` in the same file — the interface imported from `types.ts` and the Durable Object class defined in `memory.ts`. The runtime couldn't resolve which one to bind as the DO. The fix was renaming the class to `UserProfileDO` and updating the references in `index.ts` and `wrangler.toml` to match. The interface in `types.ts` kept its original name since nothing else needed to change there.

---

**Prompt 2**
"wrangler dev is throwing: workflow.not_found — the workflow binding exists in wrangler.toml
but it can't find it at runtime, do I need to deploy first before it resolves?"

**Answer**
Yes. Unlike Workers and Durable Objects which wrangler can simulate locally, Workflows have to be registered on Cloudflare's infrastructure before they can run. Even in dev mode with `--remote`, the Workflow class needs to exist on the account. Running `wrangler deploy` first registers it, after which `wrangler dev --remote` can find and execute it.

---

**Prompt 3**
"free plan durable objects need new_sqlite_classes instead of new_classes in the migrations
block, getting error code 10097 on deploy"

**Answer**
Cloudflare changed the free plan to require SQLite-backed Durable Objects rather than the older in-memory storage model. The migration block in `wrangler.toml` needs to declare the class under `new_sqlite_classes` instead of `new_classes`. It's the same class, just a different storage backend that Cloudflare mandates for free tier accounts. No changes needed in the actual DO code.

---

**Prompt 4**
"is it better to store completed briefings in KV or a Durable Object? my thinking is KV
since they're just read-heavy key lookups once written, but wanted to check if there's
a reason to keep everything in the DO"

**Answer**
KV is the right call here. Briefings are written once by the Workflow and then only ever read by the frontend polling for results — that's exactly the access pattern KV is optimised for. Durable Objects are better suited to state that needs to be updated frequently and consistently, like the user profile where ratings accumulate over time. Mixing the two keeps concerns separate: KV for immutable outputs, DO for mutable user state.

---

**Prompt 5**
"for the research pipeline should each step be a separate step.do() call or is it fine
to batch the page fetches into one step with Promise.all — wondering if checkpointing
per page is overkill"

**Answer**
Separate steps is the right approach even if it feels verbose. The whole point of using Workflows over a plain Worker is that each `step.do()` call is checkpointed — if the pipeline fails halfway through, it resumes from the last successful step rather than starting over. Batching all five page fetches into one step with `Promise.all` means if any single fetch causes a failure, all five have to re-run. At five steps it's not a big deal, but it's also not more code to keep them separate, and it means the progress is granular enough to show meaningful status updates to the frontend while the user is waiting.

--- 

**Prompt 6**
"write-briefing step is erroring with res.response?.trim is not a function, retried 5 times
and failing every time — looks like the AI response shape isn't what the code expects"

**Answer**
Workers AI doesn't always return { response: string } — the actual shape depends on the model and runtime version. The chat() function was casting the result directly to { response?: string } and calling .trim() on it, which crashes if the model returns a plain string or an OpenAI-style { choices: [{ message: { content } }] } object instead. The fix is to cast to unknown first and then check all three possible shapes before extracting the text, falling back to an empty string if none match.

---

**Prompt 7**
"the AI response shape isn't what the code expects — r.response is coming back as an object
not a string, so chat() misses it and returns nothing to writeBriefing"

**Answer**
Workers AI was returning the response as an already-parsed JSON object inside r.response rather than a string. The chat() function only checked typeof r.response === "string" so it fell through every branch and returned empty. The fix was adding a check for when r.response is an object and calling JSON.stringify() on it to convert it back to a string that writeBriefing could then parse normally.

---

**Prompt 8**
"history is storing fine but disappears when a new brief is dispatched — looks like the
DO state doesn't survive between requests in dev mode"

**Answer**
In wrangler dev, Durable Object state can get wiped on hot-reloads when using new_sqlite_classes. The fix was writing history to KV as well as the DO, and merging both sources when the profile endpoint is called. KV persists reliably across reloads so history is always recoverable even when the DO loses state. The merge logic deduplicates by briefingId so entries never appear twice.

---

**Prompt 9**
"ive rated 3 briefs, the profile notes show in the sidebar correctly, but the workflow
doesnt seem to be using them — the briefings arent getting personalised"

**Answer**
Two problems. First, DO calls from inside Workflow step.do() callbacks can hit a different instance than regular Worker requests in dev mode, so the workflow was reading an empty profile even though the sidebar showed the correct notes. Second, the personalization instruction in the system prompt was too passive. The fix was saving preference notes and the full interests/avoidTopics arrays to KV as a prefs:${userId} blob whenever the sidebar loads, then reading that KV key directly inside the workflow steps. The LLM prompt instruction was also strengthened to explicitly tell the model to act on the preferences rather than just be aware of them.