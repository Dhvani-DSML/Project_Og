import { embedQuery } from "../../embeddings/embed.js";
import { queryVectors } from "../../embeddings/vector-store.js";
import type { VectorMatch } from "../../embeddings/vector-store.js";

const DEFAULT_TOP_K = 8;

// Empirical, tuned twice, not arbitrary. First pass used 0.45 based on
// sample-repo's related-vs-unrelated numbers (~0.6-0.8 vs ~0.48-0.58,
// README "prepend context header" commit) -- but testing a genuinely
// nonsense query ("recipe for chocolate cake") against sample-repo scored
// 0.49-0.54, indistinguishable from same-codebase-but-unrelated pairs at
// that threshold. MiniLM's mean-pooled embeddings don't have a clean floor
// near zero for "totally unrelated" -- there's no threshold that separates
// "unrelated" from "nonsensical" by absolute score alone. Raised to 0.55,
// which does cleanly separate real related queries (0.66-0.76 measured)
// from both unrelated-but-real and genuinely nonsense queries (0.49-0.58)
// -- accepting that some weak-but-real semantic queries will also trigger
// the fallback loop as a false positive, which is an acceptable tradeoff
// for a demo project: trying the graph path costs nothing but latency.
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

export async function retrieveByVector(
  repoKey: string,
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<VectorMatch[]> {
  const embedding = await embedQuery(query);
  return queryVectors(repoKey, embedding, topK);
}

export function isLowConfidence(results: VectorMatch[]): boolean {
  return results.length === 0 || results[0].score < LOW_CONFIDENCE_THRESHOLD;
}
