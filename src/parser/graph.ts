import Graph from "graphology";
import type { FileGraph, SymbolNode, Edge } from "./extract.js";

export type BuildResult = {
  graph: Graph;
  stats: {
    files: number;
    symbols: number;
    totalCalls: number;
    resolvedCalls: number;
    resolutionRate: string;
  };
};

/**
 * Resolves a raw import path like "./config" relative to the importing
 * file, and tries common extensions. Heuristic — no real module resolver.
 */
function resolveImportPath(fromFile: string, rawPath: string): string {
  if (!rawPath.startsWith(".")) return rawPath; // external package, leave as-is
  // Modern ESM-style TS (NodeNext resolution, Deno, Bun) writes relative
  // imports with an explicit extension, e.g. `from "./foo.ts"`. Strip it so
  // this compares equal to a candidate file's extension-stripped path below.
  const stripped = rawPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
  const fromDir = fromFile.split("/").slice(0, -1).join("/");
  const parts = (fromDir ? fromDir + "/" + stripped : stripped).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

export function buildGraph(fileGraphs: FileGraph[]): BuildResult {
  const graph = new Graph({ multi: true, type: "directed" });

  // 1. Index every symbol by (file, name) so we can look it up during resolution.
  const symbolsByFile = new Map<string, Map<string, SymbolNode>>();
  for (const fg of fileGraphs) {
    const m = new Map<string, SymbolNode>();
    for (const s of fg.symbols) m.set(s.name, s);
    symbolsByFile.set(fg.file, m);
    for (const s of fg.symbols) {
      if (!graph.hasNode(s.id)) {
        graph.addNode(s.id, { ...s });
      }
    }
  }

  // Also index EXPORTED symbols by bare name across the whole repo, as a
  // fallback for cases where exact path resolution misses (e.g. barrel
  // files, path aliases). This is what makes resolution "best effort"
  // rather than "exact" — documented as a known limitation.
  const exportedByName = new Map<string, SymbolNode[]>();
  for (const fg of fileGraphs) {
    for (const s of fg.symbols) {
      if (s.exported) {
        const list = exportedByName.get(s.name) ?? [];
        list.push(s);
        exportedByName.set(s.name, list);
      }
    }
  }

  let resolvedCalls = 0;
  let totalCalls = 0;

  for (const fg of fileGraphs) {
    // Build a local resolution map: local name -> file it was imported from
    const importMap = new Map<string, string>();
    for (const imp of fg.imports) {
      importMap.set(imp.localName, resolveImportPath(fg.file, imp.sourcePath));
    }

    for (const edge of fg.edges) {
      totalCalls++;
      let targetSymbol: SymbolNode | undefined;

      // Case 1: call to something imported into this file
      const importedFrom = importMap.get(edge.to);
      if (importedFrom) {
        // try exact resolved path against known files (with .ts/.tsx guess)
        for (const candidateFile of fileGraphs.map((f) => f.file)) {
          const withoutExt = candidateFile.replace(/\.(ts|tsx|js|jsx)$/, "");
          if (withoutExt === importedFrom) {
            targetSymbol = symbolsByFile.get(candidateFile)?.get(edge.to);
            break;
          }
        }
      }

      // Case 2: call to something defined in the same file
      if (!targetSymbol) {
        targetSymbol = symbolsByFile.get(fg.file)?.get(edge.to);
      }

      // Case 3: fallback — unique exported symbol with this name anywhere in repo
      if (!targetSymbol) {
        const candidates = exportedByName.get(edge.to);
        if (candidates && candidates.length === 1) {
          targetSymbol = candidates[0];
        }
      }

      if (targetSymbol) {
        resolvedCalls++;
        if (!graph.hasEdge(edge.from, targetSymbol.id)) {
          graph.addEdge(edge.from, targetSymbol.id, {
            type: "calls",
            resolved: true,
          });
        }
      }
      // unresolved calls are intentionally dropped from the graph, not
      // added as dangling nodes — keeps the graph clean for traversal.
    }
  }

  return {
    graph,
    stats: {
      files: fileGraphs.length,
      symbols: graph.order,
      totalCalls,
      resolvedCalls,
      resolutionRate:
        totalCalls === 0
          ? "n/a"
          : `${Math.round((resolvedCalls / totalCalls) * 100)}%`,
    },
  };
}
