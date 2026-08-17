import crypto from "node:crypto";
import { Redis } from "@upstash/redis";
import Graph from "graphology";
import type { BuildResult } from "./graph";

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
};

/**
 * Serializes a built graph to Upstash Redis, keyed by a hash of repoKey (the
 * README says "keyed by a hash of the repo URL" — hashing also sidesteps
 * Redis key-shape edge cases in local repoKeys, e.g. Windows drive letters).
 * No-ops with a warning, rather than throwing, when Upstash credentials
 * aren't configured — ingestion should still work end-to-end without them.
 */
export async function persistGraph(repoKey: string, build: BuildResult): Promise<boolean> {
  const client = redisClient();
  if (!client) {
    console.warn(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — skipping graph persistence."
    );
    return false;
  }
  const payload: StoredGraph = { repoKey, stats: build.stats, graphExport: build.graph.export() };
  await client.set(redisKeyFor(repoKey), JSON.stringify(payload));
  return true;
}

export async function loadGraph(repoKey: string): Promise<BuildResult | null> {
  const client = redisClient();
  if (!client) return null;
  const raw = await client.get<string | StoredGraph>(redisKeyFor(repoKey));
  if (!raw) return null;
  // @upstash/redis auto-parses JSON-looking string values, so `raw` may
  // already be the object rather than a string — handle both.
  const stored: StoredGraph = typeof raw === "string" ? JSON.parse(raw) : raw;
  const graph = new Graph({ multi: true, type: "directed" });
  graph.import(stored.graphExport);
  return { graph, stats: stored.stats };
}
