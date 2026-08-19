import { NextRequest, NextResponse } from "next/server";
import { agentGraph } from "../../../agent/graph";
import { loadGraph } from "../../../parser/graph-store";
import type { SymbolNode } from "../../../parser/extract";
import type { IngestSource } from "../../../parser/ingest";

// Node.js runtime, not Edge -- vector-retrieval.ts embeds the query via the
// same fs-backed local model embed.ts loads for ingestion.
export const runtime = "nodejs";
// The full agent run is router + retrieval + a possible fallback loop +
// batched compression + answer -- each a Groq call, and groqChat's own
// retry loop (up to 3 attempts) waits out whatever reset time Groq reports
// per call, uncapped -- there's no way to shorten that wait without
// retrying before the token bucket has actually refilled, which would just
// fail again. 120s was not enough: confirmed directly in production, a
// compound "both" question (more Groq calls than a single-mode query) hit
// the rate limit twice in a row at 60.5s each -- 121s of waiting alone,
// already past the old ceiling before a 3rd retry was even attempted.
// Raised to 290s, just under Vercel Hobby's actual 300s ceiling (Fluid
// compute enabled by default), so a realistic worst-case retry sequence
// has room to actually complete instead of being killed mid-wait.
export const maxDuration = 290;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const { repoKey, question } = (body as { repoKey?: unknown; question?: unknown }) ?? {};
  if (typeof repoKey !== "string" || !repoKey.trim()) {
    return NextResponse.json({ error: "Missing 'repoKey' -- ingest a repo first via /api/ingest." }, { status: 400 });
  }
  if (typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ error: "Missing 'question'." }, { status: 400 });
  }

  try {
    const result = await agentGraph.invoke({ query: question, repoKey });

    // Enriches walked nodes with file/line data and the repo's GitHub
    // owner/repo/ref, so the graph panel can deep-link a clicked node to its
    // exact lines on GitHub. A second, read-only lookup against the same
    // persisted graph, entirely separate from the agent's own internal
    // traversal state (walkedNodes there is just id strings) -- doesn't
    // touch agent state, graph-traversal.ts, or agent/graph.ts at all.
    let nodeDetails: Record<string, { file: string; startLine: number; endLine: number }> = {};
    let repoSource: IngestSource | null = null;
    if (result.walkedNodes.length > 0) {
      const build = await loadGraph(repoKey);
      if (build) {
        repoSource = build.source;
        for (const id of result.walkedNodes) {
          if (build.graph.hasNode(id)) {
            const attrs = build.graph.getNodeAttributes(id) as SymbolNode;
            nodeDetails[id] = { file: attrs.file, startLine: attrs.startLine, endLine: attrs.endLine };
          }
        }
      }
    }

    return NextResponse.json({
      answer: result.answer,
      citations: result.citations,
      walkedNodes: result.walkedNodes,
      walkedEdges: result.walkedEdges,
      tokenStats: result.tokenStats,
      taskType: result.taskType,
      targetSymbolHint: result.targetSymbolHint,
      nodeDetails,
      repoSource,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
