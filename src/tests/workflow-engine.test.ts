import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTemplate,
  resolveMapping,
  extractPath,
  parseResult,
  shouldRun,
  detectJsonIntent,
  extractJson,
  autoReturn,
  runWorkflow,
  _resetCliCache,
  type StepDefinition,
} from "../mcp-server/workflow-engine.js";

describe("resolveTemplate", () => {
  it("resolves {{params.*}} references", () => {
    const result = resolveTemplate(
      "Hello {{params.name}}!",
      { name: "Alice" },
      {},
    );
    assert.equal(result, "Hello Alice!");
  });

  it("resolves nested {{params.*}} references", () => {
    const result = resolveTemplate(
      "Room: {{params.room.id}}",
      { room: { id: "R123" } },
      {},
    );
    assert.equal(result, "Room: R123");
  });

  it("resolves {{steps.*}} references", () => {
    const result = resolveTemplate(
      "Got: {{steps.fetch.result.name}}",
      {},
      { fetch: { result: { name: "general" } } },
    );
    assert.equal(result, "Got: general");
  });

  it("resolves nested step result properties", () => {
    const result = resolveTemplate(
      "Val: {{steps.analyze.result.score}}",
      {},
      { analyze: { result: { score: 42, label: "good" } } },
    );
    assert.equal(result, "Val: 42");
  });

  it("evaluates ternary expressions", () => {
    const result = resolveTemplate(
      "{{params.score > 5 ? 'high' : 'low'}}",
      { score: 10 },
      {},
    );
    assert.equal(result, "high");
  });

  it("evaluates ternary with step results", () => {
    const result = resolveTemplate(
      "Status: {{steps.check.result.violated ? 'YES (' + steps.check.result.policy + ')' : 'NO'}}",
      {},
      { check: { result: { violated: true, policy: "No spam" } } },
    );
    assert.equal(result, "Status: YES (No spam)");
  });

  it("evaluates false branch of ternary", () => {
    const result = resolveTemplate(
      "{{steps.check.result.violated ? 'BAD' : 'OK'}}",
      {},
      { check: { result: { violated: false } } },
    );
    assert.equal(result, "OK");
  });

  it("handles syntax errors in expressions gracefully", () => {
    const result = resolveTemplate(
      "Hello {{invalid syntax ???}} world",
      {},
      {},
    );
    assert.equal(result, "Hello  world");
  });

  it("resolves {{params}} as full JSON", () => {
    const result = resolveTemplate("Data: {{params}}", { a: 1, b: 2 }, {});
    assert.equal(result, 'Data: {"a":1,"b":2}');
  });

  it("resolves object values as JSON strings", () => {
    const result = resolveTemplate(
      "Val: {{params.data}}",
      { data: { x: 1 } },
      {},
    );
    assert.equal(result, 'Val: {"x":1}');
  });

  it("resolves missing values as empty string", () => {
    const result = resolveTemplate("Val: {{params.missing}}", {}, {});
    assert.equal(result, "Val: ");
  });

  it("strips bracket-wrapped references", () => {
    const result = resolveTemplate("{{[params.name]}}", { name: "Bob" }, {});
    assert.equal(result, "Bob");
  });
});

