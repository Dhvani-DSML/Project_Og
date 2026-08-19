# Ripple — Submission

Multi-hop code intelligence agent: answers "what breaks if I change this?" by walking
a real call graph, not by guessing from text similarity.

**Live app:** https://projectog.vercel.app
**Repository:** https://github.com/Dhvani-DSML/Project_Og

---

## 1. What I built and why

Every AI coding tool has to decide what slice of a codebase to show the model, because
you can't hand it the whole repo. Most tools do this by finding text that *sounds*
similar to the question — which misses things that are *connected* to the answer but
don't share vocabulary: a config file, a caller three functions away, an import three
files over.

Ripple builds a small, honest version of a better approach. It parses a repo into an
actual map of which functions call which and which files import which, then answers
questions by combining that relationship map with normal meaning-based search,
compresses everything down to only what's relevant, and shows exactly which parts of
the map it walked to produce the answer.

The capability this unlocks that plain RAG cannot do: **"what breaks if I change this
function?"** — answered by walking the real call graph backwards, not by guessing from
text similarity. That question, and the graph visualization showing the actual walked
path, is the center of the whole build.

Scope, stated plainly rather than glossed over: TypeScript/JavaScript only, heuristic
call resolution rather than full type inference, single-repo-at-a-time, no auth. Each
of these is a deliberate cut under a real deadline, not an oversight — argued for below.

---

## 2. Architecture and design

```
                    ┌─────────────────────────────┐
                    │   ONE-TIME: repo ingestion   │
   GitHub repo URL →│  walk files → tree-sitter    │
                    │  parse → build call graph     │
                    │       +                       │
                    │  chunk by symbol → embed      │
                    │  → store in vector index       │
                    └──────────────┬───────────────┘
                                   │ Upstash Redis (graph) /
                                   │ Upstash Vector (embeddings)
                                   ▼
                    ┌─────────────────────────────┐
                    │   PER QUERY: LangGraph agent │
   user question  → │  1. Router: structural vs     │
                    │     semantic vs both          │
                    │  2a. Graph traversal node      │
                    │      (N-hop, blast radius)     │
                    │  2b. Vector retrieval node      │
                    │      (semantic search)          │
                    │  3. Compress (verbatim + summ.)  │
                    │  4. Answer (grounded + cited)     │
                    └──────────────┬───────────────┘
                                   ▼
                    Next.js chat UI + graph visualization
                    panel highlighting the walked subgraph
```

Framework: Next.js (App Router, TypeScript), one deploy target. Agent orchestration:
`@langchain/langgraph` for conditional routing and loops, not a fixed chain. Graph
storage: `graphology`, serialized to Upstash Redis, rebuilt in-memory per invocation.
Vector store: Upstash Vector. LLM: Groq free tier. Graph visualization: `@xyflow/react`.
Deployment: Vercel.

### Key design decisions, and the actual reasoning behind each

**TypeScript/JavaScript only.** Tree-sitter grammar handling and the extraction logic
in `extract.ts` are language-specific by construction (class/method/const-arrow-fn
node types, import statement shapes). Supporting a second language means a second
extractor, tested independently, under a two-day build window. Scoping to one
language family and doing it well beat spreading thin across several done shallowly.

**`web-tree-sitter` (WASM) over native tree-sitter bindings.** Native tree-sitter
bindings need a compilation step per platform, which is friction in exactly the two
places this project runs: a dev machine and a serverless deploy target with no control
over the build image's native toolchain. WASM has no native build step at all — it
just runs. The actual cost of this decision surfaced much later, in deployment: WASM
grammar files and the WASM parser engine itself needed explicit file-tracing handling
to survive Vercel's bundling (see the deploy section below), a cost worth paying once
at deploy time versus fighting native compilation on every environment this code runs
in.

**Heuristic call resolution over full type inference.** A real language server needs
full type checking to resolve `pool.open()` to the right `open` method. That's a
different, much larger project. The heuristic resolver here — exact import-path match,
same-file match, then a "unique exported symbol by name" fallback — gets real repos
into the 11–83% resolution range (see Evaluation Metrics below), which is enough to
answer real blast-radius questions on real code, and the boundary is documented rather
than hidden: instance-method calls through a variable (`pool.open()`) don't resolve,
because that needs real type inference. That's the honest line between "heuristic
resolution" and "LSP-level semantic analysis," and it's a selling point in this
write-up, not a bug to apologize for.

