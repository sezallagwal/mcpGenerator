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
import { deriveRequiredPermissions } from "../mcp-server/mcpServerCodegen.js";
import {
  getFullEndpoints,
  getLastCorrectedIds,
} from "../mcp-server/parser/index.js";
import type { FullEndpoint } from "../mcp-server/parser/types.js";
import {
  deriveCommandKeyPath,
  autoInjectPersistence,
  autoCorrectEventParamRefs,
  findBestPropertyMatch,
  autoCorrectDeepParamRefs,
} from "../persistence-helpers.js";
import { z } from "zod";

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

function makeWf(
  steps: WorkflowStep[],
  requiredEndpoints: string[] = [],
): WorkflowDefinition {
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

function apiStep(
  id: string,
  opId: string,
  inputMapping: Record<string, unknown>,
  dependsOn?: string[],
): WorkflowStep {
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
      apiStep("post_log", "post-api-v1-chat_postMessage", {
        channel: "#moderation-log",
        text: "hi",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2);
    assert.equal(wf.steps[0].id, "ensure_moderation_log");
    assert.equal(wf.steps[0].config.type, "api_call");
    if (wf.steps[0].config.type === "api_call") {
      assert.equal(
        wf.steps[0].config.operationId,
        "post-api-v1-channels_create",
      );
      assert.deepEqual(wf.steps[0].config.inputMapping, {
        name: "moderation-log",
      });
    }
    assert.ok(wf.steps[1].dependsOn?.includes("ensure_moderation_log"));
    assert.ok(wf.requiredEndpoints.includes("post-api-v1-channels_create"));
  });

  it("does NOT inject for template channel references", () => {
    const wf = makeWf([
      apiStep("post_reply", "post-api-v1-chat_postMessage", {
        channel: "{{params.channel}}",
        text: "hi",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1, "should not inject for template channels");
  });

  it("does NOT inject for non-hash channels", () => {
    const wf = makeWf([
      apiStep("dm_user", "post-api-v1-chat_postMessage", {
        channel: "@someuser",
        text: "hi",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1, "should not inject for DM channels");
  });

  it("skips when Gemini already added ensure step", () => {
    const wf = makeWf([
      apiStep("ensure_moderation_log", "post-api-v1-channels_create", {
        name: "moderation-log",
      }),
      apiStep(
        "post_log",
        "post-api-v1-chat_postMessage",
        { channel: "#moderation-log", text: "hi" },
        ["ensure_moderation_log"],
      ),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2, "should not duplicate ensure step");
  });

  it("deduplicates when multiple steps post to the same channel", () => {
    const wf = makeWf([
      apiStep("post_a", "post-api-v1-chat_postMessage", {
        channel: "#alerts",
        text: "a",
      }),
      apiStep("post_b", "post-api-v1-chat_postMessage", {
        channel: "#alerts",
        text: "b",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 3, "should inject exactly one ensure step");
    assert.equal(wf.steps[0].id, "ensure_alerts");
    assert.ok(wf.steps[1].dependsOn?.includes("ensure_alerts"));
    assert.ok(wf.steps[2].dependsOn?.includes("ensure_alerts"));
  });

  it("handles multiple different channels", () => {
    const wf = makeWf([
      apiStep("post_log", "post-api-v1-chat_postMessage", {
        channel: "#mod-log",
        text: "a",
      }),
      apiStep("post_alert", "post-api-v1-chat_postMessage", {
        channel: "#admin-alerts",
        text: "b",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 4);
    const ensureIds = wf.steps
      .filter((s) => s.id.startsWith("ensure_"))
      .map((s) => s.id);
    assert.deepEqual(ensureIds.sort(), [
      "ensure_admin_alerts",
      "ensure_mod_log",
    ]);
    assert.ok(wf.requiredEndpoints.includes("post-api-v1-channels_create"));
  });

  it("preserves existing dependsOn on the ensure step", () => {
    const wf = makeWf([
      apiStep("check_msg", "post-api-v1-chat_postMessage", {
        channel: "#general",
        text: "x",
      }),
      apiStep(
        "post_log",
        "post-api-v1-chat_postMessage",
        { channel: "#mod-log", text: "y" },
        ["check_msg"],
      ),
    ]);
    injectEnsureChannelSteps(wf);
    const ensureMod = wf.steps.find((s) => s.id === "ensure_mod_log");
    assert.ok(ensureMod);
    assert.deepEqual(ensureMod!.dependsOn, ["check_msg"]);
  });

  it("does not add channels_create to requiredEndpoints if already present", () => {
    const wf = makeWf(
      [
        apiStep("post_log", "post-api-v1-chat_postMessage", {
          channel: "#logs",
          text: "hi",
        }),
      ],
      ["post-api-v1-channels_create"],
    );
    injectEnsureChannelSteps(wf);
    const count = wf.requiredEndpoints.filter(
      (e) => e === "post-api-v1-channels_create",
    ).length;
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
    const wf = makeWf([apiStep("get_users", "get-api-v1-users_list", {})]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 1);
  });

  it("skips when Gemini added channels_create with matching name but different step ID", () => {
    const wf = makeWf([
      apiStep("ensure_moderation_log_channel", "post-api-v1-channels_create", {
        name: "moderation-log",
      }),
      apiStep(
        "log_it",
        "post-api-v1-chat_postMessage",
        { channel: "#moderation-log", text: "hi" },
        ["ensure_moderation_log_channel"],
      ),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(
      wf.steps.length,
      2,
      "should not duplicate when channels_create already targets the same channel",
    );
  });

  it("includes members when postMessage step references params.sender", () => {
    const wf = makeWf([
      apiStep("post_help", "post-api-v1-chat_postMessage", {
        channel: "#help",
        text: '@{{params.sender.username}} asked: "{{params.query}}"',
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2);
    const ensure = wf.steps[0];
    assert.equal(ensure.id, "ensure_help");
    if (ensure.config.type === "api_call") {
      assert.deepEqual(ensure.config.inputMapping?.members, [
        "{{params.sender.username}}",
      ]);
    }
  });

  it("does NOT include members when no step references params.sender", () => {
    const wf = makeWf([
      apiStep("post_alert", "post-api-v1-chat_postMessage", {
        channel: "#alerts",
        text: "System alert: something happened",
      }),
    ]);
    injectEnsureChannelSteps(wf);
    assert.equal(wf.steps.length, 2);
    const ensure = wf.steps[0];
    if (ensure.config.type === "api_call") {
      assert.equal(
        ensure.config.inputMapping?.members,
        undefined,
        "should not add members when sender is not referenced",
      );
    }
  });
});

// ── Permission derivation (category-based) ────────────────────────────────

describe("deriveRequiredPermissions", () => {
  function makePermsWf(endpoints: string[]) {
    return [
      {
        name: "test",
        description: "test",
        steps: [],
        params: {},
        requiredEndpoints: endpoints,
        usesSampling: false,
        usesElicitation: false,
      },
    ];
  }

  it("returns only base perms for empty workflow", () => {
    const perms = deriveRequiredPermissions(makePermsWf([]));
    assert.ok(perms.includes("create-personal-access-tokens"));
    assert.ok(perms.includes("view-outside-room"));
    assert.equal(perms.length, 2);
  });

  it("channels_list triggers full channel category", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["get-api-v1-channels_list"]),
    );
    assert.ok(perms.includes("create-c"), "should include create-c");
    assert.ok(perms.includes("view-c-room"), "should include view-c-room");
    assert.ok(
      perms.includes("view-joined-room"),
      "should include view-joined-room",
    );
    assert.ok(perms.includes("edit-room"), "should include edit-room");
    assert.ok(perms.includes("archive-room"), "should include archive-room");
  });

  it("groups_create triggers full groups category", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-groups_create"]),
    );
    assert.ok(perms.includes("create-p"));
    assert.ok(perms.includes("view-p-room"));
    assert.ok(perms.includes("edit-room"));
  });

  it("chat_postMessage triggers chat category", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-chat_postMessage"]),
    );
    assert.ok(perms.includes("create-d"));
    assert.ok(perms.includes("post-readonly"));
  });

  it("chat_delete triggers destructive chat perms", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-chat_delete"]),
    );
    assert.ok(perms.includes("delete-message"));
    assert.ok(perms.includes("edit-message"));
    // also base chat perms
    assert.ok(perms.includes("create-d"));
  });

  it("im_create triggers DM category", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-im_create"]),
    );
    assert.ok(perms.includes("create-d"));
    assert.ok(perms.includes("view-d-room"));
    assert.ok(perms.includes("view-joined-room"));
  });

  it("users_info triggers users read perms", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["get-api-v1-users_info"]),
    );
    assert.ok(perms.includes("view-full-other-user-info"));
  });

  it("users_create triggers users admin perms", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-users_create"]),
    );
    assert.ok(perms.includes("create-user"));
    assert.ok(perms.includes("edit-other-user-info"));
    assert.ok(perms.includes("edit-other-user-active-status"));
    // also base users perm
    assert.ok(perms.includes("view-full-other-user-info"));
  });

  it("rooms_muteUser triggers mute perm + room view perms", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-rooms_muteUser"]),
    );
    assert.ok(perms.includes("mute-user"));
    assert.ok(perms.includes("view-c-room"));
    assert.ok(perms.includes("view-p-room"));
  });

  it("channels_invite triggers invite/kick perms", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-channels_invite"]),
    );
    assert.ok(perms.includes("add-user-to-joined-room"));
    assert.ok(perms.includes("add-user-to-any-c-room"));
    assert.ok(perms.includes("remove-user"));
  });

  it("channels_delete triggers delete-c", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-channels_delete"]),
    );
    assert.ok(perms.includes("delete-c"));
  });

  it("multiple endpoints produce union of all categories", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf([
        "get-api-v1-channels_list",
        "get-api-v1-chat_search",
        "post-api-v1-users_create",
      ]),
    );
    // channels
    assert.ok(perms.includes("create-c"));
    assert.ok(perms.includes("view-c-room"));
    // chat
    assert.ok(perms.includes("create-d"));
    assert.ok(perms.includes("post-readonly"));
    // users admin
    assert.ok(perms.includes("create-user"));
    assert.ok(perms.includes("edit-other-user-info"));
    // base
    assert.ok(perms.includes("create-personal-access-tokens"));
    assert.ok(perms.includes("view-outside-room"));
  });

  it("emoji_custom triggers manage-emoji", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-emoji-custom_create"]),
    );
    assert.ok(perms.includes("manage-emoji"));
  });

  it("discussions trigger start-discussion", () => {
    const perms = deriveRequiredPermissions(
      makePermsWf(["post-api-v1-rooms_getDiscussions"]),
    );
    assert.ok(perms.includes("start-discussion"));
  });
});

