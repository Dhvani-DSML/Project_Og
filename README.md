# GraphRAG — multi-hop code intelligence agent

## Context for whoever (human or Claude Code) picks this up

This is a take-home project with a hard deadline: **submission due August 19, 2026.**
Today is August 17. That means roughly two focused days of work remain, and this
document exists so an agentic coding session can pick up exactly where a human
strategy/scaffolding session left off, without re-deriving any of the decisions
below. Read this whole file before writing code. Where a decision was already
made and justified, don't re-litigate it unless something below is provably wrong
once you're in the code.

**Do not start from scratch.** `src/parser/` already contains working, tested code.
Run `npm run test:parser` first to see it succeed before changing anything in that
directory.

---

## What this actually is (plain language)

Every AI coding tool has to decide what slice of a codebase to show the model,
because you can't hand it the whole repo. Most tools do this by finding text that
*sounds* similar to your question — which misses things that are *connected* to
the answer but don't share vocabulary (a config file, a caller three functions
away, an import three files over).

This project builds a small, honest version of a better approach: it parses a
repo into an actual map of which functions call which, which files import which —
then answers questions by combining that relationship map with normal meaning-based
search, compresses everything down to only what's relevant, and shows the user
exactly which parts of the map it walked to produce the answer.

The flagship capability this unlocks, that plain RAG cannot do: **"what breaks if
I change this function?"** — answered by walking the actual call graph backwards,
not by guessing from text similarity.

---

## Current status — what's already built and verified

Located in `src/parser/`:

- **`extract.ts`** — Uses `web-tree-sitter` (WASM, via the `tree-sitter-wasms`
  prebuilt grammar bundle — no native compilation needed) to parse a single
  TypeScript/JavaScript file and extract:
  - Symbols: top-level `function`, `class` (+ its methods), and
    `const x = () => {}` declarations, each with file, line range, and whether
    it's exported.
  - Import bindings (local name → raw import path).
  - Raw (unresolved) call expressions inside each symbol's body.

- **`graph.ts`** — Takes the parsed output from *all* files in a repo and
  resolves cross-file calls into a real graph (`graphology`, directed,
  in-memory). Resolution strategy, in order:
  1. Exact match via import path resolution (handles `./relative/paths`).
  2. Same-file symbol match.
  3. Fallback: unique exported symbol with that name anywhere in the repo
     (handles path aliases / barrel files loosely).
  Unresolved calls are dropped rather than added as dangling nodes.

