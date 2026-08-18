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

**Through the actual running app, not the CLI (closes the last open Phase 1
item):** every prior real-repo test called `ingest()`/`agentGraph` directly
via `tsx`. Before touching Phase 5, ingested a fresh repo —
[sindresorhus/ky](https://github.com/sindresorhus/ky), not previously
touched by any prior test — through the real browser UI end to end.
`GITHUB_TOKEN` was verified against `/rate_limit` (5000/hour, confirmed
authenticated) before starting, since ky's file list is large enough to
have been a real risk unauthenticated.

- **Real numbers, reported as found:** 53 files, 121 symbols, 119/571 calls
  resolved — **21%**, the lowest resolution rate seen on any repo so far
  (sample-repo 83%, zod ~43%, class-validator 56-69%). Consistent with
  ky's style, not a bug: heavy generics, type-only imports, and constant
  calls into DOM/fetch APIs (`Headers`, `AbortController`, `Response`
  methods) that are external by construction and were never going to
  resolve.
- **Multi-hop blast radius, checked, not assumed:** asked "What breaks if I
  change mergeHeaders?" and inspected the raw API response, not just the
  rendered citations (which are a filtered subset). `walkedNodes` came back
  with 5 nodes spanning **both directions and 2 hops** — `mergeHeaders` →
  `Ky.constructor` (reverse, its real caller) and `mergeHeaders` →
  `mergeHeaderContainers` → `deepMergeInternal`/`deepMerge` (forward, 2 hops
  into what it calls). Not just the immediate caller — this is the feature
  the whole project is built around, and it holds up on real code.
- **Semantic path, exercised separately:** "Explain how the retry logic
  works" (no named symbol, forcing the vector path) returned 8 `walkedNodes`
  and a fully-grounded, accurate multi-paragraph explanation of `Ky`'s
  private `#retry`/`#retryFromError`/`#calculateRetryDelay` methods and how
  they interact — correctly describing hook behavior, jitter, backoff
  limits, and the `ForceRetryError`/timing-header special cases, all cited
  to real file:line ranges.
- **Token compression, actual percentage, not rounded up:** the first three
  queries tried (including the two above) all came back at a genuine,
  honestly-reported **0%** — their result sets (5, 8, and 9 nodes) fit
  entirely within the verbatim caps (12 chunks / hop≤1 / score≥0.6), so
  there was nothing to summarize away, the same legitimate reason
  sample-repo showed 0%. Rather than stop there, tried a more central
  symbol (`validateAndMerge`, called from all four of `createInstance`'s
  request-building paths in `index.ts`) — its 10-node blast radius produced
  a real **32% reduction (2156 → 1476 tokens)**, confirming the compression
  mechanism scales on this repo too; it's query-dependent, not repo-broken.
- **New parsing edge case, confirmed working:** ky's `Ky` class uses ES2022
  private fields and methods (`#retryCount`, `#calculateDelay()`, etc.), not
  seen in zod/class-validator/date-fns. Private *methods* extract and
  resolve correctly — confirmed directly, `Ky.#retry` and `Ky.#calculateDelay`
  both appeared correctly in the blast-radius walk above. Private *fields*
  correctly produce no symbol (consistent with the existing function/class/
  const-arrow-fn-only scope — fields aren't callable, so this is expected,
  not a gap). Also checked for decorators, enums, and namespaces: none
  present (a `@example`/`@param` grep match turned out to be JSDoc comments,
  not decorator syntax — false alarm, corrected before reporting it as a
  finding). `interface` declarations are present (`Options`,
  `NormalizedOptions`) but are the already-documented type-graph scope
  decision, not new.
- **A rate limit actually got hit — logged, not silently retried around, and
  it broke something real:** `raw.githubusercontent.com` has its own
  unauthenticated CDN rate limit, entirely separate from the
  token-authenticated `api.github.com` core limit `GITHUB_TOKEN` covers —
  confirmed by hitting it during this session's own exploratory `curl`s
  against ky's source, unrelated to the app's ingest itself. Unlike Groq's
  API (which returns an exact `x-ratelimit-reset-tokens` wait time,
  see Phase 2/3), this CDN returns a bare `429` with **no `Retry-After`
  header at all** — no way to know how long to wait. A subsequent re-ingest
  attempt then hit this same limit for **all 53 of ky's files**, and
  `ingest()` proceeded anyway: `buildGraph([])` on zero file graphs produced
  an empty graph, which `persistGraph` then wrote to Redis, **silently
  overwriting the good 121-symbol ingest from minutes earlier with
  nothing.** This is a real architectural gap the rate limit exposed, not
  just an inconvenience: a transient network failure had no guard against
  corrupting a previously-good ingest. Fixed in `ingest.ts` — if every
  attempted file fails, the function now throws a clear error instead of
  persisting empty data over whatever was there before. Confirmed the fix
  works while still rate-limited: a repeat attempt now fails loudly
  (`All 53 files failed to fetch/parse -- refusing to persist an empty
  graph...`) instead of silently corrupting anything further.

**Follow-up — the guard alone wasn't the actual fix:** the persist-guard
above stops a total-failure ingest from corrupting good data, but it doesn't
stop the failure itself. Checked directly rather than assumed: `ingest.ts`
was still fetching file content from the unauthenticated
`raw.githubusercontent.com` CDN (`GITHUB_TOKEN` only ever covered the tree
listing via `api.github.com`). Switched content fetching to the
authenticated **Git Blobs API**
(`GET /repos/{owner}/{repo}/git/blobs/{sha}` with the
`application/vnd.github.raw+json` media type, using the blob SHA already
returned by the tree listing) — now every file fetch counts against the
same 60/5000-per-hour budget `GITHUB_TOKEN` already covers, instead of a
separate, unauthenticated CDN limit with no `Retry-After` header and no way
to know when it clears. `githubFetch` also now distinguishes GitHub's
secondary/abuse rate limit (403/429 with `Retry-After`, triggered by
request *pattern*, not budget) from the primary one, since "set
`GITHUB_TOKEN`" doesn't fix that kind.

Verified two ways before moving on:
1. **Restoration**: `raw.githubusercontent.com` was still returning 429
   with zero signal of when it'd clear when this fix landed — irrelevant
   now, since the new path never touches it. Re-ingested `sindresorhus/ky`
   through the real app and got back the *exact* pre-corruption numbers
   (53 files, 121 symbols, 119/571 calls, 21%), then re-ran the
   `mergeHeaders` blast-radius query and got the identical 5-node
   `walkedNodes` list byte-for-byte — confirms the fix didn't just produce
   *some* data, it restored the *correct* graph.
2. **A second, deliberately different repo** — see below — to get a
   resolution-rate data point that isn't just re-confirming ky's
   external-API-heavy pattern.

**A repo that's mostly internal logic, not external-API glue:**
[immerjs/immer](https://github.com/immerjs/immer) (structural-sharing /
proxy-based immutable-state library — its own algorithm, not a wrapper
around fetch/DOM). Ingested through the real app: **46 files, 111 symbols,
516/4270 calls resolved — 12%**, reported exactly as the app produced it,
even though it's lower than ky's 21% and doesn't fit the "internal logic
resolves better" expectation at face value.

Investigated *why* rather than stopping at the headline number, and found
something worth knowing for the write-up beyond either repo's specific
result: **27 of the 46 files ingested are test files** (`ingest.ts`
doesn't exclude test directories, by design — test code is legitimately
part of a repo's call graph). Those 27 test files account for **3820 of
the 4270 total calls (89%) but only 47 resolved** — test-runner and
assertion-library calls (`test()`, `expect()`, matcher chains) are external
by nature and were never going to resolve, the same shape of noise as
`class-validator`'s test files, just far more dominant here since immer
happens to have more test files (27) than source files (19). **Isolating
just the 19 non-test source files: 450 calls, 150 resolved — 33%** —
genuinely higher than ky's 21%, which does support the internal-logic
hypothesis once the test-call noise is separated out. Both numbers are
real and both are reported here; the raw 12% isn't wrong, it's just
dominated by something other than what it looks like it's measuring.

**A fifth repo, decorator-heavy this time:**
[typestack/class-transformer](https://github.com/typestack/class-transformer)
(`class-validator`'s companion library — `plainToInstance`/`instanceToPlain`
and friends). 71 files, 81 symbols, 209 calls, 23 resolved — **11%**, the
lowest of the five repos tested, verified directly against the stored graph
(not taken on faith): `{files: 71, symbols: 81, totalCalls: 209,
resolvedCalls: 23, resolutionRate: '11%'}`.

Two things confirmed, not assumed:
- **Real decorator usage extracting correctly, for the first time with
  genuine (not synthetic) evidence.** The Phase 3 gap analysis found
  decorators didn't break `class_declaration` parsing, but only via a
  hand-written snippet — neither `class-validator` nor `class-transformer`'s
  own *source* actually uses decorators. `ingest.ts` includes test files by
  design, though, and class-transformer's own test fixtures
  (`test/functional/*.spec.ts`) genuinely decorate example classes with
  `@Expose`, `@Type`, etc. — confirmed via GitHub code search (13 real
  matches) before writing this down, not inferred from the resolution
  number alone.
- **The `plainToInstance` query was semantic-only, not graph-backed** —
  checked via the raw `/api/query` response rather than assumed from the
  UI: `taskType: "semantic"`, all 8 `walkedNodes` came from vector
  retrieval (`plainToInstance`, `plainToClass`, `instanceToInstance`, and
  related transform methods ranked by similarity), zero graph traversal.
  Makes sense in hindsight — "what does X do" reads as an explain-style
  question to `router.ts`, not a relationship/impact one — but worth
  confirming rather than assuming graph-backing just because the repo
  has a real call graph.

**The five-repo resolution-rate spectrum, in one place** (each tested via
`extractFile`/`buildGraph` or the full `ingest()` pipeline, several through
the real running app, not just the CLI — see each repo's own entry above
for the full story):

| Repo | Resolution rate | Why |
|---|---|---|
| `sample-repo` (3-file toy) | **83%** | Hand-written, small, every call is local — closest thing to a ceiling for this heuristic resolver. |
| `class-validator` (80-file sample) | **69%** | Real repo, but a barrel/re-export-heavy library where most calls stay internal to the package. |
| `immerjs/immer` (19 non-test source files) | **33%** | Internal algorithmic logic (structural sharing), not external-API glue — but still real generics/TS-only code capping the ceiling well below sample-repo's. |
| `sindresorhus/ky` (53 files) | **21%** | External-API-heavy by nature (DOM/fetch: `Headers`, `AbortController`, `Response` — all external, unresolvable by construction). |
| `typestack/class-transformer` (71 files) | **11%** | Metadata-reflection-driven (`reflect-metadata`, decorator introspection at runtime) rather than direct function calls — the *mechanism* connecting code paths often isn't a literal call expression at all, so there's less for a call-graph resolver to find in the first place, not just more external noise to filter out. |

Read together, not in isolation: resolution rate isn't a quality score for
the resolver, it's a reflection of how much of a given repo's *real*
control flow is expressed as direct, literal function calls the heuristic
can see — vs. calls into externals, reflection/metadata mechanisms, or
generics-heavy code the project was always explicit about not solving.
sample-repo's 83% was never the bar real repos were expected to clear.

---

## Answer node: group blast-radius answers by file

Before Phase 5, one improvement to `answer.ts`: every `walkedNodes` entry
already carries its file in the symbol id (`file.ts::functionName`), but
left to its own devices the model answered "what breaks if I change X" as
one flat list of function names with no file structure — a weaker answer
to a blast-radius question than it needs to be, since knowing exactly
*where* the damage lands is the point of walking the graph, not just that
it lands somewhere.

`generateAnswer` now takes `taskType` and, for `structural`/`both` queries
only (a semantic "explain how X works" question doesn't benefit from being
forced into file sections the same way — confirmed still reads as natural
narrative, unaffected), appends an instruction requiring exactly one
section per distinct file, covering every affected symbol in that file
together.

Tested against the exact already-verified `ky` `mergeHeaders` case (5
nodes, 2 hops, both directions — see above) specifically because the
correct grouping for that case was already known and checkable by eye:
`source/utils/merge.ts` should hold `mergeHeaders`/`mergeHeaderContainers`/
`deepMergeInternal`/`deepMerge`, `source/core/Ky.ts` should hold
`Ky.constructor`, alone. First two attempts didn't fully hold up under
testing, not just written and assumed to work:
- **Attempt 1** produced two sections for the same file
  (`source/utils/merge.ts` and a separate `source/utils/merge.ts
  (deepMergeInternal)`) — the instruction said "one section per file" but
  didn't forbid a function-name suffix on the heading, so the model treated
  a different function as license for a different heading.
- **Attempt 2** (numbered-steps phrasing: "1. list the files, 2. write that
  many sections...") fixed the splitting but leaked the count as literal
  output text (a run's answer started with a bare `2` on its own line) —
  the model followed the enumerated steps as things to narrate, not silent
  reasoning.
- **Attempt 3**: single-paragraph instruction, explicit "heading line must
  be the bare file path and nothing else," explicit "do not output
  anything about how many files there are or how you organized the
  answer." Re-ran the identical `mergeHeaders` case twice — both times
  exactly two sections, `source/utils/merge.ts` (all four
  merge.ts-symbols together) and `source/core/Ky.ts`, no leaked meta-text,
  no split file. Also re-verified against `sample-repo`'s `loadConfig`
  case (3 clean sections: `config.ts`, `db.ts`, `server.ts`) and against
  class-validator's real 112-node `ValidateBy` blast radius (3 clean
  sections at real scale, not just the toy case) — the fix holds beyond
  the one case it was tuned against.

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
      page.tsx                       # done: renders ChatPanel
      globals.css                     # done
      api/
        ingest/route.ts               # done: POST { source } -> parse + embed + store
        query/route.ts                 # done: POST { repoKey, question } -> run agent -> answer
    components/
      ChatPanel.tsx                    # done: ingest form, chat, token-savings panel
      GraphVisualization.tsx            # NEW -- Phase 5
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
      (`GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`) to list files,
      then fetch each file's content — capped at 8 concurrent requests.
      `GITHUB_TOKEN` is read from the environment if present (60 → 5000
      req/hour) but isn't required for public repos.
      Run it with `npm run ingest -- <local-dir | github-url | owner/repo>`.
      Smoke-tested against `sample-repo` (matches the known-good 7
      symbols/83%) and against a real GitHub repo
      (`sindresorhus/p-timeout`, both shorthand and full-URL / `/tree/ref`
      forms) to prove the fetch path, not just the local one. **The
      remaining gap — a real repo through the actual running app, not just
      the CLI — closed after Phase 4**, see "Through the actual running
      app, not the CLI" above: `sindresorhus/ky`, browser UI end to end,
      real numbers, a genuine multi-hop blast radius, and a real rate
      limit that surfaced and got fixed.

      **Content fetching originally used `raw.githubusercontent.com`**
      (unauthenticated, on the theory that it sat outside the rate-limited
      core API entirely). That CDN has its own separate, unauthenticated
      rate limit that `GITHUB_TOKEN` never covered — confirmed the hard way
      when it returned 429 for every file of a real repo mid-session, with
      no `Retry-After` header, and (before the persist-guard fix) silently
      corrupted a good prior ingest. **Switched to the authenticated Git
      Blobs API** (`GET /repos/{owner}/{repo}/git/blobs/{sha}` with the
      `application/vnd.github.raw+json` media type, using the blob SHA
      already returned by the tree listing) — now every file fetch counts
      against the same 60/5000-per-hour budget `GITHUB_TOKEN` already
      covers, closing the actual gap rather than just catching its
      symptom. `githubFetch` also now distinguishes GitHub's secondary/
      abuse rate limit (403/429 with `Retry-After`, triggered by request
      *pattern* — e.g. too many concurrent requests — not budget) from the
      primary one, since "set `GITHUB_TOKEN`" doesn't fix that kind.
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
- [x] `agent/graph.ts`: a genuine `StateGraph` with conditional edges based on
      `router.ts`'s output, not five functions called in a fixed sequence
      with LangGraph wrapped around it after the fact:
      - `router` fans out via `addConditionalEdges` returning an *array* of
        next nodes — `["graphTraversal"]`, `["vectorRetrieval"]`, or both in
        parallel for `taskType: "both"`.
      - Two gate nodes (`graphQualityGate`, `vectorQualityGate`) sit between
        the retrieval nodes and `compress`, using LangGraph's `Command` to
        both decide the next node *and* update state in one step — needed
        because the fallback loop has to flip `fallbackAttempted` (and
        sometimes `hopDepth`) as part of the routing decision itself, not as
        a separate node.
      - **The conditional loop** (instruction: "one real conditional loop,
        not just branching") has two conditions, both evidenced by real test
        runs, not just written and assumed to work:
        1. Single-path structural query, no anchor found in the graph at
           all (`graphResults.length === 0`) → falls back to
           `vectorRetrieval` on the raw query. Fired for real in testing: a
           query naming a nonexistent symbol correctly fell back to vector
           search, found nothing relevant there either, and the final
           answer honestly said so instead of hallucinating.
        2. `graphResults` includes any node at `hops === hopDepth` (the BFS
           frontier was still non-empty when traversal stopped, i.e. likely
           truncated) → re-invokes **the same `graphTraversal` node** with
           `hopDepth + 1`, a genuine cycle in the graph structure, not just
           a fallback to a different node. Fired for real: the
           `loadConfig` blast-radius query that missed `bootstrap` at hop 3
           (found while testing `graph-traversal.ts` in isolation,
           documented above) now correctly reaches it after one
           self-loop, confirmed via `walkedNodes` including `bootstrap` and
           `hopDepth: 3` in the final state.
        Both conditions are guarded by `fallbackAttempted`, capping the
        total extra hops at one — no risk of the loop cycling forever.
      - `walkedNodes` and `tokenStats` were checked as actually populated
        across every test case (`npm run test:agent`), not just asserted
        to exist: every run showed real symbol ids and real before/after
        token counts, including a **53% reduction on the real 297-symbol
        class-validator repo** — matching Phase 2's number, achieved this
        time via the full orchestrated graph, not a hand-called pipeline.

      Two real bugs found and fixed while testing end-to-end, neither
      caught until actually running the compiled graph:
      - Node name `"answer"` collided with the state channel `answer` --
        LangGraph rejects a node sharing a name with a state field. Renamed
        the node to `generateAnswer` (state field stays `answer`, matching
        the originally-planned shape).
      - Citation extraction (`answer.ts`) missed real citations twice over
        at real scale: the model sometimes cites with full-width brackets
        (`【id】` instead of `[id]`), and on the real repo it consistently
        cited symbols by their bare name (`[ArrayContains]`) rather than
        the full id (`src/decorator/array/ArrayContains.ts::ArrayContains`).
        First fix was two more string-matching patterns (full id OR bare
        name, any bracket style) — caught both observed failures, but
        pattern-matching free text for an unbounded set of ways a model
        might format a reference was never going to hold up on a third
        repo's different failure mode. Replaced with structured output
        instead, the same `jsonMode` pattern already used in `router.ts`
        and `compress.ts`: the model returns `{answer, citedIds: string[]}`
        directly rather than inline-bracketed prose, and `citedIds` is
        validated against the actual candidate ids (a hallucinated id that
        was never in the context can't make it into `citations`). Re-ran
        all five test cases including the exact real-repo query that broke
        both prior string-matching attempts — correct citations every time,
        with no pattern-matching left to break on a fourth format.
- [x] `npm run test:agent` (`src/agent/test-agent.ts`): end-to-end coverage
      across structural/semantic/both, the empty-anchor fallback, the
      hop-depth-expansion loop, and one real-repo run — kept as a permanent
      test, same as the per-node tests, not thrown away once green.

### Phase 4 — API + UI
- [x] `/api/ingest`: `POST { source }` (local dir, GitHub URL, or owner/repo
      shorthand — same input `ingest()` already accepts) → runs the full
      Phase 1+2 pipeline, returns `{ repoKey, source, stats, persisted,
      embeddedCount, vectorsWritten, skippedCount }`.
- [x] `/api/query`: `POST { repoKey, question }` → runs `agentGraph`, returns
      `{ answer, citations, walkedNodes, tokenStats, taskType }` — matches
      the originally-planned shape (`repoId` renamed `repoKey` to match
      every other part of the system, which already settled on that name
      back in Phase 1).
      Both routes tested directly against the real dev server (curl, then a
      small Node script once shell quoting made curl unreliable for a
      repoKey containing Windows backslashes) before any UI was built on
      top of them.

      Real, codebase-wide bug found in the process: Turbopack (Next.js 16's
      default bundler) couldn't resolve the `.js`-suffixed relative imports
      the rest of the codebase uses (required for `tsx`/native Node ESM) to
      their actual `.ts` source files — identical failure whether
      path-aliased via `@/` or plain relative. Since `src/parser`,
      `src/embeddings`, and `src/agent` are each consumed *both* directly
      via `tsx` (CLI, test scripts) *and* bundled via Turbopack (these API
      routes), the same import statement has to satisfy both toolchains at
      once. Confirmed `tsx` tolerates extensionless imports just as well as
      `.js`-suffixed ones, so standardized on extensionless relative imports
      across every file in those three directories — one style that works
      for both, instead of two conventions for the same shared files.
      Re-ran the full existing test suite after the rewrite to confirm
      nothing broke.
- [x] Chat UI (`src/components/ChatPanel.tsx`): repo input + ingestion
      status, chat interface, and a token-savings panel with deliberately
      outsized visual weight (large gradient card, 36px tabular-nums
      number) — the single most demo-friendly number in the project, per
      the original instruction. **Actually tested in a browser** (Chrome,
      via `claude-in-chrome`), not just trusted to compile: ingested
      `sample-repo` through the real UI (correct stats rendered: "3 files,
      7 symbols, 5/6 calls resolved"), asked two real questions
      back-to-back, and confirmed both grounded answers rendered with
      correct citation pills, the token panel updated per-query (106→106,
      then 155→155, both honestly 0% since sample-repo has nothing worth
      compressing), and the chat correctly stacked both turns rather than
      replacing the first. One dev-overlay "1 Issue" hydration warning
      appeared and was checked, not ignored — traced to a browser
      extension (`bbai-tooltip-injected`) mutating the DOM before React
      hydrated, exactly the extension-interference case Next.js's own
      error message calls out, not a bug in this code.

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