**Two Groq models, not one.** `openai/gpt-oss-120b` for `compress.ts` and `answer.ts`
— these run once per query and produce the actual grounded answer, worth the extra
weight. `openai/gpt-oss-20b` for `router.ts` — the classification call runs on *every*
query before anything else happens, so latency matters more than raw capability for a
3-way structural/semantic/both classification. This split exists because the model
originally planned for this project, Llama 3.3 70B, was retired from Groq's lineup
mid-build (see Decision-Making below) — the two-model split was the actual replacement
decision made in response, not the original plan.

**Local embeddings (`all-MiniLM-L6-v2`, bundled) over a hosted embedding API.** Tested
cold-start latency before building on it, not after: downloading the model at request
time cost ~17 seconds per genuinely cold container — unacceptable for a live demo.
Bundling the 22.6MB quantized model with the deployment and disabling remote model
downloads brought that to ~474ms, with zero runtime network dependency, which beats
what a hosted API's cold start would look like anyway. This is also why the file went
into git directly rather than gitignored — it needs to be part of the deployed
function bundle, not fetched at build or run time.

---

## 3. Decision-making

This section is the real build log, not a generalized description of what a project
like this "would" involve — every item below is something that actually happened,
with the specific evidence found and the specific fix made.

### The model this project was planned around had been retired