// ─── deriveCommandKeyPath ────────────────────────────────────────────

describe("deriveCommandKeyPath", () => {
  it("keeps keyPath when top-level field exists in COMMAND_BRIDGE_PARAMS", () => {
    assert.strictEqual(deriveCommandKeyPath("room", "room.id"), "room.id");
    assert.strictEqual(deriveCommandKeyPath("user", "sender.id"), "sender.id");
    assert.strictEqual(
      deriveCommandKeyPath("user", "sender.username"),
      "sender.username",
    );
  });

  it("derives room.id for room model with event-specific keyPath", () => {
    assert.strictEqual(deriveCommandKeyPath("room", "message.rid"), "room.id");
  });

  it("derives sender.id for user model with event-specific keyPath", () => {
    assert.strictEqual(
      deriveCommandKeyPath("user", "context.userId"),
      "sender.id",
    );
  });

  it("falls back to room.id for misc model with unknown keyPath", () => {
    assert.strictEqual(deriveCommandKeyPath("misc", "custom.key"), "room.id");
  });
});

// ─── autoInjectPersistence ───────────────────────────────────────────

describe("autoInjectPersistence", () => {
  it("injects read-only persistence on a command workflow that references shared stateParam", () => {
    const workflows = [
      {
        name: "monitor_event",
        triggerEvent: "IPostMessageSent",
        persistence: {
          model: "room",
          keyPath: "message.rid",
          stateParam: "incidentState",
          defaultState: { status: "open" },
          updateFromStep: "update_state",
        },
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "resolve_cmd",
        steps: [
          {
            id: "s1",
            type: "transform",
            expression: "({ resolved: true, prev: {{params.incidentState}} })",
          },
        ],
      },
    ];

    const warnings = autoInjectPersistence(workflows as any);

    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes("resolve_cmd"));
    assert.ok(warnings[0].includes("incidentState"));

    const injected = (workflows[1] as any).persistence;
    assert.ok(injected, "persistence should be injected");
    assert.strictEqual(injected.model, "room");
    assert.strictEqual(injected.keyPath, "room.id"); // derived from room model
    assert.strictEqual(injected.stateParam, "incidentState");
    assert.deepStrictEqual(injected.defaultState, { status: "open" });
    assert.strictEqual(injected.updateFromStep, undefined); // read-only
  });

  it("does not inject when command workflow already has persistence", () => {
    const workflows = [
      {
        name: "monitor",
        triggerEvent: "IPostMessageSent",
        persistence: {
          model: "room",
          keyPath: "message.rid",
          stateParam: "state",
          defaultState: {},
        },
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "cmd",
        persistence: {
          model: "user",
          keyPath: "sender.id",
          stateParam: "myState",
          defaultState: {},
        },
        steps: [
          {
            id: "s1",
            type: "transform",
            expression: "{{params.state}}",
          },
        ],
      },
    ];

    const warnings = autoInjectPersistence(workflows as any);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual((workflows[1] as any).persistence.model, "user"); // unchanged
  });

  it("does not inject when no workflow has persistence", () => {
    const workflows = [
      {
        name: "cmd1",
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "cmd2",
        steps: [{ id: "s1", type: "transform", expression: "2" }],
      },
    ];
    const warnings = autoInjectPersistence(workflows as any);
    assert.strictEqual(warnings.length, 0);
  });

  it("does not inject on event workflows", () => {
    const workflows = [
      {
        name: "event1",
        triggerEvent: "IPostMessageSent",
        persistence: {
          model: "room",
          keyPath: "message.rid",
          stateParam: "state",
          defaultState: {},
        },
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "event2",
        triggerEvent: "IPostMessageDeleted",
        steps: [
          {
            id: "s1",
            type: "transform",
            expression: "{{params.state}}",
          },
        ],
      },
    ];
    const warnings = autoInjectPersistence(workflows as any);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual((workflows[1] as any).persistence, undefined);
  });

  it("injects with user-model keyPath derived correctly", () => {
    const workflows = [
      {
        name: "track_user",
        triggerEvent: "IPostMessageSent",
        persistence: {
          model: "user",
          keyPath: "message.sender",
          stateParam: "userPrefs",
          defaultState: { theme: "dark" },
        },
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "set_prefs",
        steps: [
          {
            id: "s1",
            type: "sampling",
            prompt: "prefs: {{params.userPrefs}}",
          },
        ],
      },
    ];

    autoInjectPersistence(workflows as any);
    const injected = (workflows[1] as any).persistence;
    assert.strictEqual(injected.model, "user");
    assert.strictEqual(injected.keyPath, "sender.id"); // derived for user model
  });

  it("skips command workflows whose steps don't reference the stateParam", () => {
    const workflows = [
      {
        name: "event",
        triggerEvent: "IPostMessageSent",
        persistence: {
          model: "room",
          keyPath: "message.rid",
          stateParam: "state",
          defaultState: {},
        },
        steps: [{ id: "s1", type: "transform", expression: "1" }],
      },
      {
        name: "unrelated_cmd",
        steps: [
          {
            id: "s1",
            type: "sampling",
            prompt: "Hello {{params.query}}",
          },
        ],
      },
    ];

    const warnings = autoInjectPersistence(workflows as any);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual((workflows[1] as any).persistence, undefined);
  });
});

