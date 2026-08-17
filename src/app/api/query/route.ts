import { NextRequest, NextResponse } from "next/server";
import { agentGraph } from "../../../agent/graph";

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
      tokenStats: result.tokenStats,
      taskType: result.taskType,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
