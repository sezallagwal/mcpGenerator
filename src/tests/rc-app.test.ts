import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateAppManifestCode,
  generateAppClassCode,
  generateDynamicAppClassCode,
  generateSlashCommandCode,
  generateWebhookEndpointCode,
  generateMessageHelperCode,
  generateAppSettingsCode,
  generateRcAppPackageJsonCode,
  generateRcAppTsConfigCode,
  generateRcAppReadmeCode,
  generatePlaceholderIconBuffer,
  generateGitIgnoreCode,
  generateEditorConfigCode,
  generateMcpBridgeCode,
  generateBridgedEventHandlerCode,
  type AppGenOptions,
} from "../rc-app/rcAppTemplates.js";
import { generateRcAppProject } from "../rc-app/rcAppGenerator.js";
import type {
  WorkflowDefinition,
  PersistenceConfig,
} from "../mcp-server/types.js";
import type { AppCapability } from "../rc-app/types.js";

const testWorkflow: WorkflowDefinition = {
  name: "test_workflow",
  description: "A test workflow for unit tests",
  params: {
    type: "object",
    properties: {
      channelName: { type: "string", description: "Channel name" },
    },
    required: ["channelName"],
  },
  steps: [
    {
      id: "get_history",
      label: "Get channel history",
      config: {
        type: "api_call",
        operationId: "get-api-v1-channels_history",
        inputMapping: { roomName: "{{params.channelName}}" },
      },
    },
    {
      id: "format_result",
      label: "Format the result",
      config: {
        type: "transform",
        expression: "steps.get_history?.result?.messages?.length ?? 0",
      },
      dependsOn: ["get_history"],
    },
  ],
  requiredEndpoints: ["get-api-v1-channels_history"],
  usesSampling: false,
  usesElicitation: false,
};

describe("generateAppManifestCode", () => {
  it("generates valid JSON", () => {
    const result = generateAppManifestCode("Test App", "A test app");
    const parsed = JSON.parse(result);
    assert.ok(parsed);
  });

  it("contains required fields", () => {
    const result = JSON.parse(
      generateAppManifestCode("Test App", "A test app"),
    );
    assert.ok(result.id, "should have id");
    assert.equal(result.version, "0.0.1");
    assert.ok(result.requiredApiVersion);
    assert.ok(result.classFile);
    assert.equal(result.name, "Test App");
    assert.equal(result.description, "A test app");
    assert.ok(result.author);
    assert.ok(result.nameSlug);
  });

  it("classFile matches PascalCase convention", () => {
    const result = JSON.parse(generateAppManifestCode("My Cool App", "desc"));
    assert.equal(result.classFile, "MyCoolAppApp.ts");
  });

  it("generates random UUID when no existingId provided", () => {
    const a = JSON.parse(generateAppManifestCode("App", "desc"));
    const b = JSON.parse(generateAppManifestCode("App", "desc"));
    assert.notEqual(a.id, b.id, "should generate different UUIDs each time");
  });

  it("preserves existing ID when provided", () => {
    const existingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const result = JSON.parse(
      generateAppManifestCode("App", "desc", existingId),
    );
    assert.equal(result.id, existingId, "should reuse existing ID");
  });
});

describe("generateAppClassCode", () => {
  const baseOptions: AppGenOptions = {
    appName: "TestApp",
    description: "Test app",
    commands: [],
    messageHandlers: false,
    webhookEndpoints: [],
    workflows: [],
  };

  it("generates class extending App", () => {
    const code = generateAppClassCode(baseOptions);
    assert.ok(code.includes("extends App"));
    assert.ok(code.includes("class TestAppApp"));
  });

  it("imports App from apps-engine", () => {
    const code = generateAppClassCode(baseOptions);
    assert.ok(code.includes("@rocket.chat/apps-engine/definition/App"));
  });

  it("includes extendConfiguration with settings registration", () => {
    const code = generateAppClassCode(baseOptions);
    assert.ok(code.includes("extendConfiguration"));
    assert.ok(code.includes("settings.map"));
  });

  it("imports settings module", () => {
    const code = generateAppClassCode(baseOptions);
    assert.ok(code.includes("import { settings } from './settings/settings'"));
  });

  it("includes command registration when commands present", () => {
    const code = generateAppClassCode({
      ...baseOptions,
      commands: [{ command: "hello", description: "Say hello" }],
    });
    assert.ok(code.includes("slashCommands.provideSlashCommand"));
    assert.ok(code.includes("HelloCommand"));
  });

  it("delegates to PostMessageSentHandler when messageHandlers enabled", () => {
    const code = generateAppClassCode({
      ...baseOptions,
      messageHandlers: true,
    });
    assert.ok(code.includes("implements IPostMessageSent"));
    assert.ok(code.includes("executePostMessageSent"));
    assert.ok(code.includes("new PostMessageSentHandler"));
    assert.ok(code.includes("handler.run()"));
    assert.ok(code.includes("import { PostMessageSentHandler }"));
  });

  it("registers API endpoints when webhookEndpoints present", () => {
    const code = generateAppClassCode({
      ...baseOptions,
      webhookEndpoints: [
        { path: "webhook", description: "Test webhook", methods: ["post"] },
      ],
    });
    assert.ok(code.includes("configuration.api.provideApi"));
    assert.ok(code.includes("ApiVisibility.PUBLIC"));
  });
});

