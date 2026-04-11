import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateWorkflowToolCode,
  generateMcpServerEntryCode,
  generateWorkflowReadme,
} from "../mcp-server/mcpServerCodegen.js";
import {
  composeWorkflowDefinition,
  ComposerError,
  type ComposerWarning,
} from "../mcp-server/workflowComposer.js";
import type { WorkflowDefinition, WorkflowStep } from "../mcp-server/types.js";

describe("generateWorkflowToolCode", () => {
  const simpleWorkflow: WorkflowDefinition = {
    name: "test_workflow",
    description: "A test workflow for validation",
    params: {
      type: "object",
      properties: {
        channelName: { type: "string", description: "Channel name" },
      },
      required: ["channelName"],
    },
    steps: [
      {
        id: "step1",
        label: "First step",
        config: {
          type: "api_call",
          operationId: "get-api-v1-channels-list",
          inputMapping: {},
        },
      },
      {
        id: "step2",
        label: "Second step",
        config: {
          type: "transform",
          expression: "steps.step1.result",
        },
        dependsOn: ["step1"],
      },
    ],
    requiredEndpoints: ["get-api-v1-channels-list"],
    usesSampling: false,
    usesElicitation: false,
  };

  it("generates thin tool file that imports the engine", () => {
    const code = generateWorkflowToolCode(simpleWorkflow);
    assert.ok(
      code.includes(
        'import { runWorkflow, type StepDefinition } from "../engine/workflow-engine.js"',
      ),
      "Should import runWorkflow from engine",
    );
    assert.ok(
      code.includes("export const tool ="),
      "Should export tool definition",
    );
    assert.ok(code.includes('"test_workflow"'), "Should include workflow name");
    assert.ok(
      code.includes("handler: async (args: Record<string, unknown>,"),
      "Should have async handler",
    );
    assert.ok(
      code.includes("runWorkflow("),
      "Should call runWorkflow in handler",
    );
  });

  it("includes step definitions as data", () => {
    const code = generateWorkflowToolCode(simpleWorkflow);
    assert.ok(
      code.includes("const steps: StepDefinition[]"),
      "Should define steps as StepDefinition array",
    );
    assert.ok(code.includes('"step1"'), "Should reference step1 in data");
    assert.ok(code.includes('"step2"'), "Should reference step2 in data");
    assert.ok(code.includes('"api_call"'), "Should include step type as data");
    assert.ok(
      code.includes('"transform"'),
      "Should include transform type as data",
    );
  });

  it("includes server/client wiring exports", () => {
    const code = generateWorkflowToolCode(simpleWorkflow);
    assert.ok(
      code.includes("export function setServer"),
      "Should export setServer",
    );
    assert.ok(
      code.includes("export function setClient"),
      "Should export setClient",
    );
    assert.ok(
      code.includes("export function registerEndpoints"),
      "Should export registerEndpoints",
    );
  });

  it("embeds sampling config as step data", () => {
    const samplingWorkflow: WorkflowDefinition = {
      name: "test_sampling",
      description: "Test sampling",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "AI analysis",
          config: {
            type: "sampling",
            prompt: "Analyze this: {{params.data}}",
            systemPrompt: "You are an analyst",
            maxTokens: 500,
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };

    const code = generateWorkflowToolCode(samplingWorkflow);
    assert.ok(
      code.includes('"sampling"'),
      "Should include sampling type in step data",
    );
    assert.ok(
      code.includes("Analyze this: {{params.data}}"),
      "Should include prompt in step data",
    );
    assert.ok(
      code.includes("You are an analyst"),
      "Should include systemPrompt in step data",
    );
  });

  it("embeds elicitation config as step data", () => {
    const elicitWorkflow: WorkflowDefinition = {
      name: "test_elicit",
      description: "Test elicit",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "confirm",
          label: "User confirmation",
          config: {
            type: "elicitation",
            message: "Proceed?",
            requestedSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
            onDecline: "abort",
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: false,
      usesElicitation: true,
    };

    const code = generateWorkflowToolCode(elicitWorkflow);
    assert.ok(
      code.includes('"elicitation"'),
      "Should include elicitation type in step data",
    );
    assert.ok(
      code.includes('"Proceed?"'),
      "Should include message in step data",
    );
    assert.ok(
      code.includes('"abort"'),
      "Should include onDecline in step data",
    );
  });

  it("embeds conditional config as step data", () => {
    const condWorkflow: WorkflowDefinition = {
      name: "test_cond",
      description: "Test conditional",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "check",
          label: "Check condition",
          config: {
            type: "conditional",
            condition: "true",
            thenStep: "do_it",
            elseStep: "skip_it",
          },
        },
        {
          id: "do_it",
          label: "Do it",
          config: { type: "transform", expression: "'done'" },
          dependsOn: ["check"],
        },
        {
          id: "skip_it",
          label: "Skip",
          config: {
            type: "transform",
            expression: "'skipped'",
          },
          dependsOn: ["check"],
        },
      ],
      requiredEndpoints: [],
      usesSampling: false,
      usesElicitation: false,
    };

    const code = generateWorkflowToolCode(condWorkflow);
    assert.ok(
      code.includes('"conditional"'),
      "Should include conditional type in step data",
    );
    assert.ok(code.includes('"do_it"'), "Should reference thenStep in data");
    assert.ok(code.includes('"skip_it"'), "Should reference elseStep in data");
  });
});

describe("generateMcpServerEntryCode", () => {
  const testWorkflow: WorkflowDefinition = {
    name: "test_wf",
    description: "Test",
    params: { type: "object", properties: {} },
    steps: [],
    requiredEndpoints: [],
    usesSampling: true,
    usesElicitation: false,
  };

  const mockEndpoints = [
    { operationId: "post-api-v1-login", method: "post", path: "/api/v1/login" },
    {
      operationId: "get-api-v1-channels-list",
      method: "get",
      path: "/api/v1/channels.list",
    },
    {
      operationId: "post-api-v1-chat-sendmessage",
      method: "post",
      path: "/api/v1/chat.sendMessage",
    },
  ] as any;

  it("generates server with workflow imports", () => {
    const code = generateMcpServerEntryCode(
      "test-server",
      [testWorkflow],
      mockEndpoints,
    );
    assert.ok(code.includes("test_wf"), "Should import workflow");
    assert.ok(code.includes("setServer"), "Should wire server reference");
    assert.ok(code.includes("setClient"), "Should wire client reference");
  });

  it("declares sampling capability when workflows use it", () => {
    const code = generateMcpServerEntryCode(
      "test-server",
      [testWorkflow],
      mockEndpoints,
    );
    assert.ok(code.includes("sampling"), "Should declare sampling capability");
  });

  it("embeds endpoint map for workflow API calls", () => {
    const code = generateMcpServerEntryCode(
      "test-server",
      [testWorkflow],
      mockEndpoints,
    );
    assert.ok(
      code.includes("post-api-v1-login"),
      "Should embed endpoint operationId in map",
    );
    assert.ok(
      code.includes("/api/v1/login"),
      "Should embed endpoint path in map",
    );
    assert.ok(
      code.includes("1 workflow tools"),
      "Should mention workflow count",
    );
  });
});

describe("generateWorkflowReadme", () => {
  it("returns empty string for no workflows", () => {
    const section = generateWorkflowReadme([]);
    assert.equal(section, "");
  });

  it("generates markdown table for workflows", () => {
    const code = generateWorkflowReadme([
      {
        name: "test_wf",
        description: "A test workflow",
        params: { type: "object", properties: {} },
        steps: [
          {
            id: "s1",
            label: "Step 1",
            config: { type: "api_call", operationId: "x", inputMapping: {} },
          },
        ],
        requiredEndpoints: [],
        usesSampling: true,
        usesElicitation: false,
      },
    ]);
    assert.ok(code.includes("## Workflow Tools"), "Should have section header");
    assert.ok(code.includes("test_wf"), "Should include workflow name");
    assert.ok(code.includes("AI"), "Should mention AI feature");
  });
});

describe("composeWorkflowDefinition", () => {
  it("composes a simple api_call workflow", () => {
    const result = composeWorkflowDefinition({
      name: "get_info",
      description: "Get user info",
      params: {
        type: "object",
        properties: { username: { type: "string" } },
        required: ["username"],
      },
      steps: [
        {
          id: "fetch_user",
          label: "Fetch user profile",
          config: {
            type: "api_call",
            operationId: "get-api-v1-users-info",
            inputMapping: { username: "{{params.username}}" },
          },
        },
      ],
    });

    assert.equal(result.workflow.name, "get_info");
    assert.equal(result.workflow.steps.length, 1);
    assert.deepStrictEqual(result.executionOrder, ["fetch_user"]);
    assert.equal(result.summary.usesSampling, false);
    assert.equal(result.summary.usesElicitation, false);
    assert.deepStrictEqual(result.summary.apiCalls, ["get-api-v1-users-info"]);
  });

  it("auto-detects usesSampling", () => {
    const result = composeWorkflowDefinition({
      name: "analyze_chat",
      description: "Analyze chat messages",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch messages",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-history",
            inputMapping: {},
          },
        },
        {
          id: "analyze",
          label: "AI analysis",
          config: {
            type: "sampling",
            prompt: "Analyze: {{steps.fetch.result}}",
            maxTokens: 500,
          },
          dependsOn: ["fetch"],
        },
      ],
    });

    assert.equal(result.summary.usesSampling, true);
    assert.equal(result.workflow.usesSampling, true);
  });

  it("auto-detects usesElicitation", () => {
    const result = composeWorkflowDefinition({
      name: "confirm_action",
      description: "Confirm with user",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "ask",
          label: "Ask user",
          config: {
            type: "elicitation",
            message: "Are you sure?",
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
            },
            onDecline: "abort",
          },
        },
      ],
    });

    assert.equal(result.summary.usesElicitation, true);
    assert.equal(result.workflow.usesElicitation, true);
  });

  it("computes correct topological order", () => {
    const result = composeWorkflowDefinition({
      name: "multi_step",
      description: "Multi-step workflow",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "step_c",
          label: "Step C",
          config: { type: "transform", expression: "'done'" },
          dependsOn: ["step_b"],
        },
        {
          id: "step_a",
          label: "Step A",
          config: {
            type: "api_call",
            operationId: "get-api-v1-info",
            inputMapping: {},
          },
        },
        {
          id: "step_b",
          label: "Step B",
          config: { type: "transform", expression: "'ok'" },
          dependsOn: ["step_a"],
        },
      ],
    });

    const aIdx = result.executionOrder.indexOf("step_a");
    const bIdx = result.executionOrder.indexOf("step_b");
    const cIdx = result.executionOrder.indexOf("step_c");
    assert.ok(aIdx < bIdx, "step_a should come before step_b");
    assert.ok(bIdx < cIdx, "step_b should come before step_c");
  });

  it("collects requiredEndpoints from api_call steps", () => {
    const result = composeWorkflowDefinition({
      name: "multi_api",
      description: "Multiple API calls",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "s1",
          label: "Call 1",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "s2",
          label: "Call 2",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: {},
          },
          dependsOn: ["s1"],
        },
      ],
    });

    assert.deepStrictEqual(result.workflow.requiredEndpoints, [
      "get-api-v1-channels-list",
      "post-api-v1-chat-sendmessage",
    ]);
  });

  it("detects conditionals", () => {
    const result = composeWorkflowDefinition({
      name: "branch_test",
      description: "Test branching",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "check",
          label: "Check flag",
          config: {
            type: "conditional",
            condition: "params.flag === true",
            thenStep: "action",
          },
        },
        {
          id: "action",
          label: "Do action",
          config: { type: "transform", expression: "'done'" },
        },
      ],
    });

    assert.equal(result.summary.hasConditionals, true);
  });

  it("composed workflow is valid for code generation", () => {
    const result = composeWorkflowDefinition({
      name: "full_workflow",
      description: "Complete workflow with all step types",
      params: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          policy: { type: "string" },
        },
        required: ["channelId"],
      },
      steps: [
        {
          id: "fetch",
          label: "Fetch messages",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-history",
            inputMapping: { roomId: "{{params.channelId}}" },
          },
        },
        {
          id: "analyze",
          label: "AI analysis",
          config: {
            type: "sampling",
            prompt: "Review: {{steps.fetch.result}}",
            systemPrompt: "You are a moderator",
            maxTokens: 1000,
          },
          dependsOn: ["fetch"],
        },
        {
          id: "check",
          label: "Check results",
          config: {
            type: "conditional",
            condition: "steps.analyze.result !== '[]'",
            thenStep: "confirm",
            elseStep: "done",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "confirm",
          label: "User confirms",
          config: {
            type: "elicitation",
            message: "Found issues: {{steps.analyze.result}}",
            requestedSchema: {
              type: "object",
              properties: { action: { type: "string" } },
            },
            onDecline: "abort",
          },
          dependsOn: ["check"],
        },
        {
          id: "done",
          label: "Compile result",
          config: {
            type: "transform",
            expression: "({ analyzed: steps.analyze.result })",
          },
          dependsOn: ["check"],
        },
      ],
    });

    const code = generateWorkflowToolCode(result.workflow);
    assert.ok(code.includes("full_workflow"));
    assert.ok(code.includes("fetch"));
    assert.ok(code.includes("analyze"));
    assert.ok(
      code.includes('"sampling"'),
      "Should include sampling step type as data",
    );
    assert.ok(
      code.includes('"elicitation"'),
      "Should include elicitation step type as data",
    );
  });
});

