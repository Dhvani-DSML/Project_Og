import { agentGraph } from "./graph";

async function run(repoKey: string, query: string) {
  console.log(`\n${"=".repeat(70)}\nrepoKey=${repoKey}\nquery="${query}"\n${"=".repeat(70)}`);
  const result = await agentGraph.invoke({ query, repoKey });

  console.log(`taskType: ${result.taskType}  targetSymbolHint: ${JSON.stringify(result.targetSymbolHint)}`);
  console.log(`fallbackAttempted: ${result.fallbackAttempted}  hopDepth: ${result.hopDepth}`);
  console.log(`graphResults: ${result.graphResults.length}  vectorResults: ${result.vectorResults.length}`);
  console.log(`walkedNodes (${result.walkedNodes.length}): ${JSON.stringify(result.walkedNodes)}`);
  console.log(`walkedEdges (${result.walkedEdges.length}): ${result.walkedEdges.map((e: any) => `${e.source} -> ${e.target}`).join(", ")}`);
  console.log(`tokenStats:`, result.tokenStats);
  console.log(`citations: ${JSON.stringify(result.citations.map((c: any) => c.symbolId))}`);
  console.log(`\nAnswer:\n${result.answer}`);
}

async function main() {
  const sampleRepoKey = "local:D:\\project_og\\sample-repo";

  // Structural, real anchor -- normal path, no fallback expected.
  await run(sampleRepoKey, "What breaks if I change loadConfig?");

  // Semantic, no named symbol -- normal path.
  await run(sampleRepoKey, "How does the connection pooling work in this codebase?");

  // Both -- fan-out path.
  await run(sampleRepoKey, "What does connectDB do, and what else would need to change if I modified it?");

  // Structural with a symbol that doesn't exist -- should trigger the
  // graphQualityGate's empty-anchor fallback to vectorRetrieval.
  await run(sampleRepoKey, "What breaks if I change totallyMadeUpSymbolXYZ?");

  // Real repo, real scale (297 symbols) -- not just sample-repo's toy graph.
  await run(
    "github:typestack/class-validator@develop",
    "What would be affected if I changed ValidateBy?"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