Before writing any Phase 3 code, the Groq API key was verified with a real request
(`GET /models`) rather than assumed to work — the same practice used for the Upstash
credentials in Phase 1/2. The key was valid, but Llama 3.3 70B, the model this project
had originally been scoped around, was no longer in Groq's lineup at all. The full
current list was: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`,
`groq/compound`/`compound-mini`, and `allam-2-7b`. Rather than a like-for-like swap for
one model, the decision was two models split by role (see Architecture above) — and
both are read from environment variables (`GROQ_MODEL_LARGE`, `GROQ_MODEL_SMALL`) with
those two IDs as defaults, not hardcoded, specifically because the lineup had already
moved once mid-build and there was no reason to assume it wouldn't again before
submission.

### A rate limit that silently corrupted data, root-caused rather than patched around

Content fetching for GitHub ingestion originally used `raw.githubusercontent.com`,
unauthenticated, on the theory that it sat entirely outside the rate-limited core API.
That CDN turned out to have its own separate, unauthenticated rate limit that
`GITHUB_TOKEN` never covered — discovered the hard way when it returned 429 for every
file of a real repo (`sindresorhus/ky`) mid-session, with no `Retry-After` header at
all, meaning there was no way to know when it would clear.

The actual damage was worse than a failed request: `ingest()` proceeded anyway.
`buildGraph([])` on zero file graphs produced an empty graph, and `persistGraph` wrote
that empty graph to Redis — silently overwriting a good 121-symbol ingest from minutes
earlier with nothing. This wasn't a hypothetical risk being defended against; it
happened, was caught, and was fixed in two layers rather than one:

1. **Guard against the symptom immediately**: if every attempted file fails,
   `ingest()` now throws a clear error instead of persisting empty data over whatever
   was there before.
2. **Fix the actual cause, not just its blast radius**: switched content fetching to
   the authenticated Git Blobs API (`GET /repos/{owner}/{repo}/git/blobs/{sha}`),
   using the blob SHA the tree listing already returns. Every file fetch now counts
   against the same authenticated 60/5000-per-hour budget `GITHUB_TOKEN` already
   covers, instead of a separate, unauthenticated, unrecoverable one.

Verified two ways before moving on, not just re-run once: re-ingested `ky` through the
real app and got back the *exact* pre-corruption numbers (53 files, 121 symbols,
119/571 calls, 21%), then re-ran the `mergeHeaders` blast-radius query and got the
identical 5-node `walkedNodes` list byte-for-byte — confirming the fix restored the
*correct* graph, not just *some* graph. Then tested against a second, deliberately
different repo (`immerjs/immer`) to get a resolution-rate data point that wasn't just
re-confirming `ky`'s specific pattern.

### Two production bugs found only by testing in the deployed environment, not local dev

Local `tsx` runs never surfaced either of these, because both depend on exactly what's
different between a full local `node_modules` and a stripped-down Vercel function
bundle.

**The WASM tree leak.** `web-tree-sitter`'s parsed `Tree` objects are backed by WASM
heap memory that JavaScript's garbage collector has no visibility into — `extract.ts`
never called `.delete()` on them. Locally this is invisible; a dev machine has enough
memory that a leak across a single ingest run never becomes a symptom. In production,
against a real 53-file repo, it pushed RSS from 99MB to 938MB during parsing *alone*,
before embedding even started — already 45% of Vercel Hobby's fixed, non-configurable
2GB memory ceiling gone to leaked WASM heap. Fixed by wrapping `extractFile`'s body in
a `try/finally` that calls `tree.delete()` unconditionally, verified via
`test:parser` to produce byte-identical output — a pure memory fix, zero behavior
change.

**The ONNX arena blowup.** Fixing the leak above dropped the parsing baseline to
117MB — and revealed a second, larger problem underneath it: the embedding step alone
pushed RSS to 2.19GB, over the 2GB ceiling, with batches of 32 symbols per Groq/ONNX
call. `onnxruntime-node`'s CPU arena allocator grows in bursts sized to the batch it's
handling and never releases that memory back to the OS — confirmed by watching RSS
climb in fixed jumps that correlated exactly with batch boundaries, not with which
specific symbols were in a given batch. Reducing `BATCH_SIZE` from 32 to 8 held peak
RSS to ~870MB for the identical `ky` ingest, with no meaningful change in total
wall-clock time (more calls, each far cheaper).

Both were found the same way: not by reading documentation about Vercel's limits and
guessing what might go wrong, but by deploying, watching a real ingest fail, and
instrumenting `process.memoryUsage()` at each pipeline stage to find exactly where the
number moved.

### A graph-layout bug that looked like the same bug twice, and wasn't

After the graph panel had been shipped and verified working on Phase 5's test cases,
a real user report came in: "What breaks if I change deepMerge?" showed an empty
panel. The obvious hypothesis — this is the same rendering-completion-delay flake
documented in Phase 5 — was checked directly rather than assumed. It wasn't: the raw
API response had fully populated `walkedNodes` (15) and `walkedEdges` (20), the DOM
had all 15 node and 20 edge elements present, console had zero errors, and — unlike
the Phase 5 case, which resolved itself moments later — it did not resolve after 30+
seconds, a manual "Fit View" click, or a window resize.

Inspecting each node's actual computed `transform` found the real cause: `deepMerge`'s
call graph contains a genuine multi-node cycle (`deepMerge → deepMergeInternal →
mergeHooks → newHookValue → deepMerge`), and the hand-rolled BFS-layering layout only
guarded against single-node self-loops, not real cycles. Its column-assignment
relaxation (`column = 1 + max(predecessor columns)`, re-queuing on increase) never
stabilizes on a genuine cycle — every lap pushes every member's column higher, so by
the time the iteration guard ran out, the cycle's nodes had been relaxed to columns in
the high thirties, translating them thousands of pixels outside the visible panel.
Capped the column value at `nodeIds.length`, since no acyclic layout ever legitimately
needs more columns than there are nodes — a no-op for every real DAG case, forcing
convergence for a cycle instead of runaway growth.

That fix was real, but a second user report on the *identical* query showed the panel
still empty. Re-investigated rather than declared fixed: node positions were now
correctly bounded, but the panel's viewport had never actually moved to look at them.
Traced into `@xyflow/react`'s own source rather than guessed at further: the `fitView`
boolean prop only fits once, at initial mount, against an empty node array (state
starts empty and the real positions land a render later) — every graph that had ever
looked correct had done so by coincidence, its layout small enough to fit inside the
panel's untouched default view by luck, not because fitting logic had ever actually
run. Switching to the imperative `fitView()` call looked like the fix, and its
returned Promise resolved `true` on every call after a genuine follow-up fix (the
library's internal `nodesInitialized` flag depends on a `measured` field distinct from
the `width`/`height` already being set) — and the viewport still never visually moved.
Whatever `fitViewport()` does internally past a resolved promise wasn't reliably
reflected in this component's rendered DOM, for a reason not worth chasing further
under real deadline pressure once a direct alternative existed: since the component
already computes every node's exact position itself, it now reads the panel's real
measured size at runtime and calls `setViewport()` directly — the same underlying call
`fitViewport()` makes internally, with none of the async queue indirection in between.
Verified live on both the previously-broken cyclic case and the previously-
coincidentally-working small case, confirming the fix generalizes rather than just
patching the one query that got reported.

### The anchor-matching gap: a real limitation, found and left as documented, not silently patched

"What breaks if I change the Ky constructor?" returned "I don't have enough
information" instead of a real answer. Checked the raw API response rather than
assumed broken: `targetSymbolHint` came back as `"Ky"` — the class, not the
constructor. `graph-traversal.ts`'s anchor resolver matches a hint against a node's
bare name in escalating tiers (exact, then case-insensitive, then substring),
returning as soon as any tier has a match. The class symbol's own name is literally
`"Ky"`, an exact match, so it wins outright before `"Ky.constructor"` — which would
only qualify at the looser substring tier — is ever considered.

This is a genuine, worth-noting scope boundary, not a bug: natural-language
descriptions of a specific class member aren't reliably resolved the way an exact
member name is. The system correctly refused to hallucinate an answer once resolution
failed (`walkedEdges` came back empty, so the UI correctly suppressed the graph panel
too) — the honest failure mode, not a silent wrong one. Documented as a known
limitation rather than rushed into a same-day fix this close to the deadline, on the
same principle every other resolution-heuristic edge case in this project was handled:
a bug that's understood and written down is a very different thing from a bug that's
hidden.

### A production timeout caused by the retry logic doing exactly the right thing

A compound question — asking for both an explanation *and* a blast radius in one
query — routes to `taskType: "both"`, firing more Groq calls in a single request than
a single-mode question. One such request hit Groq's per-minute rate limit twice in a
row: 60.5 seconds of correctly-computed wait each time (`groqChat` reads Groq's exact
reported reset time rather than guessing a backoff — the only correct way to handle a
token-bucket limit, since retrying sooner just fails again before the bucket refills).
121 seconds of legitimate waiting, alone, already exceeded the query route's
`maxDuration` of 120 seconds before a third retry was even attempted — confirmed
directly in Vercel's production logs, not inferred. The retry logic wasn't wrong; the
route's own time budget was too tight for a realistic worst case. Raised `maxDuration`
to 290 seconds, just under Vercel Hobby's actual 300-second ceiling, giving a
realistic retry sequence room to actually complete instead of being killed mid-wait.

### Closing a gap identified while writing this document

Writing the product-strategy section below surfaced a real, immediately fixable gap
rather than just a future suggestion: this tool's entire pitch rests on "the graph
panel shows what was actually walked, not a plausible-looking guess," but there was no
way for a user to spot-check that claim beyond trusting the label. Built the fix
instead of leaving it as a bullet point: graph nodes are now clickable, deep-linking to
`github.com/{owner}/{repo}/blob/{ref}/{file}#L{start}-L{end}` — landing on the exact
cited lines on the real GitHub page. Owner/repo/ref are persisted alongside the graph
at ingest time (a field the original schema didn't have); `/api/query` does a second,
read-only lookup against the same persisted graph after the agent finishes to attach
per-node file/line data to the response, entirely separate from the agent's own
internal state — no changes to routing, traversal, or compression logic. Local-directory
ingestion has no browsable URL, so the click degrades to a no-op rather than an error.

Verified live, not just that it compiles: re-ingested `ky` fresh (existing persisted
graphs predate the new field), ran the `mergeHeaders` blast radius, dispatched real
pointer events on three rendered nodes, and confirmed each constructed URL landed on
the correct file with the correct lines highlighted on the actual GitHub page.

---

## 4. Evaluation metrics used

### Call-resolution rate across five real repos

| Repo | Resolution rate | Why |
|---|---|---|
| `sample-repo` (3-file toy, hand-written) | **83%** | Every call is local — closest thing to a ceiling for this heuristic resolver. |
| `class-validator` (297 symbols, full repo, real Vercel run) | **56%** | Real repo, barrel/re-export-heavy; the earlier 80-file sample measured 69% — the gap is fully explained by broader coverage on the full run, not anything resolving incorrectly. |
| `immerjs/immer` (46 files) | **12% raw / 33% source-only** | 27 of 46 files are tests; test-runner/assertion calls (`test()`, `expect()`) are external by nature and dominate the raw number. Isolating the 19 non-test source files: 450 calls, 150 resolved — 33%, supporting the "internal logic resolves better" hypothesis once test noise is separated out. |
| `sindresorhus/ky` (53 files) | **21%** | External-API-heavy by nature — DOM/fetch (`Headers`, `AbortController`, `Response`) are external by construction, unresolvable regardless of resolver quality. |
| `typestack/class-transformer` (71 files) | **11%** | Metadata-reflection-driven (`reflect-metadata`) rather than direct function calls — the *mechanism* connecting code paths often isn't a literal call expression, so there's structurally less for a call-graph resolver to find, not just more noise to filter. |

Read together: resolution rate isn't a quality score for the resolver, it's a
reflection of how much of a given repo's real control flow is expressed as direct,
literal function calls versus externals, reflection, or generics-heavy code the
project was always explicit about not solving.

### Router classification accuracy

8 hand-written questions spanning structural/semantic/both, tested standalone before
wiring anything else around the router: **7/8 on the first pass** — one genuine
borderline miss ("walk me through everything bootstrap touches" landed semantic
instead of both). Not silently accepted: the system prompt was tightened with two more
structural-signal phrases and re-run clean at **8/8**. Re-confirmed 8/8 again in this
session's final check, unchanged.

### Token compression, real percentages including the honest zero cases

- `sample-repo` (7 symbols): **0%** — genuinely nothing worth compressing; the result
  sets fit entirely within the verbatim caps. Reported as 0%, not rounded away.
- Real `class-validator` ingest, `compress.ts` unit test: **52% reduction**
  (5015 → 2423 tokens) on a 112-node `ValidateBy` blast radius.
- Same case, re-run through the full orchestrated `agent/graph.ts` (not a hand-called
  pipeline): **53% reduction** (5031 → 2364 tokens).
- `ky`'s first three real queries: **0%**, honestly — their result sets (5, 8, 9
  nodes) fit within the verbatim caps. A more central symbol (`validateAndMerge`, a
  10-node blast radius) produced a real **32% reduction** (2156 → 1476 tokens),
  confirming the mechanism scales on that repo too, once a query's context is large
  enough to need it.

