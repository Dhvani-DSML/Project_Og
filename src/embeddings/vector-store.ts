import crypto from "node:crypto";
import { Index } from "@upstash/vector";
import type { EmbeddedChunk } from "./embed.js";

try {
  // Local dev convenience, same pattern as graph-store.ts -- on Vercel these
  // are injected directly into process.env.
  process.loadEnvFile(".env.local");
} catch {}

const EXPECTED_DIMENSION = 384;
const EXPECTED_SIMILARITY = "COSINE";
const UPSERT_BATCH_SIZE = 100;
const MAX_METADATA_TEXT_CHARS = 4000;

export type ChunkMetadata = {
  repoKey: string;
  file: string;
  startLine: number;
  endLine: number;
  name: string;
  kind: string;
  exported: boolean;
  text: string; // raw code, possibly truncated -- see upsertChunks
  truncated: boolean;
};

function vectorClient(): Index<ChunkMetadata> | null {
  const url = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) return null;
  return new Index<ChunkMetadata>({ url, token });
}

function namespaceFor(repoKey: string): string {
  return crypto.createHash("sha256").update(repoKey).digest("hex").slice(0, 16);
}

/**
 * Refuses to write anything if the index isn't actually configured the way
 * the embedding model expects (384 dims, cosine similarity) -- silently
 * upserting into a mismatched index would either fail per-vector or, worse,
 * "succeed" while producing meaningless nearest-neighbor results.
 */
async function assertIndexConfig(client: Index): Promise<void> {
  const info = await client.info();
  if (info.dimension !== EXPECTED_DIMENSION) {
    throw new Error(
      `Upstash Vector index dimension is ${info.dimension}, expected ${EXPECTED_DIMENSION} ` +
        `(all-MiniLM-L6-v2 output size). Refusing to write — recreate the index with the right dimension.`
    );
  }
  if (info.similarityFunction !== EXPECTED_SIMILARITY) {
    throw new Error(
      `Upstash Vector index similarity function is ${info.similarityFunction}, expected ` +
        `${EXPECTED_SIMILARITY}. Refusing to write — recreate the index with cosine similarity.`
    );
  }
}

/**
 * Writes embedded chunks to Upstash Vector, batched (100/call) rather than
 * one at a time. Each repo gets its own namespace (hash of repoKey) so
 * multiple ingested repos share one index without their nearest-neighbor
 * results bleeding into each other.
 */
export async function upsertChunks(repoKey: string, chunks: EmbeddedChunk[]): Promise<boolean> {
  const client = vectorClient();
  if (!client) {
    console.warn(
      "UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN not set — skipping vector upsert."
    );
    return false;
  }
  if (chunks.length === 0) return true;

  await assertIndexConfig(client);
  const ns = client.namespace(namespaceFor(repoKey));

  for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);
    await ns.upsert(
      batch.map((c) => {
        const truncated = c.text.length > MAX_METADATA_TEXT_CHARS;
        return {
          id: c.id,
          vector: c.embedding,
          metadata: {
            repoKey,
            file: c.symbol.file,
            startLine: c.symbol.startLine,
            endLine: c.symbol.endLine,
            name: c.symbol.name,
            kind: c.symbol.kind,
            exported: c.symbol.exported,
            text: truncated ? c.text.slice(0, MAX_METADATA_TEXT_CHARS) : c.text,
            truncated,
          } satisfies ChunkMetadata,
        };
      })
    );
  }

  return true;
}

export type VectorMatch = {
  id: string;
  score: number;
  metadata: ChunkMetadata;
};

export async function queryVectors(
  repoKey: string,
  queryEmbedding: number[],
  topK: number = 8
): Promise<VectorMatch[]> {
  const client = vectorClient();
  if (!client) return [];
  const ns = client.namespace(namespaceFor(repoKey));
  const results = await ns.query({ vector: queryEmbedding, topK, includeMetadata: true });
  return results.map((r) => ({ id: String(r.id), score: r.score, metadata: r.metadata as ChunkMetadata }));
}