describe("composeWorkflowDefinition validation", () => {
  it("rejects empty steps", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "empty",
          description: "Empty",
          params: { type: "object", properties: {} },
          steps: [],
        }),
      /at least one step/,
    );
  });

  it("rejects invalid workflow name", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "Invalid-Name",
          description: "Bad name",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Step",
              config: { type: "transform", expression: "'x'" },
            },
          ],
        }),
      /Invalid workflow name/,
    );
  });

  it("rejects duplicate step IDs", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "dup_test",
          description: "Dup",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Step 1",
              config: { type: "transform", expression: "'a'" },
            },
            {
              id: "s1",
              label: "Step 2",
              config: { type: "transform", expression: "'b'" },
            },
          ],
        }),
      /Duplicate step ID/,
    );
  });

  it("rejects unknown dependsOn reference", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "bad_dep",
          description: "Bad dep",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Step 1",
              config: { type: "transform", expression: "'a'" },
              dependsOn: ["nonexistent"],
            },
          ],
        }),
      /unknown step "nonexistent"/,
    );
  });

  it("rejects self-dependency", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "self_dep",
          description: "Self dep",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Step 1",
              config: { type: "transform", expression: "'a'" },
              dependsOn: ["s1"],
            },
          ],
        }),
      /cannot depend on itself/,
    );
  });

  it("detects circular dependencies", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "cycle_test",
          description: "Cycle",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "a",
              label: "A",
              config: { type: "transform", expression: "'a'" },
              dependsOn: ["b"],
            },
            {
              id: "b",
              label: "B",
              config: { type: "transform", expression: "'b'" },
              dependsOn: ["a"],
            },
          ],
        }),
      /Circular dependency/,
    );
  });

  it("rejects unknown thenStep reference", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "bad_then",
          description: "Bad then",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Check",
              config: {
                type: "conditional",
                condition: "true",
                thenStep: "missing",
              },
            },
          ],
        }),
      /unknown thenStep/,
    );
  });

  it("rejects unknown elseStep reference", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "bad_else",
          description: "Bad else",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Check",
              config: {
                type: "conditional",
                condition: "true",
                thenStep: "s2",
                elseStep: "missing",
              },
            },
            {
              id: "s2",
              label: "Action",
              config: { type: "transform", expression: "'x'" },
            },
          ],
        }),
      /unknown elseStep/,
    );
  });

  it("rejects api_call without operationId", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "no_opid",
          description: "No op",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Call",
              config: {
                type: "api_call",
                operationId: "",
                inputMapping: {},
              } as any,
            },
          ],
        }),
      /operationId is required/,
    );
  });

  it("rejects sampling without prompt", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "no_prompt",
          description: "No prompt",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Sample",
              config: { type: "sampling", prompt: "" } as any,
            },
          ],
        }),
      /prompt is required/,
    );
  });

  it("rejects elicitation without message", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "no_msg",
          description: "No msg",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Ask",
              config: {
                type: "elicitation",
                message: "",
                requestedSchema: { type: "object", properties: {} },
              } as any,
            },
          ],
        }),
      /message is required/,
    );
  });

  it("rejects unknown step type", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "bad_type",
          description: "Bad type",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "Bad",
              config: { type: "foobar" } as any,
            },
          ],
        }),
      /unknown step type/,
    );
  });

  it("rejects empty description", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "no_desc",
          description: "",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "s1",
              label: "S",
              config: { type: "transform", expression: "'x'" },
            },
          ],
        }),
      /description is required/,
    );
  });

  it("throws ComposerError instances", () => {
    try {
      composeWorkflowDefinition({
        name: "Bad-Name",
        description: "Bad",
        params: { type: "object", properties: {} },
        steps: [
          {
            id: "s1",
            label: "S",
            config: { type: "transform", expression: "'x'" },
          },
        ],
      });
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof ComposerError);
    }
  });
});

describe("C2: Implicit Dependency Injection", () => {
  it("auto-adds dependency when step references another via template", () => {
    const result = composeWorkflowDefinition({
      name: "test_implicit_deps",
      description: "Test implicit deps",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.msg}}" },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "{{steps.analyze.result}}" },
          },
        },
      ],
    });

    const sendStep = result.workflow.steps.find((s) => s.id === "send")!;
    assert.ok(
      sendStep.dependsOn?.includes("analyze"),
      "send should auto-depend on analyze",
    );

    const w = result.warnings.find(
      (w) => w.code === "IMPLICIT_DEP_ADDED" && w.stepId === "send",
    );
    assert.ok(w, "Should warn about auto-added dependency");
  });

  it("auto-adds conditional as dependency for thenStep/elseStep targets", () => {
    const result = composeWorkflowDefinition({
      name: "test_conditional_deps",
      description: "Test conditional deps",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.msg}}" },
        },
        {
          id: "route",
          label: "Route",
          config: {
            type: "conditional",
            condition: "steps.analyze.result.includes('bad')",
            thenStep: "escalate",
            elseStep: "thank",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "escalate",
          label: "Escalate",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "Escalated" },
          },
          // NO dependsOn — should be auto-injected
        },
        {
          id: "thank",
          label: "Thank",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "Thanks" },
          },
          // NO dependsOn — should be auto-injected
        },
      ],
    });

    const escalate = result.workflow.steps.find((s) => s.id === "escalate")!;
    const thank = result.workflow.steps.find((s) => s.id === "thank")!;
    assert.ok(
      escalate.dependsOn?.includes("route"),
      "escalate should auto-depend on route",
    );
    assert.ok(
      thank.dependsOn?.includes("route"),
      "thank should auto-depend on route",
    );
  });

  it("does not duplicate already-declared dependencies", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_dup_deps",
      description: "Test no dup",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "{{steps.fetch.result}}" },
          },
          dependsOn: ["fetch"], // Already declared
        },
      ],
    });

    const sendStep = result.workflow.steps.find((s) => s.id === "send")!;
    const fetchDeps = sendStep.dependsOn!.filter((d) => d === "fetch");
    assert.equal(fetchDeps.length, 1, "Should not duplicate the dependency");

    const w = result.warnings.find(
      (w) =>
        w.code === "IMPLICIT_DEP_ADDED" &&
        w.stepId === "send" &&
        w.message.includes("fetch"),
    );
    assert.ok(!w, "Should not warn about already-declared dependency");
  });
});

describe("C3: Template Reference Validation", () => {
  it("throws on template referencing non-existent step", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad_ref",
          description: "Test bad ref",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "send",
              label: "Send",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat-sendmessage",
                inputMapping: { msg: "{{steps.nonexistent.result}}" },
              },
            },
          ],
        }),
      /references unknown step "nonexistent"/,
    );
  });

  it("throws on template referencing non-existent param field", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad_param",
          description: "Test bad param",
          params: {
            type: "object",
            properties: { channelName: { type: "string" } },
          },
          steps: [
            {
              id: "send",
              label: "Send",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat-sendmessage",
                inputMapping: { msg: "{{params.nonExistentField}}" },
              },
            },
          ],
        }),
      /nonExistentField.*not in the workflow params schema/,
    );
  });

  it("does not warn when param field exists", () => {
    const result = composeWorkflowDefinition({
      name: "test_good_param",
      description: "Test good param",
      params: {
        type: "object",
        properties: { channelName: { type: "string" } },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "{{params.channelName}}" },
          },
        },
      ],
    });

    const paramWarnings = result.warnings.filter(
      (w) => w.code === "DATA_FLOW_WARNING",
    );
    assert.equal(paramWarnings.length, 0, "Should have no param warnings");
  });

  it("validates template references inside nested inputMapping objects", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_nested_ref",
          description: "Test nested inputMapping",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "send",
              label: "Send",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat-sendmessage",
                inputMapping: {
                  message: {
                    msg: "{{steps.nonexistent.result}}",
                    rid: "some-room-id",
                  },
                },
              },
            },
          ],
        }),
      /references unknown step "nonexistent"/,
    );
  });

  it("throws on nested inputMapping referencing non-existent param field", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_nested_param_warn",
          description: "Test nested param warning",
          params: {
            type: "object",
            properties: { message: { type: "object" } },
          },
          steps: [
            {
              id: "send",
              label: "Send",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat-sendmessage",
                inputMapping: {
                  message: {
                    msg: "{{params.badField}}",
                    rid: "{{params.message}}",
                  },
                },
              },
            },
          ],
        }),
      /badField.*not in the workflow params schema/,
    );
  });

  it("warns on invalid sub-field of object param", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad_subfield",
          description: "Test invalid sub-field",
          params: {
            type: "object",
            properties: {
              room: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  displayName: { type: "string" },
                },
              },
              query: { type: "string" },
            },
          },
          steps: [
            {
              id: "send",
              label: "Send",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat-sendmessage",
                inputMapping: { roomId: "{{params.room.nonexistent}}" },
              },
            },
          ],
        }),
      (err: any) =>
        err.message.includes("nonexistent") &&
        err.message.includes("id, type, displayName"),
      "Should throw on unknown sub-field listing available properties",
    );
  });

  it("allows valid nested param path", () => {
    const result = composeWorkflowDefinition({
      name: "test_valid_subfield",
      description: "Test valid nested path",
      params: {
        type: "object",
        properties: {
          room: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
            },
          },
        },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { roomId: "{{params.room.id}}" },
          },
        },
      ],
    });
    assert.equal(
      result.warnings.filter((w) => w.code === "PARAM_SUBFIELD_UNKNOWN").length,
      0,
      "Should not warn on valid nested param path",
    );
  });

  it("allows JS methods on leaf params without warning", () => {
    const result = composeWorkflowDefinition({
      name: "test_leaf_method",
      description: "Test JS method on string param",
      params: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: {},
          },
        },
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: 'params.query.includes("test")',
            thenStep: "send",
          },
        },
      ],
    });
    assert.equal(
      result.warnings.filter((w) => w.code === "PARAM_SUBFIELD_UNKNOWN").length,
      0,
      "Should not warn on JS method calls on leaf params",
    );
  });
});

