import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkflowDefinition } from "../mcp-server/types.js";
import type { AppCapability } from "./types.js";
import { toPascalCase } from "../utils.js";
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
  generateRcAppsConfigCode,
  generateMcpBridgeCode,
  generateBridgedEventHandlerCode,
  type AppGenOptions,
  type SlashCommandDef,
  type WebhookEndpointDef,
} from "./rcAppTemplates.js";

export interface GenerateRcAppInput {
  appName: string;
  description: string;
  outputDir: string;
  workflows?: WorkflowDefinition[];
  extraCommands?: SlashCommandDef[];
  webhookEndpoints?: WebhookEndpointDef[];
  eventInterfaces?: AppCapability[];
  eventWorkflowMap?: Record<string, string>;
  projectDirOverride?: string;
}

export interface GenerateRcAppResult {
  projectDir: string;
  filesWritten: number;
  commands: string[];
  webhooks: string[];
  hasMessageHandlers: boolean;
  workflowCount: number;
  eventInterfaces: string[];
  isBridged: boolean;
}

export function generateRcAppProject(
  input: GenerateRcAppInput,
): GenerateRcAppResult {
  const {
    appName,
    description,
    outputDir,
    workflows = [],
    extraCommands = [],
    webhookEndpoints = [],
    eventInterfaces = [],
    eventWorkflowMap = {},
  } = input;

  const eventBoundWorkflows = new Set(Object.values(eventWorkflowMap));

  const workflowCommands: SlashCommandDef[] = workflows
    .filter((wf) => !eventBoundWorkflows.has(wf.name))
    .map((wf) => ({
      command: wf.name.replace(/_/g, "-"),
      description: wf.description,
      workflowName: wf.name,
    }));

  const fallbackWorkflow = workflows.find(
    (wf) => !eventBoundWorkflows.has(wf.name),
  );
  const wiredExtraCommands: SlashCommandDef[] = extraCommands.map((cmd) => ({
    ...cmd,
    workflowName:
      cmd.workflowName ??
      fallbackWorkflow?.name ??
      cmd.command.replace(/-/g, "_"),
  }));

  const allCommands = [...workflowCommands, ...wiredExtraCommands];

  const options: AppGenOptions = {
    appName,
    description,
    commands: allCommands,
    messageHandlers: false,
    webhookEndpoints,
    workflows,
    bridged: eventInterfaces.length > 0,
  };

  const files: Record<string, string> = {};
  const binaryFiles: Record<string, Buffer> = {};

  const className = toPascalCase(appName) + "App";

  const projectDir_ =
    input.projectDirOverride ??
    resolve(outputDir, appName.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  let existingAppId: string | undefined;
  const existingAppJson = join(projectDir_, "app.json");
  if (existsSync(existingAppJson)) {
    try {
      const prev = JSON.parse(readFileSync(existingAppJson, "utf-8"));
      if (prev.id) existingAppId = prev.id;
    } catch {
      /* ignore corrupt file */
    }
  }
  files["app.json"] = generateAppManifestCode(
    appName,
    description,
    existingAppId,
  );

  if (eventInterfaces.length > 0) {
    files[`${className}.ts`] = generateDynamicAppClassCode(
      options,
      eventInterfaces,
    );
  } else {
    files[`${className}.ts`] = generateAppClassCode(options);
  }

  files["package.json"] = generateRcAppPackageJsonCode(appName);
  files["tsconfig.json"] = generateRcAppTsConfigCode();
  files["README.md"] = generateRcAppReadmeCode(options);
  files[".gitignore"] = generateGitIgnoreCode();
  files[".editorconfig"] = generateEditorConfigCode();
  files[".rcappsconfig"] = generateRcAppsConfigCode();
  binaryFiles["icon.png"] = generatePlaceholderIconBuffer();

  files["settings/settings.ts"] = generateAppSettingsCode(options);

  files["helpers/message.ts"] = generateMessageHelperCode();

  const isBridged = eventInterfaces.length > 0;
  for (const cmd of allCommands) {
    const workflow = workflows.find((wf) => wf.name === cmd.workflowName);
    files[`commands/${cmd.command}.ts`] = generateSlashCommandCode(
      cmd,
      workflow,
      isBridged,
    );
  }

  for (const ep of webhookEndpoints) {
    files[`endpoints/${ep.path}.ts`] = generateWebhookEndpointCode(ep);
  }

  const fallbackToolName =
    workflows.length > 0
      ? workflows[0].name
      : appName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "") + "_handler";

  for (const cap of eventInterfaces) {
    const handlerName = cap.interfaceName.replace(/^I/, "") + "Handler";
    const toolName = eventWorkflowMap[cap.interfaceName] ?? fallbackToolName;
    const matchedWorkflow = workflows.find((wf) => wf.name === toolName);
    files[`handlers/${handlerName}.ts`] = generateBridgedEventHandlerCode(
      cap,
      appName,
      toolName,
      matchedWorkflow?.persistence,
    );
  }

  files["bridge/mcp-bridge.ts"] = generateMcpBridgeCode(appName);

  const projectDir =
    input.projectDirOverride ??
    resolve(outputDir, appName.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

  const dirs = new Set<string>();
  for (const filePath of [...Object.keys(files), ...Object.keys(binaryFiles)]) {
    const dir = join(projectDir, filePath, "..");
    dirs.add(dir);
  }
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  for (const [filePath, content] of Object.entries(files)) {
    writeFileSync(join(projectDir, filePath), content, "utf-8");
  }

  for (const [filePath, content] of Object.entries(binaryFiles)) {
    writeFileSync(join(projectDir, filePath), content);
  }

  return {
    projectDir,
    filesWritten: Object.keys(files).length + Object.keys(binaryFiles).length,
    commands: allCommands.map((c) => `/${c.command}`),
    webhooks: webhookEndpoints.map((e) => `/${e.path}`),
    hasMessageHandlers: eventInterfaces.some(
      (c) => c.interfaceName === "IPostMessageSent",
    ),
    workflowCount: workflows.length,
    eventInterfaces: eventInterfaces.map((c) => c.interfaceName),
    isBridged: true,
  };
}
