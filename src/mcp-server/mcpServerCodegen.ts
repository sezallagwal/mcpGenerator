import type { WorkflowDefinition } from "./types.js";
import type { FullEndpoint } from "./parser/types.js";

// ── Category-based permission map ─────────────────────────────────────────
// When a workflow uses ANY endpoint in a category, grant ALL relevant
// permissions for that category.

const OPERATION_PERMISSION_MAP: Array<{
  pattern: RegExp;
  permissions: string[];
}> = [
  // Channels (public rooms) — any channels.* operation
  {
    pattern: /channels[._-]/,
    permissions: [
      "create-c",
      "view-c-room",
      "view-joined-room",
      "edit-room",
      "set-readonly",
      "archive-room",
      "unarchive-room",
      "post-readonly",
      "clean-channel-history",
    ],
  },
  // Groups (private rooms) — any groups.* operation
  {
    pattern: /groups[._-]/,
    permissions: [
      "create-p",
      "view-p-room",
      "view-joined-room",
      "edit-room",
      "set-readonly",
      "archive-room",
      "unarchive-room",
      "post-readonly",
    ],
  },
  // DMs — any im.* or dm.* operation
  {
    pattern: /im[._-]|dm[._-]/,
    permissions: ["create-d", "view-d-room", "view-joined-room"],
  },
  // Chat (messaging) — any chat.* operation
  {
    pattern: /chat[._-]/,
    permissions: ["create-d", "post-readonly", "mention-here", "mention-all"],
  },
  // Chat destructive ops — delete/update messages
  {
    pattern: /chat[._-](delete|update)/,
    permissions: ["edit-message", "delete-message"],
  },
  // Chat pin/star
  {
    pattern: /chat[._-](pin|star)/,
    permissions: ["pin-message"],
  },
  // Invite/kick across channels and groups
  {
    pattern: /channels[._-](invite|kick)|groups[._-](invite|kick)/,
    permissions: [
      "add-user-to-joined-room",
      "add-user-to-any-c-room",
      "add-user-to-any-p-room",
      "remove-user",
    ],
  },
  // Users — any users.* read operation
  {
    pattern: /users[._-]/,
    permissions: ["view-full-other-user-info"],
  },
  // Users — admin/write operations
  {
    pattern: /users[._-](create|update|delete|setActiveStatus)/,
    permissions: [
      "create-user",
      "edit-other-user-info",
      "edit-other-user-active-status",
    ],
  },
  // Rooms — any rooms.* operation (cross-type)
  {
    pattern: /rooms[._-]/,
    permissions: ["view-c-room", "view-p-room", "view-joined-room"],
  },
  // Rooms — mute/unmute
  {
    pattern: /rooms[._-](muteUser|unmuteUser)/,
    permissions: ["mute-user"],
  },
  // Channel/group deletion
  {
    pattern: /channels[._-]delete/,
    permissions: ["delete-c"],
  },
  {
    pattern: /groups[._-]delete/,
    permissions: ["delete-p"],
  },
  // Discussions
  {
    pattern: /[Dd]iscussions/,
    permissions: ["start-discussion"],
  },
  // Roles/permissions admin
  {
    pattern: /roles[._-]|permissions[._-]/,
    permissions: ["access-permissions"],
  },
  // Custom emoji
  {
    pattern: /emoji[._-]custom/,
    permissions: ["manage-emoji"],
  },
];

const BASE_BOT_PERMISSIONS = [
  "create-personal-access-tokens",
  "view-outside-room",
];