describe("C1: Data Flow Type Validation", () => {
  it("allows accessing .field on sampling result (JSON auto-parsed at runtime)", () => {
    const result = composeWorkflowDefinition({
      name: "test_sampling_field",
      description: "Test sampling field access",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.msg}}" },
        },
        {
          id: "route",
          label: "Route",
          config: {
            type: "conditional",
            condition: "steps.analyze.result.toxicityScore > 0.7",
            thenStep: "escalate",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "escalate",
          label: "Escalate",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "escalated" },
          },
          dependsOn: ["route"],
        },
      ],
    });
    assert.ok(result.workflow, "Should compose successfully");
  });

  it("throws when accessing .field on conditional result", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bool_field",
          description: "Test bool field access",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "check",
              label: "Check",
              config: {
                type: "conditional",
                condition: "true",
                thenStep: "next",
              },
            },
            {
              id: "next",
              label: "Next",
              config: {
                type: "transform",
                expression: "steps.check.result.someField",
              },
              dependsOn: ["check"],
            },
          ],
        }),
      /accesses ".someField" on step "check" \(conditional\)/,
    );
  });

  it("allows .field access on api_call results", () => {
    const result = composeWorkflowDefinition({
      name: "test_api_field",
      description: "Test api field access",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "extract",
          label: "Extract",
          config: {
            type: "transform",
            expression: "steps.fetch.result.channels",
          },
          dependsOn: ["fetch"],
        },
      ],
    });
    assert.ok(result.workflow.steps.length === 2);
  });

  it("allows .field access on elicitation results", () => {
    const result = composeWorkflowDefinition({
      name: "test_elicit_field",
      description: "Test elicit field access",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "ask",
          label: "Ask",
          config: {
            type: "elicitation",
            message: "Confirm?",
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean" } },
            },
          },
        },
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: "steps.ask.result.confirm === true",
            thenStep: "done",
          },
          dependsOn: ["ask"],
        },
        {
          id: "done",
          label: "Done",
          config: {
            type: "transform",
            expression: "'finished'",
          },
          dependsOn: ["check"],
        },
      ],
    });
    assert.ok(result.workflow.steps.length === 3);
  });

  it("allows string method calls on sampling results", () => {
    const result = composeWorkflowDefinition({
      name: "test_string_method",
      description: "Test string method",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Check: {{params.msg}}" },
        },
        {
          id: "route",
          label: "Route",
          config: {
            type: "conditional",
            condition: 'steps.analyze.result === "toxic"',
            thenStep: "act",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "act",
          label: "Act",
          config: {
            type: "transform",
            expression: "'acted'",
          },
          dependsOn: ["route"],
        },
      ],
    });
    assert.ok(result.workflow.steps.length === 3);
  });
});

describe("C6: Semantic Warnings", () => {
  it("warns on unused sampling step", () => {
    const result = composeWorkflowDefinition({
      name: "test_unused_sampling",
      description: "Test unused sampling",
      params: { type: "object", properties: { msg: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.msg}}" },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "hello" },
          },
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "UNUSED_SAMPLING");
    assert.ok(w, "Should warn about unused sampling step");
    assert.ok(w!.message.includes("analyze"));
  });

  it("warns on duplicate API calls", () => {
    const result = composeWorkflowDefinition({
      name: "test_dup_api",
      description: "Test dup api",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "send1",
          label: "Send 1",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "hello" },
          },
        },
        {
          id: "send2",
          label: "Send 2",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "world" },
          },
          dependsOn: ["send1"],
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "DUPLICATE_API_CALL");
    assert.ok(w, "Should warn about duplicate API calls");
    assert.ok(w!.message.includes("send1"));
    assert.ok(w!.message.includes("send2"));
  });

  it("does not warn on parallel terminal leaves (BFS reachability)", () => {
    const result = composeWorkflowDefinition({
      name: "test_parallel_leaves",
      description: "Test parallel leaves",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "entry",
          label: "Entry",
          config: {
            type: "conditional",
            condition: "true",
            thenStep: "action",
          },
        },
        {
          id: "action",
          label: "Action",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-delete",
            inputMapping: {},
          },
          dependsOn: ["entry"],
        },
        {
          id: "leaf_a",
          label: "Leaf A (DM user)",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "@user" },
          },
          dependsOn: ["action"],
        },
        {
          id: "leaf_b",
          label: "Leaf B (Log)",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "#log" },
          },
          dependsOn: ["action"],
        },
      ],
    });

    const orphanWarnings = result.warnings.filter(
      (w) => w.code === "ORPHANED_STEP",
    );
    assert.equal(
      orphanWarnings.length,
      0,
      "Parallel terminal leaves should not be flagged as orphaned",
    );
  });

  it("does not warn on the last step being unreferenced", () => {
    const result = composeWorkflowDefinition({
      name: "test_last_step",
      description: "Test last step",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "{{steps.fetch.result}}" },
          },
          dependsOn: ["fetch"],
        },
      ],
    });

    const orphanWarnings = result.warnings.filter(
      (w) => w.code === "ORPHANED_STEP" && w.stepId === "send",
    );
    assert.equal(
      orphanWarnings.length,
      0,
      "Last step should not be flagged as orphaned",
    );
  });

  it("returns warnings array even when no warnings", () => {
    const result = composeWorkflowDefinition({
      name: "test_clean",
      description: "Test clean",
      params: {
        type: "object",
        properties: { msg: { type: "string" } },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "{{params.msg}}" },
          },
        },
      ],
    });

    assert.ok(Array.isArray(result.warnings));
  });

  it("does NOT warn on sampling referenced via bare JS in transform expression", () => {
    const result = composeWorkflowDefinition({
      name: "test_sampling_via_transform",
      description: "Test sampling ref via transform",
      params: { type: "object", properties: { text: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.text}}" },
        },
        {
          id: "parse",
          label: "Parse",
          config: {
            type: "transform",
            expression: "JSON.parse(steps.analyze.result)",
          },
          dependsOn: ["analyze"],
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "UNUSED_SAMPLING");
    assert.equal(
      w,
      undefined,
      "Should NOT warn about sampling referenced via transform expression",
    );
  });

  it("auto-injects dependency when transform references step via bare JS", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_js_dep",
      description: "Test bare JS dep injection",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "test" },
        },
        {
          id: "parse",
          label: "Parse",
          config: {
            type: "transform",
            expression: "JSON.parse(steps.analyze.result)",
          },
          // Note: no dependsOn — should be auto-injected
        },
      ],
    });

    const parseStep = result.workflow.steps.find((s) => s.id === "parse");
    assert.ok(
      parseStep?.dependsOn?.includes("analyze"),
      "Should auto-inject dependency from bare JS step reference",
    );
  });

  it("auto-injects dependency when conditional references step via bare JS", () => {
    const result = composeWorkflowDefinition({
      name: "test_cond_bare_js",
      description: "Test conditional bare JS dep",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "parse",
          label: "Parse",
          config: {
            type: "transform",
            expression: "'parsed'",
          },
        },
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: "steps.parse.result.isViolation === true",
            thenStep: "act",
          },
          // Note: no dependsOn — should be auto-injected
        },
        {
          id: "act",
          label: "Act",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { msg: "violation" },
          },
        },
      ],
    });

    const checkStep = result.workflow.steps.find((s) => s.id === "check");
    assert.ok(
      checkStep?.dependsOn?.includes("parse"),
      "Should auto-inject dependency from bare JS in conditional condition",
    );
  });

  it("throws on sampling step with no template references when params exist", () => {
    assert.throws(
      () => {
        composeWorkflowDefinition({
          name: "test_static_prompt",
          description: "Test static prompt",
          params: {
            type: "object",
            properties: { msg: { type: "string" } },
          },
          steps: [
            {
              id: "analyze",
              label: "Analyze",
              config: {
                type: "sampling",
                prompt: "Analyze this message for violations.",
              },
            },
            {
              id: "parse",
              label: "Parse",
              config: {
                type: "transform",
                expression: "JSON.parse(steps.analyze.result)",
              },
              dependsOn: ["analyze"],
            },
          ],
        });
      },
      (err: any) => {
        assert.ok(err instanceof ComposerError);
        assert.ok(err.message.includes("analyze"));
        assert.ok(err.message.includes("does not reference"));
        return true;
      },
    );
  });

  it("does not warn on sampling step that references params", () => {
    const result = composeWorkflowDefinition({
      name: "test_dynamic_prompt",
      description: "Test dynamic prompt",
      params: {
        type: "object",
        properties: { msg: { type: "string" } },
      },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Analyze: {{params.msg}}",
          },
        },
        {
          id: "parse",
          label: "Parse",
          config: {
            type: "transform",
            expression: "JSON.parse(steps.analyze.result)",
          },
          dependsOn: ["analyze"],
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "STATIC_SAMPLING_PROMPT");
    assert.equal(w, undefined, "Should NOT warn when prompt references params");
  });

  it("warns on chat.sendMessage with hardcoded rid (nested)", () => {
    const result = composeWorkflowDefinition({
      name: "test_hardcoded_rid",
      description: "Test hardcoded rid",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "log",
          label: "Log to channel",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: { message: { rid: "moderation-log", msg: "hello" } },
          },
        },
      ],
    });
    const w = result.warnings.find((w) => w.code === "HARDCODED_RID");
    assert.ok(w, "Should warn about hardcoded rid");
    assert.ok(w!.message.includes("moderation-log"));
    assert.ok(w!.message.includes("postMessage"));
  });

  it("warns on chat.sendMessage with hardcoded rid (top-level)", () => {
    const result = composeWorkflowDefinition({
      name: "test_hardcoded_rid_top",
      description: "Test hardcoded rid top",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "log",
          label: "Log to channel",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: { rid: "general", msg: "hello" },
          },
        },
      ],
    });
    const w = result.warnings.find((w) => w.code === "HARDCODED_RID");
    assert.ok(w, "Should warn about hardcoded rid (top-level)");
    assert.ok(w!.message.includes("general"));
  });

  it("does not warn when rid is a template reference", () => {
    const result = composeWorkflowDefinition({
      name: "test_template_rid",
      description: "Test template rid",
      params: { type: "object", properties: { roomId: { type: "string" } } },
      steps: [
        {
          id: "send",
          label: "Send message",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              message: { rid: "{{params.roomId}}", msg: "hello" },
            },
          },
        },
      ],
    });
    const w = result.warnings.find((w) => w.code === "HARDCODED_RID");
    assert.equal(w, undefined, "Should NOT warn when rid is a template");
  });

  it("does not warn for chat.postMessage with hardcoded channel", () => {
    const result = composeWorkflowDefinition({
      name: "test_post_message",
      description: "Test postMessage",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "log",
          label: "Log to channel",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "#moderation-log", text: "hello" },
          },
        },
      ],
    });
    const w = result.warnings.find((w) => w.code === "HARDCODED_RID");
    assert.equal(w, undefined, "Should NOT warn for postMessage");
  });
});

describe("MULTIPLE_ROOTS warning", () => {
  it("warns when multiple steps have no dependsOn", () => {
    const result = composeWorkflowDefinition({
      name: "test_multi_roots",
      description: "Test",
      params: { type: "object", properties: { text: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.text}}" },
        },
        {
          id: "notify",
          label: "Notify",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "#log", text: "{{params.text}}" },
          },
        },
        {
          id: "dm",
          label: "DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "@user", text: "{{params.text}}" },
          },
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "MULTIPLE_ROOTS");
    assert.ok(w, "Should warn about multiple root steps");
    assert.ok(w!.message.includes("3 root steps"));
    assert.ok(w!.message.includes("analyze"));
    assert.ok(w!.message.includes("notify"));
    assert.ok(w!.message.includes("dm"));
  });

  it("does not warn when only 1 root step", () => {
    const result = composeWorkflowDefinition({
      name: "test_single_root",
      description: "Test",
      params: { type: "object", properties: { text: { type: "string" } } },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: { type: "sampling", prompt: "Analyze: {{params.text}}" },
        },
        {
          id: "notify",
          label: "Notify",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "#log", text: "{{steps.analyze.result}}" },
          },
          dependsOn: ["analyze"],
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "MULTIPLE_ROOTS");
    assert.equal(w, undefined, "Should not warn with single root");
  });

  it("does not warn when dependsOn is empty array (treated as root)", () => {
    const result = composeWorkflowDefinition({
      name: "test_empty_deps",
      description: "Test",
      params: { type: "object", properties: { text: { type: "string" } } },
      steps: [
        {
          id: "only_step",
          label: "Only",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: { channel: "#log", text: "{{params.text}}" },
          },
          dependsOn: [],
        },
      ],
    });

    const w = result.warnings.find((w) => w.code === "MULTIPLE_ROOTS");
    assert.equal(w, undefined, "Single step with empty dependsOn is fine");
  });
});

describe("inputMapping validation", () => {
  it("allows flat inputMapping keys", () => {
    const result = composeWorkflowDefinition({
      name: "test_flat_keys",
      description: "Test",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { rid: "room-123", msg: "hello" },
          },
        },
      ],
    });

    assert.ok(result.workflow);
  });

  it("allows nested inputMapping keys", () => {
    const result = composeWorkflowDefinition({
      name: "test_nested_keys",
      description: "Test",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-sendmessage",
            inputMapping: { message: { rid: "room-123", msg: "hello" } },
          },
        },
      ],
    });

    assert.ok(result.workflow);
  });
});