### Production verification matching local baselines exactly

Every ingest and query re-run against the live Vercel deployment, across multiple
redeploys this session, returned numbers identical to the local/CLI baseline:
`ky` — 53 files, 121 symbols, 119/571 calls resolved (21%), and the `mergeHeaders`
blast radius as the identical 5-node graph, byte-for-byte, every time. This is the
concrete evidence that the deployment-infrastructure bugs found and fixed in Phase 6
(file tracing, memory, layout, timeout) were genuinely infrastructure issues — the
underlying parsing, graph-building, and retrieval pipeline never produced a different
answer between local and deployed environments.

---

## 5. Product strategy

> **DRAFT — NEEDS PERSONAL REVIEW.** The assignment asks for these in my own voice,
> not generated prose. What follows is a grounded first pass — real findings from this
> build, not invented — meant as a starting point to edit, cut, and make sound like me
> before submitting, not as final text.

### 3A — What I'd add next

**Ingest the README/docs, not just code symbols.** Tested directly this session:
"What is this repo about?" on `ky` actually worked better than expected — the vector
index has no repo-level summary, only individual function/class chunks, so I expected
a weak answer, but the LLM synthesized a coherent one from several retrieved code
chunks. It would be meaningfully better with an actual indexed source of truth. A
repo's README, architecture docs, and top-level module comments are exactly the kind
of "what is this thing for" signal that individual function bodies don't carry, and
right now none of that is embedded at all. This is the single highest-leverage gap:
"explain this repo" and "explain this subsystem" questions are common and currently
under-served by an index built entirely from function/class-level chunks.