export function deriveRequiredPermissions(
  workflows: WorkflowDefinition[],
): string[] {
  const perms = new Set<string>(BASE_BOT_PERMISSIONS);
  const allOps = new Set<string>();
  for (const wf of workflows) {
    for (const epId of wf.requiredEndpoints) allOps.add(epId);
  }
  for (const opId of allOps) {
    for (const rule of OPERATION_PERMISSION_MAP) {
      if (rule.pattern.test(opId)) {
        for (const p of rule.permissions) perms.add(p);
      }
    }
  }
  return [...perms];
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function detectJsonIntentFromStrings(
  systemPrompt?: string,
  prompt?: string,
): boolean {
  const haystack = `${systemPrompt || ""} ${prompt || ""}`.toLowerCase();
  return (
    haystack.includes("json") ||
    haystack.includes("respond only with") ||
    haystack.includes("return a json") ||
    haystack.includes("output format:")
  );
}

function validateExpression(expr: string, context: string): void {
  const forbidden =
    /require\s*\(|import\s*\(|eval\s*\(|Function\s*\(|child_process|process\.exit|process\.env/;
  if (forbidden.test(expr)) {
    throw new Error(
      `Unsafe ${context} expression rejected: "${expr}". Expressions must not import modules or invoke system APIs.`,
    );
  }
}

function validateAndFixTransform(expr: string): string {
  try {
    new Function("steps", "params", `"use strict"; return (${expr});`);
    return expr;
  } catch {
    // Not a pure expression — try as statements
  }

  try {
    new Function("steps", "params", `"use strict"; ${expr}`);
    return expr;
  } catch {
    // Doesn't compile — try auto-return fixup
  }

  const trimmed = expr.trimEnd();
  if (!trimmed.endsWith("}")) return expr;

  let depth = 0;
  let objStart = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] === "}") depth++;
    else if (trimmed[i] === "{") {
      depth--;
      if (depth === 0) {
        objStart = i;
        break;
      }
    }
  }
  if (objStart <= 0) return expr;

  const before = trimmed.substring(0, objStart).trimEnd();
  if (before.endsWith(")") || before.endsWith("else")) return expr;

  const objPart = trimmed.substring(objStart);
  const stmtPart = before.endsWith(";") ? before : before + ";";
  const candidate = `${stmtPart} return (${objPart});`;

  try {
    new Function("steps", "params", `"use strict"; ${candidate}`);
    return candidate;
  } catch {
    return expr;
  }
}

function sanitizeExpression(expr: string): string {
  return (
    expr
      .replace(/\{\{params\.([^}]+)\}\}/g, "params.$1")
      .replace(/\{\{steps\.([^}]+)\}\}/g, "steps.$1")
      // Strip quotes wrapping params/steps references — Gemini sometimes
      // writes '{{params.X}}' which after {{}} removal becomes 'params.X'.
      .replace(/(['"])params\.([^'"]+)\1/g, "params.$2")
      .replace(/(['"])steps\.([^'"]+)\1/g, "steps.$2")
  );
}

export function generateWorkflowToolCode(workflow: WorkflowDefinition): string {
  const normalizedParams = JSON.parse(
    JSON.stringify(workflow.params).replace(
      /"type"\s*:\s*"(STRING|OBJECT|ARRAY|NUMBER|BOOLEAN|INTEGER|NULL)"/gi,
      (_, t) => `"type": "${t.toLowerCase()}"`,
    ),
  );
  const schemaStr = JSON.stringify(normalizedParams, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");

  for (const step of workflow.steps) {
    if (step.config.type === "transform") {
      const expr = sanitizeExpression(step.config.expression);
      validateExpression(expr, "transform");
      step.config.expression = validateAndFixTransform(expr);
    } else if (step.config.type === "conditional") {
      const expr = sanitizeExpression(step.config.condition);
      validateExpression(expr, "conditional");
      step.config.condition = expr;
    }
  }

  const stepDefs = workflow.steps.map((step) => {
    const { type, ...configFields } = step.config;
    const base: Record<string, unknown> = {
      id: step.id,
      label: step.label,
      type,
      dependsOn: step.dependsOn || [],
      ...configFields,
    };

    switch (type) {
      case "api_call":
        if (step.config.operationId === "post-api-v1-chat_postMessage") {
          const channel = (step.config.inputMapping as Record<string, unknown>)
            ?.channel;
          if (typeof channel === "string" && channel.startsWith("#")) {
            base.continueOnError = true;
          }
        }
        if (step.config.operationId === "post-api-v1-channels_create") {
          base.continueOnError = true;
        }
        if (step.config.operationId === "post-api-v1-groups_create") {
          base.continueOnError = true;
        }
        if (
          step.config.operationId === "post-api-v1-rooms_muteUser" ||
          step.config.operationId === "post-api-v1-rooms_unmuteUser"
        ) {
          base.continueOnError = true;
        }
        if (!base.continueOnError) {
          const mapping = step.config.inputMapping as
            | Record<string, unknown>
            | undefined;
          if (mapping) {
            const ROOM_FIELDS = ["roomName", "roomId", "channel"];
            for (const field of ROOM_FIELDS) {
              const val = mapping[field];
              if (
                typeof val === "string" &&
                val.length > 0 &&
                !val.includes("{{")
              ) {
                base.continueOnError = true;
                break;
              }
            }
          }
        }
        break;
      case "sampling":
        // Fallback: detect JSON intent from prompt if no explicit responseFormat
        if (
          !base.responseFormat &&
          detectJsonIntentFromStrings(
            step.config.systemPrompt,
            step.config.prompt,
          )
        ) {
          base.responseFormat = "json";
        }
        break;
      // elicitation, transform, conditional: all fields come from the spread
    }

    return base;
  });

  const referencedIds = new Set(
    stepDefs.flatMap((s) => (s.dependsOn as string[]) || []),
  );
  for (const s of stepDefs) {
    const deps = (s.dependsOn as string[]) || [];
    if (
      !referencedIds.has(s.id as string) &&
      deps.length > 0 &&
      !s.continueOnError
    ) {
      s.continueOnError = true;
    }
  }

  for (const s of stepDefs) {
    const opId = s.operationId as string;
    const mapping = s.inputMapping as Record<string, unknown> | undefined;
    if (
      !mapping ||
      typeof mapping.roomId !== "string" ||
      mapping.roomId.includes("{{")
    )
      continue;

    const roomIdLiteral = mapping.roomId;

    if (
      opId === "post-api-v1-channels_invite" ||
      opId === "post-api-v1-channels_join"
    ) {
      const createStep = stepDefs.find(
        (c) =>
          c.operationId === "post-api-v1-channels_create" &&
          (c.inputMapping as Record<string, unknown>)?.name === roomIdLiteral,
      );
      if (createStep) {
        mapping.roomId = `{{steps.${createStep.id}.result.channel._id}}`;
      }
    }

    if (opId === "post-api-v1-groups_invite") {
      const createStep = stepDefs.find(
        (c) =>
          c.operationId === "post-api-v1-groups_create" &&
          (c.inputMapping as Record<string, unknown>)?.name === roomIdLiteral,
      );
      if (createStep) {
        mapping.roomId = `{{steps.${createStep.id}.result.group._id}}`;
      }
    }
  }

  const stepsJson = JSON.stringify(stepDefs, null, 2)
    .split("\n")
    .map((line, i) => (i === 0 ? line : "  " + line))
    .join("\n");

  return `/**
 * Workflow Tool: ${workflow.name}
 * ${esc(workflow.description)}
 *
 * Steps: ${workflow.steps.map((s) => s.id).join(" → ")}
 * Generated by rc-mcp-generator (workflow mode)
 */

import { runWorkflow, type StepDefinition } from "../engine/workflow-engine.js";

// This will be injected by the server entry
let server: any;
let client: any;

export function setServer(s: any) { server = s; }
export function setClient(c: any) { client = c; }

/**
 * Endpoint registry — maps operationId to method + path.
 * Populated by the server entry from the full endpoint list.
 */
const endpoints: Record<string, { method: string; path: string }> = {};

export function registerEndpoints(eps: Record<string, { method: string; path: string }>) {
  Object.assign(endpoints, eps);
}

// ── Step Definitions (data, not code) ───────────────────────────────────

const steps: StepDefinition[] = ${stepsJson};

// ── Tool Definition ─────────────────────────────────────────────────────

export const tool = {
  name: "${esc(workflow.name)}",
  description: \`${esc(workflow.description)}\`,
  inputSchema: ${schemaStr},
  handler: async (args: Record<string, unknown>, extra?: any) => {
    return runWorkflow(
      { server, client, endpoints, name: "${esc(workflow.name)}", extra },
      steps,
      args,
    );
  },
};
`;
}

export function generateMcpServerEntryCode(
  serverName: string,
  workflows: WorkflowDefinition[],
  endpoints: FullEndpoint[],
): string {
  const usesSampling = workflows.some((w) => w.usesSampling);
  const usesElicitation = workflows.some((w) => w.usesElicitation);

  const workflowImports = workflows.map(
    (w, i) =>
      `import { tool as wfTool${i}, setServer as setServer${i}, setClient as setClient${i}, registerEndpoints as registerEndpoints${i} } from "./tools/${w.name}.js";`,
  );

  const workflowSetup = workflows.map(
    (_, i) =>
      `setServer${i}(server);\nsetClient${i}(client);\nregisterEndpoints${i}(endpointMap);`,
  );

  const endpointMapEntries = endpoints.map((ep) => {
    return `  "${esc(ep.operationId)}": { method: "${esc(ep.method.toUpperCase())}", path: "${esc(ep.path)}" },`;
  });

  const capabilities: string[] = [`tools: {}`];
  if (usesSampling) capabilities.push(`sampling: {}`);
  if (usesElicitation) capabilities.push(`elicitation: {}`);

  return `#!/usr/bin/env node
/**
 * ${esc(serverName)} — MCP Server
 * Generated by rc-mcp-generator on ${new Date().toISOString().split("T")[0]}
 *
 * Workflow tools: ${workflows.length} (each chains API calls internally)
 * Capabilities: ${capabilities.join(", ")}
 * Transport: stdio
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
${workflowImports.join("\n")}

// ─── Endpoint Map (for workflow API calls) ────────────────────────────────

const endpointMap: Record<string, { method: string; path: string }> = {
${endpointMapEntries.join("\n")}
};

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "${esc(serverName)}", version: "1.0.0" },
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const { client, initAuth, get2faHash } = await import("./rc-client.js");
  await initAuth();

  // Wire workflow tools with server + client references
${workflowSetup.join("\n")}

  // Register workflow tools via SDK API
${workflows
  .map((w, i) => {
    const props = (w.params as any)?.properties || {};
    const zodEntries = Object.entries(props)
      .map(([key, val]: [string, any]) => {
        const desc = val?.description
          ? `.describe(${JSON.stringify(val.description)})`
          : "";
        return `      ${key}: z.any()${desc}`;
      })
      .join(",\n");
    const zodShape = zodEntries ? `{\n${zodEntries}\n    }` : "{}";
    return `  server.registerTool(\n    wfTool${i}.name,\n    { description: wfTool${i}.description, inputSchema: ${zodShape} },\n    async (args: any, extra: any): Promise<any> => wfTool${i}.handler(args, extra),\n  );`;
  })
  .join("\n")}

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("${esc(serverName)} running — ${workflows.length} workflow tools");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
`;
}

export function generateWorkflowReadme(
  workflows: WorkflowDefinition[],
): string {
  if (workflows.length === 0) return "";

  const rows = workflows
    .map((w) => {
      const features: string[] = [];
      if (w.usesSampling) features.push("AI");
      if (w.usesElicitation) features.push("Human-in-loop");
      const badges =
        features.length > 0 ? features.join(", ") : "Pure automation";
      return `| \`${w.name}\` | ${w.description} | ${w.steps.length} | ${badges} |`;
    })
    .join("\n");

  return `
## Workflow Tools

These tools are multi-step workflows that chain API calls, AI analysis, and user confirmation into single operations.

| Tool | Description | Steps | Features |
|------|-------------|-------|----------|
${rows}

### How Workflow Tools Work

Each workflow tool executes a pre-defined sequence of steps:

1. **API calls** — interact with the Rocket.Chat REST API
2. **AI analysis** (sampling) — the MCP client's LLM analyzes data and makes judgments
3. **User confirmation** (elicitation) — asks the user for approval before destructive actions
4. **Transforms** — reshape data between steps

The workflow handles all coordination internally — the LLM only needs to provide the initial parameters.
`;
}