// ─── null-safe optional fields ───────────────────────────────────────

describe("null-safe optional fields (nullable → undefined transform)", () => {
  const nullSafe = z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined);

  it("converts null to undefined", () => {
    const schema = z.object({ field: nullSafe });
    const result = schema.parse({ field: null });
    assert.strictEqual(result.field, undefined);
  });

  it("preserves real string values", () => {
    const schema = z.object({ field: nullSafe });
    const result = schema.parse({ field: "hello" });
    assert.strictEqual(result.field, "hello");
  });

  it("keeps omitted fields as undefined", () => {
    const schema = z.object({ field: nullSafe });
    const result = schema.parse({});
    assert.strictEqual(result.field, undefined);
  });

  it("works for number fields", () => {
    const numSafe = z
      .number()
      .nullable()
      .optional()
      .transform((v) => v ?? undefined);
    const schema = z.object({ n: numSafe });
    assert.strictEqual(schema.parse({ n: null }).n, undefined);
    assert.strictEqual(schema.parse({ n: 42 }).n, 42);
    assert.strictEqual(schema.parse({}).n, undefined);
  });

  it("works for object fields (persistence-like)", () => {
    const objSafe = z
      .object({ model: z.string() })
      .nullable()
      .optional()
      .transform((v) => v ?? undefined);
    const schema = z.object({ persistence: objSafe });
    assert.strictEqual(
      schema.parse({ persistence: null }).persistence,
      undefined,
    );
    assert.deepStrictEqual(
      schema.parse({ persistence: { model: "room" } }).persistence,
      { model: "room" },
    );
  });
});