describe("resolveMapping", () => {
  it("passes static values through", () => {
    const result = resolveMapping({ key: "value", num: 42 }, {}, {});
    assert.deepEqual(result, { key: "value", num: 42 });
  });

  it("resolves template strings", () => {
    const result = resolveMapping(
      { name: "{{params.user}}" },
      { user: "Alice" },
      {},
    );
    assert.deepEqual(result, { name: "Alice" });
  });

  it("recursively resolves nested objects", () => {
    const result = resolveMapping(
      { message: { msg: "Hello {{params.name}}", rid: "R1" } },
      { name: "World" },
      {},
    );
    assert.deepEqual(result, { message: { msg: "Hello World", rid: "R1" } });
  });

  it("parses JSON results from object references", () => {
    const result = resolveMapping(
      { data: "{{params.obj}}" },
      { obj: { a: 1 } },
      {},
    );
    assert.deepEqual(result, { data: { a: 1 } });
  });

  it("preserves static arrays", () => {
    const result = resolveMapping({ items: [1, 2, 3] }, {}, {});
    assert.deepEqual(result, { items: [1, 2, 3] });
  });

  it("resolves templates inside arrays of objects", () => {
    const result = resolveMapping(
      {
        attachments: [
          { text: "Hello {{params.user}}", color: "red" },
          { text: "static" },
        ],
      },
      { user: "Alice" },
      {},
    );
    assert.deepEqual(result, {
      attachments: [{ text: "Hello Alice", color: "red" }, { text: "static" }],
    });
  });

  it("resolves templates inside arrays of strings", () => {
    const result = resolveMapping(
      { tags: ["{{params.a}}", "static", "{{params.b}}"] },
      { a: "X", b: "Y" },
      {},
    );
    assert.deepEqual(result, { tags: ["X", "static", "Y"] });
  });

  it("resolves nested arrays recursively", () => {
    const result = resolveMapping(
      { rows: [["{{params.v}}"]] },
      { v: "cell" },
      {},
    );
    assert.deepEqual(result, { rows: [["cell"]] });
  });
});

describe("extractPath", () => {
  it("extracts nested value by dot path", () => {
    const result = extractPath({ channel: { _id: "C1" } }, "channel._id");
    assert.equal(result, "C1");
  });

  it("returns undefined for missing path", () => {
    const result = extractPath({ a: 1 }, "b.c");
    assert.equal(result, undefined);
  });

  it("parses MCP-format results first", () => {
    const mcpResult = {
      content: [{ text: '{"user": {"name": "Alice"}}' }],
    };
    const result = extractPath(mcpResult, "user.name");
    assert.equal(result, "Alice");
  });
});

describe("parseResult", () => {
  it("returns raw value if not MCP format", () => {
    assert.deepEqual(parseResult({ a: 1 }), { a: 1 });
  });

  it("parses JSON from MCP content", () => {
    const mcpResult = { content: [{ text: '{"ok": true}' }] };
    assert.deepEqual(parseResult(mcpResult), { ok: true });
  });

  it("returns raw text if not valid JSON", () => {
    const mcpResult = { content: [{ text: "hello world" }] };
    assert.equal(parseResult(mcpResult), "hello world");
  });
});

describe("shouldRun", () => {
  interface ExecutionState {
    params: Record<string, any>;
    stepResults: Record<string, any>;
    completedSteps: string[];
    nextStepOverride: string | null;
    skipStep: string | null;
    stepDeps: Record<string, string[]>;
    deferredActions: any[];
  }

  function makeState(overrides?: Partial<ExecutionState>): ExecutionState {
    return {
      params: {},
      stepResults: {},
      completedSteps: [],
      nextStepOverride: null,
      skipStep: null,
      stepDeps: {},
      deferredActions: [],
      ...overrides,
    };
  }

  it("returns true when no dependencies", () => {
    const state = makeState({ stepDeps: { s1: [] } });
    assert.equal(shouldRun("s1", state), true);
  });

  it("returns true when all dependencies are completed", () => {
    const state = makeState({
      stepDeps: { s2: ["s1"] },
      completedSteps: ["s1"],
    });
    assert.equal(shouldRun("s2", state), true);
  });

  it("returns false when dependencies are not completed", () => {
    const state = makeState({ stepDeps: { s2: ["s1"] } });
    assert.equal(shouldRun("s2", state), false);
  });

  it("skips step when skipStep matches", () => {
    const state = makeState({ skipStep: "s1" });
    assert.equal(shouldRun("s1", state), false);
    assert.equal(state.stepResults.s1.status, "skipped");
    assert.equal(state.skipStep, null);
  });

  it("runs targeted step when nextStepOverride matches", () => {
    const state = makeState({ nextStepOverride: "s2" });
    assert.equal(shouldRun("s2", state), true);
    assert.equal(state.nextStepOverride, null);
  });

  it("skips non-targeted step when nextStepOverride is active", () => {
    const state = makeState({ nextStepOverride: "s2" });
    assert.equal(shouldRun("s1", state), false);
    assert.equal(state.nextStepOverride, "s2");
  });

  it("cascades skip when dependency was skipped", () => {
    const state = makeState({
      stepDeps: { s2: ["s1"] },
      stepResults: { s1: { result: null, status: "skipped" } },
    });
    assert.equal(shouldRun("s2", state), false);
    assert.equal(state.stepResults.s2.status, "skipped");
  });

  it("cascades skip through multiple levels", () => {
    const state = makeState({
      stepDeps: { s2: ["s1"], s3: ["s2"] },
      stepResults: { s1: { result: null, status: "skipped" } },
    });
    assert.equal(shouldRun("s2", state), false);
    assert.equal(state.stepResults.s2.status, "skipped");
    assert.equal(shouldRun("s3", state), false);
    assert.equal(state.stepResults.s3.status, "skipped");
  });
});

