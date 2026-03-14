import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateRestClientCode,
  generateMcpServerPackageJson,
  generateMcpServerTsConfig,
  generateMcpServerEnvExample,
  generateTestSetupCode,
  generateMcpServerReadme,
} from "../mcp-server/mcpServerTemplates.js";
import { getFullEndpoints } from "../mcp-server/parser/index.js";
import type { FullEndpoint } from "../mcp-server/parser/types.js";

let testEndpoints: FullEndpoint[];

async function setup() {
  if (testEndpoints) return;
  testEndpoints = await getFullEndpoints([
    "post-api-v1-login",
    "get-api-v1-channels_list",
    "get-api-v1-channels_history",
  ]);
}

describe("generateRestClientCode", () => {
  it("generates RocketChatClient class", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("class RocketChatClient"));
  });

  it("exports client singleton", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("export const client = new RocketChatClient()"));
  });

  it("exports ToolResult type", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("export type ToolResult"));
  });

  it("has request() method with auth support", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("async request("));
    assert.ok(code.includes("options.auth"));
    assert.ok(code.includes("X-Auth-Token"));
  });

  it("has setAuth() method for in-memory credential updates", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(
      code.includes("setAuth(token: string, userId: string)"),
      "should expose setAuth method",
    );
    assert.ok(
      code.includes("config.authToken = token"),
      "setAuth should update authToken",
    );
    assert.ok(
      code.includes("config.userId = userId"),
      "setAuth should update userId",
    );
  });

  it("reads config from environment variables", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("process.env.ROCKETCHAT_URL"));
    assert.ok(code.includes("process.env.ROCKETCHAT_AUTH_TOKEN"));
    assert.ok(code.includes("process.env.ROCKETCHAT_USER_ID"));
  });

  it("exports initAuth() for startup login", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("export async function initAuth()"));
  });

  it("supports username/password auto-login", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("process.env.ROCKETCHAT_USER"));
    assert.ok(code.includes("process.env.ROCKETCHAT_PASSWORD"));
    assert.ok(code.includes("/api/v1/login"));
  });

  it("supports pre-existing token mode", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("config.authToken && config.userId"));
    assert.ok(code.includes("Using pre-existing auth tokens"));
  });

  it("starts in unconfigured mode when no credentials", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(code.includes("No Rocket.Chat credentials found"));
    assert.ok(code.includes("unconfigured mode"));
    assert.ok(
      !code.includes("process.exit(1)"),
      "should not exit on missing credentials",
    );
  });

  it("uses console.error (not console.log) for stdio safety", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(
      !code.includes("console.log"),
      "generated code should never use console.log (breaks stdio MCP)",
    );
  });

  it("exports get2faHash helper", async () => {
    await setup();
    const code = generateRestClientCode();
    assert.ok(
      code.includes("export function get2faHash"),
      "should export get2faHash for 2FA password fallback",
    );
    assert.ok(
      code.includes('createHash("sha256")'),
      "should use SHA-256 for 2FA hash",
    );
  });

  it("checks tokens before username/password (auth priority)", async () => {
    await setup();
    const code = generateRestClientCode();
    const tokenCheckIdx = code.indexOf("config.authToken && config.userId");
    const loginIdx = code.indexOf("/api/v1/login");
    assert.ok(tokenCheckIdx > 0, "should check tokens");
    assert.ok(loginIdx > 0, "should have login");
    assert.ok(
      tokenCheckIdx < loginIdx,
      "token check should come before login (tokens take priority)",
    );
  });
});

describe("generateMcpServerPackageJson", () => {
  it("generates valid JSON", () => {
    const json = generateMcpServerPackageJson("test-server");
    const pkg = JSON.parse(json);
    assert.ok(pkg);
  });

  it("uses server name as package name", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("my-mcp-server"));
    assert.equal(pkg.name, "my-mcp-server");
  });

  it("has type: module", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("test"));
    assert.equal(pkg.type, "module");
  });

  it("includes @modelcontextprotocol/sdk dependency", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("test"));
    assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"]);
  });

  it("includes tsx and typescript devDependencies", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("test"));
    assert.ok(pkg.devDependencies.tsx);
    assert.ok(pkg.devDependencies.typescript);
  });

  it("start script includes --env-file-if-exists=.env", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("test"));
    assert.ok(
      pkg.scripts.start.includes("--env-file-if-exists=.env"),
      "start script should conditionally load .env",
    );
  });

  it("has build and start:built scripts", () => {
    const pkg = JSON.parse(generateMcpServerPackageJson("test"));
    assert.equal(pkg.scripts.build, "tsc");
    assert.ok(pkg.scripts["start:built"]);
  });
});