// ── Phase A: Fuzzy operationId auto-resolution ──

describe("Levenshtein fuzzy matching in getFullEndpoints", () => {
  it("resolves getMessage when given getMessages (pluralization)", async () => {
    const eps = await getFullEndpoints(["get-api-v1-chat_getMessages"]);
    const ids = eps.map((e) => e.operationId);
    assert.ok(
      ids.includes("get-api-v1-chat_getMessage"),
      `Expected getMessage in results, got: ${ids}`,
    );
  });

  it("records correction in getLastCorrectedIds", async () => {
    await getFullEndpoints(["get-api-v1-chat_getMessages"]);
    const corrected = getLastCorrectedIds();
    assert.strictEqual(
      corrected.get("get-api-v1-chat_getMessages"),
      "get-api-v1-chat_getMessage",
    );
  });

  it("does NOT fuzzy-match distant IDs (distance > 2)", async () => {
    await getFullEndpoints(["get-api-v1-chat_deleteMessages"]);
    const corrected = getLastCorrectedIds();
    // "deleteMessages" is too far from "getMessage" (dist > 2)
    assert.ok(
      !corrected.has("get-api-v1-chat_deleteMessages") ||
        corrected.get("get-api-v1-chat_deleteMessages") !==
          "get-api-v1-chat_getMessage",
      "Should not fuzzy-match distant operationIds",
    );
  });

  it("exact match produces no correction", async () => {
    await getFullEndpoints(["get-api-v1-chat_getMessage"]);
    const corrected = getLastCorrectedIds();
    assert.ok(
      !corrected.has("get-api-v1-chat_getMessage"),
      "Exact match should not be in corrected map",
    );
  });
});