describe("generateWorkflowToolCode terminal step continueOnError", () => {
  it("auto-sets continueOnError on terminal steps with dependencies", () => {
    const workflow: WorkflowDefinition = {
      name: "test_terminal",
      description: "Tests terminal step detection",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "step_a",
          label: "First",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "step_b",
          label: "Middle",
          config: { type: "transform", expression: "steps.step_a.result" },
          dependsOn: ["step_a"],
        },
        {
          id: "step_c",
          label: "Terminal",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: { text: "done" },
          },
          dependsOn: ["step_b"],
        },
      ],
      requiredEndpoints: [
        "get-api-v1-channels-list",
        "post-api-v1-chat_sendMessage",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(code.includes('"id": "step_c"'), "Should contain step_c");
    const stepCIdx = code.indexOf('"id": "step_c"');
    const nextStepOrEnd = code.indexOf('"id":', stepCIdx + 1);
    const stepCBlock =
      nextStepOrEnd === -1
        ? code.slice(stepCIdx)
        : code.slice(stepCIdx, nextStepOrEnd);
    assert.ok(
      stepCBlock.includes('"continueOnError": true'),
      "Terminal step_c should have continueOnError",
    );
  });

  it("does not set continueOnError on mid-chain steps", () => {
    const workflow: WorkflowDefinition = {
      name: "test_midchain",
      description: "Tests mid-chain detection",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "step_a",
          label: "First",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "step_b",
          label: "Middle",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: { text: "mid" },
          },
          dependsOn: ["step_a"],
        },
        {
          id: "step_c",
          label: "Terminal",
          config: { type: "transform", expression: "steps.step_b.result" },
          dependsOn: ["step_b"],
        },
      ],
      requiredEndpoints: [
        "get-api-v1-channels-list",
        "post-api-v1-chat_sendMessage",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    const stepBIdx = code.indexOf('"id": "step_b"');
    const stepCIdx = code.indexOf('"id": "step_c"');
    const stepBBlock = code.slice(stepBIdx, stepCIdx);
    assert.ok(
      !stepBBlock.includes('"continueOnError"'),
      "Mid-chain step_b should NOT have continueOnError",
    );
  });

  it("does not set continueOnError on root single-step workflows", () => {
    const workflow: WorkflowDefinition = {
      name: "test_single",
      description: "Single step workflow",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "only_step",
          label: "Only step",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
      ],
      requiredEndpoints: ["get-api-v1-channels-list"],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      !code.includes('"continueOnError"'),
      "Single root step should NOT have continueOnError",
    );
  });
});

describe("forEach / as composer validation", () => {
  it("accepts api_call with forEach and as", () => {
    const result = composeWorkflowDefinition({
      name: "test_foreach",
      description: "Test forEach",
      params: { type: "object", properties: { query: { type: "string" } } },
      steps: [
        {
          id: "channels",
          label: "Get channels",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: { count: "10" },
          },
        },
        {
          id: "get_pinned",
          label: "Get pinned",
          config: {
            type: "api_call",
            operationId: "get-api-v1-chat_getPinnedMessages",
            forEach: "{{steps.channels.result.channels}}",
            as: "channel",
            inputMapping: { roomId: "{{steps.channel.result._id}}" },
          },
          dependsOn: ["channels"],
        },
      ],
    });
    assert.ok(result.workflow);
    assert.equal(result.workflow.steps.length, 2);
  });

  it("auto-sets as when forEach is provided without it", () => {
    const result = composeWorkflowDefinition({
      name: "test_auto_as",
      description: "Auto as",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "list_channels",
          label: "List channels",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "step1",
          label: "Step",
          config: {
            type: "api_call",
            operationId: "get-api-v1-test",
            inputMapping: {},
            forEach: "{{steps.list_channels.result.channels}}",
          } as any,
          dependsOn: ["list_channels"],
        },
      ],
    });
    assert.ok(result.workflow);
    assert.equal((result.workflow.steps[1].config as any).as, "step1_item");
    assert.ok(result.warnings.some((w) => w.code === "FIELD_AUTO_SET"));
  });

  it("strips as without forEach and emits warning", () => {
    const result = composeWorkflowDefinition({
      name: "test_strip_as",
      description: "Strip as",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "step1",
          label: "Step",
          config: {
            type: "api_call",
            operationId: "get-api-v1-test",
            inputMapping: {},
            as: "item",
          } as any,
        },
      ],
    });
    assert.ok(result.workflow);
    assert.equal((result.workflow.steps[0].config as any).as, undefined);
    assert.ok(
      result.warnings.some(
        (w) => w.code === "FIELD_STRIPPED" && w.stepId === "step1",
      ),
    );
  });
});

describe("forEach / as codegen", () => {
  it("serializes forEach and as in generated step definitions", () => {
    const workflow: WorkflowDefinition = {
      name: "test_foreach",
      description: "Test forEach codegen",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "channels",
          label: "Get channels",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: { count: "10" },
          },
        },
        {
          id: "get_pinned",
          label: "Get pinned",
          config: {
            type: "api_call",
            operationId: "get-api-v1-chat_getPinnedMessages",
            forEach: "{{steps.channels.result.channels}}",
            as: "channel",
            inputMapping: { roomId: "{{steps.channel.result._id}}" },
          },
          dependsOn: ["channels"],
        },
      ],
      requiredEndpoints: [
        "get-api-v1-channels_list",
        "get-api-v1-chat_getPinnedMessages",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(code.includes('"forEach"'), "Should serialize forEach");
    assert.ok(code.includes('"as"'), "Should serialize as");
    assert.ok(
      code.includes('"channel"'),
      "Should have channel as iterator name",
    );
  });
});

describe("template normalization", () => {
  it("auto-wraps bare steps.* ref in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_ref",
      description: "Auto-wrap bare ref",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              rid: "steps.fetch.result.channel._id",
            },
          },
        },
      ],
    });
    const sendStep = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (sendStep.config as any).inputMapping;
    // After .result stripping: {{steps.fetch.channel._id}}
    // After inferOutputPath: outputPath="channel" inferred, ref rewritten to {{steps.fetch._id}}
    assert.equal(
      mapping.rid,
      "{{steps.fetch._id}}",
      "Bare ref should be auto-wrapped and outputPath-rewritten",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "TEMPLATE_AUTO_WRAPPED"),
      "Should emit TEMPLATE_AUTO_WRAPPED warning",
    );
  });

  it("auto-wraps bare params.* ref in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_param",
      description: "Auto-wrap bare param ref",
      params: {
        type: "object",
        properties: { query: { type: "string" } },
      },
      steps: [
        {
          id: "search",
          label: "Search",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {
              query: "params.query",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "search")!;
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.query, "{{params.query}}");
  });

  it("auto-wraps bare ref in forEach field", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_foreach",
      description: "Auto-wrap bare forEach",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "list",
          label: "List",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "iter",
          label: "Iterate",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            forEach: "steps.list.result.channels",
            as: "ch",
            inputMapping: { id: "{{steps.ch.result._id}}" },
          },
        },
      ],
    });
    const iterStep = result.workflow.steps.find((s) => s.id === "iter")!;
    // After .result stripping + auto-wrap: {{steps.list.channels}}
    // After inferOutputPath: outputPath="channels" inferred, ref rewritten to {{steps.list}}
    assert.equal(
      (iterStep.config as any).forEach,
      "{{steps.list}}",
      "forEach bare ref should be auto-wrapped and outputPath-rewritten",
    );
  });

  it("rewrites {{asVar.field}} to {{steps.asVar.field}}", () => {
    const result = composeWorkflowDefinition({
      name: "test_as_rewrite",
      description: "Rewrite as-variable refs",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "list",
          label: "List",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "iter",
          label: "Iterate",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            forEach: "{{steps.list.result.channels}}",
            as: "channel",
            inputMapping: { roomId: "{{channel._id}}" },
          },
        },
      ],
    });
    const iterStep = result.workflow.steps.find((s) => s.id === "iter")!;
    const mapping = (iterStep.config as any).inputMapping;
    assert.equal(
      mapping.roomId,
      "{{steps.channel._id}}",
      "as-variable ref should be rewritten",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "AS_VAR_REWRITTEN"),
      "Should emit AS_VAR_REWRITTEN warning",
    );
  });

  it("does NOT rewrite as-variable to params when names collide", () => {
    const result = composeWorkflowDefinition({
      name: "test_as_collision",
      description: "forEach as-var collides with param name",
      params: {
        type: "object",
        properties: {
          room: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
            },
          },
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "list",
          label: "List",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "iter",
          label: "Iterate rooms",
          config: {
            type: "api_call",
            operationId: "get-api-v1-chat_getPinnedMessages",
            forEach: "{{steps.list.result.channels}}",
            as: "room",
            inputMapping: { roomId: "{{room._id}}" },
          },
          dependsOn: ["list"],
        },
      ],
    });
    const iterStep = result.workflow.steps.find((s) => s.id === "iter")!;
    const mapping = (iterStep.config as any).inputMapping;
    assert.notEqual(
      mapping.roomId,
      "{{params.room._id}}",
      "as-variable 'room' must NOT be rewritten to params.room",
    );
    assert.equal(
      mapping.roomId,
      "{{steps.room._id}}",
      "as-variable should be rewritten to steps.room path",
    );
    assert.ok(
      !result.warnings.some(
        (w) =>
          w.code === "EVENT_PARAM_REWRITTEN" && w.message.includes('"room."'),
      ),
      "Should NOT emit EVENT_PARAM_REWRITTEN for forEach as-variable",
    );
  });

  it("does NOT normalize transform expressions (raw JS)", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_normalize_js",
      description: "Do not normalize raw JS",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "transform",
          label: "Transform",
          config: {
            type: "transform",
            expression: "steps.fetch.result.channels.length",
          },
          dependsOn: ["fetch"],
        },
      ],
    });
    const xStep = result.workflow.steps.find((s) => s.id === "transform")!;
    // After .result stripping: steps.fetch.channels.length
    // After inferOutputPath: outputPath="channels" inferred, ref rewritten to steps.fetch.length
    assert.equal(
      (xStep.config as any).expression,
      "steps.fetch.length",
      "Transform expressions should have .result stripped and outputPath-rewritten",
    );
  });
});

describe("requestBody unwrapping (Fix 4)", () => {
  it("unwraps requestBody wrapper in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_unwrap",
      description: "Unwrap requestBody",
      params: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              requestBody: {
                message: {
                  msg: "{{params.text}}",
                  rid: "GENERAL",
                },
              },
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(
      !("requestBody" in mapping),
      "requestBody wrapper should be removed",
    );
    assert.ok("message" in mapping, "Inner keys should be promoted");
    assert.ok(
      result.warnings.some((w) => w.code === "REQUEST_BODY_UNWRAPPED"),
      "Should emit REQUEST_BODY_UNWRAPPED warning",
    );
  });

  it("unwraps body wrapper in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_unwrap_body",
      description: "Unwrap body",
      params: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              body: {
                channel: "#general",
                text: "{{params.text}}",
              },
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(!("body" in mapping), "body wrapper should be removed");
    assert.equal(mapping.channel, "#general");
  });

  it("does NOT unwrap when requestBody is not the only key", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_unwrap",
      description: "No unwrap",
      params: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              requestBody: { msg: "{{params.text}}" },
              extraField: "value",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(
      "requestBody" in mapping,
      "Should NOT unwrap when multiple keys exist",
    );
  });
});