- **`test-parse.ts`** — Runs both of the above against `sample-repo/` (3 files,
  a deliberate `server.ts → db.ts → config.ts` call chain) and proves two things
  that matter for the whole pitch of this project:
  - Multi-hop forward traversal ("what does `startServer` transitively call?")
  - Multi-hop backward traversal / blast radius ("what breaks if `loadConfig`
    changes?")
  Both work correctly across 3 files. Last run: 7 symbols found, 83% of raw
  calls resolved.

**Known, already-discovered limitation (keep this, don't silently "fix" it away
without flagging it in the final write-up):** method calls through an instance
variable (`pool.open()`) don't resolve, because that requires knowing `pool`'s
type, which needs real type inference, not name matching. This is the documented
boundary between "heuristic resolution" (what this project does) and
"LSP-level semantic analysis" (what a production version would need). It's a
selling point in the write-up, not a bug to hide.

**Not yet built:** everything past parsing — embeddings/vector search, the
LangGraph agent, the API layer, the frontend, and deployment. That's the rest
of this document.

---

## Real-repo parsing gaps

Before building `ingest.ts`, `extract.ts` + `graph.ts` were run against three
real open-source TS repos (not just the 3-file `sample-repo`), each picked to
stress a different pattern: [zod](https://github.com/colinhacks/zod) (heavy
`interface`/`type`/generics, abstract base classes), [class-validator]
(https://github.com/typestack/class-validator) (decorator-based API, built
almost entirely out of barrel re-exports), and
[date-fns](https://github.com/date-fns/date-fns) (modern ESM-style imports
with explicit `.ts` extensions, one-function-per-folder + fan-out barrel
index). Each finding below was triaged individually: fixed, or documented as
a deliberate scope limitation the same way the instance-method-call gap
already was.

**Fixed:**
1. Relative imports written with an explicit extension (`from "./foo.ts"`,
   required under NodeNext/ESM resolution — date-fns's entire source is
   written this way) silently broke exact-path call resolution, because
   `resolveImportPath` never stripped the extension before comparing against
   an extension-stripped candidate file path. Masked in casual testing by the
   "unique exported symbol" fallback; isolated with a same-named-symbol-in-
   two-files repro, which went from 0% to 100% resolved once fixed. Fixed in
   `resolveImportPath` (`graph.ts`).
2. `abstract class` declarations parse as a distinct `abstract_class_declaration`
   node in the tree-sitter grammar, not `class_declaration` — the extractor's
   class-handling branch didn't match it, so an abstract class and everything
   in it (methods, calls) was silently dropped. Real impact: zod's `ZodType`,
   the abstract base class nearly everything else in the library extends, was
   invisible. Fixed in `extractFile` (`extract.ts`).

**Documented as known limitations (deliberate scope calls, not fixed):**
3. `interface`/`type` declarations are never extracted as symbols. This
   project's graph is a *call* graph, not a type graph, and "what breaks if I
   change this function" doesn't need interface nodes — but it's worth being
   explicit that this is a scope cut, not an oversight, given how common they
   are in real TS (500+ occurrences in zod's own source alone).
4. `namespace Foo { ... }` blocks (`internal_module` in the grammar) aren't
   traversed into, so anything declared inside one — including real functions
   with real calls — is invisible. Confirmed concretely, not just
   theoretically: zod's `errorUtil.ts` defines two functions entirely inside
   `export namespace errorUtil { ... }`, both silently dropped. Uncommon (4/1/0
   occurrences across the three repos tested), so left undone rather than
   generalizing symbol extraction to be recursive under deadline pressure.

**Confirmed already working, no change needed:**
5. Barrel/re-export files (`export * from "./x"`, `export { x as default }`)
   correctly produce zero symbols of their own and don't crash the parser.
   Calls made through a barrel import already resolve via the existing
   "unique exported symbol by name" fallback in `graph.ts` — confirmed
   against class-validator, which routes essentially every export through
   exactly this pattern.
6. Decorators (`@Injectable()`, `@Column()`, etc.) don't break
   `class_declaration` parsing. Neither class-validator nor class-transformer
   actually uses decorators in its *own* source (they're decorator-providing
   libraries, not consumers of them), so this was confirmed with a small
   synthetic decorated-class snippet instead of real-repo evidence.

**Context — real-world resolution rates:** `sample-repo` resolves 83% of
calls. Real repos are lower: zod ~43%, class-validator ~69% (both over their
first 80 non-test source files) — expected, since real code calls into
external packages, builtins, and generics-heavy code the heuristic resolver
was never meant to catch. This is a baseline for what `ingest.ts` should
expect, not a regression to chase down.

**Full-pipeline validation (not just extract.ts/graph.ts in isolation):**
everything above was found by calling `extractFile`/`buildGraph` directly
against locally-cloned repos, before `ingest.ts` existed. Before Phase 3
started, `ingest.ts` itself was run end-to-end against a real GitHub repo for
the first time — `npm run ingest -- typestack/class-validator`, the actual
production path: GitHub tree listing, per-file fetch from
`raw.githubusercontent.com`, parse, build graph, persist to Upstash Redis,
chunk + embed, upsert to Upstash Vector. All 178 real source files (not a
truncated sample this time — no test-directory exclusion either, unlike the
earlier gap-hunting script), 297 symbols, **zero extraction errors**. Graph
persisted to Redis at 146KB (nowhere near any payload limit). All 297
chunks embedded and landed in Upstash Vector's own isolated namespace,
confirmed via `/info` (`vectorCount: 297`, fully indexed).

Resolution rate came back lower than the earlier 80-file sample (56% vs.
69%) — checked *why* rather than assuming it's fine: of the 301 unresolved
calls, **zero** trace to an actual ambiguous-name collision (the one real
known gap in the fallback resolver); every single one targets a name that
doesn't exist anywhere in the repo at all (external packages, builtins,
test-framework calls like `expect`/`describe`). The lower number is fully
explained by broader real coverage — this run, unlike the original
gap-hunting script, didn't skip test files or truncate at 80 — not by
anything resolving incorrectly. This is a validation finding, not a new bug:
the full production pipeline, not just the parser, has now actually seen
messy real-world code before Phase 3's agent gets built on top of what it
produces.

---

## Full pipeline (target architecture)

```
                    ┌─────────────────────────────┐
                    │   ONE-TIME: repo ingestion   │
                    │                              │
   GitHub repo URL →│  walk files → tree-sitter    │
                    │  parse → build call graph     │
                    │  (done, see src/parser/)      │
                    │       +                       │
                    │  chunk by symbol → embed      │
                    │  → store in vector index       │
                    │  (NOT YET BUILT)               │
                    └──────────────┬───────────────┘
                                   │ stored (Upstash Redis for graph,
                                   │ Upstash Vector for embeddings)
                                   ▼
                    ┌─────────────────────────────┐
                    │   PER QUERY: LangGraph agent │
                    │                              │
   user question  → │  1. Router: structural vs     │
                    │     semantic vs both          │
                    │  2a. Graph traversal node      │
                    │      (N-hop, shortest path,    │
                    │       or reverse/"blast radius")│
                    │  2b. Vector retrieval node      │
                    │      (hybrid: embeddings + BM25)│
                    │  3. Merge + compress node        │
                    │     (verbatim for high-relevance,│
                    │      summarized for the rest;    │
                    │      logs token count before/    │
                    │      after)                       │
                    │  4. Answerer node                  │
                    │     (grounded answer + citations   │
                    │      + list of graph nodes walked) │
                    └──────────────┬───────────────┘
                                   ▼
                    Next.js chat UI + graph visualization
                    panel highlighting the walked subgraph
```

---

## Tech stack (decided — don't relitigate without a strong reason)

All chosen to be free/open-source-first and to deploy as a **single Vercel
project**, avoiding a separate hosted backend.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router), TypeScript | One deploy target, serverless API routes |
| Agent orchestration | `@langchain/langgraph` (JS) | Conditional routing + loops, not just a fixed chain |
| Code parsing | `web-tree-sitter` + `tree-sitter-wasms` | Already working, no native build step |
| Graph storage | `graphology`, serialized to **Upstash Redis** (free tier, REST-based) | Rebuild in-memory per invocation; no infra to manage |
| Embeddings | `@xenova/transformers` (`all-MiniLM-L6-v2`), running in-process, **model weights bundled with the deployment** (not downloaded at runtime) | Zero API cost, genuinely open source, verified fast enough once bundled — see "Embedding model cold-start" below |
| Vector store | **Upstash Vector** (free tier, REST API) | Built for exactly this serverless pattern |
| LLM | Groq free tier — **`openai/gpt-oss-120b`** (compress/answer) + **`openai/gpt-oss-20b`** (router) | Open-weight, free access, fast enough for a live demo — see "LLM model choice" below for why this changed from the original Llama 3.3 70B pick and why it's split into two models |
| Graph visualization | `react-flow` or `vis-network` | Render the walked subgraph next to the answer |
| Deployment | Vercel | Required by the assignment |

