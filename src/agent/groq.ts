try {
  process.loadEnvFile(".env.local");
} catch {}

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// See README "LLM model choice": Llama 3.3 70B was retired from Groq's
// lineup mid-build. Read from env with these as defaults rather than
// hardcoded, since the lineup has already moved once.
export const MODEL_LARGE = process.env.GROQ_MODEL_LARGE || "openai/gpt-oss-120b";
export const MODEL_SMALL = process.env.GROQ_MODEL_SMALL || "openai/gpt-oss-20b";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function groqChat(
  model: string,
  messages: ChatMessage[],
  opts: { jsonMode?: boolean; temperature?: number } = {}
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0].message.content;
}
