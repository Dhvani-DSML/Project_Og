"use client";

import { useEffect, useMemo } from "react";
import { ReactFlow, Background, Controls, MarkerType, useNodesState, useEdgesState, type Node, type Edge } from "@xyflow/react";
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
  let guard = nodeIds.length * nodeIds.length + 10;
  while (queue.length > 0 && guard-- > 0) {
    const id = queue.shift()!;
    const col = column.get(id)!;
    for (const next of outgoing.get(id) ?? []) {
      const candidate = col + 1;
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

export default function GraphVisualization({ walkedNodes, walkedEdges, targetSymbolHint }: Props) {
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
        // Explicit width/height (not just CSS in `style`) so @xyflow/react
        // doesn't have to wait for its own ResizeObserver to report each
        // node's "measured" size before it can compute an edge path against
        // it -- shaves a render pass off the delay between mount and edges
        // actually appearing.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        data: { label: `${name}\n${file}` },
        style: {
          background: isAnchor ? "#4f7cff" : "#171a20",
          color: isAnchor ? "#fff" : "#e6e8eb",
          border: isAnchor ? "2px solid #8ab4ff" : "1px solid #2a2d35",
          borderRadius: 8,
          padding: 8,
          fontSize: 11,
          fontFamily: "ui-monospace, SF Mono, Consolas, monospace",
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
      style: { stroke: "#4f7cff", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#4f7cff", width: 16, height: 16 },
    }));

    return { nodes, edges };
  }, [walkedNodes, walkedEdges, targetSymbolHint]);

  // Controlled state via useNodesState/useEdgesState (the library's own
  // documented pattern) rather than passing computed arrays straight
  // through as props.
  const [nodes, setNodes] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed, setNodes, setEdges]);

  if (computed.nodes.length === 0) {
    return <div className="graph-viz-empty">No graph traversal for this query (semantic-only match).</div>;
  }

  return (
    <div className="graph-viz">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
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
