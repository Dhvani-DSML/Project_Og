import Graph from "graphology";
import { loadGraph } from "../../parser/graph-store.js";
import type { GraphWalkResult } from "../state.js";
import type { SymbolNode } from "../../parser/extract.js";

const DEFAULT_HOP_DEPTH = 2;

/**
 * Resolves a natural-language symbol hint (router.ts's best guess, e.g.
 * "loadConfig" or "ConnectionPool.open") to actual graph node ids. Exact
 * bare-name match first, then case-insensitive, then substring -- same
 * escalating-heuristic shape as the import resolver in graph.ts, and for
 * the same reason: a name that doesn't exist verbatim shouldn't just fail,
 * but an exact hit shouldn't be diluted by a looser one either.
 */
function findAnchors(graph: Graph, hint: string): string[] {
  const exact: string[] = [];
  const caseInsensitive: string[] = [];
  const substring: string[] = [];
  const hintLower = hint.toLowerCase();

  graph.forEachNode((nodeId, attrs) => {
    const name = (attrs as SymbolNode).name;
    if (name === hint) exact.push(nodeId);
    else if (name.toLowerCase() === hintLower) caseInsensitive.push(nodeId);
    else if (name.toLowerCase().includes(hintLower) || hintLower.includes(name.toLowerCase())) {
      substring.push(nodeId);
    }
  });

  if (exact.length) return exact;
  if (caseInsensitive.length) return caseInsensitive;
  return substring;
}

function bfs(graph: Graph, anchors: string[], direction: "forward" | "reverse", hopDepth: number): GraphWalkResult[] {
  const visited = new Map<string, number>();
  for (const a of anchors) visited.set(a, 0);
  let frontier = anchors;

  for (let hop = 1; hop <= hopDepth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const neighbors: string[] = [];
      if (direction === "forward") graph.forEachOutNeighbor(nodeId, (n) => neighbors.push(n));
      else graph.forEachInNeighbor(nodeId, (n) => neighbors.push(n));
      for (const n of neighbors) {
        if (!visited.has(n)) {
          visited.set(n, hop);
          next.push(n);
        }
      }
    }
    frontier = next;
  }

  const results: GraphWalkResult[] = [];
  for (const [nodeId, hops] of visited) {
    results.push({ nodeId, symbol: graph.getNodeAttributes(nodeId) as SymbolNode, hops, direction });
  }
  return results;
}

/**
 * Walks both directions from the resolved anchor(s): forward ("what does
 * this transitively call") and reverse ("blast radius" -- what transitively
 * calls this). Deliberate choice, not an oversight: the router extracts a
 * target symbol but not a direction, and running both is cheap (pure graph
 * traversal, no LLM cost) versus guessing wrong on the project's own
 * flagship "what breaks if I change this" question.
 */
export async function traverseGraph(
  repoKey: string,
  targetSymbolHint: string | null,
  hopDepth: number = DEFAULT_HOP_DEPTH
): Promise<GraphWalkResult[]> {
  if (!targetSymbolHint) return [];
  const build = await loadGraph(repoKey);
  if (!build) return [];

  const anchors = findAnchors(build.graph, targetSymbolHint);
  if (anchors.length === 0) return [];

  return [
    ...bfs(build.graph, anchors, "forward", hopDepth),
    ...bfs(build.graph, anchors, "reverse", hopDepth),
  ];
}

/**
 * Shortest path between two named symbols -- part of the three traversal
 * modes originally planned (forward N-hop, reverse N-hop, shortest path).
 * Implemented and exported, but not currently wired into agent/graph.ts:
 * router.ts extracts one target symbol per query, not two, so there's no
 * current caller that has two names to path between. Documented here
 * rather than silently dropped or silently claimed as wired in.
 */
export async function shortestPath(
  repoKey: string,
  fromHint: string,
  toHint: string
): Promise<GraphWalkResult[] | null> {
  const build = await loadGraph(repoKey);
  if (!build) return null;

  const fromAnchors = findAnchors(build.graph, fromHint);
  const toAnchors = findAnchors(build.graph, toHint);
  if (fromAnchors.length === 0 || toAnchors.length === 0) return null;
  const toSet = new Set(toAnchors);

  // Plain BFS shortest path (unweighted graph) from the first matched
  // "from" anchor to the nearest matched "to" anchor.
  const start = fromAnchors[0];
  const prev = new Map<string, string>();
  const visited = new Set<string>([start]);
  let queue = [start];
  let found: string | null = toSet.has(start) ? start : null;

  while (queue.length && !found) {
    const next: string[] = [];
    for (const nodeId of queue) {
      const neighbors: string[] = [];
      build.graph.forEachOutNeighbor(nodeId, (n) => neighbors.push(n));
      for (const n of neighbors) {
        if (visited.has(n)) continue;
        visited.add(n);
        prev.set(n, nodeId);
        if (toSet.has(n)) {
          found = n;
          break;
        }
        next.push(n);
      }
      if (found) break;
    }
    queue = next;
  }

  if (!found) return null;

  const path: string[] = [found];
  let cur = found;
  while (prev.has(cur)) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }

  return path.map((nodeId, i) => ({
    nodeId,
    symbol: build.graph.getNodeAttributes(nodeId) as SymbolNode,
    hops: i,
    direction: "forward" as const,
  }));
}