Repo scope: **TypeScript/JavaScript only.** This is a deliberate scope cut to
keep tree-sitter grammar handling simple within the deadline — say so plainly
in the write-up, don't pretend it's multi-language.

---

## LLM model choice (Llama 3.3 70B is gone from Groq)

Before writing any Phase 3 code against it, the Groq API key was verified
with a real request (`GET /models`) rather than assumed to work — same
practice as the Upstash credentials in Phase 1/2. The key is valid, but
**Llama 3.3 70B, the model this README originally named, is no longer in
Groq's lineup at all.** Full current text-generation model list: `openai/
gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`, `groq/compound` /
`compound-mini` (Groq's own agentic wrapper, not a plain chat model), and
`allam-2-7b` (Arabic-focused, 4k context). Groq's lineup changed at least
once already during this build's window — no reason to assume it won't
again before submission.

**Decision:** two models, not a like-for-like swap for one:
- **`openai/gpt-oss-120b`** for `compress.ts` and `answer.ts` — the
  "large capable model" role Llama 3.3 70B was filling, chosen for quality:
  these nodes run once per query and their output is the actual grounded
  answer, so it's worth the extra weight.
- **`openai/gpt-oss-20b`** for `router.ts` — the classification call runs on
  *every* query before anything else happens, so latency matters more than
  raw capability there; a 20b model is plenty for a 3-way structural/
  semantic/both classification.

Both are read from environment variables with these two model IDs as
defaults (`GROQ_MODEL_LARGE`, `GROQ_MODEL_SMALL` — see "Environment
variables needed"), not hardcoded in the node files, precisely because the
lineup has already moved once.

---

## Embedding model cold-start (tested before building on it)

The README previously flagged cold-start latency for `@xenova/transformers`
running inside a Vercel serverless function as a real risk, not a
hypothetical — this was tested in isolation, before writing any of the rest
of Phase 2, per the working agreement not to build on unverified assumptions.

Two scenarios, both against `Xenova/all-MiniLM-L6-v2` (quantized ONNX, the
library's default):

| Scenario | import | model load/init | first embed | **total** |
|---|---|---|---|---|
| Cold — no local cache, downloads from HF hub | 2,457ms | 14,554ms | 11ms | **~17,000ms** |
| Warm disk, fresh process, network disabled | 251ms | 212ms | 12ms | **~474ms** |

The model itself isn't slow — WASM init plus inference off local disk is
under half a second, and a second `embed()` call in the same warm process
took 5ms (relevant for batching hundreds of symbols per repo). The 17-second
number only happens when the model has to be **downloaded over the network
at request time**, which is what `transformers.js`'s default runtime
download-and-cache behavior would do on every genuinely cold Vercel
container — `/tmp` doesn't reliably survive between cold starts, so this
isn't a one-time cost, it recurs for real users.

The on-disk model (quantized ONNX weights + tokenizer) is 22.6MB — small
enough to bundle directly into the function deployment.

**Decision:** keep the local model (don't switch to a hosted embedding API),
but bundle the weights with the deployment and set `allowRemoteModels: false`
so cold starts read from local disk instead of the network. That's the
~474ms row above on every cold start, with zero runtime network dependency —
better than a hosted API's cold start would be anyway.

---

## Environment variables needed

```
GROQ_API_KEY=                 # configured, see .env.local (gitignored)
GROQ_MODEL_LARGE=openai/gpt-oss-120b   # default if unset -- see "LLM model choice"
GROQ_MODEL_SMALL=openai/gpt-oss-20b    # default if unset -- see "LLM model choice"
UPSTASH_VECTOR_REST_URL=      # configured, see .env.local (gitignored)
UPSTASH_VECTOR_REST_TOKEN=    # configured, see .env.local (gitignored)
UPSTASH_REDIS_REST_URL=       # configured, see .env (gitignored)
UPSTASH_REDIS_REST_TOKEN=     # configured, see .env (gitignored)
GITHUB_TOKEN=       # optional, raises the unauthenticated rate limit for public repo ingestion
```

Upstash Redis, Upstash Vector, and Groq are all configured and verified
working (real round-trip write/read for each Upstash service; Groq checked
with a real `/models` request — see Phase 1/2 checklists and "LLM model
choice"). Only `GITHUB_TOKEN` remains unset — optional, not required to
proceed. `GROQ_MODEL_LARGE`/`GROQ_MODEL_SMALL` are read with the listed
defaults if unset, not required to be set explicitly.

---

## Directory structure (target — extend what exists, don't restructure it)

```
graphrag/
  src/
    parser/
      extract.ts          # done
      graph.ts             # done
      test-parse.ts         # done
      ingest.ts              # done: walk a whole repo dir / fetch from GitHub, call extract.ts per file
      graph-store.ts          # done: persistGraph/loadGraph, Upstash Redis, keyed by hash(repoKey)
    embeddings/
      fetch-model.ts          # done: one-time download of bundled model weights
      models/                  # done: bundled all-MiniLM-L6-v2 weights (22.6MB, gitted)
      embed.ts                  # done: AST-aware chunking (reuses extract.ts line ranges) + batched embed
      vector-store.ts          # done: Upstash Vector read/write, namespaced per repo
    agent/
      state.ts                  # NEW: LangGraph state type
      nodes/
        router.ts                # NEW
        graph-traversal.ts        # NEW
        vector-retrieval.ts       # NEW
        compress.ts                # NEW
        answer.ts                   # NEW
      graph.ts                      # NEW: wires nodes into the LangGraph StateGraph
    app/                             # Next.js App Router
      page.tsx                       # chat UI
      api/
        ingest/route.ts               # POST: repo URL -> parse + embed + store
        query/route.ts                 # POST: question -> run agent -> answer
    components/
      ChatPanel.tsx
      GraphVisualization.tsx
  sample-repo/                          # done, keep for regression testing
  README.md                              # this file
