import { classifyQuery } from "./router";

const cases: { q: string; expectTaskType: string; expectHint: string | null | "any" }[] = [
  // Structural: relationship/impact questions
  { q: "What breaks if I change loadConfig?", expectTaskType: "structural", expectHint: "loadConfig" },
  { q: "What does startServer call?", expectTaskType: "structural", expectHint: "startServer" },
  { q: "What would be affected if I removed ConnectionPool.open?", expectTaskType: "structural", expectHint: "ConnectionPool.open" },
  // Semantic: meaning/behavior questions
  { q: "Explain what validateConfig does.", expectTaskType: "semantic", expectHint: "validateConfig" },
  { q: "How does the connection pooling work in this codebase?", expectTaskType: "semantic", expectHint: "any" },
  { q: "Find the code that handles database connection errors.", expectTaskType: "semantic", expectHint: "any" },
  // Both: needs relationship walking AND behavior explanation
  { q: "What does connectDB do, and what else would need to change if I modified it?", expectTaskType: "both", expectHint: "connectDB" },
  { q: "Walk me through everything bootstrap touches and explain each step.", expectTaskType: "both", expectHint: "bootstrap" },
];

async function main() {
  let pass = 0;
  for (const c of cases) {
    const result = await classifyQuery(c.q);
    const taskOk = result.taskType === c.expectTaskType;
    const hintOk =
      c.expectHint === "any"
        ? true
        : c.expectHint === null
        ? result.targetSymbolHint === null
        : result.targetSymbolHint?.toLowerCase().includes(c.expectHint.toLowerCase().split(".").pop()!);
    const ok = taskOk && hintOk;
    if (ok) pass++;
    console.log(
      `[${ok ? "OK" : "MISS"}] "${c.q}"\n   -> taskType=${result.taskType} (expected ${c.expectTaskType})  hint=${JSON.stringify(result.targetSymbolHint)} (expected ${JSON.stringify(c.expectHint)})`
    );
  }
  console.log(`\n${pass}/${cases.length} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
