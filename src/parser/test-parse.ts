import fs from "node:fs";
import path from "node:path";
import { initParsers, extractFile } from "./extract";
import { buildGraph } from "./graph";

const REPO_DIR = path.join(process.cwd(), "sample-repo");

async function main() {
  await initParsers();

  const files = fs.readdirSync(REPO_DIR).filter((f) => f.endsWith(".ts"));
  const fileGraphs = files.map((f) => {
    const filePath = f; // keep relative, matches import resolution logic
    const source = fs.readFileSync(path.join(REPO_DIR, f), "utf-8");
    return extractFile(filePath, source);
  });

  console.log("--- Symbols found per file ---");
  for (const fg of fileGraphs) {
    console.log(
      `${fg.file}: ${fg.symbols.map((s) => `${s.name} (${s.kind})`).join(", ")}`
    );
  }

  const { graph, stats } = buildGraph(fileGraphs);

  console.log("\n--- Resolution stats ---");
  console.log(stats);

  console.log("\n--- Resolved call edges (this is the graph) ---");
  graph.forEachEdge((edge, attrs, source, target) => {
    console.log(`${source}  --calls-->  ${target}`);
  });

  console.log(
    "\n--- Multi-hop test: what does startServer transitively depend on? ---"
  );
  const start = "server.ts::startServer";
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    graph.forEachOutNeighbor(current, (neighbor) => {
      if (!visited.has(neighbor)) queue.push(neighbor);
    });
  }
  visited.delete(start);
  console.log(`${start} transitively reaches:`);
  for (const v of visited) console.log(`  - ${v}`);

  console.log(
    "\n--- Blast radius test: if config.ts::loadConfig changes signature, what breaks upstream? ---"
  );
  const target = "config.ts::loadConfig";
  const callers = new Set<string>();
  const rq = [target];
  const rvisited = new Set<string>();
  while (rq.length) {
    const current = rq.shift()!;
    if (rvisited.has(current)) continue;
    rvisited.add(current);
    graph.forEachInNeighbor(current, (caller) => {
      callers.add(caller);
      if (!rvisited.has(caller)) rq.push(caller);
    });
  }
  console.log(`Callers that would be affected:`);
  for (const c of callers) console.log(`  - ${c}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