```

---

## Build plan (phased — do them roughly in this order)

### Phase 1 — whole-repo ingestion (extend, don't rewrite, the parser)
- [x] Re-run against 2-3 *real* small-to-medium open source TS repos (not just
      the 3-file sample) to catch parsing edge cases the sample repo doesn't
      cover — done *before* `ingest.ts` itself, on request, so its fixes would
      already be in place for real ingestion. See "Real-repo parsing gaps"
      above.
- [x] `ingest.ts`: given a local directory or a GitHub repo URL/`owner/repo`
      shorthand, list all `.ts`/`.tsx`/`.js`/`.jsx` files, run `extractFile`
      on each, pass all `FileGraph`s into `buildGraph`. Local directories are
      walked directly; GitHub repos use one REST API call
      (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`) to list files
      — this keeps the rate-limited core API budget to O(1) calls regardless
      of repo size — then fetch each file's content from
      `raw.githubusercontent.com`, which sits outside that rate limit, capped
      at 8 concurrent requests. `GITHUB_TOKEN` is read from the environment
      if present (60 → 5000 req/hour) but isn't required for public repos.
      Run it with `npm run ingest -- <local-dir | github-url | owner/repo>`.
      Smoke-tested against `sample-repo` (matches the known-good 7
      symbols/83%) and against a real GitHub repo
      (`sindresorhus/p-timeout`, both shorthand and full-URL / `/tree/ref`
      forms) to prove the fetch path, not just the local one.
