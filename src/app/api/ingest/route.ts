import { NextRequest, NextResponse } from "next/server";
import { ingest } from "../../../parser/ingest";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const source = (body as { source?: unknown })?.source;
  if (typeof source !== "string" || !source.trim()) {
    return NextResponse.json(
      { error: "Missing 'source' -- a local directory, GitHub URL, or owner/repo shorthand." },
      { status: 400 }
    );
  }

  try {
    const result = await ingest(source);
    return NextResponse.json({
      repoKey: result.repoKey,
      source: result.source,
      stats: result.build.stats,
      persisted: result.persisted,
      embeddedCount: result.embeddedCount,
      vectorsWritten: result.vectorsWritten,
      skippedCount: result.skipped.length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