// ── Phase B: autoCorrectEventParamRefs ──

describe("autoCorrectEventParamRefs", () => {
  const eventShape: Record<string, Record<string, unknown>> = {
    message: {
      room: { id: "string", "displayName?": "string" },
      sender: { id: "string", username: "string" },
      "text?": "string",
    },
  };
  const domainKeys = new Set(["message", "incidentState"]);

  it("corrects params.room → params.message.room in templates", () => {
    const raw = {
      name: "test_wf",
      steps: [
        {
          id: "step1",
          type: "transform",
          expression: "({{params.room.displayName}})",
        },
      ],
    };
    const warnings = autoCorrectEventParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0, "Should produce a warning");
    assert.ok(
      (raw.steps[0] as any).expression.includes("params.message.room"),
      `Expected params.message.room, got: ${(raw.steps[0] as any).expression}`,
    );
  });

  it("corrects bare params.sender in JS expressions", () => {
    const raw = {
      name: "test_wf",
      steps: [
        {
          id: "step1",
          type: "conditional",
          condition: 'params.sender.username === "admin"',
        },
      ],
    };
    const warnings = autoCorrectEventParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.ok(
      (raw.steps[0] as any).condition.includes("params.message.sender"),
      `Expected params.message.sender, got: ${(raw.steps[0] as any).condition}`,
    );
  });

  it("does NOT touch already-correct params.message.room", () => {
    const raw = {
      name: "test_wf",
      steps: [
        {
          id: "step1",
          type: "transform",
          expression: "{{params.message.room.id}}",
        },
      ],
    };
    const warnings = autoCorrectEventParamRefs(raw, domainKeys, eventShape);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(
      (raw.steps[0] as any).expression,
      "{{params.message.room.id}}",
    );
  });

  it("does NOT touch top-level params like incidentState", () => {
    const raw = {
      name: "test_wf",
      steps: [
        {
          id: "step1",
          type: "transform",
          expression: "{{params.incidentState.active}}",
        },
      ],
    };
    const warnings = autoCorrectEventParamRefs(raw, domainKeys, eventShape);
    assert.strictEqual(warnings.length, 0);
  });

  it("corrects params.text in inputMapping values", () => {
    const raw = {
      name: "test_wf",
      steps: [
        {
          id: "step1",
          type: "api_call",
          inputMapping: { msg: "{{params.text}}" },
        },
      ],
    };
    const warnings = autoCorrectEventParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.strictEqual(
      (raw.steps[0] as any).inputMapping.msg,
      "{{params.message.text}}",
    );
  });
});

