import path from "node:path";
import type { FeatureExtractionPipeline } from "@xenova/transformers";
import type { FileGraph, SymbolNode } from "../parser/extract.js";

const MODELS_DIR = path.join(process.cwd(), "src/embeddings/models");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 32;

export type SymbolChunk = {
  id: string; // same id as SymbolNode.id, e.g. "server.ts::startServer"
  symbol: SymbolNode;
  text: string; // exact source slice for symbol.startLine..symbol.endLine
};

export type EmbeddedChunk = SymbolChunk & {
  embedding: number[];
};

/**
 * Slices each symbol's exact source range (already computed by the
 * tree-sitter pass in extract.ts) rather than re-chunking text from scratch
 * — this is the whole point of doing AST-aware boundaries in Phase 0, so the
 * embedding step must not re-split naively on top of it.
 */
export function chunkSymbols(fileGraphs: FileGraph[], sources: Map<string, string>): SymbolChunk[] {
  const chunks: SymbolChunk[] = [];
  for (const fg of fileGraphs) {
    const source = sources.get(fg.file);
    if (source === undefined) continue; // file was skipped during ingestion
    const lines = source.split("\n");
    for (const symbol of fg.symbols) {
      // startLine/endLine are 1-indexed and inclusive.
      const text = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n").trim();
      if (text) chunks.push({ id: symbol.id, symbol, text });
    }
  }
  return chunks;
}

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // Bundled with the deployment, not downloaded at runtime — see
      // README, "Embedding model cold-start" for why this matters.
      env.cacheDir = MODELS_DIR;
      env.allowRemoteModels = false;
      return pipeline("feature-extraction", MODEL_ID) as Promise<FeatureExtractionPipeline>;
    })();
  }
  return extractorPromise;
}

/**
 * Embeds all chunks in batches rather than one symbol at a time — matters
 * once a real repo has hundreds of symbols, not just sample-repo's 7.
 */
export async function embedChunks(chunks: SymbolChunk[]): Promise<EmbeddedChunk[]> {
  if (chunks.length === 0) return [];
  const extractor = await getExtractor();
  const results: EmbeddedChunk[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const output = await extractor(
      batch.map((c) => c.text),
      { pooling: "mean", normalize: true }
    );
    // output.dims = [batch.length, 384]; .tolist() gives one array per input.
    const vectors = output.tolist() as number[][];
    batch.forEach((chunk, j) => results.push({ ...chunk, embedding: vectors[j] }));
  }

  return results;
}

export async function embedFileGraphs(
  fileGraphs: FileGraph[],
  sources: Map<string, string>
): Promise<EmbeddedChunk[]> {
  return embedChunks(chunkSymbols(fileGraphs, sources));
}