**Close the anchor-matching gap for natural-language member references.** Documented
above as a known limitation, not fixed under deadline: "the Ky constructor" resolves
to the class, not the constructor, because the resolver's exact-match tier stops as
soon as the bare class name matches. A real fix isn't hard to scope: when a hint like
"constructor" or a method-shaped phrase co-occurs with a class name already in the
graph, prefer the qualified member (`Ky.constructor`) over the bare class before
falling through to substring matching. This is a small, well-understood, low-risk
change — flagged here specifically because it's exactly the shape of gap worth fixing
in a follow-up, not a same-day rush.

**An "LLM Wiki" browsing mode.**

> [DRAFT — REVIEW BEFORE SUBMITTING] Written in first person as raw notes, not
> polished copy — needs a real pass before this goes out.

This is Andrej Karpathy's "LLM Wiki" idea — instead of re-deriving an answer from
scratch on every single query the way plain RAG (and honestly, the way Ripple itself)
does, the LLM incrementally builds and maintains an actual persistent, structured
knowledge base from the source material. Ingest, query, and — the part that makes it
more than a cache — lint: go back and check whether what it wrote is still true.

Why I think this fits *this* project specifically and isn't just a generic "add a
wiki" idea bolted on: Ripple already has the hard part done. It has a real
relationship graph, not just embeddings — that's the whole pitch of the project. What
it doesn't have is anything that *aggregates* across that graph into a narrative. Ask
it "how does auth flow through this app" and it'll walk whatever nodes the router
decides are relevant to that one question, then throw the answer away. Ask basically
the same question tomorrow and it does the exact same work again from zero. A wiki
layer sitting on top of the graph could synthesize a "how does auth flow through this
app" *page* once, and then just serve it — the graph traversal is the thing that makes
that page trustworthy in the first place, other tools don't have that relationship
data to build the page from honestly.

