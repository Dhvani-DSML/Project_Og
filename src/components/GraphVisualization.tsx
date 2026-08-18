"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type WalkedEdge = { source: string; target: string };

type Props = {
  walkedNodes: string[];
  walkedEdges: WalkedEdge[];
  targetSymbolHint: string | null;
};

const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 70;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 46;

function parseId(id: string): { file: string; name: string } {
  const idx = id.indexOf("::");
  return idx === -1 ? { file: "", name: id } : { file: id.slice(0, idx), name: id.slice(idx + 2) };
}

/**
 * No auto-layout library (dagre/elkjs) -- for a "small subgraph" (the
 * README's own phrasing), a hand-rolled BFS-layer layout is simpler than
 * pulling in a whole layout engine for a handful of nodes. Roots (no
 * incoming walked edge) sit in column 0; everything else's column is one
 * past its furthest-back predecessor, so the anchor and its blast radius
 * read left-to-right the way the traversal actually happened.
 */
function computeLayout(nodeIds: string[], edges: WalkedEdge[]): Map<string, { x: number; y: number }> {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const e of edges) {
    if (e.source === e.target) continue; // self-loops don't affect layering
    if (!incoming.has(e.target) || !outgoing.has(e.source)) continue;
    incoming.get(e.target)!.add(e.source);
    outgoing.get(e.source)!.add(e.target);
  }

  const column = new Map<string, number>();
  const roots = nodeIds.filter((id) => incoming.get(id)!.size === 0);
  const queue = roots.length > 0 ? [...roots] : [nodeIds[0]];
  for (const r of queue) column.set(r, 0);

  // BFS forward through outgoing edges, column = 1 + max(predecessor columns)
  // seen so far; cap iterations so a dense/cyclic graph can't loop forever.
  //
  // The iteration cap alone isn't enough, though -- it bounds how many times
  // this loop runs, not how large a column value it can reach before it runs
  // out. A genuine multi-node cycle (not just the self-loops filtered above
  // -- e.g. real code found in ky: deepMerge -> deepMergeInternal ->
  // mergeHooks -> newHookValue -> deepMerge) never stabilizes: each lap
  // relaxes every node in the cycle to a higher column, so by the time the
  // guard exhausts, affected nodes can land at columns in the dozens,
  // translating them thousands of pixels outside the panel -- nodes exist
  // correctly in the DOM the whole time, they're just positioned off-screen.
  // Confirmed directly against a live deployment: cycle nodes landed at
  // translate(8360-9020px, ...) while legitimate roots sat at column 0.
  //
  // Capping the column to nodeIds.length closes this: no acyclic layout
  // ever legitimately needs more columns than there are nodes, so this is a
  // no-op for every real DAG case (including the already-verified 112-node
  // ValidateBy graph), and for a cycle it forces convergence -- once a
  // node's column hits the cap, no further candidate can be strictly
  // greater, so the relaxation naturally stops instead of climbing.
  let guard = nodeIds.length * nodeIds.length + 10;
  while (queue.length > 0 && guard-- > 0) {
    const id = queue.shift()!;
    const col = column.get(id)!;
    for (const next of outgoing.get(id) ?? []) {
      const candidate = Math.min(col + 1, nodeIds.length);
      if (!column.has(next) || candidate > column.get(next)!) {
        column.set(next, candidate);
        queue.push(next);
      }
    }
  }
  // Anything never reached by the BFS (disconnected within the walked set,
  // e.g. a vector-only match with no walked edges at all) goes in column 0.
  for (const id of nodeIds) if (!column.has(id)) column.set(id, 0);

  const byColumn = new Map<number, string[]>();
  for (const id of nodeIds) {
    const col = column.get(id)!;
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(id);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const [col, ids] of byColumn) {
    ids.forEach((id, row) => {
      positions.set(id, { x: col * COLUMN_WIDTH, y: row * ROW_HEIGHT });
    });
  }
  return positions;
}