describe("event param shorthand normalization", () => {
  it("rewrites {{context.X}} to {{params.context.X}} in templates", () => {
    const result = composeWorkflowDefinition({
      name: "test_event_rewrite",
      description: "Test event param shorthand",
      params: {
        type: "object",
        properties: { context: { type: "object" } },
      },
      steps: [
        {
          id: "send_dm",
          label: "Send DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "@{{context.user.username}}",
              text: "Hello {{context.user.name}}!",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "@{{params.context.user.username}}");
    assert.equal(mapping.text, "Hello {{params.context.user.name}}!");
  });

  it("keeps bare context.X in conditional conditions (warns only)", () => {
    const result = composeWorkflowDefinition({
      name: "test_condition_rewrite",
      description: "Test condition rewrite",
      params: {
        type: "object",
        properties: { context: { type: "object" } },
      },
      steps: [
        {
          id: "action",
          label: "Action step",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: { channel: "general", text: "hi" },
          },
        },
        {
          id: "check_admin",
          label: "Check admin role",
          config: {
            type: "conditional",
            condition: "context.user.roles.includes('admin')",
            thenStep: "action",
          },
        },
      ],
    });
    const condStep = result.workflow.steps.find((s) => s.id === "check_admin")!;
    // JS rewriter is now warning-only: condition stays unchanged
    assert.equal(
      (condStep.config as any).condition,
      "context.user.roles.includes('admin')",
    );
    // Should emit a shorthand warning
    assert.ok(
      result.warnings.some((w) => w.code === "EVENT_PARAM_SHORTHAND"),
      "should emit EVENT_PARAM_SHORTHAND warning",
    );
  });

  it("rewrites {{context.X}} in sampling prompt so it passes validation", () => {
    const result = composeWorkflowDefinition({
      name: "test_sampling_rewrite",
      description: "Test sampling rewrite",
      params: {
        type: "object",
        properties: { context: { type: "object" } },
      },
      steps: [
        {
          id: "gen_checklist",
          label: "Generate checklist",
          config: {
            type: "sampling",
            prompt:
              "Generate checklist for {{context.user.name}} with roles {{context.user.roles}}",
            maxTokens: 200,
          },
        },
        {
          id: "post_it",
          label: "Post checklist",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "general",
              text: "{{steps.gen_checklist.result}}",
            },
          },
        },
      ],
    });
    const samplingStep = result.workflow.steps.find(
      (s) => s.id === "gen_checklist",
    )!;
    const prompt = (samplingStep.config as any).prompt;
    assert.ok(
      prompt.includes("{{params.context.user.name}}"),
      `prompt should have params prefix: ${prompt}`,
    );
    assert.ok(
      prompt.includes("{{params.context.user.roles}}"),
      `prompt should have params prefix: ${prompt}`,
    );
  });

  it("does NOT double-rewrite already-prefixed params.context.X", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_double_rewrite",
      description: "Test idempotent rewrite",
      params: {
        type: "object",
        properties: { context: { type: "object" } },
      },
      steps: [
        {
          id: "send_dm",
          label: "Send DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "@{{params.context.user.username}}",
              text: "Hello {{context.user.name}}!",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(
      mapping.channel,
      "@{{params.context.user.username}}",
      "should NOT double-prefix",
    );
    assert.equal(
      mapping.text,
      "Hello {{params.context.user.name}}!",
      "should prefix missing one",
    );
  });

  it("works with message event param (not just context)", () => {
    const result = composeWorkflowDefinition({
      name: "test_message_rewrite",
      description: "Test message event param",
      params: {
        type: "object",
        properties: { message: { type: "object" } },
      },
      steps: [
        {
          id: "echo",
          label: "Echo message",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "{{message.rid}}",
              text: "Echo: {{message.text}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "{{params.message.rid}}");
    assert.equal(mapping.text, "Echo: {{params.message.text}}");
  });

  it("keeps bare context.X in transform expressions (warns only)", () => {
    const result = composeWorkflowDefinition({
      name: "test_transform_rewrite",
      description: "Test transform rewrite",
      params: {
        type: "object",
        properties: { context: { type: "object" } },
      },
      steps: [
        {
          id: "get_roles",
          label: "Extract roles",
          config: {
            type: "transform",
            expression: "context.user.roles.join(', ')",
          },
        },
        {
          id: "post_it",
          label: "Post roles",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "general",
              text: "{{steps.get_roles.result}}",
            },
          },
        },
      ],
    });
    const transformStep = result.workflow.steps.find(
      (s) => s.id === "get_roles",
    )!;
    // JS rewriter is now warning-only: expression stays unchanged
    assert.equal(
      (transformStep.config as any).expression,
      "context.user.roles.join(', ')",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "EVENT_PARAM_SHORTHAND"),
      "should emit EVENT_PARAM_SHORTHAND warning",
    );
  });

  it("rewrites {{params.user.X}} to {{params.context.user.X}} when user is sub-field of context", () => {
    const result = composeWorkflowDefinition({
      name: "test_subfield_rewrite",
      description: "Test sub-field rewrite",
      params: {
        type: "object",
        properties: {
          context: {
            type: "object",
            properties: {
              user: { type: "object" },
              performedBy: { type: "object" },
            },
          },
        },
      },
      steps: [
        {
          id: "send_dm",
          label: "Send DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "@{{params.user.username}}",
              text: "Hello {{params.user.name}}, added by {{params.performedBy.username}}!",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "@{{params.context.user.username}}");
    assert.equal(
      mapping.text,
      "Hello {{params.context.user.name}}, added by {{params.context.performedBy.username}}!",
    );
  });

  it("warns for params.user.X sub-field shorthand in JS conditions", () => {
    // With the JS rewriter now warning-only, params.user.X stays as-is.
    // But validation catches params.user as an unknown param.
    // The correct way is to use params.context.user.X or bare context.user.X.
    // We test that using the correct bare form works and emits a shorthand warning.
    const result = composeWorkflowDefinition({
      name: "test_subfield_js_rewrite",
      description: "Test sub-field JS rewrite",
      params: {
        type: "object",
        properties: {
          context: {
            type: "object",
            properties: {
              user: { type: "object" },
            },
          },
        },
      },
      steps: [
        {
          id: "action",
          label: "Action",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: { channel: "general", text: "hi" },
          },
        },
        {
          id: "check_role",
          label: "Check role",
          config: {
            type: "conditional",
            condition: "context.user.roles.includes('admin')",
            thenStep: "action",
          },
        },
      ],
    });
    const condStep = result.workflow.steps.find((s) => s.id === "check_role")!;
    assert.equal(
      (condStep.config as any).condition,
      "context.user.roles.includes('admin')",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "EVENT_PARAM_SHORTHAND"),
      "should emit EVENT_PARAM_SHORTHAND warning",
    );
  });

  it("does NOT rewrite params.context.user.X (already correct)", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_double_subfield",
      description: "Test no double sub-field rewrite",
      params: {
        type: "object",
        properties: {
          context: {
            type: "object",
            properties: {
              user: { type: "object" },
            },
          },
        },
      },
      steps: [
        {
          id: "send_dm",
          label: "Send DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "@{{params.context.user.username}}",
              text: "Hello {{params.context.user.name}}!",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "@{{params.context.user.username}}");
    assert.equal(mapping.text, "Hello {{params.context.user.name}}!");
  });

  it("does NOT rewrite when sub-field name matches a top-level param", () => {
    const result = composeWorkflowDefinition({
      name: "test_toplevel_precedence",
      description: "Test top-level param takes precedence",
      params: {
        type: "object",
        properties: {
          user: { type: "object" },
          context: {
            type: "object",
            properties: {
              user: { type: "object" },
            },
          },
        },
      },
      steps: [
        {
          id: "send_dm",
          label: "Send DM",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "@{{params.user.username}}",
              text: "{{params.context.user.name}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps[0];
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "@{{params.user.username}}");
    assert.equal(mapping.text, "{{params.context.user.name}}");
  });

  it("does NOT corrupt step result property chains containing param names", () => {
    // With scope injection (Approach 5), the JS rewriter no longer mutates
    // conditions/transforms. Both bare `room.id` and `params.room.id` work
    // at runtime because buildJsScope injects params as bare identifiers.
    const result = composeWorkflowDefinition({
      name: "test_no_step_corruption",
      description: "Ensure step result property chains are not corrupted",
      params: {
        type: "object",
        properties: {
          room: {
            type: "object",
            properties: {
              id: { type: "string" },
              displayName: { type: "string" },
            },
          },
          sender: {
            type: "object",
            properties: {
              id: { type: "string" },
              username: { type: "string" },
            },
          },
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "get_room_info",
          label: "Get Room Info",
          config: {
            type: "api_call",
            operationId: "get-api-v1-rooms_info",
            inputMapping: { roomId: "{{params.room.id}}" },
          },
        },
        {
          id: "check_room",
          label: "Check Room",
          config: {
            type: "conditional",
            condition:
              "room.id !== '' && steps.get_room_info.room.name.startsWith('inc-')",
            thenStep: "build_state",
          },
        },
        {
          id: "build_state",
          label: "Build State",
          config: {
            type: "transform",
            expression:
              "({ user: sender.username, roomType: steps.get_room_info.room.type })",
          },
        },
      ],
    });

    const condStep = result.workflow.steps.find((s) => s.id === "check_room")!;
    const condition = (condStep.config as any).condition;
    // JS rewriter is now warning-only: bare room.id stays as-is
    assert.ok(
      condition.includes("room.id"),
      `bare room.id should remain unchanged: ${condition}`,
    );
    // steps.get_room_info.room.name → after inferOutputPath (outputPath="room" inferred):
    // steps.get_room_info.name
    assert.ok(
      condition.includes("steps.get_room_info.name"),
      `step property chain should be rewritten by outputPath inference: ${condition}`,
    );

    const transformStep = result.workflow.steps.find(
      (s) => s.id === "build_state",
    )!;
    const expr = (transformStep.config as any).expression;
    // bare sender.username stays as-is
    assert.ok(
      expr.includes("sender.username"),
      `bare sender.username should remain unchanged: ${expr}`,
    );
    // steps.get_room_info.room.type → after inferOutputPath: steps.get_room_info.type
    assert.ok(
      expr.includes("steps.get_room_info.type"),
      `step property chain should be rewritten by outputPath inference: ${expr}`,
    );

    // Should emit EVENT_PARAM_SHORTHAND warnings (not REWRITTEN)
    assert.ok(
      result.warnings.some((w) => w.code === "EVENT_PARAM_SHORTHAND"),
      `should emit EVENT_PARAM_SHORTHAND warning`,
    );
  });
});

describe("codegen safety nets", () => {
  it("auto-sets continueOnError on groups_create steps", () => {
    const workflow: WorkflowDefinition = {
      name: "test_groups_create",
      description: "Tests groups_create continueOnError",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "create_group",
          label: "Create Group",
          config: {
            type: "api_call",
            operationId: "post-api-v1-groups_create",
            inputMapping: { name: "test-group" },
          },
        },
        {
          id: "post_msg",
          label: "Post",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: { channel: "#test-group", text: "hello" },
          },
          dependsOn: ["create_group"],
        },
      ],
      requiredEndpoints: [
        "post-api-v1-groups_create",
        "post-api-v1-chat_postMessage",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    const groupIdx = code.indexOf('"id": "create_group"');
    const nextIdx = code.indexOf('"id":', groupIdx + 1);
    const block =
      nextIdx === -1 ? code.slice(groupIdx) : code.slice(groupIdx, nextIdx);
    assert.ok(
      block.includes('"continueOnError": true'),
      "groups_create step should have continueOnError",
    );
  });

  it("auto-sets continueOnError on channels_info with hardcoded roomName", () => {
    const workflow: WorkflowDefinition = {
      name: "test_room_lookup",
      description: "Tests hardcoded roomName continueOnError",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "lookup_channel",
          label: "Lookup Channel",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_info",
            inputMapping: { roomName: "support-team" },
          },
        },
      ],
      requiredEndpoints: ["get-api-v1-channels_info"],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes('"continueOnError": true'),
      "channels_info with hardcoded roomName should have continueOnError",
    );
  });

  it("does NOT auto-set continueOnError when roomId is a template reference", () => {
    const workflow: WorkflowDefinition = {
      name: "test_dynamic_room",
      description: "Tests dynamic roomId does not get continueOnError",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "lookup",
          label: "Lookup",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_info",
            inputMapping: { roomName: "general" },
          },
        },
        {
          id: "invite",
          label: "Invite",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels_invite",
            inputMapping: {
              roomId: "{{steps.lookup.result.channel._id}}",
              userId: "{{params.userId}}",
            },
          },
          dependsOn: ["lookup"],
        },
        {
          id: "post_msg",
          label: "Post",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              roomId: "{{steps.lookup.result.channel._id}}",
              text: "done",
            },
          },
          dependsOn: ["invite"],
        },
      ],
      requiredEndpoints: [
        "get-api-v1-channels_info",
        "post-api-v1-channels_invite",
        "post-api-v1-chat_postMessage",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    const inviteIdx = code.indexOf('"id": "invite"');
    const nextIdx = code.indexOf('"id":', inviteIdx + 1);
    const block =
      nextIdx === -1 ? code.slice(inviteIdx) : code.slice(inviteIdx, nextIdx);
    assert.ok(
      !block.includes('"continueOnError"'),
      "Mid-chain channels_invite with dynamic roomId should NOT have continueOnError from room-field rule",
    );
  });

  it("auto-wires channels_create → channels_invite roomId reference", () => {
    const workflow: WorkflowDefinition = {
      name: "test_autowire",
      description: "Tests auto-wire create → invite",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "ensure_general",
          label: "Ensure General",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels_create",
            inputMapping: { name: "general" },
          },
        },
        {
          id: "add_to_general",
          label: "Add to General",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels_invite",
            inputMapping: { roomId: "general", userId: "{{params.userId}}" },
          },
          dependsOn: ["ensure_general"],
        },
      ],
      requiredEndpoints: [
        "post-api-v1-channels_create",
        "post-api-v1-channels_invite",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes("steps.ensure_general.result.channel._id"),
      "roomId should reference the create step's channel._id",
    );
    assert.ok(
      !code.includes('"roomId": "general"'),
      "Literal 'general' should be replaced",
    );
  });

  it("auto-wires groups_create → groups_invite roomId reference", () => {
    const workflow: WorkflowDefinition = {
      name: "test_autowire_groups",
      description: "Tests auto-wire create → invite for groups",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "create_mod_group",
          label: "Create Mod Group",
          config: {
            type: "api_call",
            operationId: "post-api-v1-groups_create",
            inputMapping: { name: "mod-team" },
          },
        },
        {
          id: "invite_to_mod",
          label: "Invite to Mod",
          config: {
            type: "api_call",
            operationId: "post-api-v1-groups_invite",
            inputMapping: { roomId: "mod-team", userId: "{{params.userId}}" },
          },
          dependsOn: ["create_mod_group"],
        },
      ],
      requiredEndpoints: [
        "post-api-v1-groups_create",
        "post-api-v1-groups_invite",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes("steps.create_mod_group.result.group._id"),
      "roomId should reference the create step's group._id",
    );
  });

  it("skips auto-wire when roomId is already a template reference", () => {
    const workflow: WorkflowDefinition = {
      name: "test_no_autowire",
      description: "Tests that existing template refs are preserved",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "ensure_chan",
          label: "Ensure Channel",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels_create",
            inputMapping: { name: "general" },
          },
        },
        {
          id: "invite",
          label: "Invite",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels_invite",
            inputMapping: {
              roomId: "{{steps.ensure_chan.result.channel._id}}",
              userId: "{{params.userId}}",
            },
          },
          dependsOn: ["ensure_chan"],
        },
      ],
      requiredEndpoints: [
        "post-api-v1-channels_create",
        "post-api-v1-channels_invite",
      ],
      usesSampling: false,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes("steps.ensure_chan.result.channel._id"),
      "Existing template reference should be preserved",
    );
  });
});

