import { groqChat, MODEL_LARGE } from "../groq.js";
import type { CompressedChunk, Citation } from "../state.js";

const SYSTEM_PROMPT = `You are a code intelligence assistant. Answer the user's question using ONLY the provided context -- a mix of verbatim code and one-line summaries, pulled from the codebase's call graph and semantic search.

When you reference a specific symbol, cite it inline using its exact id in plain ASCII square brackets, e.g. [file.ts::functionName] -- not any other bracket style. Only cite ids that actually appear in the context below. If the context doesn't contain enough information to answer confidently, say so plainly rather than guessing.`;

export async function generateAnswer(
  query: string,
  compressedContext: CompressedChunk[]
): Promise<{ answer: string; citations: Citation[] }> {
  if (compressedContext.length === 0) {
    return {
      answer:
        "I couldn't find anything in this repo's call graph or semantic index relevant to that question. Try rephrasing, or naming a specific function/class.",
      citations: [],
    };
  }

  const contextBlock = compressedContext
    .map((c) => `[${c.id}] (${c.file}:${c.startLine}-${c.endLine})${c.verbatim ? "" : " [summarized]"}\n${c.text}`)
    .join("\n\n");

  const answer = await groqChat(
    MODEL_LARGE,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:\n\n${contextBlock}\n\nQuestion: ${query}` },
    ],
    { temperature: 0.3 }
  );

  // Citations reflect what the model actually cited, not everything that
  // was available -- checking which ids literally appear in the answer text
  // is a real filter, not just "return everything we had." Matches on the
  // full id OR its bare name (the part after "::"), and doesn't require any
  // particular bracket style: confirmed empirically that the model doesn't
  // reliably cite the full id (real response on class-validator's 297-symbol
  // repo cited "[ArrayContains]", not the full
  // "src/decorator/array/ArrayContains.ts::ArrayContains") and doesn't
  // reliably use ASCII brackets either (one response used full-width
  // 【id】). Requiring either exact match silently dropped real citations.
  const citations: Citation[] = compressedContext
    .filter((c) => answer.includes(c.id) || answer.includes(c.id.split("::").pop()!))
    .map((c) => ({ symbolId: c.id, file: c.file, startLine: c.startLine, endLine: c.endLine }));

  return { answer, citations };
}
