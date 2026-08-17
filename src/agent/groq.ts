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

function parseResetSeconds(header: string | null): number {
  // Groq returns e.g. "23.37s" or "1m31.2s" in x-ratelimit-reset-tokens.
  if (!header) return 10;
  const minutes = /(\d+(?:\.\d+)?)m/.exec(header);
  const seconds = /(\d+(?:\.\d+)?)s/.exec(header);
  return (minutes ? parseFloat(minutes[1]) * 60 : 0) + (seconds ? parseFloat(seconds[1]) : 0);
}

const MAX_RETRIES = 3;

/**
 * Free-tier Groq's per-minute token budget (8000 TPM at time of writing) is
 * low enough that a real repo's compress/answer calls hit it routinely --
 * confirmed directly, not hypothesized: both compress.ts's batched
 * summarization and answer.ts's single context call independently hit 429s
 * against the real 297-symbol class-validator ingest. Retrying with the
 * exact wait time Groq reports (x-ratelimit-reset-tokens), rather than a
 * guessed backoff, is the correct handling for an expected, recoverable
 * condition -- not something to paper over by shrinking context until it
 * stops happening to show up in testing.
 */
export async function groqChat(
  model: string,
  messages: ChatMessage[],
  opts: { jsonMode?: boolean; temperature?: number } = {}
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitSeconds = parseResetSeconds(res.headers.get("x-ratelimit-reset-tokens")) + 0.5;
      console.warn(`Groq rate limit hit, waiting ${waitSeconds.toFixed(1)}s before retry ${attempt + 1}/${MAX_RETRIES}...`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Groq API error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }

  throw new Error(`Groq API rate limit exceeded after ${MAX_RETRIES} retries`);
}