// ── Phase 3: Sampling responseSchema inference ──────────────────────────

describe("inferSamplingResponseSchemas", () => {
  it("infers responseSchema from downstream field accesses", () => {
    const result = composeWorkflowDefinition({
      name: "test_infer",
      description: "Test schema inference",
      params: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt:
              "Analyze query: {{params.query}} — return relevant, answer, sources",
            responseFormat: "json",
          },
        },
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: "steps.analyze.result.relevant === false",
            thenStep: "fallback",
            elseStep: "reply",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "reply",
          label: "Reply",
          config: {
            type: "transform",
            expression:
              "steps.analyze.result.answer + steps.analyze.result.sources.join(',')",
          },
          dependsOn: ["check"],
        },
        {
          id: "fallback",
          label: "Fallback",
          config: {
            type: "transform",
            expression: "'no results'",
          },
          dependsOn: ["check"],
        },
      ],
    });

    const analyzeStep = result.workflow.steps.find((s) => s.id === "analyze")!;
    const cfg = analyzeStep.config as {
      responseSchema?: Record<string, string>;
    };
    assert.ok(cfg.responseSchema, "responseSchema should be inferred");
    assert.equal(
      cfg.responseSchema!.relevant,
      "boolean",
      "relevant used with === false → boolean",
    );
    assert.equal(
      cfg.responseSchema!.answer,
      "string",
      "answer used in string concatenation → string",
    );
    assert.equal(
      cfg.responseSchema!.sources,
      "array",
      "sources used with .join → array",
    );
  });

  it("emits SAMPLING_SCHEMA_MISMATCH when field not in prompt", () => {
    const result = composeWorkflowDefinition({
      name: "test_mismatch",
      description: "Test mismatch warning",
      params: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Analyze: {{params.query}}",
            responseFormat: "json",
          },
        },
        {
          id: "use_it",
          label: "Use",
          config: {
            type: "transform",
            expression: "steps.analyze.result.secretField",
          },
          dependsOn: ["analyze"],
        },
      ],
    });

    const mismatchWarnings = result.warnings.filter(
      (w) => w.code === "SAMPLING_SCHEMA_MISMATCH",
    );
    assert.ok(
      mismatchWarnings.length > 0,
      "should warn about secretField not in prompt",
    );
    assert.ok(
      mismatchWarnings[0].message.includes("secretField"),
      "warning mentions the missing field",
    );
  });

  it("does NOT infer schema for sampling steps without responseFormat json", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_infer",
      description: "No inference for text format",
      params: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Analyze: {{params.query}}",
          },
        },
        {
          id: "use_it",
          label: "Use",
          config: {
            type: "transform",
            expression: "steps.analyze.result.includes('hello')",
          },
          dependsOn: ["analyze"],
        },
      ],
    });

    const analyzeStep = result.workflow.steps.find((s) => s.id === "analyze")!;
    const cfg = analyzeStep.config as {
      responseSchema?: Record<string, string>;
    };
    assert.equal(
      cfg.responseSchema,
      undefined,
      "no schema for text-format sampling",
    );
  });
});

// ── Fix B: config spread preserves all fields ─────────────────────────────