- [x] Serialize the resulting graph to Upstash Redis, keyed by a hash of the
      repo URL. Lives in `src/parser/graph-store.ts` (`persistGraph` /
      `loadGraph`), called automatically at the end of `ingest()`. Redis key
      is `graphrag:graph:<sha256(repoKey)>`; value is the repoKey, stats, and
      graphology's own `graph.export()` output as JSON, reconstructed on load
      via `graph.import(...)`. No-ops with a warning instead of throwing when
      `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` aren't set, so
      ingestion still works end-to-end without Redis. Credentials now
      configured (in `.env`, gitignored). Verified as a real round trip, not
      just a write: ingested `sample-repo`, then loaded it back in a separate
      process and confirmed the reconstructed graph still traverses correctly
      (`startServer` → `connectDB`), with node/edge counts matching the
      original build (7 nodes, 5 edges).

### Phase 2 — semantic half
- [x] Verify `@xenova/transformers` cold-start before building on it — done
      first, see "Embedding model cold-start" above. Decision: bundle the
      model weights rather than switch to a hosted API.
- [x] `embed.ts`: for each symbol node already extracted, take its source text
      (the actual function/class body, sliced by line range) as the chunk —
      this reuses the AST-aware boundaries from Phase 0, avoiding the
      "naive fixed-size chunking" failure mode described in the project's
      own pitch. Embed with `all-MiniLM-L6-v2`, batched (32 chunks/call)
      rather than one symbol at a time. `ingest.ts` now threads a
      `sources: Map<file, text>` through its result so `embed.ts` can slice
      exact line ranges without re-reading local files or re-fetching GitHub
      content. Verified against `sample-repo`: all 7 chunks' sliced text
      matches the symbol boundaries exactly (including a class body vs. its
      one method sliced separately), 384-dim embeddings, ~500ms for the
      whole batch including model init.

      **Follow-up on the cosine-similarity caveat above, fixed before any
      writes to Upstash Vector** (changing this after would have meant
      re-embedding everything already stored): each chunk now gets a short
      context header — symbol kind, name (which already folds in the
      enclosing class for methods, e.g. `ConnectionPool.open`), and file path
      — prepended to its code before embedding (`SymbolChunk.embeddingText`,
      kept separate from `.text` so citations/display still show the raw
      code, not the synthetic header). Re-measured on the same three
      symbols: `cos(loadConfig, validateConfig)` went from 0.508 to **0.622**,
      while the unrelated pairs dropped to **0.584** (`startServer`) and
      **0.484** (`ConnectionPool.open`) — a real, measurable improvement in
      separation, not just noise.

      Worth being honest about what this is and isn't: the gap is still
      modest (0.622 vs. 0.584), not dramatic. That's not a bug to keep
      chasing — it's a found example of exactly the limitation this whole
      project is built around. Semantic embeddings on short, boilerplate-y
      code genuinely struggle to differentiate meaning from a handful of
      lines of near-identical shape, no matter how the text is framed. That
      is precisely *why* the graph traversal path exists as a complementary
      signal alongside vector search, not a redundant one — the project's
      pitch (see "What this actually is") is that relationship-walking
      catches what text similarity misses, and this is a concrete,
      measured instance of that, not a hypothetical one anymore.