describe("generateSlashCommandCode", () => {
  it("generates ISlashCommand implementation", () => {
    const code = generateSlashCommandCode({
      command: "digest",
      description: "Get channel digest",
    });
    assert.ok(code.includes("implements ISlashCommand"));
    assert.ok(code.includes("command = 'digest'"));
  });

  it("includes executor method", () => {
    const code = generateSlashCommandCode({
      command: "hello",
      description: "Say hello",
    });
    assert.ok(code.includes("async executor"));
    assert.ok(code.includes("SlashCommandContext"));
  });

  it("class name is PascalCase + Command", () => {
    const code = generateSlashCommandCode({
      command: "my-command",
      description: "Test",
    });
    assert.ok(code.includes("class MyCommandCommand"));
  });

  it("generates bridged workflow command when workflow provided", () => {
    const code = generateSlashCommandCode(
      { command: "test", description: "Test", workflowName: "test_workflow" },
      testWorkflow,
    );
    assert.ok(code.includes("McpBridge"));
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("test_workflow"));
  });

  it("conditionally includes threadId and triggerId in bridge call", () => {
    const code = generateSlashCommandCode(
      { command: "test", description: "Test", workflowName: "test_workflow" },
      testWorkflow,
    );
    assert.ok(
      code.includes("const _threadId = context.getThreadId()"),
      "Should extract threadId to a variable",
    );
    assert.ok(
      code.includes("toolArgs.threadId = _threadId || statusMsgId"),
      "Should use existing threadId or fall back to status message ID",
    );
    assert.ok(
      code.includes(
        "const statusMsgId = await modify.getCreator().finish(statusMsg)",
      ),
      "Should capture status message ID",
    );
    assert.ok(
      code.includes("const _triggerId = context.getTriggerId()"),
      "Should extract triggerId to a variable",
    );
    assert.ok(
      code.includes("if (_triggerId) toolArgs.triggerId = _triggerId"),
      "Should conditionally assign triggerId",
    );
    assert.ok(
      !code.includes("threadId: context.getThreadId()"),
      "Should NOT have inline threadId assignment",
    );
  });

  it("includes error handling", () => {
    const code = generateSlashCommandCode({
      command: "test",
      description: "Test",
    });
    assert.ok(code.includes("catch (error)"));
    assert.ok(code.includes("Error executing"));
  });
});

describe("generateWebhookEndpointCode", () => {
  it("generates ApiEndpoint class", () => {
    const code = generateWebhookEndpointCode({
      path: "incoming",
      description: "Handle incoming data",
      methods: ["post"],
    });
    assert.ok(code.includes("extends ApiEndpoint"));
    assert.ok(code.includes("path = 'incoming'"));
  });

  it("generates methods for each HTTP method", () => {
    const code = generateWebhookEndpointCode({
      path: "webhook",
      description: "Test",
      methods: ["get", "post"],
    });
    assert.ok(code.includes("public async get("));
    assert.ok(code.includes("public async post("));
  });

  it("returns success response", () => {
    const code = generateWebhookEndpointCode({
      path: "test",
      description: "Test",
      methods: ["post"],
    });
    assert.ok(code.includes("this.success"));
  });

  it("class name is PascalCase + Endpoint", () => {
    const code = generateWebhookEndpointCode({
      path: "my-hook",
      description: "Test",
      methods: ["post"],
    });
    assert.ok(code.includes("class MyHookEndpoint"));
  });
});

describe("RC App config files", () => {
  it("package.json has apps-engine dependency", () => {
    const pkg = JSON.parse(generateRcAppPackageJsonCode("test-app"));
    assert.ok(pkg.devDependencies["@rocket.chat/apps-engine"]);
  });

  it("package.json has ui-kit dependency", () => {
    const pkg = JSON.parse(generateRcAppPackageJsonCode("test-app"));
    assert.ok(pkg.dependencies["@rocket.chat/ui-kit"]);
  });

  it("package.json has deploy script", () => {
    const pkg = JSON.parse(generateRcAppPackageJsonCode("test-app"));
    assert.ok(pkg.scripts.deploy);
  });

  it("tsconfig targets es2017 (Apps-Engine requirement)", () => {
    const config = JSON.parse(generateRcAppTsConfigCode());
    assert.equal(config.compilerOptions.target, "es2017");
    assert.equal(config.compilerOptions.module, "commonjs");
  });

  it("placeholder icon is a valid PNG buffer", () => {
    const icon = generatePlaceholderIconBuffer();
    assert.ok(Buffer.isBuffer(icon));
    assert.equal(icon[0], 0x89);
    assert.equal(icon[1], 0x50);
    assert.equal(icon[2], 0x4e);
    assert.equal(icon[3], 0x47);
  });

  it(".gitignore excludes node_modules and dist", () => {
    const gitignore = generateGitIgnoreCode();
    assert.ok(gitignore.includes("node_modules/"));
    assert.ok(gitignore.includes("dist/"));
  });

  it(".editorconfig sets 4-space indent", () => {
    const editorconfig = generateEditorConfigCode();
    assert.ok(editorconfig.includes("indent_size = 4"));
    assert.ok(editorconfig.includes("indent_style = space"));
  });
});