function GraphVisualizationInner({ walkedNodes, walkedEdges, targetSymbolHint }: Props) {
  const computed = useMemo(() => {
    if (walkedNodes.length === 0) return { nodes: [], edges: [] };

    const positions = computeLayout(walkedNodes, walkedEdges);
    const hintLower = targetSymbolHint?.toLowerCase();

    const nodes: Node[] = walkedNodes.map((id) => {
      const { file, name } = parseId(id);
      const isAnchor = hintLower !== undefined && hintLower !== null && name.toLowerCase().endsWith(hintLower);
      const pos = positions.get(id) ?? { x: 0, y: 0 };
      return {
        id,
        position: pos,
        // Both width/height (a size request/style hint) AND measured (what
        // internally marks a node as actually ready) -- confirmed by
        // reading @xyflow/system's adoptUserNodes source directly: it reads
        // userNode.measured.width/height specifically, a different field
        // from the width/height set here, to decide `nodesInitialized`.
        // Without `measured` explicitly set, nodesInitialized stays false
        // forever for nodes that never go through the library's own
        // ResizeObserver pass (which explicit width/height intentionally
        // bypasses) -- and fitView()'s queued fit only ever actually
        // processes when `fitViewQueued && nodesInitialized` are both true,
        // so its returned Promise silently hung forever. Confirmed directly
        // against a live repro: the effect below fired correctly with real
        // node/edge data every time, fitView() was genuinely called every
        // time, and its .then()/.catch() never fired even once.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
        data: { label: `${name}\n${file}` },
        // className adds only a hover glow (see .rf-node:hover in
        // globals.css) -- base colors stay inline below so they reliably
        // beat @xyflow/react/dist/style.css's own default node styling
        // regardless of which stylesheet Next happens to inject last.
        className: "rf-node",
        style: {
          background: isAnchor ? "#0f766e" : "#171a20",
          color: isAnchor ? "#fff" : "#e6e8eb",
          border: isAnchor ? "2px solid #2dd4bf" : "1px solid #2a2d35",
          borderRadius: 8,
          padding: 8,
          fontSize: 11,
          fontFamily: "var(--font-mono), ui-monospace, SF Mono, Consolas, monospace",
          whiteSpace: "pre-line",
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          textAlign: "left" as const,
        },
      };
    });

    const edges: Edge[] = walkedEdges.map((e, i) => ({
      id: `${e.source}->${e.target}-${i}`,
      source: e.source,
      target: e.target,
      animated: false,
      // Literal hex, not var(--accent-teal) -- @xyflow sets this as a raw SVG
      // marker/stroke attribute, not through a CSS-parsed style property, so
      // a CSS custom property reference isn't guaranteed to resolve here.
      style: { stroke: "#2dd4bf", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#2dd4bf", width: 16, height: 16 },
    }));

    return { nodes, edges };
  }, [walkedNodes, walkedEdges, targetSymbolHint]);

  // Controlled state via useNodesState/useEdgesState (the library's own
  // documented pattern) rather than passing computed arrays straight
  // through as props.
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const { setViewport } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed, setNodes, setEdges]);

  // NOT the `fitView` boolean prop on <ReactFlow>, and NOT the imperative
  // fitView() either -- both were tried and both proven unreliable here,
  // not just guessed away:
  //
  // The boolean prop only fits ONCE, at initial mount, against whatever
  // `nodes` holds at that exact instant. useNodesState<Node>([]) starts
  // empty, and the real positions only land a render later via the effect
  // above, so it was fitting to nothing and never re-running once real data
  // arrived. Every graph that ever appeared to render correctly did so by
  // coincidence -- its nodes' raw pixel coordinates happened to fall inside
  // the panel's untouched default viewport (small column counts stay under
  // the panel's own ~785px width).
  //
  // The imperative fitView() looked like the fix -- traced its internals
  // directly, not guessed: it queues via `fitViewQueued` and only resolves
  // once `fitViewQueued && nodesInitialized` are both true, where
  // `nodesInitialized` requires `userNode.measured.width/height` (a
  // different field from the top-level width/height already set below).
  // Added `measured` to fix that gap -- confirmed via direct store
  // inspection that afterward every precondition was genuinely correct
  // (container width/height non-zero, panZoom initialized, measured
  // present) and fitView()'s promise resolved `true` every time, on both
  // local dev and this live deployment. And the viewport still never
  // visually moved off translate(0,0) scale(1). Whatever `fitViewport()`
  // does internally past that point isn't reliably reflected in this
  // component's actual rendered DOM, for a reason not worth chasing
  // further under deadline pressure once a direct alternative exists.
  //
  // `setViewport()` calls the same underlying `panZoom.setViewport()`
  // fitViewport() calls, with none of the queue/nodesInitialized
  // indirection in between -- and since this component already computes
  // every node's exact position itself (computeLayout above), it can
  // compute the required pan/zoom directly instead of asking the library
  // to infer it asynchronously.
  useEffect(() => {
    if (nodes.length === 0 || !containerRef.current) return;
    const container = containerRef.current.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const maxX = Math.max(...nodes.map((n) => n.position.x + NODE_WIDTH));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxY = Math.max(...nodes.map((n) => n.position.y + NODE_HEIGHT));
    const graphWidth = Math.max(maxX - minX, 1);
    const graphHeight = Math.max(maxY - minY, 1);
    const padding = 40;
    const zoom = Math.min(
      (container.width - padding * 2) / graphWidth,
      (container.height - padding * 2) / graphHeight,
      1
    );
    const x = (container.width - graphWidth * zoom) / 2 - minX * zoom;
    const y = (container.height - graphHeight * zoom) / 2 - minY * zoom;
    setViewport({ x, y, zoom }, { duration: 0 });
  }, [nodes, edges, setViewport]);

  if (computed.nodes.length === 0) {
    return <div className="graph-viz-empty">No graph traversal for this query (semantic-only match).</div>;
  }

  return (
    <div className="graph-viz" ref={containerRef}>
      <div className="graph-viz-label">Traversed graph</div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={true}
        onError={(code, message) => console.error(`[ReactFlow ${code}]`, message)}
      >
        <Background color="#22262e" gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// useReactFlow() requires a <ReactFlowProvider> ancestor -- each chat
// message renders its own GraphVisualization instance, so the provider is
// scoped per-instance here rather than once globally, keeping each graph's
// viewport state independent (a later message's graph shouldn't inherit an
// earlier one's pan/zoom).
export default function GraphVisualization(props: Props) {
  return (
    <ReactFlowProvider>
      <GraphVisualizationInner {...props} />
    </ReactFlowProvider>
  );
}