- [x] `vector-store.ts`: write embeddings to Upstash Vector with metadata
      (symbol id, file, line range, name, kind, exported, raw code text
      capped at 4000 chars). Namespaced per repo (hash of repoKey) so
      multiple ingested repos share one index without their nearest-neighbor
      results bleeding into each other. Batched upserts (100/call). Before
      any write: fetches `/info` and refuses to proceed if the index isn't
      actually 384-dim cosine similarity — confirmed against the real index
      (`wondrous-fox-1124`) before writing anything, not assumed. Implements
      top-k query. `upsertChunks`/`queryVectors` now wired into `ingest()`
      automatically, same as graph persistence.

      Verified end-to-end against `sample-repo`: querying with `loadConfig`'s
      own embedding returns itself at score 1.0, with `connectDB` (0.837) and
      `validateConfig` (0.811) — the two functions that actually call/relate
      to it — ranked above the unrelated `startServer`/`bootstrap` in a
      second query, confirming the context-header fix above produces
      coherent real rankings, not just better isolated cosine numbers.

      One honest finding, not a code bug: the very first query immediately
      after the first-ever upsert to a fresh namespace came back empty —
      Upstash Vector has some indexing propagation delay before a write is
      queryable. Resolved on its own moments later and hasn't recurred.
      Not fixed with a retry/poll loop here because the real pipeline never
      queries in the same breath as ingesting (ingest is one-time,
      querying happens per chat message later) — but worth remembering if
      Phase 4's UI ever offers "ingest, then immediately ask a question."

### Phase 3 — LangGraph agent
- [x] `state.ts`: `{ query, taskType, graphResults, vectorResults, compressedContext, tokenStats, answer, citations, walkedNodes }`
      plus two additions the original list above provably needed:
      `repoKey` (no node can know which Redis graph or Vector namespace to
      load without it — the original state type never named which repo it's
      even operating on) and `targetSymbolHint` + `fallbackAttempted` (needed
      by router.ts and the conditional loop in `agent/graph.ts`, see below).
      Built on `Annotation.Root` with real per-field reducers, not a plain
      object type — `walkedNodes` in particular accumulates
      (dedup-union) across nodes instead of last-write-wins, since the
      fan-out ("both") and fallback-loop cases both have more than one node
      contribute to it in the same run, and Phase 5's graph visualization
      depends entirely on this list being real and complete.