describe("generateMessageHelperCode", () => {
  it("generates sendMessage function", () => {
    const code = generateMessageHelperCode();
    assert.ok(code.includes("export async function sendMessage"));
    assert.ok(code.includes("modify.getCreator().startMessage()"));
  });

  it("generates notifyUser function", () => {
    const code = generateMessageHelperCode();
    assert.ok(code.includes("export async function notifyUser"));
    assert.ok(code.includes("modify.getNotifier().notifyUser"));
  });

  it("sendMessage supports thread replies", () => {
    const code = generateMessageHelperCode();
    assert.ok(code.includes("setThreadId"));
    assert.ok(code.includes("threadId"));
  });

  it("uses app user as sender (Rasa pattern)", () => {
    const code = generateMessageHelperCode();
    assert.ok(code.includes("getAppUser"));
    assert.ok(code.includes("setSender(appUser)"));
  });
});

describe("generateAppSettingsCode", () => {
  const baseOptions: AppGenOptions = {
    appName: "TestApp",
    description: "Test",
    commands: [],
    messageHandlers: false,
    webhookEndpoints: [],
    workflows: [],
  };

  it("generates ISetting array", () => {
    const code = generateAppSettingsCode(baseOptions);
    assert.ok(code.includes("ISetting"));
    assert.ok(code.includes("SettingType"));
    assert.ok(code.includes("export const settings"));
  });

  it("includes target_channel setting for all apps", () => {
    const code = generateAppSettingsCode(baseOptions);
    assert.ok(code.includes("target_channel"));
  });

  it("includes bot_username and llm_api_url when messageHandlers enabled", () => {
    const code = generateAppSettingsCode({
      ...baseOptions,
      messageHandlers: true,
    });
    assert.ok(code.includes("bot_username"));
    assert.ok(code.includes("llm_api_url"));
    assert.ok(code.includes("service_unavailable_message"));
  });

  it("omits bot settings when messageHandlers disabled", () => {
    const code = generateAppSettingsCode(baseOptions);
    assert.ok(!code.includes("bot_username"));
    assert.ok(!code.includes("llm_api_url"));
  });
});

describe("generateRcAppReadmeCode", () => {
  it("includes app name and description", () => {
    const readme = generateRcAppReadmeCode({
      appName: "Test App",
      description: "A test app",
      commands: [],
      messageHandlers: false,
      webhookEndpoints: [],
      workflows: [],
    });
    assert.ok(readme.includes("# Test App"));
    assert.ok(readme.includes("A test app"));
  });

  it("lists slash commands", () => {
    const readme = generateRcAppReadmeCode({
      appName: "Test",
      description: "Test",
      commands: [{ command: "hello", description: "Say hello" }],
      messageHandlers: false,
      webhookEndpoints: [],
      workflows: [],
    });
    assert.ok(readme.includes("/hello"));
    assert.ok(readme.includes("Say hello"));
  });

  it("includes MCP vs RC App comparison table", () => {
    const readme = generateRcAppReadmeCode({
      appName: "Test",
      description: "Test",
      commands: [],
      messageHandlers: false,
      webhookEndpoints: [],
      workflows: [],
    });
    assert.ok(readme.includes("MCP Server"));
    assert.ok(readme.includes("RC App (this)"));
  });
});

