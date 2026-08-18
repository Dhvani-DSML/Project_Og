import { Annotation } from "@langchain/langgraph";
import type { SymbolNode } from "../parser/extract";
import type { VectorMatch } from "../embeddings/vector-store";

export type TaskType = "structural" | "semantic" | "both";

export type GraphWalkResult = {
  nodeId: string;
  symbol: SymbolNode;
  hops: number;
  direction: "forward" | "reverse"; // forward = transitively calls; reverse = blast radius (calls it)
};

// Real caller -> callee edges as actually traversed during the walk (not an
// induced subgraph reconstructed from which nodes ended up visited) --
// what Phase 5's graph visualization draws.
export type WalkedEdge = { source: string; target: string };

export type CompressedChunk = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  verbatim: boolean; // true = kept as-is in the prompt; false = replaced with a summary
};

export type Citation = {
  symbolId: string;
  file: string;
  startLine: number;
  endLine: number;
};

export type TokenStats = {
  beforeTokens: number;
  afterTokens: number;
  reductionPercent: number;
};

const lastWrite = <T>(fallback: T) => ({ reducer: (_left: T, right: T) => right, default: () => fallback });

export const AgentStateAnnotation = Annotation.Root({
  // Set once at invocation, never updated by a node.
  query: Annotation<string>,
  // Which repo's graph/vectors to operate on. The README's originally
  // planned state type omitted this entirely -- without it, no node can
  // know which Redis graph or Vector namespace to load, so it's added here
  // as a provable gap in the original plan, not a discretionary addition.
  repoKey: Annotation<string>,

  taskType: Annotation<TaskType>(lastWrite<TaskType>("both")),
  // Best-guess symbol name router.ts extracted from the query (e.g.
  // "loadConfig" from "what breaks if I change loadConfig?"), or null for
  // genuinely nameless semantic questions. Used to anchor graph traversal
  // and, in the fallback loop, to decide whether a semantic-path miss can
  // even attempt a graph-path retry.
  targetSymbolHint: Annotation<string | null>(lastWrite<string | null>(null)),

  graphResults: Annotation<GraphWalkResult[]>(lastWrite<GraphWalkResult[]>([])),
  vectorResults: Annotation<VectorMatch[]>(lastWrite<VectorMatch[]>([])),
  // How many hops graphTraversal walked with. Starts at 2; the conditional
  // loop in agent/graph.ts bumps it to 3 and re-runs the same node when the
  // BFS frontier was still non-empty at the cutoff (confirmed real on
  // sample-repo: loadConfig's blast radius missed a caller at hop 3).
  hopDepth: Annotation<number>(lastWrite<number>(2)),

  // Set true the first time the conditional fallback loop fires, so it can
  // only ever fire once per query -- guards against ping-ponging between
  // the graph and vector nodes.
  fallbackAttempted: Annotation<boolean>(lastWrite<boolean>(false)),

  compressedContext: Annotation<CompressedChunk[]>(lastWrite<CompressedChunk[]>([])),
  tokenStats: Annotation<TokenStats>(
    lastWrite<TokenStats>({ beforeTokens: 0, afterTokens: 0, reductionPercent: 0 })
  ),

  answer: Annotation<string>(lastWrite<string>("")),
  citations: Annotation<Citation[]>(lastWrite<Citation[]>([])),

  // Accumulates across nodes rather than overwriting -- graphTraversal and
  // vectorRetrieval each contribute their own node ids, and in the fan-out
  // ("both") or fallback-loop case both run in the same query, so a plain
  // last-write reducer would silently drop whichever ran first. This is
  // exactly the field Phase 5's graph visualization depends on being real.
  walkedNodes: Annotation<string[]>({
    reducer: (left: string[], right: string[]) => [...new Set([...left, ...right])],
    default: () => [],
  }),

  // Same accumulate-and-dedup shape as walkedNodes, for the same reason
  // (fan-out/fallback-loop can have graphTraversal contribute more than
  // once in a single run) -- what Phase 5's graph visualization draws.
  // vectorRetrieval never contributes edges: semantic results aren't
  // graph-connected to each other by construction.
  walkedEdges: Annotation<WalkedEdge[]>({
    reducer: (left: WalkedEdge[], right: WalkedEdge[]) => {
      const seen = new Set(left.map((e) => `${e.source}->${e.target}`));
      const merged = [...left];
      for (const e of right) {
        const key = `${e.source}->${e.target}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(e);
        }
      }
      return merged;
    },
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
