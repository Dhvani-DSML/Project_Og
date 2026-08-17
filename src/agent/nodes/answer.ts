import { groqChat, MODEL_LARGE } from "../groq";
import type { CompressedChunk, Citation, TaskType } from "../state";

// Structured output, not text pattern-matching. The first version asked the
// model to cite inline as "[exact-id]" and then grepped the free-text answer
// for those ids -- it broke twice on real data in two different ways (one
// response used full-width brackets, another cited bare names instead of
// full ids on a real 297-symbol repo), and there's no reason a third repo
// wouldn't break it a third way. Adding more string patterns to catch each
// new format as it's discovered doesn't fix the underlying problem; asking
// for citedIds as an explicit JSON field, validated against the actual
// candidate ids, does -- the model can no longer express a citation in a
// shape this code fails to recognize.
const BASE_SYSTEM_PROMPT = `You are a code intelligence assistant. Answer the user's question using ONLY the provided context -- a mix of verbatim code and one-line summaries, pulled from the codebase's call graph and semantic search.

Respond with ONLY a JSON object: {"answer": string, "citedIds": string[]}.
- "answer": your full answer, in plain prose. You may still reference symbols by name for readability, but do not rely on any particular bracket or formatting convention -- citation tracking does not parse this text.
- "citedIds": the exact ids (from the context headers below, e.g. "file.ts::functionName") of every symbol you actually relied on to answer. Only include ids that appear in the context. If the context doesn't contain enough information to answer confidently, say so in "answer" and leave "citedIds" empty rather than guessing.`;

// Every context chunk's id already carries its file (file.ts::name), and
// every walked graph node is grounded in a specific file -- but left to its
// own devices the model tends to answer "what breaks if I change X" as one
// flat list of function names with no file structure, which is a worse
// answer to a question about blast radius than it needs to be: the point of
// walking the graph is knowing exactly where the damage lands, not just
// that it lands somewhere. Only added for structural/both queries -- a
// semantic "explain how X works" question doesn't benefit from being forced
// into file sections the same way.
const FILE_GROUPING_INSTRUCTIONS = `

This question involves the codebase's call graph (structural/blast-radius reasoning). Organize "answer" by file, with exactly one section per distinct file path that appears among the context's ids below (the part before "::") -- never two sections for the same file, even when multiple symbols in it are affected; cover all of that file's affected symbols together as bullet points under its one heading. Each heading line must be the bare file path and nothing else -- no function name, no parenthetical, no suffix. Under each heading, explain specifically what breaks (or is affected) in that file and why, grounded in the actual code shown. Do not produce one flat list of function names with no file grouping, and do not output anything about how many files there are or how you organized the answer -- just the file sections themselves. If every affected symbol is in a single file, write one file section.`;

function buildSystemPrompt(taskType: TaskType): string {
  return taskType === "semantic" ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT + FILE_GROUPING_INSTRUCTIONS;
}

export async function generateAnswer(
  query: string,
  compressedContext: CompressedChunk[],
  taskType: TaskType
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

  const content = await groqChat(
    MODEL_LARGE,
    [
      { role: "system", content: buildSystemPrompt(taskType) },
      { role: "user", content: `Context:\n\n${contextBlock}\n\nQuestion: ${query}` },
    ],
    { jsonMode: true, temperature: 0.3 }
  );

  let parsed: { answer?: unknown; citedIds?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model didn't return valid JSON despite json_object mode -- fail open
    // with the raw text as the answer and no citations, rather than crash
    // the whole query on a formatting hiccup.
    return { answer: content, citations: [] };
  }

  const answer = typeof parsed.answer === "string" ? parsed.answer : content;
  const citedIds = Array.isArray(parsed.citedIds) ? parsed.citedIds.filter((id): id is string => typeof id === "string") : [];

  // Validate against the actual candidates rather than trusting the model's
  // list outright -- guards against a hallucinated id that was never in the
  // context making it into citations.
  const byId = new Map(compressedContext.map((c) => [c.id, c]));
  const citations: Citation[] = citedIds
    .map((id) => byId.get(id))
    .filter((c): c is CompressedChunk => c !== undefined)
    .map((c) => ({ symbolId: c.id, file: c.file, startLine: c.startLine, endLine: c.endLine }));

  return { answer, citations };
}