describe("generateRcAppProject (full project)", () => {
  let tmpDir: string;

  function makeTmp(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "rc-app-test-"));
    return tmpDir;
  }

  function cleanup() {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  it("creates project directory with all core files", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Basic App",
        description: "A basic test app",
        outputDir: dir,
      });

      assert.ok(
        result.filesWritten >= 10,
        `Expected at least 10 files, got ${result.filesWritten}`,
      );

      const contents = readFileSync(
        join(result.projectDir, "app.json"),
        "utf-8",
      );
      const manifest = JSON.parse(contents);
      assert.equal(manifest.name, "Basic App");

      const mainClass = readFileSync(
        join(result.projectDir, "BasicAppApp.ts"),
        "utf-8",
      );
      assert.ok(mainClass.includes("class BasicAppApp"));

      assert.ok(
        existsSync(join(result.projectDir, "settings", "settings.ts")),
        "settings/settings.ts should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, "helpers", "message.ts")),
        "helpers/message.ts should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, ".gitignore")),
        ".gitignore should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, ".editorconfig")),
        ".editorconfig should exist",
      );

      assert.ok(
        existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")),
        "bridge/mcp-bridge.ts should always exist",
      );
      assert.ok(result.isBridged);
    } finally {
      cleanup();
    }
  });

  it("generates slash commands from workflows", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Workflow App",
        description: "App with workflows",
        outputDir: dir,
        workflows: [testWorkflow],
      });

      assert.ok(result.commands.length > 0, "Should have commands");
      assert.ok(result.commands.includes("/test-workflow"));

      const cmdFile = readFileSync(
        join(result.projectDir, "commands", "test-workflow.ts"),
        "utf-8",
      );
      assert.ok(cmdFile.includes("implements ISlashCommand"));
      assert.ok(cmdFile.includes("bridge.callTool"));
      assert.ok(cmdFile.includes("test_workflow"));
    } finally {
      cleanup();
    }
  });

  it("generates webhook endpoints", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Webhook App",
        description: "App with webhooks",
        outputDir: dir,
        webhookEndpoints: [
          {
            path: "alert",
            description: "Handle alerts",
            methods: ["post"],
          },
        ],
      });

      assert.ok(result.webhooks.includes("/alert"));

      const epFile = readFileSync(
        join(result.projectDir, "endpoints", "alert.ts"),
        "utf-8",
      );
      assert.ok(epFile.includes("extends ApiEndpoint"));
      assert.ok(epFile.includes("path = 'alert'"));
    } finally {
      cleanup();
    }
  });

  it("always generates bridged even without event interfaces", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Event App",
        description: "App with bridged architecture",
        outputDir: dir,
      });

      assert.ok(
        existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")),
        "bridge/mcp-bridge.ts should always exist",
      );
      assert.ok(result.isBridged);

      const bridge = readFileSync(
        join(result.projectDir, "bridge", "mcp-bridge.ts"),
        "utf-8",
      );
      assert.ok(bridge.includes("class McpBridge"));
    } finally {
      cleanup();
    }
  });

  it("generates full-featured app with everything", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Full App",
        description: "Full featured app",
        outputDir: dir,
        workflows: [testWorkflow],
        webhookEndpoints: [
          { path: "incoming", description: "Incoming hook", methods: ["post"] },
        ],
      });

      assert.ok(result.commands.includes("/test-workflow"));
      assert.ok(result.webhooks.includes("/incoming"));
      assert.equal(result.workflowCount, 1);
      assert.ok(result.isBridged);

      const mainClass = readFileSync(
        join(result.projectDir, "FullAppApp.ts"),
        "utf-8",
      );
      assert.ok(mainClass.includes("TestWorkflowCommand"));
      assert.ok(mainClass.includes("IncomingEndpoint"));
      assert.ok(mainClass.includes("import { settings }"));

      assert.ok(
        existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")),
        "bridge should always exist",
      );

      assert.ok(
        existsSync(join(result.projectDir, "commands")),
        "commands/ should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, "endpoints")),
        "endpoints/ should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, "helpers")),
        "helpers/ should exist",
      );
      assert.ok(
        existsSync(join(result.projectDir, "settings")),
        "settings/ should exist",
      );
    } finally {
      cleanup();
    }
  });
});

describe("workflow step types in RC App commands", () => {
  it("generates bridged API call delegation", () => {
    const code = generateSlashCommandCode(
      { command: "test", description: "Test", workflowName: "test_workflow" },
      testWorkflow,
    );
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("McpBridge"));
  });

  it("generates bridged command for sampling workflow", () => {
    const wf: WorkflowDefinition = {
      name: "sampling_test",
      description: "Test sampling",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "analyze",
          label: "Analyze with AI",
          config: {
            type: "sampling",
            prompt: "Analyze this: {{params.text}}",
            maxTokens: 500,
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: true,
      usesElicitation: false,
    };

    const code = generateSlashCommandCode(
      {
        command: "analyze",
        description: "Test",
        workflowName: "sampling_test",
      },
      wf,
    );
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("sampling_test"));
  });

  it("generates bridged command for elicitation workflow", () => {
    const wf: WorkflowDefinition = {
      name: "elicit_test",
      description: "Test elicitation",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "confirm",
          label: "Confirm action",
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
      requiredEndpoints: [],
      usesSampling: false,
      usesElicitation: true,
    };

    const code = generateSlashCommandCode(
      { command: "confirm", description: "Test", workflowName: "elicit_test" },
      wf,
    );
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("elicit_test"));
  });

  it("generates bridged command for conditional workflow", () => {
    const wf: WorkflowDefinition = {
      name: "conditional_test",
      description: "Test conditional",
      params: { type: "object", properties: {} },
      steps: [
        {
          id: "check",
          label: "Check condition",
          config: {
            type: "conditional",
            condition: "params.enabled === 'true'",
            thenStep: "do_action",
          },
        },
        {
          id: "do_action",
          label: "Do the action",
          config: {
            type: "transform",
            expression: "'action done'",
          },
        },
      ],
      requiredEndpoints: [],
      usesSampling: false,
      usesElicitation: false,
    };

    const code = generateSlashCommandCode(
      {
        command: "check",
        description: "Test",
        workflowName: "conditional_test",
      },
      wf,
    );
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("conditional_test"));
  });
});

const mockPostMessageSent: AppCapability = {
  interfaceName: "IPostMessageSent",
  category: "messages",
  importPath: "definition/messages/IPostMessageSent",
  deprecated: false,
  jsDoc: "Handler called after a message is sent",
  methods: [
    {
      name: "executePostMessageSent",
      isOptional: false,
      parameters: [
        { name: "message", type: "IMessage", isOptional: false },
        { name: "read", type: "IRead", isOptional: false },
        { name: "http", type: "IHttp", isOptional: false },
        { name: "persistence", type: "IPersistence", isOptional: false },
        { name: "modify", type: "IModify", isOptional: false },
      ],
      returnType: "Promise<void>",
    },
    {
      name: "checkPostMessageSent",
      isOptional: true,
      parameters: [
        { name: "message", type: "IMessage", isOptional: false },
        { name: "read", type: "IRead", isOptional: false },
        { name: "http", type: "IHttp", isOptional: false },
      ],
      returnType: "Promise<boolean>",
    },
  ],
};

