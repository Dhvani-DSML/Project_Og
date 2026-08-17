import { traverseGraph } from "./graph-traversal";
import { retrieveByVector } from "./vector-retrieval";
import { compressContext } from "./compress";
import { generateAnswer } from "./answer";
import type { TaskType } from "../state";

async function run(repoKey: string, query: string, hint: string | null, taskType: TaskType) {
  console.log(`\n=== repoKey=${repoKey}  query="${query}" ===`);
  const [graphResults, vectorResults] = await Promise.all([
    traverseGraph(repoKey, hint),
    retrieveByVector(repoKey, query),
  ]);
  console.log(`graphResults: ${graphResults.length}, vectorResults: ${vectorResults.length}`);

  const { compressedContext, tokenStats } = await compressContext(repoKey, graphResults, vectorResults);
  console.log(`compressedContext: ${compressedContext.length} chunks (${compressedContext.filter((c) => c.verbatim).length} verbatim, ${compressedContext.filter((c) => !c.verbatim).length} summarized)`);
  console.log(`tokenStats:`, tokenStats);

  const { answer, citations } = await generateAnswer(query, compressedContext, taskType);
  console.log(`\nAnswer:\n${answer}`);
  console.log(`\nCitations (${citations.length}):`, citations.map((c) => c.symbolId));
}

async function main() {
  await run("local:D:\\project_og\\sample-repo", "What breaks if I change loadConfig?", "loadConfig", "structural");
  await run(
    "github:typestack/class-validator@develop",
    "What does the IsDefined decorator check, and what would be affected if I changed ValidateBy?",
    "ValidateBy",
    "both"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