describe("conditional branching", () => {
  it("condition true: runs thenStep, skips elseStep", async () => {
    const steps: StepDefinition[] = [
      {
        id: "check",
        label: "Check",
        type: "conditional",
        condition: "true",
        thenStep: "do_it",
        elseStep: "skip_it",
        dependsOn: [],
      },
      {
        id: "do_it",
        label: "Do",
        type: "transform",
        expression: "'done'",
        dependsOn: ["check"],
      },
      {
        id: "skip_it",
        label: "Skip",
        type: "transform",
        expression: "'skipped'",
        dependsOn: ["check"],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.ok(parsed.completedSteps.includes("do_it"));
    assert.ok(!parsed.completedSteps.includes("skip_it"));
    assert.equal(parsed.stepResults.skip_it.status, "skipped");
  });

  it("condition false with elseStep: runs elseStep, skips thenStep", async () => {
    const steps: StepDefinition[] = [
      {
        id: "check",
        label: "Check",
        type: "conditional",
        condition: "false",
        thenStep: "do_it",
        elseStep: "skip_it",
        dependsOn: [],
      },
      {
        id: "do_it",
        label: "Do",
        type: "transform",
        expression: "'done'",
        dependsOn: ["check"],
      },
      {
        id: "skip_it",
        label: "Skip",
        type: "transform",
        expression: "'else_ran'",
        dependsOn: ["check"],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.ok(parsed.completedSteps.includes("skip_it"));
    assert.ok(!parsed.completedSteps.includes("do_it"));
    assert.equal(parsed.stepResults.do_it.status, "skipped");
  });

  it("BUG A FIX: condition false without elseStep skips thenStep and downstream", async () => {
    const steps: StepDefinition[] = [
      {
        id: "check",
        label: "Check violation",
        type: "conditional",
        condition: "false",
        thenStep: "delete_msg",
        dependsOn: [],
      },
      {
        id: "delete_msg",
        label: "Delete message",
        type: "transform",
        expression: "'deleted'",
        dependsOn: ["check"],
      },
      {
        id: "dm_user",
        label: "DM user",
        type: "transform",
        expression: "'dm_sent'",
        dependsOn: ["delete_msg"],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.ok(parsed.completedSteps.includes("check"));
    assert.ok(!parsed.completedSteps.includes("delete_msg"));
    assert.ok(!parsed.completedSteps.includes("dm_user"));
    assert.equal(parsed.stepResults.delete_msg.status, "skipped");
    assert.equal(parsed.stepResults.dm_user.status, "skipped");
  });

  it("condition true without elseStep: runs thenStep and downstream", async () => {
    const steps: StepDefinition[] = [
      {
        id: "check",
        label: "Check violation",
        type: "conditional",
        condition: "true",
        thenStep: "delete_msg",
        dependsOn: [],
      },
      {
        id: "delete_msg",
        label: "Delete message",
        type: "transform",
        expression: "'deleted'",
        dependsOn: ["check"],
      },
      {
        id: "dm_user",
        label: "DM user",
        type: "transform",
        expression: "'dm_sent'",
        dependsOn: ["delete_msg"],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.ok(parsed.completedSteps.includes("check"));
    assert.ok(parsed.completedSteps.includes("delete_msg"));
    assert.ok(parsed.completedSteps.includes("dm_user"));
    assert.equal(parsed.stepResults.delete_msg.result, "deleted");
    assert.equal(parsed.stepResults.dm_user.result, "dm_sent");
  });
});

describe("transform execution", () => {
  it("evaluates expression with steps and params in scope", async () => {
    const steps: StepDefinition[] = [
      {
        id: "compute",
        label: "Compute",
        type: "transform",
        expression: "params.a + params.b",
        dependsOn: [],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      { a: 3, b: 4 },
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.compute.result, 7);
  });

  it("can reference previous step results", async () => {
    const steps: StepDefinition[] = [
      {
        id: "first",
        label: "First",
        type: "transform",
        expression: "({ value: 42 })",
        dependsOn: [],
      },
      {
        id: "second",
        label: "Second",
        type: "transform",
        expression: "steps.first.result.value * 2",
        dependsOn: ["first"],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.second.result, 84);
  });

  it("handles multi-statement expressions with return keyword", async () => {
    const steps: StepDefinition[] = [
      {
        id: "multi",
        label: "Multi-statement",
        type: "transform",
        expression:
          "let obj = JSON.parse(JSON.stringify(params.state)); obj.count = (obj.count || 0) + 1; return obj;",
        dependsOn: [],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      { state: { count: 2, name: "test" } },
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.multi.result.count, 3);
    assert.equal(parsed.stepResults.multi.result.name, "test");
  });
});

describe("API call payload building", () => {
  it("does not use requestBody fallback (Bug B)", async () => {
    let capturedBody: any = null;
    const mockClient = {
      request: async (_method: string, _path: string, opts: any) => {
        capturedBody = opts.body;
        return { success: true };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "call",
        label: "API call",
        type: "api_call",
        operationId: "post-api-v1-test",
        inputMapping: { field1: "value1" },
        dependsOn: [],
      },
    ];

    await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-test": { method: "POST", path: "/api/v1/test" },
        },
        name: "test",
      },
      steps,
      {},
    );

    assert.deepEqual(capturedBody, { field1: "value1" });
  });

  it("passes nested inputMapping through as-is (no auto-wrapping)", async () => {
    let capturedBody: any = null;
    const mockClient = {
      request: async (_method: string, _path: string, opts: any) => {
        capturedBody = opts.body;
        return { success: true };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "call",
        label: "Send message",
        type: "api_call",
        operationId: "post-api-v1-chat_sendMessage",
        inputMapping: { message: { msg: "hello", rid: "R1" } },
        dependsOn: [],
      },
    ];

    await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-chat_sendMessage": {
            method: "POST",
            path: "/api/v1/chat.sendMessage",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    assert.deepEqual(capturedBody, { message: { msg: "hello", rid: "R1" } });
  });
});

describe("error handling", () => {
  it("returns error result when step throws", async () => {
    const steps: StepDefinition[] = [
      {
        id: "bad",
        label: "Bad step",
        type: "transform",
        expression: "JSON.parse('invalid json{')",
        dependsOn: [],
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "error");
    assert.ok(parsed.error.length > 0);
  });
});

describe("detectJsonIntent", () => {
  it("detects 'JSON' in systemPrompt", () => {
    assert.equal(
      detectJsonIntent({
        id: "x",
        label: "x",
        type: "sampling",
        dependsOn: [],
        systemPrompt: "Respond ONLY with JSON",
      }),
      true,
    );
  });

  it("detects 'json' in prompt", () => {
    assert.equal(
      detectJsonIntent({
        id: "x",
        label: "x",
        type: "sampling",
        dependsOn: [],
        prompt: "Return a json object",
      }),
      true,
    );
  });

  it("returns false for plain text prompts", () => {
    assert.equal(
      detectJsonIntent({
        id: "x",
        label: "x",
        type: "sampling",
        dependsOn: [],
        prompt: "Summarize this text",
      }),
      false,
    );
  });

  it("detects 'respond only with' even without JSON keyword", () => {
    assert.equal(
      detectJsonIntent({
        id: "x",
        label: "x",
        type: "sampling",
        dependsOn: [],
        systemPrompt: "Respond only with the analysis",
      }),
      true,
    );
  });
});

describe("extractJson", () => {
  it("extracts JSON object from surrounding text", () => {
    assert.equal(
      extractJson('Here is the result:\n{"key": "value"}\nDone!'),
      '{"key": "value"}',
    );
  });

  it("extracts JSON array from surrounding text", () => {
    assert.equal(extractJson("Result: [1, 2, 3] end"), "[1, 2, 3]");
  });

  it("returns null when no JSON present", () => {
    assert.equal(extractJson("just plain text"), null);
  });

  it("handles nested objects", () => {
    const json = '{"outer": {"inner": "value"}, "arr": [1, 2]}';
    assert.equal(extractJson("prefix " + json + " suffix"), json);
  });

  it("handles JSON with escaped braces in strings", () => {
    const json = '{"msg": "use {curly} braces"}';
    assert.equal(extractJson("text " + json + " text"), json);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(extractJson("text {not json at all text"), null);
  });

  it("handles text before and after a clean JSON object", () => {
    const result = extractJson(
      'Analysis complete. {"valid": true} Hope this helps!',
    );
    assert.equal(result, '{"valid": true}');
  });

  it("skips invalid opening brace and finds valid JSON later", () => {
    const result = extractJson('first { invalid then {"valid": true} end');
    assert.equal(result, '{"valid": true}');
  });
});

describe("autoReturn", () => {
  it("passes through pure expressions unchanged", () => {
    assert.equal(autoReturn('"hello"'), '"hello"');
  });

  it("passes through valid statement code unchanged", () => {
    const expr = "const x = 1; return x;";
    assert.equal(autoReturn(expr), expr);
  });

  it("wraps trailing object literal in return for multi-statement expressions", () => {
    const expr =
      "const now = Date.now(); const count = 1; { count, lastViolationTimestamp: now }";
    const fixed = autoReturn(expr);
    const fn = new Function("steps", "params", `"use strict"; ${fixed}`);
    const result = fn({}, {});
    assert.equal(typeof result, "object");
    assert.equal(result.count, 1);
    assert.equal(typeof result.lastViolationTimestamp, "number");
  });

  it("handles the exact update_violation_state expression from generated code", () => {
    const expr =
      "const now = Date.now(); const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000); let violationCount = params.userState.violationCount; if (params.userState.lastViolationTimestamp < oneWeekAgo) { violationCount = 1; } else { violationCount++; } { violationCount, lastViolationTimestamp: now }";
    const fixed = autoReturn(expr);
    const fn = new Function("steps", "params", `"use strict"; ${fixed}`);
    const result = fn(
      {},
      { userState: { violationCount: 2, lastViolationTimestamp: 0 } },
    );
    assert.equal(result.violationCount, 1);
    assert.equal(typeof result.lastViolationTimestamp, "number");
  });

  it("does not wrap if/else blocks in return", () => {
    const expr = 'if (true) { console.log("hi"); }';
    const fixed = autoReturn(expr);
    const fn = new Function("steps", "params", `"use strict"; ${fixed}`);
    assert.equal(fn({}, {}), undefined);
  });

  it("does not wrap function body blocks in return", () => {
    const expr = "const fn = () => { return 1; }";
    const fixed = autoReturn(expr);
    assert.equal(fixed, expr);
  });
});

describe("continueOnError", () => {
  it("workflow continues when a continueOnError step fails", async () => {
    const steps: StepDefinition[] = [
      {
        id: "step1",
        label: "Transform step",
        type: "transform",
        dependsOn: [],
        expression: '"first"',
      },
      {
        id: "step2",
        label: "Failing API step",
        type: "api_call",
        dependsOn: ["step1"],
        operationId: "nonexistent",
        inputMapping: {},
        continueOnError: true,
      },
      {
        id: "step3",
        label: "After failure",
        type: "transform",
        dependsOn: ["step2"],
        expression: '"reached"',
      },
    ];

    const mockClient = {
      request: async () => {
        throw new Error("API down");
      },
    };

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: { nonexistent: { method: "POST", path: "/test" } },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.ok(parsed.completedSteps.includes("step2"));
    assert.ok(parsed.completedSteps.includes("step3"));
    assert.equal(parsed.stepResults.step2.status, "error");
    assert.equal(parsed.stepResults.step3.result, "reached");
  });

  it("workflow aborts when a non-continueOnError step fails", async () => {
    const steps: StepDefinition[] = [
      {
        id: "step1",
        label: "Failing step",
        type: "api_call",
        dependsOn: [],
        operationId: "nonexistent",
        inputMapping: {},
        // no continueOnError
      },
      {
        id: "step2",
        label: "Should not run",
        type: "transform",
        dependsOn: ["step1"],
        expression: '"never"',
      },
    ];

    const mockClient = {
      request: async () => {
        throw new Error("API down");
      },
    };

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: { nonexistent: { method: "POST", path: "/test" } },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "error");
    assert.ok(!parsed.completedSteps.includes("step2"));
  });
});

describe("Gemini CLI headless mode", () => {
  it("_resetCliCache is exported and callable", () => {
    assert.equal(typeof _resetCliCache, "function");
    _resetCliCache();
  });

  it("sampling step without any provider throws descriptive error", async () => {
    const origKey = process.env.GEMINI_API_KEY;
    const origGoogleKey = process.env.GOOGLE_API_KEY;
    const origPath = process.env.PATH;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.PATH = "/nonexistent";

    _resetCliCache();

    const steps: StepDefinition[] = [
      {
        id: "analyze",
        label: "Analyze",
        type: "sampling",
        prompt: "Is this harmful? {{params.text}}",
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      { text: "hello world" },
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "error");
    assert.ok(
      parsed.error.includes("Gemini CLI") || parsed.error.includes("sampling"),
      `Error should mention Gemini CLI or sampling, got: ${parsed.error}`,
    );

    if (origKey) process.env.GEMINI_API_KEY = origKey;
    if (origGoogleKey) process.env.GOOGLE_API_KEY = origGoogleKey;
    process.env.PATH = origPath;
    _resetCliCache();
  });

  it("sampling falls through to direct API when CLI not available", async () => {
    const origKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-dummy-key";
    const origPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
    _resetCliCache();

    const steps: StepDefinition[] = [
      {
        id: "analyze",
        label: "Analyze",
        type: "sampling",
        prompt: "Test prompt",
      },
    ];

    const result = await runWorkflow(
      { server: {}, client: {}, endpoints: {}, name: "test" },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "error");
    assert.ok(
      !parsed.error.includes("No sampling provider"),
      "Should have attempted API call, not complained about no provider",
    );

    if (origKey) {
      process.env.GEMINI_API_KEY = origKey;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
    process.env.PATH = origPath;
    _resetCliCache();
  });
});

describe("forEach / as iteration on api_call", () => {
  it("iterates over an array from a previous step and collects results", async () => {
    const calls: string[] = [];
    const mockClient = {
      request: async (_method: string, path: string, _opts: any) => {
        if (path.includes("chat.getPinnedMessages")) {
          const roomId = new URL("http://x" + path).searchParams.get("roomId");
          calls.push(roomId!);
          return { messages: [{ text: `msg-from-${roomId}` }] };
        }
        return { isError: true, content: [{ text: "not found" }] };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "channels",
        label: "Get channels",
        type: "transform",
        expression:
          "({ channels: [{ _id: 'ch1' }, { _id: 'ch2' }, { _id: 'ch3' }] })",
      },
      {
        id: "get_pinned",
        label: "Get pinned per channel",
        type: "api_call",
        operationId: "get-api-v1-chat_getPinnedMessages",
        forEach: "{{steps.channels.result.channels}}",
        as: "channel",
        inputMapping: { roomId: "{{steps.channel.result._id}}" },
        dependsOn: ["channels"],
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "get-api-v1-chat_getPinnedMessages": {
            method: "GET",
            path: "/api/v1/chat.getPinnedMessages",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.deepEqual(calls, ["ch1", "ch2", "ch3"]);
    const stepResult = parsed.stepResults.get_pinned.result;
    assert.equal(Array.isArray(stepResult), true);
    assert.equal(stepResult.length, 3);
    assert.deepEqual(stepResult[0], { messages: [{ text: "msg-from-ch1" }] });
  });

  it("returns empty array when forEach collection is empty", async () => {
    const mockClient = {
      request: async () => {
        throw new Error("Should not be called");
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "channels",
        label: "Empty list",
        type: "transform",
        expression: "({ channels: [] })",
      },
      {
        id: "get_pinned",
        label: "Get pinned per channel",
        type: "api_call",
        operationId: "get-api-v1-chat_getPinnedMessages",
        forEach: "{{steps.channels.result.channels}}",
        as: "channel",
        inputMapping: { roomId: "{{steps.channel.result._id}}" },
        dependsOn: ["channels"],
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "get-api-v1-chat_getPinnedMessages": {
            method: "GET",
            path: "/api/v1/chat.getPinnedMessages",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.deepEqual(parsed.stepResults.get_pinned.result, []);
  });

  it("forEach results can be consumed by downstream transform", async () => {
    const mockClient = {
      request: async (_method: string, path: string) => {
        const roomId = new URL("http://x" + path).searchParams.get("roomId");
        return { messages: [{ text: `pinned-${roomId}` }] };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "channels",
        label: "Get channels",
        type: "transform",
        expression: "({ channels: [{ _id: 'A' }, { _id: 'B' }] })",
      },
      {
        id: "get_pinned",
        label: "Get pinned",
        type: "api_call",
        operationId: "get-api-v1-chat_getPinnedMessages",
        forEach: "{{steps.channels.result.channels}}",
        as: "ch",
        inputMapping: { roomId: "{{steps.ch.result._id}}" },
        dependsOn: ["channels"],
      },
      {
        id: "merge",
        label: "Merge all messages",
        type: "transform",
        expression: "steps.get_pinned.result.flatMap(r => r.messages)",
        dependsOn: ["get_pinned"],
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "get-api-v1-chat_getPinnedMessages": {
            method: "GET",
            path: "/api/v1/chat.getPinnedMessages",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.status, "success");
    assert.deepEqual(parsed.stepResults.merge.result, [
      { text: "pinned-A" },
      { text: "pinned-B" },
    ]);
  });
});

describe("engine safety nets", () => {
  it("throws when a template param resolves to empty", async () => {
    const mockClient = {
      request: async () => ({ success: true }),
    };

    const steps: StepDefinition[] = [
      {
        id: "invite_buddy",
        label: "Invite Buddy",
        type: "api_call",
        operationId: "post-api-v1-groups_invite",
        inputMapping: {
          roomId: "ABC123abcdef12345",
          userId: "{{params.context.performedBy.id}}",
        },
        dependsOn: [],
        continueOnError: true,
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-groups_invite": {
            method: "POST",
            path: "/api/v1/groups.invite",
          },
        },
        name: "test",
      },
      steps,
      { context: { user: { id: "u1" } } }, // no performedBy → resolves to ""
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.invite_buddy.status, "error");
    assert.ok(
      parsed.stepResults.invite_buddy.error.includes("resolved to empty"),
      "Error message should mention resolved to empty",
    );
  });

  it("sanitizes channel name in channels.create", async () => {
    let capturedBody: any = null;
    const mockClient = {
      request: async (_m: string, _p: string, opts: any) => {
        capturedBody = opts.body;
        return { channel: { _id: "X1", name: "onboarding-john-doe" } };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "create",
        label: "Create Channel",
        type: "api_call",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "Onboarding John Doe!" },
        dependsOn: [],
      },
    ];

    await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-channels_create": {
            method: "POST",
            path: "/api/v1/channels.create",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    assert.equal(capturedBody.name, "onboarding-john-doe");
  });

  it("resolves channel name to _id for channels.invite", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const mockClient = {
      request: async (method: string, path: string, _opts: any) => {
        calls.push({ method, path });
        if (path.includes("channels.info")) {
          return { channel: { _id: "RESOLVED_ID_123456", name: "general" } };
        }
        return { channel: { _id: "RESOLVED_ID_123456" } };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "invite",
        label: "Add to general",
        type: "api_call",
        operationId: "post-api-v1-channels_invite",
        inputMapping: {
          roomId: "general", // name instead of _id
          userId: "user123abcdef12345",
        },
        dependsOn: [],
      },
    ];

    await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-channels_invite": {
            method: "POST",
            path: "/api/v1/channels.invite",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    assert.ok(calls.some((c) => c.path.includes("channels.info")));
    const inviteCall = calls.find((c) => c.path === "/api/v1/channels.invite");
    assert.ok(inviteCall, "Should have made the invite call");
  });

  it("skips name resolution when roomId looks like Mongo _id", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const mockClient = {
      request: async (method: string, path: string, _opts: any) => {
        calls.push({ method, path });
        return { channel: { _id: "ByehQjC44FwMeiLbX" } };
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "invite",
        label: "Add to channel",
        type: "api_call",
        operationId: "post-api-v1-channels_invite",
        inputMapping: {
          roomId: "ByehQjC44FwMeiLbX", // already a Mongo _id
          userId: "user123abcdef12345",
        },
        dependsOn: [],
      },
    ];

    await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-channels_invite": {
            method: "POST",
            path: "/api/v1/channels.invite",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    assert.ok(!calls.some((c) => c.path.includes("channels.info")));
  });

  it("fetches existing channel on duplicate channels.create", async () => {
    const mockClient = {
      request: async (_m: string, path: string, opts: any) => {
        if (path === "/api/v1/channels.create") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "error-duplicate-channel-name",
                  success: false,
                }),
              },
            ],
          };
        }
        if (path.includes("channels.info")) {
          return {
            channel: { _id: "EXISTING_CH_123456", name: "general", t: "c" },
          };
        }
        return {};
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "ensure",
        label: "Ensure channel",
        type: "api_call",
        operationId: "post-api-v1-channels_create",
        inputMapping: { name: "general" },
        dependsOn: [],
        continueOnError: true,
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-channels_create": {
            method: "POST",
            path: "/api/v1/channels.create",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.ensure.status, "success");
    assert.equal(
      parsed.stepResults.ensure.result.channel._id,
      "EXISTING_CH_123456",
    );
  });

  it("fetches existing group on duplicate groups.create", async () => {
    const mockClient = {
      request: async (_m: string, path: string, _opts: any) => {
        if (path === "/api/v1/groups.create") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "error-duplicate-channel-name",
                  success: false,
                }),
              },
            ],
          };
        }
        if (path.includes("groups.info")) {
          return {
            group: {
              _id: "EXISTING_GRP_12345",
              name: "onboarding-alice",
              t: "p",
            },
          };
        }
        return {};
      },
    };

    const steps: StepDefinition[] = [
      {
        id: "ensure_group",
        label: "Ensure group",
        type: "api_call",
        operationId: "post-api-v1-groups_create",
        inputMapping: { name: "onboarding-alice" },
        dependsOn: [],
        continueOnError: true,
      },
    ];

    const result = await runWorkflow(
      {
        server: {},
        client: mockClient,
        endpoints: {
          "post-api-v1-groups_create": {
            method: "POST",
            path: "/api/v1/groups.create",
          },
        },
        name: "test",
      },
      steps,
      {},
    );

    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.stepResults.ensure_group.status, "success");
    assert.equal(
      parsed.stepResults.ensure_group.result.group._id,
      "EXISTING_GRP_12345",
    );
  });
});
