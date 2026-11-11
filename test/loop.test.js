import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runLoop, parseArgs, ConfigError, toolChoiceFor } from "../src/loop.js";
import { executeTool } from "../src/tools.js";
import { buildSystemPrompt } from "../src/prompt.js";

// These tests stub globalThis.fetch, so no real network calls are made.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ENV = { OPENCODE_API_KEY: "test-key", GOOGLE_PLACES_API_KEY: "test-places-key" };

function modelResponse(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    headers: { "content-type": "application/json" },
  });
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

test("food questions reach the model", async () => {
  let modelCalls = 0;
  globalThis.fetch = async () => {
    modelCalls++;
    return modelResponse({ role: "assistant", content: "Go eat chicken rice lah." });
  };

  const reply = await runLoop([], "Uncle, where to eat lunch?", ENV, "test-session");
  assert.equal(reply, "Go eat chicken rice lah.");
  assert.equal(modelCalls, 1);
});

test("the loop stops after MAX_ROUNDS model calls", async () => {
  let modelCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("chat/completions")) {
      modelCalls++;
      return modelResponse({
        role: "assistant",
        content: null,
        tool_calls: [toolCall(`call-${modelCalls}`, "get_bus_arrivals", { stop_code: "bad" })],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const reply = await runLoop([], "next bus?", ENV, "test-session");
  assert.equal(modelCalls, 8);
  assert.match(reply, /too many times/);
});

test("a failing tool is reported to the model instead of crashing the turn", async () => {
  const toolResults = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("chat/completions")) {
      const body = JSON.parse(init.body);
      const last = body.messages.at(-1);
      if (last.role === "tool") {
        toolResults.push(JSON.parse(last.content));
        return modelResponse({ role: "assistant", content: "Weather check failed, bring umbrella." });
      }
      return modelResponse({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("call-1", "get_rain_forecast", {})],
      });
    }
    throw new TypeError("network down");
  };

  const reply = await runLoop([], "will it rain?", ENV, "test-session");
  assert.equal(reply, "Weather check failed, bring umbrella.");
  assert.match(toolResults[0].error, /network down/);
});

test("a model response without choices throws a clear error", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "overloaded" } }), {
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(runLoop([], "hi", ENV, "s-123456"), /no message \(overloaded\)/);
});

test("a missing OPENCODE_API_KEY is a config error", async () => {
  await assert.rejects(runLoop([], "hi", {}, "s-123456"), ConfigError);
});

test("the session id and system prompt stay the same across turns", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ session: init.headers["x-opencode-session"], system: body.messages[0].content });
    return modelResponse({ role: "assistant", content: "ok" });
  };

  await runLoop([], "first", ENV, "conversation-1");
  await runLoop([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }], "second", ENV, "conversation-1");
  assert.equal(seen[0].session, "conversation-1");
  assert.equal(seen[1].session, "conversation-1");
  assert.equal(seen[0].system, seen[1].system);
  assert.equal(seen[0].system, buildSystemPrompt());
});

test("parseArgs handles bad and unusual tool arguments", () => {
  assert.deepEqual(parseArgs('{"query":"laksa"}'), { args: { query: "laksa" } });
  assert.deepEqual(parseArgs({ query: "laksa" }), { args: { query: "laksa" } });
  assert.deepEqual(parseArgs("null"), { args: {} });
  assert.deepEqual(parseArgs(""), { args: {} });
  assert.match(parseArgs("{bad").error, /not valid JSON/);
  assert.match(parseArgs("[1,2]").error, /JSON object/);
});

test("executeTool rejects a bad bus stop code without calling the API", async () => {
  globalThis.fetch = async () => {
    throw new Error("should not be called");
  };
  const result = JSON.parse(await executeTool("get_bus_arrivals", { stop_code: "undefined" }, ENV));
  assert.match(result.error, /five-digit/);
});

test("bus questions force the bus tool on the first round only", () => {
  const forced = { type: "function", function: { name: "get_bus_arrivals" } };
  assert.deepEqual(toolChoiceFor("When is the next 107 bus?", 0), forced);
  assert.deepEqual(toolChoiceFor("next bus at stop 07361", 0), forced);
  assert.equal(toolChoiceFor("When is the next 107 bus?", 1), undefined);
  assert.equal(toolChoiceFor("Where to eat lunch?", 0), undefined);
});

test("a forced tool_choice is sent to the model", async () => {
  const choices = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("chat/completions")) {
      choices.push(JSON.parse(init.body).tool_choice);
      return modelResponse({ role: "assistant", content: "ok" });
    }
    throw new Error("unexpected");
  };
  await runLoop([], "any bus coming?", ENV, "test-session");
  assert.equal(choices[0].function.name, "get_bus_arrivals");
});
