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
| Embeddings | `@xenova/transformers` (`all-MiniLM-L6-v2`), running in-process | Zero API cost, genuinely open source. If cold-start latency in serverless becomes a real problem, fall back to a free-tier hosted embedding API — note the tradeoff in the write-up either way, don't silently swap without noting why |
| Vector store | **Upstash Vector** (free tier, REST API) | Built for exactly this serverless pattern |
| LLM | Groq free tier, Llama 3.3 70B or similar | Open-weight model, free access, fast enough for a live demo |
| Graph visualization | `react-flow` or `vis-network` | Render the walked subgraph next to the answer |
| Deployment | Vercel | Required by the assignment |

Repo scope: **TypeScript/JavaScript only.** This is a deliberate scope cut to
keep tree-sitter grammar handling simple within the deadline — say so plainly
in the write-up, don't pretend it's multi-language.

---

## Environment variables needed

```
GROQ_API_KEY=
UPSTASH_VECTOR_REST_URL=
UPSTASH_VECTOR_REST_TOKEN=
UPSTASH_REDIS_REST_URL=       # configured, see .env (gitignored)
UPSTASH_REDIS_REST_TOKEN=     # configured, see .env (gitignored)
GITHUB_TOKEN=       # optional, raises the unauthenticated rate limit for public repo ingestion
```

Upstash Redis is configured and verified working (real round-trip write/read,
see Phase 1 checklist). Vector, Groq, and `GITHUB_TOKEN` are still unset —
sign-up is required before those can be filled in; flag this to the user
rather than inventing placeholder values that silently fail.

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
      embed.ts               # NEW: chunk symbols, embed with transformers.js
      vector-store.ts          # NEW: Upstash Vector read/write
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
- [ ] `embed.ts`: for each symbol node already extracted, take its source text
      (the actual function/class body, sliced by line range) as the chunk —
      this reuses the AST-aware boundaries from Phase 0, avoiding the
      "naive fixed-size chunking" failure mode described in the project's
      own pitch. Embed with `all-MiniLM-L6-v2`.
- [ ] `vector-store.ts`: write embeddings to Upstash Vector with metadata
      (symbol id, file, line range). Implement top-k semantic search.

### Phase 3 — LangGraph agent
- [ ] `state.ts`: `{ query, taskType, graphResults, vectorResults, compressedContext, tokenStats, answer, citations, walkedNodes }`
- [ ] `router.ts`: classify the question (structural / semantic / both) using
      a cheap LLM call with a small few-shot prompt.
- [ ] `graph-traversal.ts`: implement three traversal modes on the graphology
      graph — forward N-hop, reverse N-hop ("blast radius"), and shortest
      path between two named symbols.
- [ ] `vector-retrieval.ts`: top-k semantic search against Upstash Vector.
- [ ] `compress.ts`: merge both result sets, dedupe, keep top-relevance chunks
      verbatim, summarize the rest via one LLM call, and **log the before/after
      token count** — this number is a headline feature of the demo, don't
      lose it in implementation.
- [ ] `answer.ts`: final grounded answer, with file/line citations and the
      list of graph node IDs actually walked (needed for the visualization).
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
