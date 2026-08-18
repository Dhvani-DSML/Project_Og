import { NextRequest, NextResponse } from "next/server";
import { agentGraph } from "../../../agent/graph";

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
    return NextResponse.json({
      answer: result.answer,
      citations: result.citations,
      walkedNodes: result.walkedNodes,
      walkedEdges: result.walkedEdges,
      tokenStats: result.tokenStats,
      taskType: result.taskType,
      targetSymbolHint: result.targetSymbolHint,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
