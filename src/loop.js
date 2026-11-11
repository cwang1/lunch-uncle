import { buildSystemPrompt, singaporeTime } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// OpenCode Go endpoint (OpenAI-compatible chat completions) and model.
const LLM_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const LLM_MODEL = "kimi-k3";

const LLM_TIMEOUT_MS = 20_000;
// Total time budget for one user turn, across all rounds.
const TURN_BUDGET_MS = 45_000;
const MAX_ROUNDS = 8;
// Caps output (including any reasoning tokens) per model call.
const MAX_OUTPUT_TOKENS = 2_000;

const TOO_MANY_ROUNDS_REPLY =
  "Uncle tried too many times already. Ask something simpler.";
const OUT_OF_TIME_REPLY =
  "Uncle took too long to check. Ask again, maybe simpler.";
const EMPTY_REPLY = "Uncle blur already. Ask again?";

/** Thrown for problems the person running the app has to fix. */
export class ConfigError extends Error {}

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as {role: "user" | "assistant", content}
 * messages, already validated. sessionId should stay the same for the whole
 * conversation so the OpenCode Go endpoint can route and cache consistently.
 */
export async function runLoop(history, message, env, sessionId, options = {}) {
  checkConfig(env);

  const baseUrl = options.baseUrl ?? LLM_BASE_URL;
  const deadline = Date.now() + (options.turnBudgetMs ?? TURN_BUDGET_MS);
  const session = sessionId || crypto.randomUUID();

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: `[${singaporeTime()}] ${message}` },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() >= deadline) {
      return OUT_OF_TIME_REPLY;
    }

    const assistant = await callModel(messages, env, session, baseUrl);
    const toolCalls = Array.isArray(assistant.tool_calls)
      ? assistant.tool_calls
      : [];

    // Drop malformed tool calls; the provider would reject them next round.
    const validCalls = toolCalls.filter(
      (c) => c && typeof c.id === "string" && c.id && c.function?.name,
    );
    if (validCalls.length !== toolCalls.length) {
      console.warn(
        `round ${round}: dropped ${toolCalls.length - validCalls.length} malformed tool call(s)`,
      );
    }

    if (validCalls.length === 0) {
      const text = typeof assistant.content === "string" ? assistant.content.trim() : "";
      return text || EMPTY_REPLY;
    }

    messages.push({ ...assistant, tool_calls: validCalls });

    for (const call of validCalls) {
      const parsed = parseArgs(call.function.arguments);
      console.log(`round ${round}: ${call.function.name}`, parsed.args ?? parsed.error);
      const result = parsed.error
        ? JSON.stringify({ error: parsed.error })
        : await executeTool(call.function.name, parsed.args, env);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return TOO_MANY_ROUNDS_REPLY;
}

function checkConfig(env) {
  if (!LLM_BASE_URL || LLM_BASE_URL.includes("TODO") || !LLM_MODEL || LLM_MODEL.includes("TODO")) {
    throw new ConfigError(
      "LLM_BASE_URL / LLM_MODEL in src/loop.js are not set. See README setup step 4.",
    );
  }
  if (!env.OPENCODE_API_KEY) {
    throw new ConfigError(
      "OPENCODE_API_KEY is not set. Add it to .env for local dev, or with `wrangler secret put` for production.",
    );
  }
  if (!env.GOOGLE_PLACES_API_KEY) {
    console.warn("GOOGLE_PLACES_API_KEY is not set: place search will return an error.");
  }
}

async function callModel(messages, env, sessionId, baseUrl) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
      "user-agent": "lunch-uncle/1.0",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new ConfigError(`LLM rejected the API key (${res.status}). Check OPENCODE_API_KEY.`);
    }
    throw new Error(`LLM returned ${res.status}: ${detail}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("LLM returned a response that is not JSON");
  }

  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    const reason = data?.error?.message ?? data?.choices?.[0]?.finish_reason ?? "no choices";
    throw new Error(`LLM returned no message (${reason})`);
  }
  return message;
}

/**
 * Parse tool-call arguments. Returns {args} on success or {error} that is
 * sent back to the model so it can correct the call.
 */
export function parseArgs(raw) {
  if (raw == null || raw === "") {
    return { args: {} };
  }
  if (typeof raw === "object") {
    return Array.isArray(raw)
      ? { error: "Tool arguments must be a JSON object, not an array." }
      : { args: raw };
  }
  if (typeof raw !== "string") {
    return { error: "Tool arguments must be a JSON object." };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: `Tool arguments are not valid JSON: ${raw.slice(0, 100)}` };
  }
  if (value === null) {
    return { args: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "Tool arguments must be a JSON object." };
  }
  return { args: value };
}