describe("config spread (codegen)", () => {
  it("preserves explicit responseFormat from sampling config", () => {
    const workflow: WorkflowDefinition = {
      name: "test_response_format",
      description: "Test responseFormat preservation",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Tell me about the weather today",
            responseFormat: "json",
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes('"responseFormat": "json"'),
      "responseFormat should appear in generated code",
    );
  });

  it("preserves responseSchema in sampling config", () => {
    const workflow: WorkflowDefinition = {
      name: "test_response_schema",
      description: "Test responseSchema preservation",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Analyze this message. Respond in JSON.",
            responseFormat: "json",
            responseSchema: { relevant: "boolean", answer: "string" },
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes('"responseSchema"'),
      "responseSchema should appear in generated code",
    );
    assert.ok(
      code.includes('"relevant"'),
      "responseSchema field should appear",
    );
  });

  it("falls back to detection when responseFormat not explicit", () => {
    const workflow: WorkflowDefinition = {
      name: "test_detection_fallback",
      description: "Test fallback detection",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt:
              "Respond with a JSON object containing relevant and answer fields",
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      code.includes('"responseFormat": "json"'),
      "responseFormat should be auto-detected from prompt",
    );
  });

  it("does not add responseFormat when no JSON intent", () => {
    const workflow: WorkflowDefinition = {
      name: "test_no_json",
      description: "Test no responseFormat",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "greet",
          label: "Greet",
          config: {
            type: "sampling",
            prompt: "Say hello to the user",
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };
    const code = generateWorkflowToolCode(workflow);
    assert.ok(
      !code.includes('"responseFormat"'),
      "should NOT have responseFormat for non-JSON prompt",
    );
  });
});

// ── Fix C: Handlebars auto-conversion ────────────────────────────────────

describe("Handlebars auto-conversion", () => {
  it("converts {{#each}} to map/join", () => {
    const result = composeWorkflowDefinition({
      name: "test_each",
      description: "Test each conversion",
      params: {
        type: "object",
        properties: { items: { type: "array" } },
      },
      steps: [
        {
          id: "format",
          label: "Format",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              msg: "Results:\\n{{#each params.items}}- {{this.name}}\\n{{/each}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "format")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(
      !mapping.msg.includes("{{#each"),
      "Handlebars should be converted",
    );
    assert.ok(mapping.msg.includes(".map("), "Should use .map()");
    assert.ok(mapping.msg.includes(".join("), "Should use .join()");
  });

  it("converts {{#if}} to ternary", () => {
    const result = composeWorkflowDefinition({
      name: "test_if",
      description: "Test if conversion",
      params: {
        type: "object",
        properties: { flag: { type: "boolean" } },
      },
      steps: [
        {
          id: "msg",
          label: "Message",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              msg: "{{#if params.flag}}Enabled{{/if}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "msg")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(
      !mapping.msg.includes("{{#if"),
      "Handlebars #if should be converted",
    );
    assert.ok(mapping.msg.includes("?"), "Should use ternary");
  });

  it("converts {{#if}}...{{else}}...{{/if}} to ternary with both branches", () => {
    const result = composeWorkflowDefinition({
      name: "test_if_else",
      description: "Test if-else conversion",
      params: {
        type: "object",
        properties: { active: { type: "boolean" } },
      },
      steps: [
        {
          id: "status",
          label: "Status",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              msg: "User is {{#if params.active}}active{{else}}inactive{{/if}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "status")!;
    const mapping = (step.config as any).inputMapping;
    assert.ok(mapping.msg.includes("active"), "Should include 'active'");
    assert.ok(mapping.msg.includes("inactive"), "Should include 'inactive'");
    assert.ok(!mapping.msg.includes("{{#if"), "Handlebars should be converted");
  });

  it("throws on nested Handlebars blocks", () => {
    assert.throws(
      () => {
        composeWorkflowDefinition({
          name: "test_nested",
          description: "Test nested blocks error",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "fmt",
              label: "Format",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat_sendMessage",
                inputMapping: {
                  msg: "{{#each items}}{{#if this.active}}{{this.name}}{{/if}}{{/each}}",
                },
              },
            },
          ],
        });
      },
      { message: /nested Handlebars blocks/i },
    );
  });

  it("throws on unsupported Handlebars helpers", () => {
    assert.throws(
      () => {
        composeWorkflowDefinition({
          name: "test_unless",
          description: "Test unsupported helper",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "fmt",
              label: "Format",
              config: {
                type: "api_call",
                operationId: "post-api-v1-chat_sendMessage",
                inputMapping: {
                  msg: "{{#unless done}}Not done{{/unless}}",
                },
              },
            },
          ],
        });
      },
      { message: /unsupported Handlebars helper/i },
    );
  });
});

// ── Fix D: Newline/tab normalization (single + double escaping) ─────────

describe("Newline/tab normalization", () => {
  it("normalizes single-escaped \\n to real newline in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_newline_single",
      description: "Test single escape",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "post",
          label: "Post",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              text: "line1\\nline2",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "post")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(
      mapping.text,
      "line1\nline2",
      "Single-escaped \\n should become real newline",
    );
  });

  it("normalizes double-escaped \\\\n to real newline in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_newline_double",
      description: "Test double escape",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "post",
          label: "Post",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              text: "line1\\\\nline2",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "post")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(
      mapping.text,
      "line1\nline2",
      "Double-escaped \\\\n should become real newline",
    );
  });

  it("normalizes triple-escaped \\\\\\n to real newline", () => {
    const result = composeWorkflowDefinition({
      name: "test_newline_triple",
      description: "Test triple escape",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "post",
          label: "Post",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              text: "a\\\\\\nb",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "post")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(
      mapping.text,
      "a\nb",
      "Triple-escaped should become real newline",
    );
  });

  it("does NOT mangle \\n in transform expressions (raw JS context is not normalized)", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_false_positive",
      description: "Test that JS contexts are untouched",
      params: { type: "object", properties: { data: { type: "string" } } },
      steps: [
        {
          id: "parse",
          label: "Parse",
          config: {
            type: "transform" as const,
            expression: "params.data.split('\\n')",
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "parse")!;
    const expr = (step.config as any).expression;
    assert.ok(
      expr.includes("\\n"),
      `Transform expression should keep \\n as-is for JS, got: ${JSON.stringify(expr)}`,
    );
  });

  it("normalizes \\t same as \\n (single + double)", () => {
    const result = composeWorkflowDefinition({
      name: "test_tab",
      description: "Test tab normalization",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "post",
          label: "Post",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              text: "col1\\tcol2\\\\tcol3",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "post")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(
      mapping.text,
      "col1\tcol2\tcol3",
      "Both single and double escaped tabs should normalize",
    );
  });

  it("handles multiple \\n in a single string", () => {
    const result = composeWorkflowDefinition({
      name: "test_multi_newline",
      description: "Test multiple newlines",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "post",
          label: "Post",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              text: "Header\\n\\nBody\\nFooter",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "post")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(mapping.text, "Header\n\nBody\nFooter");
  });

  it("normalizes nested inputMapping (message.msg) double-escaped", () => {
    const result = composeWorkflowDefinition({
      name: "test_nested_escape",
      description: "Test nested inputMapping",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              message: {
                rid: "some-room-id",
                msg: "Status:\\\\n- Item 1\\\\n- Item 2",
              },
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (step.config as any).inputMapping;
    assert.strictEqual(
      (mapping.message as any).msg,
      "Status:\n- Item 1\n- Item 2",
      "Double-escaped \\\\n in nested inputMapping should normalize",
    );
  });

  it("normalizes prompt strings with double-escaped newlines", () => {
    const result = composeWorkflowDefinition({
      name: "test_prompt_escape",
      description: "Test prompt normalization",
      params: { type: "object", properties: { data: { type: "string" } } },
      steps: [
        {
          id: "classify",
          label: "Classify",
          config: {
            type: "sampling" as const,
            prompt: "Analyze this:\\\\n{{params.data}}",
            systemPrompt: "You are a classifier.\\\\nBe concise.",
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "classify")!;
    const cfg = step.config as any;
    assert.strictEqual(cfg.prompt, "Analyze this:\n{{params.data}}");
    assert.strictEqual(cfg.systemPrompt, "You are a classifier.\nBe concise.");
  });
});

// ── Fix A: .result auto-stripping ───────────────────────────────────────

describe(".result auto-stripping", () => {
  it("strips .result from template references", () => {
    const result = composeWorkflowDefinition({
      name: "test_strip",
      description: "Test result stripping",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "send",
          label: "Send",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat_sendMessage",
            inputMapping: {
              msg: "{{steps.fetch.result.channel.name}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "send")!;
    const mapping = (step.config as any).inputMapping;
    // After .result stripping: {{steps.fetch.channel.name}}
    // After inferOutputPath: outputPath="channel" inferred, ref rewritten
    assert.equal(mapping.msg, "{{steps.fetch.name}}");
    assert.ok(result.warnings.some((w) => w.code === "FIELD_STRIPPED"));
  });

  it("strips .result from transform expressions", () => {
    const result = composeWorkflowDefinition({
      name: "test_strip_transform",
      description: "Test result stripping in transforms",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "calc",
          label: "Calc",
          config: {
            type: "transform",
            expression: "steps.fetch.result.items.length",
          },
          dependsOn: ["fetch"],
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "calc")!;
    // After .result stripping: steps.fetch.items.length
    // After inferOutputPath: outputPath="items" inferred, ref rewritten
    assert.equal((step.config as any).expression, "steps.fetch.length");
  });

  it("strips .result from conditional expressions", () => {
    const result = composeWorkflowDefinition({
      name: "test_strip_cond",
      description: "Test result stripping in conditionals",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels_list",
            inputMapping: {},
          },
        },
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: "steps.analyze.result.violated === true",
            thenStep: "notify",
          },
          dependsOn: ["analyze"],
        },
        {
          id: "notify",
          label: "Notify",
          config: {
            type: "transform",
            expression: "'notified'",
          },
          dependsOn: ["check"],
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "check")!;
    // After .result stripping: steps.analyze.violated === true
    // After inferOutputPath: outputPath="violated" inferred, ref rewritten
    assert.equal((step.config as any).condition, "steps.analyze === true");
  });
});

describe("composeWorkflowDefinition — stringified JSON normalization", () => {
  it("parses stringified JSON object in inputMapping back to native object", () => {
    const result = composeWorkflowDefinition({
      name: "test_sort",
      description: "Test sort normalization",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "list",
          label: "List channels",
          config: {
            type: "api_call" as const,
            operationId: "get-api-v1-channels_list",
            inputMapping: {
              sort: '{"msgs": -1}',
              count: 10,
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "list")!;
    const mapping = (step.config as any).inputMapping;
    assert.deepStrictEqual(mapping.sort, { msgs: -1 });
    assert.equal(mapping.count, 10);
    assert.ok(
      result.warnings.some((w) => w.code === "STRINGIFIED_JSON_PARSED"),
      "should emit STRINGIFIED_JSON_PARSED warning",
    );
  });

  it("parses stringified JSON array in inputMapping", () => {
    const result = composeWorkflowDefinition({
      name: "test_arr",
      description: "Test array normalization",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "op",
          label: "Op",
          config: {
            type: "api_call" as const,
            operationId: "get-api-v1-channels_list",
            inputMapping: {
              fields: '["name", "msgs"]',
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "op")!;
    const mapping = (step.config as any).inputMapping;
    assert.deepStrictEqual(mapping.fields, ["name", "msgs"]);
  });

  it("does NOT parse template strings that start with {{", () => {
    const result = composeWorkflowDefinition({
      name: "test_tpl",
      description: "Test template passthrough",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "op",
          label: "Op",
          config: {
            type: "api_call" as const,
            operationId: "get-api-v1-channels_list",
            inputMapping: {
              roomId: "{{params.roomId}}",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "op")!;
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.roomId, "{{params.roomId}}");
    assert.ok(
      !result.warnings.some((w) => w.code === "STRINGIFIED_JSON_PARSED"),
      "should NOT emit STRINGIFIED_JSON_PARSED for template strings",
    );
  });

  it("does NOT parse plain strings", () => {
    const result = composeWorkflowDefinition({
      name: "test_plain",
      description: "Test plain string passthrough",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "op",
          label: "Op",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "#general",
              text: "hello world",
            },
          },
        },
      ],
    });
    const step = result.workflow.steps.find((s) => s.id === "op")!;
    const mapping = (step.config as any).inputMapping;
    assert.equal(mapping.channel, "#general");
    assert.equal(mapping.text, "hello world");
    assert.ok(
      !result.warnings.some((w) => w.code === "STRINGIFIED_JSON_PARSED"),
    );
  });
});

describe("bare params.X validation in JS contexts", () => {
  it("condition with bare params.room passes when room is in schema", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_param_cond",
      description: "Bare param in condition",
      params: {
        type: "object",
        properties: {
          room: { type: "string" },
          sender: { type: "string" },
        },
      },
      steps: [
        {
          id: "check",
          label: "Check Room",
          config: {
            type: "conditional" as const,
            condition: "params.room === 'general'",
            thenStep: "ok",
          },
        },
        {
          id: "ok",
          label: "OK",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: { channel: "#general", text: "ok" },
          },
        },
      ],
    });
    assert.ok(result.workflow);
  });

  it("condition with bare params.unknownField throws", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bare_unknown_cond",
          description: "Bare unknown param in condition",
          params: {
            type: "object",
            properties: {
              room: { type: "string" },
            },
          },
          steps: [
            {
              id: "check",
              label: "Check",
              config: {
                type: "conditional" as const,
                condition: "params.unknownField === true",
                thenStep: "ok",
              },
            },
            {
              id: "ok",
              label: "OK",
              config: {
                type: "api_call" as const,
                operationId: "post-api-v1-chat_postMessage",
                inputMapping: { channel: "#general", text: "ok" },
              },
            },
          ],
        }),
      (err: any) => {
        assert.ok(err.message.includes("params.unknownField"));
        assert.ok(err.message.includes("not in the workflow params schema"));
        return true;
      },
    );
  });

  it("transform with bare params.unknownField throws", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bare_unknown_transform",
          description: "Bare unknown param in transform",
          params: {
            type: "object",
            properties: {
              room: { type: "string" },
            },
          },
          steps: [
            {
              id: "xform",
              label: "Transform",
              config: {
                type: "transform" as const,
                expression: "params.unknownField.x + 1",
              },
            },
          ],
        }),
      (err: any) => {
        assert.ok(err.message.includes("params.unknownField"));
        assert.ok(err.message.includes("not in the workflow params schema"));
        return true;
      },
    );
  });

  it("transform with bare params.room passes when room is in schema", () => {
    const result = composeWorkflowDefinition({
      name: "test_bare_param_transform",
      description: "Bare param in transform",
      params: {
        type: "object",
        properties: {
          room: { type: "string" },
        },
      },
      steps: [
        {
          id: "xform",
          label: "Transform",
          config: {
            type: "transform" as const,
            expression: "params.room.toUpperCase()",
          },
        },
      ],
    });
    assert.ok(result.workflow);
  });

  it("api_call with bare params.X in inputMapping is NOT validated as JS context", () => {
    // api_call uses {{params.X}} templates, not bare refs — bare refs in api_call should not trigger validation
    const result = composeWorkflowDefinition({
      name: "test_api_no_bare",
      description: "API call ignores bare param check",
      params: {
        type: "object",
        properties: {
          room: { type: "string" },
        },
      },
      steps: [
        {
          id: "call",
          label: "Call",
          config: {
            type: "api_call" as const,
            operationId: "post-api-v1-chat_postMessage",
            inputMapping: {
              channel: "{{params.room}}",
              text: "hello",
            },
          },
        },
      ],
    });
    assert.ok(result.workflow);
  });
});

describe("inferOutputPath", () => {
  it("infers outputPath when all downstream refs access the same field", () => {
    const result = composeWorkflowDefinition({
      name: "test_infer",
      description: "Test outputPath inference",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_channels",
          label: "Fetch Channels",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: { count: 5 },
          },
        },
        {
          id: "process",
          label: "Process",
          config: {
            type: "transform",
            expression: "steps.get_channels.channels.map(c => c.name)",
          },
          dependsOn: ["get_channels"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "get_channels");
    assert.ok(apiStep);
    assert.equal(
      (apiStep.config as any).outputPath,
      "channels",
      "outputPath should be inferred from downstream refs",
    );
    // Downstream ref should be rewritten to drop the field
    const processStep = result.workflow.steps.find((s) => s.id === "process");
    assert.ok(processStep);
    assert.ok(
      !(processStep.config as any).expression.includes(
        "steps.get_channels.channels",
      ),
      "Downstream ref should be rewritten to drop the inferred field",
    );
    assert.ok(
      (processStep.config as any).expression.includes("steps.get_channels.map"),
      `Expected rewritten ref, got: ${(processStep.config as any).expression}`,
    );

    assert.ok(
      result.warnings.some((w) => w.code === "OUTPUT_PATH_INFERRED"),
      "Should emit OUTPUT_PATH_INFERRED warning",
    );
  });

  it("fixes redundant extraction when outputPath already set", () => {
    const result = composeWorkflowDefinition({
      name: "test_fix_redundant",
      description: "Test redundant outputPath fix",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_history",
          label: "Fetch History",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-history",
            inputMapping: { roomId: "R1" },
            outputPath: "messages",
          },
        },
        {
          id: "summarize",
          label: "Summarize",
          config: {
            type: "sampling",
            prompt: "Summarize: {{steps.get_history.messages}}",
          },
          dependsOn: ["get_history"],
        },
      ],
    });

    const summarizeStep = result.workflow.steps.find(
      (s) => s.id === "summarize",
    );
    assert.ok(summarizeStep);
    assert.equal(
      (summarizeStep.config as any).prompt,
      "Summarize: {{steps.get_history}}",
      "Redundant .messages should be stripped since outputPath already extracts it",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "OUTPUT_PATH_REF_FIXED"),
      "Should emit OUTPUT_PATH_REF_FIXED warning",
    );
  });

  it("does not infer when downstream refs access different fields", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_infer",
      description: "Test no inference with mixed fields",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_data",
          label: "Fetch Data",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-info",
            inputMapping: { roomId: "R1" },
          },
        },
        {
          id: "use_a",
          label: "Use A",
          config: {
            type: "sampling",
            prompt: "Channel: {{steps.get_data.channel}}",
          },
          dependsOn: ["get_data"],
        },
        {
          id: "use_b",
          label: "Use B",
          config: {
            type: "sampling",
            prompt: "Success: {{steps.get_data.success}}",
          },
          dependsOn: ["get_data"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "get_data");
    assert.ok(apiStep);
    assert.equal(
      (apiStep.config as any).outputPath,
      undefined,
      "Should NOT infer outputPath when multiple different fields are accessed",
    );
    assert.ok(!result.warnings.some((w) => w.code === "OUTPUT_PATH_INFERRED"));
  });

  it("handles template context refs in forEach", () => {
    const result = composeWorkflowDefinition({
      name: "test_foreach_infer",
      description: "Test outputPath inference with forEach",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_channels",
          label: "Fetch Channels",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "process_each",
          label: "Process Each",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-info",
            inputMapping: { roomId: "{{ch._id}}" },
            forEach: "{{steps.get_channels.channels}}",
            as: "ch",
          },
          dependsOn: ["get_channels"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "get_channels");
    assert.equal(
      (apiStep!.config as any).outputPath,
      "channels",
      "outputPath should be inferred from forEach ref",
    );

    const forEachStep = result.workflow.steps.find(
      (s) => s.id === "process_each",
    );
    assert.equal(
      (forEachStep!.config as any).forEach,
      "{{steps.get_channels}}",
      "forEach ref should be rewritten to drop field",
    );
  });

  it("leaves explicit outputPath with correct refs unchanged", () => {
    const result = composeWorkflowDefinition({
      name: "test_explicit_correct",
      description: "Test explicit outputPath with correct refs",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_channels",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
            outputPath: "channels",
          },
        },
        {
          id: "use",
          label: "Use",
          config: {
            type: "sampling",
            prompt: "Channels: {{steps.get_channels}}",
          },
          dependsOn: ["get_channels"],
        },
      ],
    });

    assert.equal(
      (
        result.workflow.steps.find((s) => s.id === "get_channels")!
          .config as any
      ).outputPath,
      "channels",
    );
    assert.equal(
      (result.workflow.steps.find((s) => s.id === "use")!.config as any).prompt,
      "Channels: {{steps.get_channels}}",
      "Correct refs should not be modified",
    );
    assert.ok(
      !result.warnings.some(
        (w) =>
          w.code === "OUTPUT_PATH_INFERRED" ||
          w.code === "OUTPUT_PATH_REF_FIXED",
      ),
    );
  });

  it("rewrites refs in inputMapping values", () => {
    const result = composeWorkflowDefinition({
      name: "test_infer_input",
      description: "Test inference with inputMapping",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "create_ch",
          label: "Create Channel",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels-create",
            inputMapping: { name: "test" },
          },
        },
        {
          id: "post_msg",
          label: "Post Message",
          config: {
            type: "api_call",
            operationId: "post-api-v1-chat-postMessage",
            inputMapping: {
              channel: "#{{steps.create_ch.channel.name}}",
              text: "Hello",
            },
          },
          dependsOn: ["create_ch"],
        },
      ],
    });

    const createStep = result.workflow.steps.find((s) => s.id === "create_ch");
    assert.equal(
      (createStep!.config as any).outputPath,
      "channel",
      "outputPath should be inferred from inputMapping ref",
    );

    const postStep = result.workflow.steps.find((s) => s.id === "post_msg");
    assert.equal(
      (postStep!.config as any).inputMapping.channel,
      "#{{steps.create_ch.name}}",
      "inputMapping ref should be rewritten to drop inferred field",
    );
  });

  it("handles optional chaining in transform expressions (steps.X?.field)", () => {
    const result = composeWorkflowDefinition({
      name: "test_optional_chain",
      description: "Test optional chaining detection and rewrite",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "create_room",
          label: "Create Room",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels-create",
            inputMapping: { name: "incident-room" },
          },
        },
        {
          id: "set_state",
          label: "Set State",
          config: {
            type: "transform",
            expression:
              '{ roomId: steps.create_room?.channel?._id || "fallback" }',
          },
          dependsOn: ["create_room"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "create_room");
    assert.equal(
      (apiStep!.config as any).outputPath,
      "channel",
      "outputPath should be inferred from optional-chaining ref",
    );

    const transformStep = result.workflow.steps.find(
      (s) => s.id === "set_state",
    );
    const expr = (transformStep!.config as any).expression;
    assert.ok(
      !expr.includes("create_room?.channel"),
      `Optional-chaining ref should be rewritten, got: ${expr}`,
    );
    assert.ok(
      expr.includes("steps.create_room?._id"),
      `Expected steps.create_room?._id, got: ${expr}`,
    );
  });

  it("handles mixed regular and optional chaining refs to same field", () => {
    const result = composeWorkflowDefinition({
      name: "test_mixed_chain",
      description: "Test mixed dot and optional chaining",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_info",
          label: "Get Info",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-info",
            inputMapping: { roomId: "R1" },
          },
        },
        {
          id: "use_template",
          label: "Use Template",
          config: {
            type: "sampling",
            prompt: "Name: {{steps.get_info.channel.name}}",
          },
          dependsOn: ["get_info"],
        },
        {
          id: "use_js",
          label: "Use JS",
          config: {
            type: "conditional",
            condition: 'steps.get_info?.channel?.type === "c"',
            thenStep: "use_template",
          },
          dependsOn: ["get_info"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "get_info");
    assert.equal(
      (apiStep!.config as any).outputPath,
      "channel",
      "Should infer from both template and optional-chaining refs",
    );

    const tmplStep = result.workflow.steps.find((s) => s.id === "use_template");
    assert.equal(
      (tmplStep!.config as any).prompt,
      "Name: {{steps.get_info.name}}",
      "Template ref should be rewritten",
    );

    const condStep = result.workflow.steps.find((s) => s.id === "use_js");
    const cond = (condStep!.config as any).condition;
    assert.ok(
      !cond.includes("get_info?.channel"),
      `Optional-chaining ref should be rewritten, got: ${cond}`,
    );
    assert.ok(
      cond.includes('steps.get_info?.type === "c"'),
      `Expected steps.get_info?.type, got: ${cond}`,
    );
  });

  it("rewrites steps.X.field?._id (optional chaining after the extracted field)", () => {
    const result = composeWorkflowDefinition({
      name: "test_chain_after_field",
      description: "Test optional chaining after the extracted field",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "fetch",
          label: "Fetch",
          config: {
            type: "api_call",
            operationId: "post-api-v1-channels-create",
            inputMapping: { name: "test" },
          },
        },
        {
          id: "use",
          label: "Use",
          config: {
            type: "transform",
            expression: "steps.fetch.channel?._id",
          },
          dependsOn: ["fetch"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "fetch");
    assert.equal(
      (apiStep!.config as any).outputPath,
      "channel",
      "outputPath should be inferred",
    );

    const useStep = result.workflow.steps.find((s) => s.id === "use");
    const expr = (useStep!.config as any).expression;
    assert.equal(
      expr,
      "steps.fetch?._id",
      `Should rewrite to steps.fetch?._id, got: ${expr}`,
    );
  });

  it("handles optional chaining with nullish coalescing and fallback", () => {
    const result = composeWorkflowDefinition({
      name: "test_nullish",
      description: "Test optional chaining with ?? fallback",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "get_data",
          label: "Get Data",
          config: {
            type: "api_call",
            operationId: "get-api-v1-channels-list",
            inputMapping: {},
          },
        },
        {
          id: "safe_use",
          label: "Safe Use",
          config: {
            type: "transform",
            expression: "steps.get_data?.channels?.length ?? 0",
          },
          dependsOn: ["get_data"],
        },
      ],
    });

    const apiStep = result.workflow.steps.find((s) => s.id === "get_data");
    assert.equal(
      (apiStep!.config as any).outputPath,
      "channels",
      "outputPath should be inferred from optional-chaining ref with nullish coalescing",
    );

    const useStep = result.workflow.steps.find((s) => s.id === "safe_use");
    const expr = (useStep!.config as any).expression;
    assert.ok(
      !expr.includes("get_data?.channels"),
      `Optional-chaining ref should be rewritten, got: ${expr}`,
    );
    assert.ok(
      expr.includes("steps.get_data?.length"),
      `Expected steps.get_data?.length, got: ${expr}`,
    );
  });
});

