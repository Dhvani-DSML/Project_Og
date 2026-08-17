import { groqChat, MODEL_SMALL } from "../groq";
import type { TaskType } from "../state";

const SYSTEM_PROMPT = `You are the router for a code-intelligence agent that answers questions about a codebase using two complementary tools:

- STRUCTURAL: walks the actual function call graph (who calls what, what depends on what). Best for questions about relationships, dependencies, or impact -- e.g. "what breaks if I change X", "what does X call", "what depends on Y", "what would be affected by removing Z", "everything X touches", "walk me through what X uses".
- SEMANTIC: vector similarity search over function/class descriptions and code. Best for questions about meaning or behavior -- e.g. "explain what X does", "how does Y work", "find code that handles Z".

Classify the user's question as exactly one of "structural", "semantic", or "both" (when it needs relationship-walking AND behavior explanation together).

Also extract the single most likely function/class/method name the question is about, if one is named or clearly implied (e.g. "loadConfig", "ConnectionPool.open"). If no specific symbol is named or implied, use null.

Respond with ONLY a JSON object, no other text: {"taskType": "structural" | "semantic" | "both", "targetSymbolHint": string | null}`;

export type RouterResult = {
  taskType: TaskType;
  targetSymbolHint: string | null;
};

const VALID_TASK_TYPES: TaskType[] = ["structural", "semantic", "both"];

export async function classifyQuery(query: string): Promise<RouterResult> {
  const content = await groqChat(
    MODEL_SMALL,
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: query },
    ],
    { jsonMode: true, temperature: 0 }
  );

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Model didn't return valid JSON despite json_object mode -- fail open
    // to "both" rather than crash the whole query on a router hiccup.
    return { taskType: "both", targetSymbolHint: null };
  }

  const taskType: TaskType = VALID_TASK_TYPES.includes(parsed.taskType) ? parsed.taskType : "both";
  const targetSymbolHint =
    typeof parsed.targetSymbolHint === "string" && parsed.targetSymbolHint.trim()
      ? parsed.targetSymbolHint.trim()
      : null;

  return { taskType, targetSymbolHint };
}