describe("generateMcpServerTsConfig", () => {
  it("generates valid JSON", () => {
    const json = generateMcpServerTsConfig();
    const config = JSON.parse(json);
    assert.ok(config);
  });

  it("targets ES2022", () => {
    const config = JSON.parse(generateMcpServerTsConfig());
    assert.equal(config.compilerOptions.target, "ES2022");
  });

  it("uses Node16 module resolution", () => {
    const config = JSON.parse(generateMcpServerTsConfig());
    assert.equal(config.compilerOptions.module, "Node16");
    assert.equal(config.compilerOptions.moduleResolution, "Node16");
  });

  it("has strict mode enabled", () => {
    const config = JSON.parse(generateMcpServerTsConfig());
    assert.equal(config.compilerOptions.strict, true);
  });
});

describe("generateMcpServerEnvExample", () => {
  it("includes all required env vars", () => {
    const env = generateMcpServerEnvExample();
    assert.ok(env.includes("ROCKETCHAT_URL"));
    assert.ok(env.includes("ROCKETCHAT_AUTH_TOKEN"));
    assert.ok(env.includes("ROCKETCHAT_USER_ID"));
  });

  it("includes username/password auto-login vars", () => {
    const env = generateMcpServerEnvExample();
    assert.ok(
      env.includes("ROCKETCHAT_USER"),
      "should include ROCKETCHAT_USER for auto-login",
    );
    assert.ok(
      env.includes("ROCKETCHAT_PASSWORD"),
      "should include ROCKETCHAT_PASSWORD for auto-login",
    );
  });

  it("documents admin and bot credential sections", () => {
    const env = generateMcpServerEnvExample();
    assert.ok(
      env.includes("Admin credentials") || env.includes("admin"),
      "should document admin credentials for initial setup",
    );
    assert.ok(
      env.includes("Bot credentials") || env.includes("auto-generated"),
      "should document bot credentials (auto-generated)",
    );
  });
});

describe("generateTestSetupCode", () => {
  it("exports ctx object with tools, fetch state, and mockFetch", () => {
    const code = generateTestSetupCode(["test_workflow"]);
    assert.ok(code.includes("export const ctx"));
    assert.ok(code.includes("tools:"));
    assert.ok(code.includes("lastFetchUrl:"));
    assert.ok(code.includes("lastFetchOptions:"));
    assert.ok(code.includes("mockFetch:"));
  });

  it("mocks fetch with Response returning success", () => {
    const code = generateTestSetupCode(["test_workflow"]);
    assert.ok(code.includes("mock.fn"));
    assert.ok(code.includes("new Response"));
    assert.ok(code.includes("success"));
  });

  it("exports init() that sets env vars and loads tools", () => {
    const code = generateTestSetupCode(["test_workflow"]);
    assert.ok(code.includes("export async function init()"));
    assert.ok(code.includes("process.env.ROCKETCHAT_URL"));
    assert.ok(code.includes("process.env.ROCKETCHAT_AUTH_TOKEN"));
    assert.ok(code.includes("process.env.ROCKETCHAT_USER_ID"));
    assert.ok(
      code.includes(
        'import { tool as wfTool0 } from "../tools/test_workflow.js"',
      ),
    );
  });

  it("exports reset() that clears captured state", () => {
    const code = generateTestSetupCode(["test_workflow"]);
    assert.ok(code.includes("export function reset()"));
    assert.ok(code.includes("mockFetch.mock.resetCalls()"));
  });

  it("uses console.error not console.log", () => {
    const code = generateTestSetupCode(["test_workflow"]);
    assert.ok(
      !code.includes("console.log"),
      "setup should not use console.log",
    );
  });
});

