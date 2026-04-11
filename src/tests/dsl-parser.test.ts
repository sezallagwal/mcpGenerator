import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDsl } from "../dsl/parseDsl.js";

describe("parseDsl", () => {
  // ── Minimal project ──────────────────────────────────────────────────

  it("parses a minimal project with one workflow and one step", () => {
    const dsl = `
PROJECT my-bot
DESCRIPTION A simple bot

WORKFLOW greet
  DESCRIPTION Greets users

  STEP say_hi : api_call
    LABEL Say Hi
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = Hello!
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "my-bot");
    assert.equal(result.description, "A simple bot");
    assert.equal(result.workflows.length, 1);
    assert.equal(result.workflows[0].name, "greet");
    assert.equal(result.workflows[0].description, "Greets users");
    assert.equal(result.workflows[0].steps.length, 1);

    const step = result.workflows[0].steps[0];
    assert.equal(step.id, "say_hi");
    assert.equal(step.type, "api_call");
    assert.equal(step.label, "Say Hi");
    assert.equal(step.operationId, "post-api-v1-chat_postMessage");
    assert.deepEqual(step.inputMapping, {
      channel: "#general",
      text: "Hello!",
    });
  });

  // ── PARAM keyword ────────────────────────────────────────────────────

  it("parses PARAM declarations into workflow params", () => {
    const dsl = `
PROJECT param-test
DESCRIPTION Tests PARAM syntax

WORKFLOW search
  DESCRIPTION Search rooms
  PARAM query : string : The search query
  PARAM room_id : string : The room to search in
  PARAM limit : number : Max results

  STEP do_search : api_call
    OPERATION get-api-v1-chat_search
    MAP roomId = {{params.room_id}}
    MAP searchText = {{params.query}}
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows.length, 1);
    const wf = result.workflows[0];
    assert.ok(wf.params);
    const props = (wf.params as any).properties;
    assert.deepEqual(props.query, {
      type: "string",
      description: "The search query",
    });
    assert.deepEqual(props.room_id, {
      type: "string",
      description: "The room to search in",
    });
    assert.deepEqual(props.limit, {
      type: "number",
      description: "Max results",
    });
  });

  it("parses PARAM without description", () => {
    const dsl = `
PROJECT param-test2
DESCRIPTION Minimal params

WORKFLOW w
  DESCRIPTION test
  PARAM flag : boolean

  STEP s : transform
    EXPRESSION true
`;
    const result = parseDsl(dsl);
    const props = (result.workflows[0].params as any).properties;
    assert.deepEqual(props.flag, { type: "boolean" });
  });

  it("rejects PARAM with invalid type", () => {
    const dsl = `
PROJECT param-test3
DESCRIPTION Bad type

WORKFLOW w
  DESCRIPTION test
  PARAM x : integer

  STEP s : transform
    EXPRESSION true
`;
    assert.throws(() => parseDsl(dsl), /PARAM type "integer" invalid/);
  });

  // ── MAP dot-path reconstruction ──────────────────────────────────────

  it("reconstructs nested objects from MAP dot-paths", () => {
    const dsl = `
PROJECT map-test
DESCRIPTION Tests MAP syntax

WORKFLOW w
  DESCRIPTION test

  STEP send : api_call
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = Hello
    MAP message.tmid = {{params.threadId}}
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[0].inputMapping, {
      message: {
        rid: "{{params.room.id}}",
        msg: "Hello",
        tmid: "{{params.threadId}}",
      },
    });
  });

  // ── MAP value type inference ─────────────────────────────────────────

  it("infers correct types for MAP values", () => {
    const dsl = `
PROJECT type-test
DESCRIPTION Tests value type inference

WORKFLOW w
  DESCRIPTION test

  STEP call : api_call
    OPERATION get-api-v1-channels_list
    MAP count = 5
    MAP sort = {"msgs": -1}
    MAP active = true
    MAP name = {{params.query}}
    MAP items = ["a", "b"]
`;
    const result = parseDsl(dsl);
    const mapping = result.workflows[0].steps[0].inputMapping!;
    assert.equal(mapping.count, 5);
    assert.deepEqual(mapping.sort, { msgs: -1 });
    assert.equal(mapping.active, true);
    assert.equal(mapping.name, "{{params.query}}");
    assert.deepEqual(mapping.items, ["a", "b"]);
  });

  // ── Heredoc parsing ──────────────────────────────────────────────────

  it("parses heredoc expressions", () => {
    const dsl = `
PROJECT heredoc-test
DESCRIPTION Tests heredoc

WORKFLOW w
  DESCRIPTION test

  STEP merge : transform
    EXPRESSION <<<
      const a = steps.first || [];
      const b = steps.second || [];
      return [...a, ...b]
    >>>
`;
    const result = parseDsl(dsl);
    const expr = result.workflows[0].steps[0].expression!;
    assert.ok(expr.includes("const a = steps.first || [];"));
    assert.ok(expr.includes("return [...a, ...b]"));
  });

  it("parses heredoc prompts", () => {
    const dsl = `
PROJECT heredoc-test
DESCRIPTION Tests heredoc prompt

WORKFLOW w
  DESCRIPTION test

  STEP ask : sampling
    PROMPT <<<
      Query: {{params.query}}
      Results: {{steps.search}}
    >>>
    MAX_TOKENS 500
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.ok(step.prompt!.includes("Query: {{params.query}}"));
    assert.ok(step.prompt!.includes("Results: {{steps.search}}"));
    assert.equal(step.maxTokens, 500);
  });

  // ── DEPENDS ON ───────────────────────────────────────────────────────

  it("parses DEPENDS ON with multiple steps", () => {
    const dsl = `
PROJECT deps-test
DESCRIPTION Test dependencies

WORKFLOW w
  DESCRIPTION test

  STEP root : transform
    EXPRESSION true

  STEP a : transform
    DEPENDS ON root
    EXPRESSION 1

  STEP b : transform
    DEPENDS ON root a
    EXPRESSION 2
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[1].dependsOn, ["root"]);
    assert.deepEqual(result.workflows[0].steps[2].dependsOn, ["root", "a"]);
  });

  // ── Conditional step ─────────────────────────────────────────────────

  it("parses conditional with THEN and ELSE", () => {
    const dsl = `
PROJECT cond-test
DESCRIPTION Test conditional

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION true

  STEP gate : conditional
    DEPENDS ON check
    CONDITION steps.check === true
    THEN handle_yes
    ELSE handle_no

  STEP handle_yes : api_call
    DEPENDS ON gate
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = Yes

  STEP handle_no : api_call
    DEPENDS ON gate
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #general
    MAP text = No
`;
    const result = parseDsl(dsl);
    const gate = result.workflows[0].steps[1];
    assert.equal(gate.type, "conditional");
    assert.equal(gate.condition, "steps.check === true");
    assert.equal(gate.thenStep, "handle_yes");
    assert.equal(gate.elseStep, "handle_no");
  });

  it("parses conditional with THEN only (no ELSE)", () => {
    const dsl = `
PROJECT cond-test
DESCRIPTION Test conditional no else

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION true

  STEP gate : conditional
    DEPENDS ON check
    CONDITION steps.check !== null
    THEN proceed
`;
    const result = parseDsl(dsl);
    const gate = result.workflows[0].steps[1];
    assert.equal(gate.thenStep, "proceed");
    assert.equal(gate.elseStep, undefined);
  });

  // ── Sampling step ────────────────────────────────────────────────────

  it("parses sampling with systemPrompt, responseFormat, maxTokens", () => {
    const dsl = `
PROJECT sampling-test
DESCRIPTION Test sampling

WORKFLOW w
  DESCRIPTION test

  STEP analyze : sampling
    SYSTEM_PROMPT You are an analyst.
    PROMPT Analyze: {{params.query}}
    RESPONSE_FORMAT json
    MAX_TOKENS 2000
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.equal(step.type, "sampling");
    assert.equal(step.systemPrompt, "You are an analyst.");
    assert.equal(step.prompt, "Analyze: {{params.query}}");
    assert.equal(step.responseFormat, "json");
    assert.equal(step.maxTokens, 2000);
  });

  it("parses CONTENT_TEXT and CONTENT_IMAGE", () => {
    const dsl = `
PROJECT content-test
DESCRIPTION Test content array

WORKFLOW w
  DESCRIPTION test

  STEP analyze : sampling
    DEPENDS ON extract
    CONTENT_TEXT Does this image violate content policy?
    CONTENT_IMAGE {{steps.extract}}
    RESPONSE_FORMAT json
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.deepEqual(step.content, [
      { type: "text", text: "Does this image violate content policy?" },
      { type: "image", url: "{{steps.extract}}" },
    ]);
  });

  // ── Elicitation step ─────────────────────────────────────────────────

  it("parses elicitation with SCHEMA and ON_DECLINE", () => {
    const dsl = `
PROJECT elicit-test
DESCRIPTION Test elicitation

WORKFLOW w
  DESCRIPTION test

  STEP ask : elicitation
    MESSAGE How should I format the results?
    SCHEMA {"type":"object","properties":{"format":{"type":"string","enum":["brief","detailed"]}},"required":["format"]}
    ON_DECLINE skip_remaining
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[0];
    assert.equal(step.type, "elicitation");
    assert.equal(step.message, "How should I format the results?");
    assert.deepEqual(step.requestedSchema, {
      type: "object",
      properties: {
        format: { type: "string", enum: ["brief", "detailed"] },
      },
      required: ["format"],
    });
    assert.equal(step.onDecline, "skip_remaining");
  });

  // ── FOR_EACH / AS ────────────────────────────────────────────────────

  it("parses FOR_EACH and AS", () => {
    const dsl = `
PROJECT loop-test
DESCRIPTION Test forEach

WORKFLOW w
  DESCRIPTION test

  STEP get_items : api_call
    OPERATION get-api-v1-channels_list

  STEP process : api_call
    DEPENDS ON get_items
    OPERATION get-api-v1-chat_getPinnedMessages
    FOR_EACH {{steps.get_items.channels}}
    AS chan
    MAP roomId = {{chan._id}}
    MAP count = 20
`;
    const result = parseDsl(dsl);
    const step = result.workflows[0].steps[1];
    assert.equal(step.forEach, "{{steps.get_items.channels}}");
    assert.equal(step.as, "chan");
  });

  // ── Webhook ──────────────────────────────────────────────────────────

  it("parses WEBHOOK endpoints", () => {
    const dsl = `
PROJECT webhook-test
DESCRIPTION Test webhooks

WORKFLOW w
  DESCRIPTION test

  STEP noop : transform
    EXPRESSION true

WEBHOOK /incoming-alert
  DESCRIPTION Receives external alert payloads
  METHODS post

WEBHOOK /status
  DESCRIPTION Health check
  METHODS get post
`;
    const result = parseDsl(dsl);
    assert.equal(result.webhookEndpoints!.length, 2);
    assert.equal(result.webhookEndpoints![0].path, "/incoming-alert");
    assert.equal(
      result.webhookEndpoints![0].description,
      "Receives external alert payloads",
    );
    assert.deepEqual(result.webhookEndpoints![0].methods, ["post"]);
    assert.deepEqual(result.webhookEndpoints![1].methods, ["get", "post"]);
  });

  // ── Comments and blank lines ─────────────────────────────────────────

  it("ignores comments and blank lines", () => {
    const dsl = `
# This is a comment
PROJECT comment-test
DESCRIPTION Test comments

# Another comment
WORKFLOW w
  DESCRIPTION test

  # Step comment
  STEP noop : transform
    EXPRESSION true
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "comment-test");
    assert.equal(result.workflows[0].steps.length, 1);
  });

  // ── Multiple workflows ───────────────────────────────────────────────

  it("parses multiple workflows in one DSL", () => {
    const dsl = `
PROJECT multi-test
DESCRIPTION Multiple workflows

WORKFLOW first
  DESCRIPTION First workflow

  STEP a : transform
    EXPRESSION 1

WORKFLOW second
  DESCRIPTION Second workflow

  STEP b : transform
    EXPRESSION 2

WORKFLOW third
  DESCRIPTION Third workflow

  STEP c : transform
    EXPRESSION 3
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows.length, 3);
    assert.equal(result.workflows[0].name, "first");
    assert.equal(result.workflows[1].name, "second");
    assert.equal(result.workflows[2].name, "third");
  });

  // ── Full kb_search round-trip ────────────────────────────────────────

  it("parses the full kb_search example", () => {
    const dsl = `
PROJECT team-hub
DESCRIPTION Knowledge-base search via slash command and image moderation

WORKFLOW kb_search
  DESCRIPTION Search pinned and matched messages, AI-rank, confirm, reply


  STEP get_channels : api_call
    LABEL Fetch Top Channels
    OPERATION get-api-v1-channels_list
    MAP count = 5
    MAP sort = {"msgs": -1}

  STEP fetch_pinned : api_call
    LABEL Get Pinned Per Channel
    DEPENDS ON get_channels
    OPERATION get-api-v1-chat_getPinnedMessages
    FOR_EACH {{steps.get_channels.channels}}
    AS channel
    MAP roomId = {{channel._id}}
    MAP count = 20

  STEP search_msgs : api_call
    LABEL Search Per Channel
    DEPENDS ON get_channels
    OPERATION get-api-v1-chat_search
    FOR_EACH {{steps.get_channels.channels}}
    AS ch
    MAP roomId = {{ch._id}}
    MAP searchText = {{params.query}}
    MAP count = 10

  STEP merge : transform
    LABEL Merge All Results
    DEPENDS ON fetch_pinned search_msgs
    EXPRESSION <<<
      const pinned = (steps.fetch_pinned || []).flatMap(r => r?.messages || []);
      const searched = (steps.search_msgs || []).flatMap(r => r?.messages || []);
      return [...pinned, ...searched].map(m => ({ id: m._id, text: m.msg, author: m.u?.username, room: m.rid }))
    >>>

  STEP rank : sampling
    LABEL AI-Rank Results
    DEPENDS ON merge
    SYSTEM_PROMPT You are a knowledge-base search assistant. Rank results by relevance.
    PROMPT <<<
      Query: {{params.query}}
      Candidate messages:
      {{steps.merge}}
      Return JSON: { results: [{ id, text, author, room, score }], hasRelevant: boolean }
    >>>
    RESPONSE_FORMAT json
    MAX_TOKENS 2000

  STEP check_found : conditional
    LABEL Any Relevant?
    DEPENDS ON rank
    CONDITION steps.rank.hasRelevant === true
    THEN ask_format
    ELSE suggest_help

  STEP ask_format : elicitation
    LABEL Ask User Preferences
    DEPENDS ON check_found
    MESSAGE Found results. How should I present them?
    SCHEMA {"type":"object","properties":{"format":{"type":"string","enum":["brief","detailed"]},"maxResults":{"type":"number"}},"required":["format"]}
    ON_DECLINE skip_remaining

  STEP compile : sampling
    LABEL Compile Final Answer
    DEPENDS ON ask_format
    PROMPT <<<
      User wants a {{steps.ask_format.format ?? "brief"}} summary.
      Compile the top {{steps.ask_format.maxResults ?? 3}} results:
      {{steps.rank.results}}
    >>>

  STEP reply_thread : api_call
    LABEL Reply in Thread
    DEPENDS ON compile
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = {{steps.compile}}
    MAP message.tmid = {{params.threadId}}

  STEP log_search : api_call
    LABEL Log to Channel
    DEPENDS ON compile
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #kb-activity
    MAP text = Search by @{{params.sender.username}}: {{params.query}}

  STEP save_state : transform
    LABEL Update History
    DEPENDS ON compile
    EXPRESSION ({ queries: [...(params.searchHistory?.queries || []).slice(-9), params.query] })

  STEP suggest_help : api_call
    LABEL Suggest Help
    DEPENDS ON check_found
    OPERATION post-api-v1-chat_sendMessage
    MAP message.rid = {{params.room.id}}
    MAP message.msg = No results for "{{params.query}}". Try #help.
    MAP message.tmid = {{params.threadId}}
`;
    const result = parseDsl(dsl);
    assert.equal(result.projectName, "team-hub");
    assert.equal(result.workflows.length, 1);

    const wf = result.workflows[0];
    assert.equal(wf.name, "kb_search");
    assert.equal(wf.steps.length, 12);

    // API call with MAP dot-path
    const replyThread = wf.steps.find((s) => s.id === "reply_thread")!;
    assert.deepEqual(replyThread.inputMapping, {
      message: {
        rid: "{{params.room.id}}",
        msg: "{{steps.compile}}",
        tmid: "{{params.threadId}}",
      },
    });

    // forEach/as
    const fetchPinned = wf.steps.find((s) => s.id === "fetch_pinned")!;
    assert.equal(fetchPinned.forEach, "{{steps.get_channels.channels}}");
    assert.equal(fetchPinned.as, "channel");

    // Conditional
    const checkFound = wf.steps.find((s) => s.id === "check_found")!;
    assert.equal(checkFound.thenStep, "ask_format");
    assert.equal(checkFound.elseStep, "suggest_help");

    // Elicitation
    const askFormat = wf.steps.find((s) => s.id === "ask_format")!;
    assert.ok(askFormat.requestedSchema);
    assert.equal(askFormat.onDecline, "skip_remaining");
  });

  // ── Error cases ──────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws on missing PROJECT", () => {
      const dsl = `
WORKFLOW w
  DESCRIPTION test
  STEP noop : transform
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Missing PROJECT/);
    });

    it("throws on missing DESCRIPTION", () => {
      const dsl = `
