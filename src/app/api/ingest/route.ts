import { NextRequest, NextResponse } from "next/server";
import { ingest } from "../../../parser/ingest";

// Node.js runtime, not Edge -- extract.ts loads WASM grammars via fs +
// path.join(process.cwd(), ...) and embed.ts reads the bundled ONNX model
// the same way. Edge's runtime doesn't give reliable filesystem access for
// either.
export const runtime = "nodejs";
// Real repos take real time: ky (53 files) measured at ~45s end to end
// (parse, graph, persist, embed, upsert). Larger repos need headroom.
// Vercel's own default/max on Hobby is already 300s with Fluid compute, so
// this is explicit rather than relying on an unstated default, not an
// attempt to exceed any plan's ceiling.
export const maxDuration = 300;

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