const mockPostRoomCreate: AppCapability = {
  interfaceName: "IPostRoomCreate",
  category: "rooms",
  importPath: "definition/rooms/IPostRoomCreate",
  deprecated: false,
  jsDoc: "Handler called after a room is created",
  methods: [
    {
      name: "executePostRoomCreate",
      isOptional: false,
      parameters: [
        { name: "room", type: "IRoom", isOptional: false },
        { name: "read", type: "IRead", isOptional: false },
        { name: "http", type: "IHttp", isOptional: false },
        { name: "persistence", type: "IPersistence", isOptional: false },
        { name: "modify", type: "IModify", isOptional: false },
      ],
      returnType: "Promise<void>",
    },
  ],
};

const mockPostLivechatRoomStarted: AppCapability = {
  interfaceName: "IPostLivechatRoomStarted",
  category: "livechat",
  importPath: "definition/livechat/IPostLivechatRoomStarted",
  deprecated: false,
  jsDoc: "Handler called after a livechat room is started",
  methods: [
    {
      name: "executePostLivechatRoomStarted",
      isOptional: false,
      parameters: [
        { name: "room", type: "IRoom", isOptional: false },
        { name: "read", type: "IRead", isOptional: false },
        { name: "http", type: "IHttp", isOptional: false },
        { name: "persistence", type: "IPersistence", isOptional: false },
        { name: "modify", type: "IModify", isOptional: false },
      ],
      returnType: "Promise<void>",
    },
  ],
};

describe("generateDynamicAppClassCode", () => {
  const baseOptions: AppGenOptions = {
    appName: "DynBot",
    description: "Dynamic app",
    commands: [],
    messageHandlers: false,
    webhookEndpoints: [],
    workflows: [],
  };

  it("generates class extending App", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(code.includes("class DynBotApp extends App"));
  });

  it("implements requested interfaces", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
      mockPostRoomCreate,
    ]);
    assert.ok(code.includes("implements IPostMessageSent, IPostRoomCreate"));
  });

  it("imports event interfaces from apps-engine", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(code.includes("import { IPostMessageSent }"));
  });

  it("imports handler classes", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(code.includes("import { PostMessageSentHandler }"));
  });

  it("generates delegate methods for execute methods", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(code.includes("executePostMessageSent"));
    assert.ok(code.includes("new PostMessageSentHandler"));
    assert.ok(code.includes("handler.run()"));
  });

  it("skips optional check methods", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(!code.includes("checkPostMessageSent"));
  });

  it("works with multiple capabilities", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
      mockPostRoomCreate,
    ]);
    assert.ok(code.includes("executePostMessageSent"));
    assert.ok(code.includes("executePostRoomCreate"));
    assert.ok(code.includes("PostMessageSentHandler"));
    assert.ok(code.includes("PostRoomCreateHandler"));
  });

  it("includes slash commands alongside event interfaces", () => {
    const code = generateDynamicAppClassCode(
      { ...baseOptions, commands: [{ command: "help", description: "Help" }] },
      [mockPostRoomCreate],
    );
    assert.ok(code.includes("HelpCommand"));
    assert.ok(code.includes("executePostRoomCreate"));
  });

  it("includes dynamic generation comment", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
    ]);
    assert.ok(code.includes("Dynamically generated"));
  });

  it("lists event interfaces in the header comment", () => {
    const code = generateDynamicAppClassCode(baseOptions, [
      mockPostMessageSent,
      mockPostRoomCreate,
    ]);
    assert.ok(
      code.includes("Event interfaces: IPostMessageSent, IPostRoomCreate"),
    );
  });
});