PROJECT test
WORKFLOW w
  DESCRIPTION test
  STEP noop : transform
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Missing project DESCRIPTION/);
    });

    it("throws on no workflows", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
`;
      assert.throws(() => parseDsl(dsl), /No WORKFLOW/);
    });

    it("throws on invalid step type", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad : unknown_type
    EXPRESSION true
`;
      assert.throws(() => parseDsl(dsl), /Unknown step type/);
    });

    it("throws on unterminated heredoc", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP t : transform
    EXPRESSION <<<
      some code here
`;
      assert.throws(() => parseDsl(dsl), /Unterminated heredoc/);
    });

    it("throws on STEP without colon separator", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP bad_step transform
`;
      assert.throws(() => parseDsl(dsl), /STEP requires format/);
    });

    it("throws on invalid SCHEMA JSON", () => {
      const dsl = `
PROJECT test
DESCRIPTION test
WORKFLOW w
  DESCRIPTION test
  STEP ask : elicitation
    MESSAGE test
    SCHEMA {not valid json}
`;
      assert.throws(() => parseDsl(dsl), /SCHEMA value must be valid JSON/);
    });
  });

  // ── Inline single-line expression ────────────────────────────────────

  it("parses inline single-line expression", () => {
    const dsl = `
PROJECT inline-test
DESCRIPTION Test inline

WORKFLOW w
  DESCRIPTION test

  STEP check : transform
    EXPRESSION params.message ? true : false
`;
    const result = parseDsl(dsl);
    assert.equal(
      result.workflows[0].steps[0].expression,
      "params.message ? true : false",
    );
  });

  // ── CONTINUE_ON_ERROR ────────────────────────────────────────────────

  it("parses CONTINUE_ON_ERROR flag", () => {
    const dsl = `
PROJECT err-test
DESCRIPTION Test continueOnError

WORKFLOW w
  DESCRIPTION test

  STEP risky : api_call
    OPERATION post-api-v1-chat_postMessage
    MAP channel = #test
    MAP text = hi
    CONTINUE_ON_ERROR
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows[0].steps[0].continueOnError, true);
  });

  // ── OUTPUT_PATH ──────────────────────────────────────────────────────

  it("parses OUTPUT_PATH", () => {
    const dsl = `
PROJECT path-test
DESCRIPTION Test outputPath

WORKFLOW w
  DESCRIPTION test

  STEP get : api_call
    OPERATION get-api-v1-channels_list
    OUTPUT_PATH channels
`;
    const result = parseDsl(dsl);
    assert.equal(result.workflows[0].steps[0].outputPath, "channels");
  });

  // ── SCHEMA via heredoc ───────────────────────────────────────────────

  it("parses SCHEMA as heredoc JSON", () => {
    const dsl = `
PROJECT schema-heredoc
DESCRIPTION Test heredoc schema

WORKFLOW w
  DESCRIPTION test

  STEP ask : elicitation
    MESSAGE Pick format
    SCHEMA <<<
      {
        "type": "object",
        "properties": {
          "fmt": { "type": "string" }
        }
      }
    >>>
`;
    const result = parseDsl(dsl);
    assert.deepEqual(result.workflows[0].steps[0].requestedSchema, {
      type: "object",
      properties: { fmt: { type: "string" } },
    });
  });
});