describe("generateMcpServerReadme", () => {
  it("includes server name as title", async () => {
    await setup();
    const md = generateMcpServerReadme("my-cool-server", testEndpoints);
    assert.ok(md.startsWith("# my-cool-server"));
  });

  it("includes a tools table with all endpoints", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    for (const ep of testEndpoints) {
      assert.ok(
        md.includes(ep.operationId),
        `README should list ${ep.operationId}`,
      );
      assert.ok(
        md.includes(ep.path),
        `README should list path for ${ep.operationId}`,
      );
    }
    assert.ok(md.includes("| Endpoint |"), "should have table header");
  });

  it("includes correct tool count", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("Workflow tools"), "should mention workflow tools");
  });

  it("includes quick start instructions", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("npm install"));
    assert.ok(md.includes(".env.example"));
    assert.ok(md.includes("npm start"));
  });

  it("documents both auth modes", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("Username / Password"), "should document mode 1");
    assert.ok(md.includes("Pre-existing Tokens"), "should document mode 2");
    assert.ok(md.includes("ROCKETCHAT_USER"));
    assert.ok(md.includes("ROCKETCHAT_AUTH_TOKEN"));
  });

  it("includes project structure tree", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("server.ts"), "tree should include server.ts");
    assert.ok(md.includes("rc-client.ts"), "tree should include rc-client.ts");
    assert.ok(md.includes("tools/"), "tree should include tools/");
    assert.ok(md.includes("setup.ts"), "tree should include setup.ts");
  });

  it("includes testing section", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("## Testing"));
    assert.ok(md.includes("npm test"));
  });

  it("includes generation date", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    const today = new Date().toISOString().split("T")[0];
    assert.ok(md.includes(today), "should include generation date");
  });

  it("includes scripts table", async () => {
    await setup();
    const md = generateMcpServerReadme("test-server", testEndpoints);
    assert.ok(md.includes("| Script |"), "should have scripts table");
    assert.ok(md.includes("npm run build"), "should document build script");
  });
});

describe("generateMcpServerEnvExample — CLI-first sampling", () => {
  it("shows Gemini CLI as primary when usesSampling is true", () => {
    const env = generateMcpServerEnvExample({ usesSampling: true });
    assert.ok(
      env.includes("Gemini CLI headless"),
      "should mention Gemini CLI headless mode as primary",
    );
    assert.ok(
      env.includes("1,000 requests/day"),
      "should document CLI free tier quota",
    );
  });

  it("shows API key as fallback when usesSampling is true", () => {
    const env = generateMcpServerEnvExample({ usesSampling: true });
    assert.ok(env.includes("Fallback"), "should label API key as fallback");
    assert.ok(
      env.includes("GEMINI_API_KEY"),
      "should include GEMINI_API_KEY variable",
    );
  });

  it("API key is commented out by default", () => {
    const env = generateMcpServerEnvExample({ usesSampling: true });
    assert.ok(
      env.includes("# GEMINI_API_KEY"),
      "GEMINI_API_KEY should be commented out (CLI is primary)",
    );
  });

  it("omits sampling section when usesSampling is false", () => {
    const env = generateMcpServerEnvExample({ usesSampling: false });
    assert.ok(
      !env.includes("GEMINI_API_KEY"),
      "should not include sampling config when not needed",
    );
    assert.ok(
      !env.includes("Gemini CLI"),
      "should not mention CLI when not needed",
    );
  });
});

import { injectEnsureChannelSteps } from "../mcp-server/ensureChannelInjector.js";
import type { WorkflowDefinition, WorkflowStep } from "../mcp-server/types.js";
import type { JSONSchema7 } from "json-schema";

function makeWf(steps: WorkflowStep[], requiredEndpoints: string[] = []): WorkflowDefinition {
  return {
    name: "test_wf",
    description: "test",
    params: {} as JSONSchema7,
    steps,
    requiredEndpoints,
    usesSampling: false,
    usesElicitation: false,
  };
}

function apiStep(id: string, opId: string, inputMapping: Record<string, unknown>, dependsOn?: string[]): WorkflowStep {
  return {
    id,
    label: id,
    config: { type: "api_call", operationId: opId, inputMapping },
    ...(dependsOn ? { dependsOn } : {}),
  };
}

