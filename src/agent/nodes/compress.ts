import { fetchChunks } from "../../embeddings/vector-store.js";
import { groqChat, MODEL_LARGE } from "../groq.js";
import type { GraphWalkResult, CompressedChunk, TokenStats } from "../state.js";
import type { VectorMatch } from "../../embeddings/vector-store.js";

const VERBATIM_HOP_THRESHOLD = 1; // graph hits within this many hops are kept verbatim
const VERBATIM_SCORE_THRESHOLD = 0.6; // vector hits above this score are kept verbatim
const MAX_VERBATIM_CHUNKS = 12; // cap so a large repo's result set can't blow up the answer prompt
// A popular symbol's blast radius on a real repo can reach 100+ nodes (measured:
// 112 for class-validator's ValidateBy) -- far more raw material than any answer
// needs. Trimming the tail here, not just at the verbatim/summarize split, is what
// keeps the summarization call itself within Groq's per-minute token budget.
const MAX_TOTAL_CANDIDATES = 40;
// Cramming every non-verbatim candidate into one summarization prompt is exactly
// what blew Groq's 8000 TPM limit on the real repo (112 graph results, 11,375
// tokens requested in a single call) -- batching applies the same "don't do it
// one giant call at a time" principle already used for embedding and upserting.
const SUMMARIZE_BATCH_SIZE = 10;
// Below this, a one-sentence summary is likely to cost MORE tokens than the
// code itself. First attempt used 15 -- still went negative on sample-repo
// (155 -> 163 tokens), because a real "concise one sentence" from an LLM
// runs ~40-60+ characters (~10-15 tokens) on its own, so anything only
// slightly above 15 tokens of *code* still nets a loss once summarized.
// Raised to 40 based on that actual measurement, not a second guess.
const TOO_SMALL_TO_SUMMARIZE_TOKENS = 40;

/**
 * Rough approximation (chars/4), not exact BPE token counts -- an exact
 * count would need a tokenizer matching whichever Groq model is running,
 * which isn't reliably available for gpt-oss over a REST API. Consistent
 * enough, applied identically before and after, to report a meaningful
 * before/after reduction number, which is what the demo actually needs.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type Candidate = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  relevanceScore: number; // unified 0-1-ish score so graph hits and vector hits can be ranked together
  minHops: number | null; // null if this candidate only came from vector search
};

/**
 * Merges graph-traversal and vector-retrieval results into one ranked,
 * deduped candidate list, keeps the most relevant verbatim and summarizes
 * the rest via one LLM call, and logs the before/after token estimate --
 * the project's headline demo number, populated for real here, not left as
 * a placeholder that "works" without actually being measured.
 */
export async function compressContext(
  repoKey: string,
  graphResults: GraphWalkResult[],
  vectorResults: VectorMatch[]
): Promise<{ compressedContext: CompressedChunk[]; tokenStats: TokenStats }> {
  // The persisted call graph only stores symbol metadata (file, line range,
  // name) -- not source text -- so graph-traversal results get their actual
  // code from Vector, which already has it from ingestion (see
  // vector-store.ts:fetchChunks).
  const graphTextById = await fetchChunks(
    repoKey,
    graphResults.map((g) => g.nodeId)
  );

  const byId = new Map<string, Candidate>();

  for (const g of graphResults) {
    const meta = graphTextById.get(g.nodeId);
    if (!meta) continue; // symbol has no vector entry (e.g. index predates it) -- skip rather than show empty code
    const relevanceScore = Math.max(0.3, 1 - g.hops * 0.2); // hop 0 -> 1.0, hop 1 -> 0.8, hop 2 -> 0.6, floor 0.3
    const existing = byId.get(g.nodeId);
    byId.set(g.nodeId, {
      id: g.nodeId,
      file: meta.file,
      startLine: meta.startLine,
      endLine: meta.endLine,
      text: meta.text,
      relevanceScore: Math.max(existing?.relevanceScore ?? 0, relevanceScore),
      minHops: Math.min(existing?.minHops ?? Infinity, g.hops),
    });
  }

  for (const v of vectorResults) {
    const existing = byId.get(v.id);
    if (existing) {
      existing.relevanceScore = Math.max(existing.relevanceScore, v.score);
    } else {
      byId.set(v.id, {
        id: v.id,
        file: v.metadata.file,
        startLine: v.metadata.startLine,
        endLine: v.metadata.endLine,
        text: v.metadata.text,
        relevanceScore: v.score,
        minHops: null,
      });
    }
  }

  const candidates = [...byId.values()]
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_TOTAL_CANDIDATES);
  const beforeTokens = candidates.reduce((sum, c) => sum + estimateTokens(c.text), 0);

  const verbatim: Candidate[] = [];
  const toSummarize: Candidate[] = [];
  for (const c of candidates) {
    const isHighRelevance =
      (c.minHops !== null && c.minHops <= VERBATIM_HOP_THRESHOLD) || c.relevanceScore >= VERBATIM_SCORE_THRESHOLD;
    const tooSmallToBother = estimateTokens(c.text) < TOO_SMALL_TO_SUMMARIZE_TOKENS;
    if ((isHighRelevance || tooSmallToBother) && verbatim.length < MAX_VERBATIM_CHUNKS) verbatim.push(c);
    else toSummarize.push(c);
  }

  const summaries = toSummarize.length > 0 ? await summarizeChunks(toSummarize) : new Map<string, string>();

  const compressedContext: CompressedChunk[] = [
    ...verbatim.map((c) => ({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: c.text,
      verbatim: true,
    })),
    ...toSummarize.map((c) => ({
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      text: summaries.get(c.id) ?? c.text.slice(0, 200), // fall back to a truncated snippet if summarization failed for this id
      verbatim: false,
    })),
  ];

  const afterTokens = compressedContext.reduce((sum, c) => sum + estimateTokens(c.text), 0);
  const reductionPercent = beforeTokens === 0 ? 0 : Math.round((1 - afterTokens / beforeTokens) * 100);

  return { compressedContext, tokenStats: { beforeTokens, afterTokens, reductionPercent } };
}

/**
 * Batched (10 symbols/call), not one giant prompt -- a popular symbol's
 * blast radius on a real repo produces far more candidates than one
 * summarization call can safely hold within Groq's per-minute token budget
 * (confirmed: 112 graph results on class-validator's ValidateBy blew the
 * 8000 TPM limit in a single call). Batches run sequentially, not in
 * parallel, so they don't just recreate the same rate-limit problem by
 * firing all at once instead of one giant one.
 */
async function summarizeChunks(chunks: Candidate[]): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();

  for (let i = 0; i < chunks.length; i += SUMMARIZE_BATCH_SIZE) {
    const batch = chunks.slice(i, i + SUMMARIZE_BATCH_SIZE);
    const prompt = batch.map((c) => `### ${c.id}\n${c.text}`).join("\n\n");

    const content = await groqChat(
      MODEL_LARGE,
      [
        {
          role: "system",
          content:
            "For each code symbol below, write exactly one concise sentence (max ~20 words) describing what it does. " +
            'Respond with ONLY a JSON object mapping the symbol id to its one-sentence summary, e.g. {"file.ts::foo": "..."}. ' +
            "Do not include the code itself in your response.",
        },
        { role: "user", content: prompt },
      ],
      { jsonMode: true, temperature: 0 }
    );

    try {
      const parsed = JSON.parse(content) as Record<string, string>;
      for (const [id, summary] of Object.entries(parsed)) summaries.set(id, summary);
    } catch {
      // this batch's ids fall back to a truncated snippet in the caller
    }
  }

  return summaries;
}