The mechanism I keep coming back to for why this is actually buildable and not just a
nice idea: every answer this project produces already carries `path:line` citations.
A wiki page built the same way would carry the same citations. Which means the
staleness check — the "lint" part — is almost free to add on top of the ingestion
pipeline that already exists: when a repo gets re-ingested, diff each wiki page's
cited line ranges against the new parse, and flag the page as stale if they moved.
Right now there is *nothing* in this system that tells you "hey, this answer I gave
you three ingests ago doesn't hold anymore" — that's a real, concrete gap, and I think
it's the kind of gap that matters a lot once you imagine someone actually relying on
this day to day instead of asking it one question and closing the tab.

Honest note on why this isn't built: I didn't build it, on purpose. A new pipeline
stage — persistent wiki storage, a synthesis step, a lint/staleness job — is a lot of
new surface area to introduce this close to a deadline, and the risk of destabilizing
a working, fully-tested submission for a feature that wouldn't even be fully tested
itself felt like the wrong trade. What I'd actually do first, before the full wiki, is
the much smaller version of the same underlying gap: parse and embed the repo's own
README and `package.json` as retrievable chunks alongside the function/class chunks
that already get embedded. That directly fixes something I found while testing this
session — "what is this repo about" currently has to be answered entirely from
function-level code chunks, with no author-written summary anywhere in the index, and
it works better than I expected but it's clearly missing the obvious source of truth.
That's a same-day-sized change and the natural first step toward the bigger wiki idea,
not a separate thing.

### 3B — UI issues in this category of tool

**Large-graph legibility.** The hand-rolled BFS-layer layout works and is now
correctly fitted to the viewport (see the deploy bug write-up above), but a 100+-node
blast radius (the real `ValidateBy` case) is still a wall of small boxes at a
necessarily tiny zoom level — technically correct, not actually readable at a glance.
Tools in this category generally under-invest in "what does the user actually look at
first" for a large result set; some kind of default clustering, collapsing, or
progressive-disclosure ("show me the direct callers first, expand for more") would
matter more than further layout-algorithm polish.

**The compression number needs to explain itself, not just report itself.** The
token-compression card shows a real, honest before/after number — including the
honest 0% cases — but doesn't currently explain *why* a given query compressed by 0%
or 50%. A one-line "nothing here needed summarizing" vs. "12 of 112 nodes kept
verbatim, the rest summarized" distinction would turn a number into something a user
actually trusts and understands the mechanics of, rather than a bare stat.

---

## Links

- **Live app:** https://projectog.vercel.app
- **Repository:** https://github.com/Dhvani-DSML/Project_Og