describe("injectEnsureChannelSteps", () => {
  it("injects ensure step before a static #channel post", () => {
    const wf = makeWf([
      apiStep("post_log", "post-api-v1-chat_postMessage", { channel: "#moderation-log", text: "hi" }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2);
    assert.equal(wf.steps[0].id, "ensure_moderation_log");
    assert.equal(wf.steps[0].config.type, "api_call");
    if (wf.steps[0].config.type === "api_call") {
      assert.equal(wf.steps[0].config.operationId, "post-api-v1-channels_create");
      assert.deepEqual(wf.steps[0].config.inputMapping, { name: "moderation-log" });
    }
    assert.ok(wf.steps[1].dependsOn?.includes("ensure_moderation_log"));
    assert.ok(wf.requiredEndpoints.includes("post-api-v1-channels_create"));
  });

  it("does NOT inject for template channel references", () => {
    const wf = makeWf([
      apiStep("post_reply", "post-api-v1-chat_postMessage", { channel: "{{params.channel}}", text: "hi" }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1, "should not inject for template channels");
  });

  it("does NOT inject for non-hash channels", () => {
    const wf = makeWf([
      apiStep("dm_user", "post-api-v1-chat_postMessage", { channel: "@someuser", text: "hi" }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1, "should not inject for DM channels");
  });

  it("skips when Gemini already added ensure step", () => {
    const wf = makeWf([
      apiStep("ensure_moderation_log", "post-api-v1-channels_create", { name: "moderation-log" }),
      apiStep("post_log", "post-api-v1-chat_postMessage", { channel: "#moderation-log", text: "hi" }, ["ensure_moderation_log"]),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2, "should not duplicate ensure step");
  });

  it("deduplicates when multiple steps post to the same channel", () => {
    const wf = makeWf([
      apiStep("post_a", "post-api-v1-chat_postMessage", { channel: "#alerts", text: "a" }),
      apiStep("post_b", "post-api-v1-chat_postMessage", { channel: "#alerts", text: "b" }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 3, "should inject exactly one ensure step");
    assert.equal(wf.steps[0].id, "ensure_alerts");
    assert.ok(wf.steps[1].dependsOn?.includes("ensure_alerts"));
    assert.ok(wf.steps[2].dependsOn?.includes("ensure_alerts"));
  });

  it("handles multiple different channels", () => {
    const wf = makeWf([
      apiStep("post_log", "post-api-v1-chat_postMessage", { channel: "#mod-log", text: "a" }),
      apiStep("post_alert", "post-api-v1-chat_postMessage", { channel: "#admin-alerts", text: "b" }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 4);
    const ensureIds = wf.steps.filter((s) => s.id.startsWith("ensure_")).map((s) => s.id);
    assert.deepEqual(ensureIds.sort(), ["ensure_admin_alerts", "ensure_mod_log"]);
    assert.ok(wf.requiredEndpoints.includes("post-api-v1-channels_create"));
  });

  it("preserves existing dependsOn on the ensure step", () => {
    const wf = makeWf([
      apiStep("check_msg", "post-api-v1-chat_postMessage", { channel: "#general", text: "x" }),
      apiStep("post_log", "post-api-v1-chat_postMessage", { channel: "#mod-log", text: "y" }, ["check_msg"]),
    ]);
    injectEnsureChannelSteps(wf);
    const ensureMod = wf.steps.find((s) => s.id === "ensure_mod_log");
    assert.ok(ensureMod);
    assert.deepEqual(ensureMod!.dependsOn, ["check_msg"]);
  });

  it("does not add channels_create to requiredEndpoints if already present", () => {
    const wf = makeWf(
      [apiStep("post_log", "post-api-v1-chat_postMessage", { channel: "#logs", text: "hi" })],
      ["post-api-v1-channels_create"],
    );
    injectEnsureChannelSteps(wf);
    const count = wf.requiredEndpoints.filter((e) => e === "post-api-v1-channels_create").length;
    assert.equal(count, 1, "should not duplicate requiredEndpoints entry");
  });

  it("no-ops on workflow with no api_call steps", () => {
    const wf = makeWf([
      {
        id: "decide",
        label: "decide",
        config: { type: "sampling", prompt: "Is this ok?" },
      },
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1);
  });

  it("no-ops on workflow with no chat_postMessage steps", () => {
    const wf = makeWf([
      apiStep("get_users", "get-api-v1-users_list", {}),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1);
  });

  it("skips when Gemini added channels_create with matching name but different step ID", () => {
    const wf = makeWf([
      apiStep("ensure_moderation_log_channel", "post-api-v1-channels_create", { name: "moderation-log" }),
      apiStep("log_it", "post-api-v1-chat_postMessage", { channel: "#moderation-log", text: "hi" }, ["ensure_moderation_log_channel"]),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2, "should not duplicate when channels_create already targets the same channel");
  });
});