describe("generateRcAppProject with eventInterfaces", () => {
  let tmpDir: string;

  function makeTmp(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "rc-app-dyn-"));
    return tmpDir;
  }

  function cleanup() {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  it("generates handler files for each event interface (always bridged)", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Event Bot",
        description: "Bot with dynamic events",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent, mockPostRoomCreate],
      });

      assert.ok(
        existsSync(
          join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        ),
      );
      assert.ok(
        existsSync(
          join(result.projectDir, "handlers", "PostRoomCreateHandler.ts"),
        ),
      );

      const handler = readFileSync(
        join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        "utf-8",
      );
      assert.ok(handler.includes("McpBridge"), "handlers should use McpBridge");

      assert.ok(existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")));
    } finally {
      cleanup();
    }
  });

  it("reports eventInterfaces in result", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Event Bot",
        description: "Bot with dynamic events",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent, mockPostRoomCreate],
      });

      assert.deepStrictEqual(result.eventInterfaces, [
        "IPostMessageSent",
        "IPostRoomCreate",
      ]);
    } finally {
      cleanup();
    }
  });

  it("uses dynamic main class with implements", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Event Bot",
        description: "Bot with dynamic events",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent],
      });

      const mainClass = readFileSync(
        join(result.projectDir, "EventBotApp.ts"),
        "utf-8",
      );
      assert.ok(mainClass.includes("implements IPostMessageSent"));
      assert.ok(mainClass.includes("Dynamically generated"));
    } finally {
      cleanup();
    }
  });

  it("event handlers are always bridged with auto-derived tool name", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Dup Test",
        description: "Dedup test",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent],
      });

      const handler = readFileSync(
        join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        "utf-8",
      );
      assert.ok(handler.includes("McpBridge"));
      assert.ok(handler.includes("dup_test_handler"));
      assert.ok(result.hasMessageHandlers);
      assert.ok(result.isBridged);
    } finally {
      cleanup();
    }
  });

  it("combines event interfaces with workflows and commands", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Full Dynamic",
        description: "Everything combined",
        outputDir: dir,
        workflows: [testWorkflow],
        eventInterfaces: [mockPostRoomCreate],
      });

      assert.ok(result.commands.includes("/test-workflow"));
      assert.deepStrictEqual(result.eventInterfaces, ["IPostRoomCreate"]);

      const mainClass = readFileSync(
        join(result.projectDir, "FullDynamicApp.ts"),
        "utf-8",
      );
      assert.ok(mainClass.includes("implements IPostRoomCreate"));
      assert.ok(mainClass.includes("TestWorkflowCommand"));
    } finally {
      cleanup();
    }
  });
});

describe("generateMcpBridgeCode", () => {
  it("generates McpBridge class", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("class McpBridge"));
  });

  it("has callTool method", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("callTool"));
    assert.ok(code.includes("toolName: string"));
  });

  it("has listTools method", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("listTools"));
  });

  it("uses JSON-RPC format for MCP protocol", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("jsonrpc"));
    assert.ok(code.includes("tools/call"));
  });

  it("reads MCP server URL from settings", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("mcp_server_url"));
    assert.ok(code.includes("localhost:3001"));
  });

  it("imports IHttp from apps-engine", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("IHttp"));
    assert.ok(code.includes("apps-engine/definition/accessors"));
  });

  it("exports McpToolResult interface", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("McpToolResult"));
    assert.ok(code.includes("status:"));
    assert.ok(code.includes("content:"));
  });

  it("includes bridged mode comment", () => {
    const code = generateMcpBridgeCode("TestBot");
    assert.ok(code.includes("bridged mode"));
  });
});

describe("generateBridgedEventHandlerCode", () => {
  it("generates handler with McpBridge import", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(code.includes("McpBridge"));
    assert.ok(code.includes("import"));
  });

  it("generates bridged mode comment", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(code.includes("bridged mode"));
  });

  it("creates bridge and calls tool for message events", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(code.includes("new McpBridge"));
    assert.ok(code.includes("bridge.callTool"));
    assert.ok(code.includes("smart_auto_reply"));
  });

  it("includes bot check for message handlers", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(
      code.includes("roles") && code.includes("bot"),
      "Should check sender roles for bot",
    );
    assert.ok(code.includes("getAppUser"));
  });

  it("logs result instead of posting to channel", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(code.includes("Workflow completed"));
    assert.ok(code.includes("result.completedSteps"));
    assert.ok(
      !code.includes("import { sendMessage }"),
      "Should not import the sendMessage helper directly",
    );
  });

  it("generates room handler for room events", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostRoomCreate,
      "TestBot",
      "room_setup",
    );
    assert.ok(code.includes("room.slugifiedName"));
    assert.ok(code.includes("room_setup"));
    assert.ok(code.includes("McpBridge"));
  });

  it("generates livechat handler for livechat events", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostLivechatRoomStarted,
      "TestBot",
      "livechat_assist",
    );
    assert.ok(code.includes("Livechat event"));
    assert.ok(code.includes("livechat_assist"));
    assert.ok(code.includes("McpBridge"));
  });

  it("has run() method", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(code.includes("public async run()"));
  });

  it("does not import sendMessage helper", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "smart_auto_reply",
    );
    assert.ok(!code.includes("import { sendMessage }"));
  });
});

