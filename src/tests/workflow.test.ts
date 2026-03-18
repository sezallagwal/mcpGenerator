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

  it("generates bot setup in runAutoConfig when bridged", () => {
    const code = generateMcpServerEntryCode(
      "test-server",
      [testWorkflow],
      mockEndpoints,
      { bridged: true },
    );
    assert.ok(code.includes("runAutoConfig"), "Should call runAutoConfig");
    assert.ok(code.includes("get2faHash"), "Should import get2faHash for 2FA");
    assert.ok(
      code.includes("test-server-bot"),
      "Should derive bot username from server name",
    );
    assert.ok(code.includes("users.create"), "Should create bot user via API");
    assert.ok(
      code.includes("permissions.update"),
      "Should grant bot permissions",
    );
    assert.ok(
      code.includes("generatePersonalAccessToken"),
      "Should generate PAT for bot",
    );
    assert.ok(
      code.includes("client.setAuth"),
      "Should switch client identity to bot",
    );
    assert.ok(
      code.includes("Accounts_TwoFactorAuthentication_By_Email_Enabled"),
      "Should handle 2FA toggle during provisioning",
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

describe("Persistence validation", () => {
  it("passes persistence config through to workflow definition", () => {
    const result = composeWorkflowDefinition({
      name: "test_persist",
      description: "Test persistence",
      params: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "Analyze: {{params.text}}",
          },
        },
        {
          id: "update_state",
          label: "Update state",
          config: {
            type: "transform",
            expression: "({ count: 1 })",
          },
          dependsOn: ["analyze"],
        },
      ],
      persistence: {
        model: "user",
        keyPath: "sender.username",
        stateParam: "userState",
        defaultState: { count: 0 },
        updateFromStep: "update_state",
      },
    });

    assert.ok(result.workflow.persistence);
    assert.equal(result.workflow.persistence!.model, "user");
    assert.equal(result.workflow.persistence!.keyPath, "sender.username");
    assert.equal(result.workflow.persistence!.stateParam, "userState");
    assert.equal(result.workflow.persistence!.updateFromStep, "update_state");
  });

  it("throws when updateFromStep references non-existent step", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad_persist",
          description: "Test bad persistence",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "analyze",
              label: "Analyze",
              config: {
                type: "sampling",
                prompt: "test",
              },
            },
          ],
          persistence: {
            model: "user",
            keyPath: "sender.username",
            stateParam: "userState",
            defaultState: {},
            updateFromStep: "nonexistent",
          },
        }),
      /nonexistent.*does not exist/,
    );
  });

  it("throws when stateParam is invalid identifier", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad_param",
          description: "Test bad param",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "analyze",
              label: "Analyze",
              config: {
                type: "sampling",
                prompt: "test",
              },
            },
          ],
          persistence: {
            model: "user",
            keyPath: "sender.username",
            stateParam: "invalid-param",
            defaultState: {},
          },
        }),
      /invalid.*stateParam/i,
    );
  });

  it("throws when keyPath is empty", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_no_key",
          description: "Test no key",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "analyze",
              label: "Analyze",
              config: {
                type: "sampling",
                prompt: "test",
              },
            },
          ],
          persistence: {
            model: "user",
            keyPath: "",
            stateParam: "state",
            defaultState: {},
          },
        }),
      /keyPath.*required/i,
    );
  });

  it("warns when updateFromStep is not a transform step", () => {
    const result = composeWorkflowDefinition({
      name: "test_warn_persist",
      description: "Test warn",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze",
          config: {
            type: "sampling",
            prompt: "test",
          },
        },
      ],
      persistence: {
        model: "user",
        keyPath: "sender.username",
        stateParam: "userState",
        defaultState: {},
        updateFromStep: "analyze",
      },
    });

    assert.ok(
      result.warnings.some(
        (w) =>
          w.stepId === "analyze" &&
          w.message.includes("sampling") &&
          w.message.includes("transform"),
      ),
      "Should warn about non-transform updateFromStep",
    );
  });

  it("does not include persistence when not provided", () => {
    const result = composeWorkflowDefinition({
      name: "test_no_persist",
      description: "Test",
      params: { type: "object", properties: {} },
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
      ],
    });

    assert.equal(result.workflow.persistence, undefined);
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

  it("rejects forEach without as", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad",
          description: "Missing as",
          params: { type: "object", properties: {} },
          steps: [
            {
              id: "step1",
              label: "Step",
              config: {
                type: "api_call",
                operationId: "get-api-v1-test",
                inputMapping: {},
                forEach: "{{steps.x.result}}",
              } as any,
            },
          ],
        }),
      /\"as\" is required when \"forEach\" is specified/,
    );
  });

  it("rejects as without forEach", () => {
    assert.throws(
      () =>
        composeWorkflowDefinition({
          name: "test_bad",
          description: "Missing forEach",
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
        }),
      /\"forEach\" is required when \"as\" is specified/,
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
    assert.equal(
      mapping.rid,
      "{{steps.fetch.result.channel._id}}",
      "Bare ref should be auto-wrapped",
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
    assert.equal(
      (iterStep.config as any).forEach,
      "{{steps.list.result.channels}}",
      "forEach bare ref should be auto-wrapped",
    );
  });

  it("rewrites {{asVar.field}} to {{steps.asVar.result.field}}", () => {
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
      "{{steps.channel.result._id}}",
      "as-variable ref should be rewritten",
    );
    assert.ok(
      result.warnings.some((w) => w.code === "AS_VAR_REWRITTEN"),
      "Should emit AS_VAR_REWRITTEN warning",
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
    assert.equal(
      (xStep.config as any).expression,
      "steps.fetch.result.channels.length",
      "Transform expressions should remain as raw JS",
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

  it("rewrites context.X to params.context.X in conditional conditions", () => {
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
    assert.equal(
      (condStep.config as any).condition,
      "params.context.user.roles.includes('admin')",
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

  it("rewrites transform expressions", () => {
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
    assert.equal(
      (transformStep.config as any).expression,
      "params.context.user.roles.join(', ')",
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

  it("rewrites params.user.X to params.context.user.X in JS conditions", () => {
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
            condition: "params.user.roles.includes('admin')",
            thenStep: "action",
          },
        },
      ],
    });
    const condStep = result.workflow.steps.find((s) => s.id === "check_role")!;
    assert.equal(
      (condStep.config as any).condition,
      "params.context.user.roles.includes('admin')",
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
