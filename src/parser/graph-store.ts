import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import Graph from "graphology";
import type { BuildResult } from "./graph";
import type { IngestSource } from "./ingest";

try {
  // Local dev convenience -- on Vercel these are injected directly into
  // process.env, so there's no .env file to find and this is a silent no-op.
  process.loadEnvFile();
} catch {}

function redisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function redisKeyFor(repoKey: string): string {
  const hash = crypto.createHash("sha256").update(repoKey).digest("hex");
  return `graphrag:graph:${hash}`;
}

type StoredGraph = {
  repoKey: string;
  stats: BuildResult["stats"];
  graphExport: ReturnType<Graph["export"]>;
  // Owner/repo/ref (or local dir) the graph was built from -- added so query
  // time can reconstruct a GitHub deep link (owner/repo/ref/file#Lstart-Lend)
  // for each walked node without re-deriving it from repoKey's string
  // encoding. Optional: graphs persisted before this field existed won't
  // have it, and loadGraph below degrades that to `null` rather than
  // throwing on old data.
  source?: IngestSource;
};

/**
 * Serializes a built graph to Upstash Redis, keyed by a hash of repoKey (the
 * README says "keyed by a hash of the repo URL" — hashing also sidesteps
 * Redis key-shape edge cases in local repoKeys, e.g. Windows drive letters).
 * No-ops with a warning, rather than throwing, when Upstash credentials
 * aren't configured — ingestion should still work end-to-end without them.
 */
export async function persistGraph(
  repoKey: string,
  build: BuildResult,
  source: IngestSource
): Promise<boolean> {
  const client = redisClient();
  if (!client) {
    console.warn(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — skipping graph persistence."
    );
    return false;
  }
  const payload: StoredGraph = { repoKey, stats: build.stats, graphExport: build.graph.export(), source };
  await client.set(redisKeyFor(repoKey), JSON.stringify(payload));
  return true;
}

export async function loadGraph(
  repoKey: string
): Promise<(BuildResult & { source: IngestSource | null }) | null> {
  const client = redisClient();
  if (!client) return null;
  const raw = await client.get<string | StoredGraph>(redisKeyFor(repoKey));
  if (!raw) return null;
  // @upstash/redis auto-parses JSON-looking string values, so `raw` may
  // already be the object rather than a string — handle both.
  const stored: StoredGraph = typeof raw === "string" ? JSON.parse(raw) : raw;
  const graph = new Graph({ multi: true, type: "directed" });
  graph.import(stored.graphExport);
  return { graph, stats: stored.stats, source: stored.source ?? null };
}