describe("generateRcAppProject with bridged mode", () => {
  let tmpDir: string;

  function makeTmp(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "rc-app-bridged-"));
    return tmpDir;
  }

  function cleanup() {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  it("generates bridge module in bridged mode", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Bridged Bot",
        description: "Bridged test",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent],
        eventWorkflowMap: { IPostMessageSent: "smart_auto_reply" },
      });

      assert.ok(result.isBridged);
      assert.ok(existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")));

      const bridge = readFileSync(
        join(result.projectDir, "bridge", "mcp-bridge.ts"),
        "utf-8",
      );
      assert.ok(bridge.includes("class McpBridge"));
    } finally {
      cleanup();
    }
  });

  it("generates bridged handlers instead of regular handlers", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Bridged Bot",
        description: "Bridged test",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent],
        eventWorkflowMap: { IPostMessageSent: "smart_auto_reply" },
      });

      const handler = readFileSync(
        join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        "utf-8",
      );
      assert.ok(handler.includes("McpBridge"));
      assert.ok(handler.includes("smart_auto_reply"));
      assert.ok(handler.includes("bridged mode"));
    } finally {
      cleanup();
    }
  });

  it("always generates bridge (bridged architecture)", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Standard Bot",
        description: "Standard test",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent],
      });

      assert.ok(result.isBridged);
      assert.ok(existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")));
    } finally {
      cleanup();
    }
  });

  it("reports isBridged always true", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Bridged Check",
        description: "Check",
        outputDir: dir,
        eventInterfaces: [mockPostRoomCreate],
        eventWorkflowMap: { IPostRoomCreate: "room_setup" },
      });

      assert.equal(result.isBridged, true);
      assert.deepStrictEqual(result.eventInterfaces, ["IPostRoomCreate"]);
    } finally {
      cleanup();
    }
  });

  it("generates bridged with multiple event interfaces", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Multi Bridged",
        description: "Multiple interfaces",
        outputDir: dir,
        eventInterfaces: [mockPostMessageSent, mockPostRoomCreate],
        eventWorkflowMap: {
          IPostMessageSent: "multi_handler",
          IPostRoomCreate: "multi_handler",
        },
      });

      assert.ok(
        existsSync(
          join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        ),
      );
      assert.ok(
        existsSync(
          join(result.projectDir, "handlers", "PostRoomCreateHandler.ts"),
        ),
      );
      assert.ok(existsSync(join(result.projectDir, "bridge", "mcp-bridge.ts")));

      const msgHandler = readFileSync(
        join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        "utf-8",
      );
      const roomHandler = readFileSync(
        join(result.projectDir, "handlers", "PostRoomCreateHandler.ts"),
        "utf-8",
      );
      assert.ok(msgHandler.includes("multi_handler"));
      assert.ok(roomHandler.includes("multi_handler"));
    } finally {
      cleanup();
    }
  });
});

describe("generateBridgedEventHandlerCode with persistence", () => {
  const persistenceConfig: PersistenceConfig = {
    model: "user",
    keyPath: "sender.username",
    stateParam: "userState",
    defaultState: { violationCount: 0, lastViolation: "" },
    updateFromStep: "update_state",
  };

  it("imports RocketChatAssociationModel and RocketChatAssociationRecord", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(code.includes("RocketChatAssociationModel"));
    assert.ok(code.includes("RocketChatAssociationRecord"));
    assert.ok(code.includes("@rocket.chat/apps-engine/definition/metadata"));
  });

  it("reads persisted state before bridge call", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(code.includes("getPersistenceReader"));
    assert.ok(code.includes("readByAssociation"));
    assert.ok(code.includes("sender.username"));
    assert.ok(code.includes("RocketChatAssociationModel.USER"));
  });

  it("injects state param into bridge call args", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(code.includes("message: this.message"));
    assert.ok(code.includes("userState"));
  });

  it("uses default state when no record exists", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(code.includes('"violationCount":0'));
  });

  it("updates persistence from step result when updateFromStep is set", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(code.includes("updateByAssociation"));
    assert.ok(code.includes("createWithAssociation"));
    assert.ok(code.includes("update_state"));
    assert.ok(
      code.includes("stepEntry?.status === 'success'"),
      "Should use status check",
    );
  });

  it("does not generate update code when updateFromStep is omitted", () => {
    const readOnlyConfig: PersistenceConfig = {
      model: "room",
      keyPath: "room._id",
      stateParam: "roomState",
      defaultState: { messageCount: 0 },
    };
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      readOnlyConfig,
    );
    assert.ok(code.includes("getPersistenceReader"));
    assert.ok(!code.includes("updateByAssociation"));
    assert.ok(!code.includes("createWithAssociation"));
  });

  it("uses correct association model for room-keyed state", () => {
    const roomConfig: PersistenceConfig = {
      model: "room",
      keyPath: "room._id",
      stateParam: "roomState",
      defaultState: { messageCount: 0 },
    };
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      roomConfig,
    );
    assert.ok(code.includes("RocketChatAssociationModel.ROOM"));
  });

  it("does not import metadata types when no persistence", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
    );
    assert.ok(!code.includes("RocketChatAssociationModel"));
    assert.ok(!code.includes("RocketChatAssociationRecord"));
  });

  it("strips domain param name prefix from keyPath to avoid double-nesting", () => {
    const prefixedConfig: PersistenceConfig = {
      model: "user",
      keyPath: "message.sender.username",
      stateParam: "userState",
      defaultState: { count: 0 },
    };
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      prefixedConfig,
    );
    assert.ok(
      code.includes("this.message.sender.username"),
      "Should strip duplicate domain param prefix",
    );
    assert.ok(
      !code.includes("this.message.message.sender"),
      "Should NOT have double domain param name",
    );
  });

  it("does not strip keyPath when it does not start with domain param name", () => {
    const correctConfig: PersistenceConfig = {
      model: "user",
      keyPath: "sender.username",
      stateParam: "userState",
      defaultState: { count: 0 },
    };
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      correctConfig,
    );
    assert.ok(
      code.includes("this.message.sender.username"),
      "Should work correctly when keyPath has no prefix",
    );
  });
});