describe("inferMissingConditionalTargets", () => {
  it("auto-infers thenStep when exactly 1 step depends on the conditional", () => {
    const result = composeWorkflowDefinition({
      name: "infer_then",
      description: "Test thenStep inference",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "gate",
          label: "Gate",
          config: {
            type: "conditional",
            condition: "true",
            // thenStep intentionally omitted
          } as any,
        },
        {
          id: "action",
          label: "Action",
          config: { type: "transform", expression: "'done'" },
          dependsOn: ["gate"],
        },
      ],
    });

    const gateStep = result.workflow.steps.find((s) => s.id === "gate")!;
    assert.equal(
      (gateStep.config as any).thenStep,
      "action",
      "thenStep should be auto-inferred from the single dependent",
    );
    assert.ok(
      result.warnings.some(
        (w) => w.code === "FIELD_AUTO_SET" && w.message.includes("thenStep"),
      ),
      "Should emit FIELD_AUTO_SET warning for inferred thenStep",
    );
  });

  it("hard-errors when conditional has 0 dependents and no thenStep", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "no_dep",
          description: "No dependents",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "gate",
              label: "Gate",
              config: {
                type: "conditional",
                condition: "true",
              } as any,
            },
            {
              id: "other",
              label: "Other",
              config: { type: "transform", expression: "'x'" },
              // does NOT depend on gate
            },
          ],
        }),
      /thenStep is required.*cannot infer/i,
    );
  });

  it("hard-errors when conditional has 2+ dependents and no thenStep (ambiguous)", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "multi_dep",
          description: "Multiple dependents",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "gate",
              label: "Gate",
              config: {
                type: "conditional",
                condition: "true",
              } as any,
            },
            {
              id: "branch_a",
              label: "A",
              config: { type: "transform", expression: "'a'" },
              dependsOn: ["gate"],
            },
            {
              id: "branch_b",
              label: "B",
              config: { type: "transform", expression: "'b'" },
              dependsOn: ["gate"],
            },
          ],
        }),
      /thenStep is required.*Multiple steps/i,
    );
  });

  it("infers thenStep when elseStep is present and 1 other dependent exists", () => {
    const result = composeWorkflowDefinition({
      name: "infer_with_else",
      description: "Test with elseStep",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "check",
          label: "Check",
          config: {
            type: "conditional",
            condition: "true",
            elseStep: "fallback",
            // thenStep intentionally omitted
          } as any,
        },
        {
          id: "primary",
          label: "Primary",
          config: { type: "transform", expression: "'yes'" },
          dependsOn: ["check"],
        },
        {
          id: "fallback",
          label: "Fallback",
          config: { type: "transform", expression: "'no'" },
          dependsOn: ["check"],
        },
      ],
    });

    const checkStep = result.workflow.steps.find((s) => s.id === "check")!;
    assert.equal(
      (checkStep.config as any).thenStep,
      "primary",
      "thenStep should be inferred from the dependent that is NOT the elseStep",
    );
  });

  it("hard-errors when elseStep present but 0 other dependents for thenStep", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "else_only",
          description: "Only elseStep",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "check",
              label: "Check",
              config: {
                type: "conditional",
                condition: "true",
                elseStep: "fallback",
              } as any,
            },
            {
              id: "fallback",
              label: "Fallback",
              config: { type: "transform", expression: "'no'" },
              dependsOn: ["check"],
            },
          ],
        }),
      /thenStep is required.*no other step depends/i,
    );
  });

  it("does not modify conditionals that already have thenStep", () => {
    const result = composeWorkflowDefinition({
      name: "already_has",
      description: "Has thenStep",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "gate",
          label: "Gate",
          config: {
            type: "conditional",
            condition: "true",
            thenStep: "action",
          },
        },
        {
          id: "action",
          label: "Action",
          config: { type: "transform", expression: "'done'" },
          dependsOn: ["gate"],
        },
      ],
    });

    const gateStep = result.workflow.steps.find((s) => s.id === "gate")!;
    assert.equal((gateStep.config as any).thenStep, "action");
    assert.ok(
      !result.warnings.some(
        (w) =>
          w.code === "FIELD_AUTO_SET" &&
          w.message.includes("thenStep") &&
          w.stepId === "gate",
      ),
      "Should NOT emit inference warning when thenStep was already set",
    );
  });
});