- [x] `router.ts`: classify the question (structural / semantic / both) using
      a cheap LLM call (`openai/gpt-oss-20b`) with a system prompt, plus
      extracts a best-guess target symbol name from the query for
      `graph-traversal.ts` to anchor on. **Tested standalone before wiring
      anything else around it** (`npm run test:router`, 8 hand-written
      questions spanning structural/semantic/both): 7/8 on the first pass,
      one genuine borderline miss ("walk me through everything bootstrap
      touches" landed semantic instead of both) — not silently accepted,
      the system prompt was tightened with a couple more structural-signal
      phrases ("everything X touches", "walk me through what X uses") and
      re-run clean at 8/8. Kept as a real committed test
      (`src/agent/nodes/test-router.ts`), not thrown away after passing.
- [x] `graph-traversal.ts`: implements all three planned modes. `traverseGraph`
      resolves `router.ts`'s target-symbol hint to actual node ids (exact ->
      case-insensitive -> substring, same escalating-heuristic shape as
      `graph.ts`'s import resolver) and walks **both** forward (transitively
      calls) and reverse ("blast radius") from there — a deliberate choice,
      not an oversight: the router doesn't extract a direction, and running
      both is cheap versus guessing wrong on the project's own flagship
      question. `shortestPath` between two named symbols is implemented and
      tested, but not currently wired into `agent/graph.ts` — the router
      extracts one target symbol per query, not two, so nothing currently
      calls it with two names. Noted here rather than silently dropped or
      overclaimed as wired in.

      Tested against `sample-repo`'s known graph before wiring anything
      around it (`npm run test:retrieval`) and found a real, concrete case
      for instruction #3's conditional loop, not a theoretical one: `loadConfig`'s
      reverse walk at the default `hopDepth=2` correctly finds `connectDB` and
      its two callers, but misses `bootstrap` at hop 3 — the BFS frontier was
      still non-empty when traversal stopped. This is exactly what
      `agent/graph.ts`'s fallback loop (below) checks for and retries once.
- [x] `vector-retrieval.ts`: top-k semantic search against Upstash Vector via
      `embedQuery` + `queryVectors`. Also defines `isLowConfidence` for the
      fallback loop. Threshold tuned twice, not guessed once: started at 0.45
      from sample-repo's related-vs-unrelated numbers, but testing a
      genuinely nonsense query ("recipe for chocolate cake") against the
      same repo scored 0.49-0.54 — indistinguishable at that threshold from
      real unrelated-but-in-domain pairs. MiniLM's mean-pooled embeddings
      don't have a clean floor near zero for "totally unrelated," so no
      threshold perfectly separates "unrelated" from "nonsense" by absolute
      score. Raised to 0.55, which does cleanly separate real related
      queries (0.66-0.76 measured) from both — accepting that some
      weak-but-real semantic queries will also trip the fallback loop as a
      false positive, an acceptable tradeoff since trying the graph path
      costs only latency, not correctness.