describe("Bug 2: event-bound workflow slash command filtering", () => {
  let tmpDir: string;

  function makeTmp(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "rc-app-bug2-"));
    return tmpDir;
  }

  function cleanup() {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  }

  const eventWorkflow: WorkflowDefinition = {
    name: "analyze_and_moderate_message",
    description: "Analyze and moderate messages",
    triggerEvent: "IPostMessageSent",
    params: {
      type: "object",
      properties: {
        message: {
          type: "object",
          description: "Event data from IPostMessageSent",
        },
        userState: { type: "object", description: "Persisted state" },
      },
    },
    steps: [
      {
        id: "check_room",
        label: "Check room type",
        config: {
          type: "conditional",
          condition: 'params.message.room.type === "c"',
          thenStep: "analyze",
        },
      },
      {
        id: "analyze",
        label: "Analyze message",
        config: {
          type: "sampling",
          prompt: "Analyze: {{params.message.text}}",
        },
        dependsOn: ["check_room"],
      },
    ],
    requiredEndpoints: [],
    usesSampling: true,
    usesElicitation: false,
  };

  it("skips slash command for workflow mapped to an event", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Mod Bot",
        description: "Moderation",
        outputDir: dir,
        workflows: [eventWorkflow],
        eventInterfaces: [mockPostMessageSent],
        eventWorkflowMap: { IPostMessageSent: "analyze_and_moderate_message" },
      });

      assert.ok(
        !result.commands.includes("/analyze-and-moderate-message"),
        "Event-bound workflow should not get a slash command",
      );
      assert.ok(
        !existsSync(
          join(
            result.projectDir,
            "commands",
            "analyze-and-moderate-message.ts",
          ),
        ),
        "No slash command file for event-bound workflow",
      );
      assert.ok(
        existsSync(
          join(result.projectDir, "handlers", "PostMessageSentHandler.ts"),
        ),
        "Event handler should still be generated",
      );
    } finally {
      cleanup();
    }
  });

  it("still generates slash command for non-event-bound workflows", () => {
    const dir = makeTmp();
    try {
      const result = generateRcAppProject({
        appName: "Mod Bot",
        description: "Moderation",
        outputDir: dir,
        workflows: [eventWorkflow, testWorkflow],
        eventInterfaces: [mockPostMessageSent],
        eventWorkflowMap: { IPostMessageSent: "analyze_and_moderate_message" },
      });

      assert.ok(
        result.commands.includes("/test-workflow"),
        "Non-event-bound workflow should still get slash command",
      );
      assert.ok(
        !result.commands.includes("/analyze-and-moderate-message"),
        "Event-bound workflow should be filtered out",
      );
    } finally {
      cleanup();
    }
  });

  it("always generates bridged command body with McpBridge", () => {
    const code = generateSlashCommandCode(
      {
        command: "moderate",
        description: "Moderate",
        workflowName: "analyze_and_moderate_message",
      },
      eventWorkflow,
    );
    assert.ok(
      code.includes("McpBridge"),
      "Should always use McpBridge for bridged commands",
    );
    assert.ok(
      code.includes("bridge.callTool"),
      "Should delegate to MCP server via bridge",
    );
  });
});

describe("generateBridgedEventHandlerCode persistence status guard", () => {
  const persistenceConfig: PersistenceConfig = {
    model: "user",
    keyPath: "sender.username",
    stateParam: "userState",
    defaultState: { violationCount: 0 },
    updateFromStep: "update_state",
  };

  it("checks stepEntry.status === 'success' before persisting", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(
      code.includes("stepEntry?.status === 'success'"),
      "Should check step status is success before persisting",
    );
    assert.ok(
      !code.includes("updatedState !== undefined"),
      "Should NOT use the old undefined-only check",
    );
  });

  it("reads stepEntry first, then extracts result", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
      persistenceConfig,
    );
    assert.ok(
      code.includes('const stepEntry = stepResults["update_state"]'),
      "Should extract stepEntry from stepResults",
    );
    assert.ok(
      code.includes("const updatedState = stepEntry.result"),
      "Should extract result from stepEntry",
    );
  });
});

describe("generateBridgedEventHandlerCode message text guard", () => {
  it("guards against undefined message text for message handlers", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
    );
    assert.ok(
      code.includes("if (!text) return"),
      "Should guard against undefined/empty text in message handlers",
    );
  });

  it("places text guard after bot check and before logger", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "ModBot",
      "moderate_message",
    );
    const botCheckIdx = code.indexOf("sender.id === appUser.id");
    const textGuardIdx = code.indexOf("if (!text) return");
    const loggerIdx = code.indexOf("logger.info");
    assert.ok(
      botCheckIdx < textGuardIdx,
      "text guard should come after bot check",
    );
    assert.ok(textGuardIdx < loggerIdx, "text guard should come before logger");
  });
});

describe("bridged handler logs result instead of deferring", () => {
  it("generates simple success/error logging (no deferred actions)", () => {
    const code = generateBridgedEventHandlerCode(
      mockPostMessageSent,
      "TestBot",
      "test_workflow",
    );
    assert.ok(
      code.includes("Workflow completed"),
      "Should log workflow completion",
    );
    assert.ok(code.includes("MCP Server error"), "Should log MCP errors");
    assert.ok(
      !code.includes("deferredActions"),
      "Should NOT contain deferred action handling — MCP server executes directly",
    );
  });
});
