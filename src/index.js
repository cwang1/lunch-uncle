import ui from "./ui.html";
import { runLoop, ConfigError } from "./loop.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response(ui, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && pathname === "/chat") {
      return handleChat(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 2_000;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const parsed = parseChatBody(body);
  if (parsed.error) {
    return json({ error: parsed.error }, 400);
  }

  try {
    const reply = await runLoop(parsed.history, parsed.message, env, parsed.sessionId);
    return json({ reply });
  } catch (err) {
    console.error("chat failed:", err);
    if (err instanceof ConfigError) {
      return json({ error: "Uncle not set up properly. Tell the person running this app to check the server log." }, 500);
    }
    return json({ error: "Uncle cannot think right now, try again later." }, 502);
  }
}

/**
 * Validate a /chat request body. Returns {error} or the cleaned fields.
 * Only user and assistant text turns are accepted from the client, and only
 * the most recent ones are kept.
 */
export function parseChatBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }

  const { message, history = [], sessionId } = body;

  if (typeof message !== "string" || message.trim() === "") {
    return { error: "message is required" };
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { error: `message must be at most ${MAX_MESSAGE_CHARS} characters` };
  }

  if (!Array.isArray(history)) {
    return { error: "history must be an array" };
  }
  for (const turn of history) {
    if (
      !turn ||
      typeof turn !== "object" ||
      (turn.role !== "user" && turn.role !== "assistant") ||
      typeof turn.content !== "string"
    ) {
      return { error: "history entries must be {role: \"user\" | \"assistant\", content: string}" };
    }
  }

  const cleanHistory = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_HISTORY_CHARS) }));

  return {
    message: message.trim(),
    history: cleanHistory,
    sessionId: typeof sessionId === "string" && SESSION_ID.test(sessionId) ? sessionId : null,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