// ── Phase B2: findBestPropertyMatch ──

describe("findBestPropertyMatch", () => {
  const candidates = ["id", "displayName", "slugifiedName", "type", "creator"];

  it("returns null for empty candidates", () => {
    assert.strictEqual(findBestPropertyMatch("name", []), null);
  });

  it("case-insensitive exact match", () => {
    assert.strictEqual(findBestPropertyMatch("Type", candidates), "type");
    assert.strictEqual(findBestPropertyMatch("ID", candidates), "id");
  });

  it("Levenshtein distance = 1 unique match", () => {
    assert.strictEqual(findBestPropertyMatch("tpye", candidates), "type");
  });

  it("suffix match — unique winner", () => {
    assert.strictEqual(
      findBestPropertyMatch("slug", ["id", "slugifiedName", "type"]),
      "slugifiedName",
    );
  });

  it("suffix match — multiple winners, picks shortest", () => {
    // "name" suffix-matches both displayName (11 chars) and slugifiedName (13 chars)
    assert.strictEqual(
      findBestPropertyMatch("name", candidates),
      "displayName",
    );
  });

  it("contains match — unique winner", () => {
    assert.strictEqual(
      findBestPropertyMatch("thread", ["id", "threadId", "text"]),
      "threadId",
    );
  });

  it("contains match — non-unique returns null", () => {
    // "at" is contained in "batch", "catalog", "matrix" — 3 matches, non-unique
    // None are suffix matches (tier 3), so we hit tier 4 contains with >1 → skip
    // Levenshtein distances are all > 2, so no tier 5 match either
    assert.strictEqual(
      findBestPropertyMatch("at", ["batch", "catalog", "matrix"]),
      null,
    );
  });

  it("Levenshtein ≤ 2, unique match", () => {
    assert.strictEqual(
      findBestPropertyMatch("emial", ["email", "phone", "address"]),
      "email",
    );
  });

  it("no match at all → null", () => {
    assert.strictEqual(findBestPropertyMatch("foobar", candidates), null);
  });

  // ── Optionality-aware matching ──

  it("suffix match — with optionalSet, prefers required over optional", () => {
    // Without optionality info: picks shortest (displayName)
    assert.strictEqual(
      findBestPropertyMatch("name", candidates),
      "displayName",
    );
    // With optionality info: displayName is optional, slugifiedName is required
    const optionalSet = new Set(["displayName"]);
    assert.strictEqual(
      findBestPropertyMatch("name", candidates, optionalSet),
      "slugifiedName",
    );
  });

  it("suffix match — all optional, falls back to shortest", () => {
    const optionalSet = new Set(["displayName", "slugifiedName"]);
    assert.strictEqual(
      findBestPropertyMatch("name", candidates, optionalSet),
      "displayName",
    );
  });

  it("suffix match — all required with optionalSet, picks shortest required", () => {
    const optionalSet = new Set(["creator"]);
    assert.strictEqual(
      findBestPropertyMatch("name", candidates, optionalSet),
      "displayName",
    );
  });

  it("lev=1 — with optionalSet, disambiguates unique required", () => {
    // "tpe" is lev=1 from both "type" and "tpe" — but if we craft it right:
    // "idd" is lev=1 from "id" (3→2, deletion). Not enough candidates.
    // Better: two lev=1 candidates, one optional, one required
    const cands = ["fname", "lname"];
    // "lnme" is lev=1 from "lname" only — that's unique, no optionality needed
    // Let's use a case where both match at lev=1:
    // "xname" vs candidates ["fname", "lname"]: lev(xname,fname)=1, lev(xname,lname)=1
    assert.strictEqual(
      findBestPropertyMatch("xname", ["fname", "lname"]),
      null, // multiple lev=1 matches, no optionality → null (falls through all tiers)
    );
    assert.strictEqual(
      findBestPropertyMatch("xname", ["fname", "lname"], new Set(["fname"])),
      "lname", // fname is optional, lname is required → unique required
    );
  });

  it("contains match — with optionalSet, disambiguates unique required", () => {
    // "op" is contained in both "operation" and "optional"
    const cands = ["operation", "optional", "count"];
    assert.strictEqual(
      findBestPropertyMatch("op", cands),
      null, // two contains matches, non-unique, no lev2 → null
    );
    assert.strictEqual(
      findBestPropertyMatch("op", cands, new Set(["optional"])),
      "operation", // optional is optional → unique required is operation
    );
  });
});