- [x] `compress.ts`: merges graph + vector results (deduped by id, graph
      results hydrated with real code text from Vector via `fetchChunks` --
      the persisted graph itself only stores symbol metadata, not source),
      keeps top-relevance chunks verbatim, summarizes the rest, and logs
      real before/after token counts (`tokenStats`) — not a placeholder.
      Tested against both `sample-repo` and the real 297-symbol
      class-validator ingest (`npm run test:compress-answer`) before wiring
      into `agent/graph.ts`, and both tests caught real bugs the first pass
      had, not just confirmed it worked:
      - **Negative compression on tiny code.** First pass showed
        `reductionPercent: -1` on sample-repo — summarizing a 1-3 line
        function produced a summary *longer* than the code. Added a
        too-small-to-summarize floor; first guess (15 tokens) still went
        negative (-5%), because a real LLM "concise one sentence" runs
        ~40-60+ characters on its own. Raised to 40 based on that actual
        measurement. sample-repo now correctly shows 0% (nothing there is
        worth compressing — an honest result, not a failure to force a
        number).
      - **Real scaling bug, not a demo-only edge case.** `ValidateBy`'s
        blast radius on the real repo reached 112 graph nodes. Cramming
        every non-verbatim one into a single summarization prompt blew
        Groq's 8000 TPM limit (11,375 tokens requested in one call).
        Fixed with two changes: cap total candidates considered to 40
        before splitting verbatim/summarize (a 112-node blast radius is
        more raw material than any answer needs anyway), and batch the
        summarization calls themselves (10 symbols/call, sequential) —
        same batching principle already applied to embedding and
        upserting, just not yet to this LLM call.
      - Even after batching, `answer.ts`'s own single context call still
        hit a 429 against the shared per-minute budget (compress.ts's
        batches had already used most of it). Rather than shrinking
        context further to make the problem stop showing up in testing,
        added real retry logic to `groq.ts` (`groqChat`): reads Groq's
        `x-ratelimit-reset-tokens` header for the exact wait time and
        retries, up to 3 times — the correct handling for an expected,
        recoverable free-tier constraint. Confirmed working: hit the
        limit again on re-test, waited the reported 49.7s, retried, and
        completed successfully with a fully-grounded answer. Final
        measured result on the real repo: **5015 → 2423 tokens, 52%
        reduction** — the actual headline number, not a placeholder.
- [x] `answer.ts`: final grounded answer via `openai/gpt-oss-120b`, with
      file/line citations. Citations are filtered to symbols the model
      actually cited inline (`[file.ts::name]` appearing in the answer
      text), not just everything that was available as context — a real
      precision filter, not "return everything we had." Verified on the
      real repo: correctly traced `IsDefined` → `ValidateBy` and explained
      the blast radius of changing `ValidateBy` across every decorator
      built on it, grounded in real code snippets with correct citations.
- [ ] `agent/graph.ts`: wire these into an actual `StateGraph` with conditional
      edges — this is what makes it a LangGraph project rather than a fixed
      pipeline; don't flatten it into a plain function-call chain for
      convenience.

### Phase 4 — API + UI
- [ ] `/api/ingest`: accepts a repo URL, runs Phase 1 + 2, returns a status.
- [ ] `/api/query`: accepts `{ repoId, question }`, runs the agent, returns
      `{ answer, citations, walkedNodes, tokenStats }`.
- [ ] Chat UI: input for repo URL, ingestion status, chat interface, and a
      persistent panel showing the last query's token-savings stat
      ("48,203 → 8,912 tokens, 81% reduction") — this is the single most
      demo-friendly number in the whole project, give it real visual weight.

### Phase 5 — graph visualization
- [ ] Render `walkedNodes` + their edges as a small subgraph (react-flow),
      highlighting the path the agent actually traversed for the current
      answer. This is the highest-leverage polish item — it visually proves
      "full codebase awareness" in a way a paragraph of text cannot.

### Phase 6 — deploy + submission polish
- [ ] Deploy to Vercel, verify cold-start behavior of the WASM parser and the
      embedding model in a serverless function specifically (this is the most
      likely place for a nasty last-minute surprise — test it early in this
      phase, not at the end).
- [ ] Test end-to-end against 2-3 real repos.
- [ ] Write the submission doc (what was built and why, architecture,
      decision log, known limitations, GitHub link, Vercel link).

---

## Explicit non-goals (don't drift into these under deadline pressure)

- No multi-language support beyond TS/JS.
- No full type inference / language-server-level resolution — heuristic
  resolution is the documented, intentional scope.
- No user auth, no multi-tenant support, no persistence beyond a single
  ingested repo at a time.
- No attempt to match TokenFold's actual internals — this is explicitly a
  smaller, transparent demonstration of the same underlying problem, not a
  reverse-engineering attempt.

## Working agreement for this session

- Keep `npm run test:parser` passing after every change to `src/parser/`.
- When a resolution heuristic fails on a real repo, log it and note it in this
  README's limitations rather than quietly special-casing it away.
- Prefer shipping Phases 1-4 completely over polishing Phase 5-6 partially —
  a working text answer with no graph visualization beats a beautiful
  visualization with a broken agent underneath.
