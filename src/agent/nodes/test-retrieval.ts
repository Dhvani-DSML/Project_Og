import { ingest } from "../../parser/ingest";
import { traverseGraph, shortestPath } from "./graph-traversal";
import { retrieveByVector, isLowConfidence } from "./vector-retrieval";

async function main() {
  const result = await ingest("sample-repo");
  console.log("repoKey:", result.repoKey);

  console.log("\n--- traverseGraph: 'loadConfig' (expect blast radius upstream: connectDB, ConnectionPool.open, startServer, bootstrap) ---");
  const walk = await traverseGraph(result.repoKey, "loadConfig");
  for (const w of walk) console.log(`  [${w.direction} hop=${w.hops}] ${w.nodeId}`);

  console.log("\n--- traverseGraph: 'startServer' (expect forward: connectDB, loadConfig, validateConfig) ---");
  const walk2 = await traverseGraph(result.repoKey, "startServer");
  for (const w of walk2) console.log(`  [${w.direction} hop=${w.hops}] ${w.nodeId}`);

  console.log("\n--- traverseGraph: nonexistent symbol (expect empty) ---");
  const walk3 = await traverseGraph(result.repoKey, "totallyMadeUpSymbolXYZ");
  console.log(`  ${walk3.length} results`);

  console.log("\n--- shortestPath: bootstrap -> loadConfig ---");
  const path = await shortestPath(result.repoKey, "bootstrap", "loadConfig");
  console.log(path ? path.map((p) => p.nodeId).join(" -> ") : "no path found");

  console.log("\n--- retrieveByVector: 'how is the database connection configured' ---");
  const vres = await retrieveByVector(result.repoKey, "how is the database connection configured");
  for (const v of vres.slice(0, 5)) console.log(`  ${v.id}  score=${v.score.toFixed(4)}`);
  console.log(`  low confidence: ${isLowConfidence(vres)}`);

  console.log("\n--- retrieveByVector: totally unrelated query 'recipe for chocolate cake' ---");
  const vres2 = await retrieveByVector(result.repoKey, "recipe for chocolate cake ingredients");
  for (const v of vres2.slice(0, 5)) console.log(`  ${v.id}  score=${v.score.toFixed(4)}`);
  console.log(`  low confidence: ${isLowConfidence(vres2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