// ── Phase B3: autoCorrectDeepParamRefs ──

describe("autoCorrectDeepParamRefs", () => {
  const eventShape: Record<string, Record<string, unknown>> = {
    message: {
      room: {
        id: "string",
        "displayName?": "string",
        slugifiedName: "string",
        type: "string",
        creator: { id: "string", username: "string" },
      },
      sender: { id: "string", username: "string", "name?": "string" },
      "text?": "string",
    },
  };
  const domainKeys = new Set(["message", "incidentState"]);

  it("valid deep path passes unchanged", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "transform",
          expression: "{{params.message.room.id}}",
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(
      (raw.steps[0] as any).expression,
      "{{params.message.room.id}}",
    );
  });

  it("auto-corrects hallucinated leaf: room.name → room.slugifiedName (required wins over optional displayName)", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "sampling",
          prompt: "Room: {{params.message.room.name}}",
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0, "Should produce a warning");
    assert.ok(
      (raw.steps[0] as any).prompt.includes(
        "params.message.room.slugifiedName",
      ),
      `Expected slugifiedName, got: ${(raw.steps[0] as any).prompt}`,
    );
  });

  it("auto-corrects wrong case: DisplayName → displayName", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "api_call",
          inputMapping: { name: "{{params.message.room.DisplayName}}" },
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.strictEqual(
      (raw.steps[0] as any).inputMapping.name,
      "{{params.message.room.displayName}}",
    );
  });

  it("auto-corrects typo: tpye → type", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "conditional",
          condition: 'params.message.room.tpye === "c"',
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.ok(
      (raw.steps[0] as any).condition.includes("params.message.room.type"),
      `Expected type, got: ${(raw.steps[0] as any).condition}`,
    );
  });

  it("JS method on leaf passes unchanged", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "conditional",
          condition: 'params.message.text.includes("urgent")',
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.strictEqual(warnings.length, 0);
    assert.ok(
      (raw.steps[0] as any).condition.includes("params.message.text.includes"),
    );
  });

  it("skips persistence params (not in domainKeys shape)", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "transform",
          expression: "{{params.incidentState.active}}",
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(
      (raw.steps[0] as any).expression,
      "{{params.incidentState.active}}",
    );
  });

  it("throws on fabricated property with no match", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "sampling",
          prompt: "Color: {{params.message.room.color}}",
        },
      ],
    };
    assert.throws(
      () => autoCorrectDeepParamRefs(raw, domainKeys, eventShape),
      (err: any) =>
        err.message.includes("color") &&
        err.message.includes("id") &&
        err.message.includes("displayName"),
      "Should throw listing available properties",
    );
  });

  it("corrects nested deep path: room.creator.Username → room.creator.username", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "sampling",
          prompt: "Creator: {{params.message.room.creator.Username}}",
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.ok(
      (raw.steps[0] as any).prompt.includes(
        "params.message.room.creator.username",
      ),
      `Expected username, got: ${(raw.steps[0] as any).prompt}`,
    );
  });

  it("corrects inputMapping values: room.name → room.slugifiedName", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "api_call",
          inputMapping: { roomName: "{{params.message.room.name}}" },
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.strictEqual(
      (raw.steps[0] as any).inputMapping.roomName,
      "{{params.message.room.slugifiedName}}",
    );
  });

  it("corrects bare JS refs: params.message.room.name → room.slugifiedName", () => {
    const raw = {
      name: "wf",
      steps: [
        {
          id: "s1",
          type: "conditional",
          condition: 'params.message.room.name === "general"',
        },
      ],
    };
    const warnings = autoCorrectDeepParamRefs(raw, domainKeys, eventShape);
    assert.ok(warnings.length > 0);
    assert.ok(
      (raw.steps[0] as any).condition.includes(
        "params.message.room.slugifiedName",
      ),
      `Expected slugifiedName, got: ${(raw.steps[0] as any).condition}`,
    );
  });
});
