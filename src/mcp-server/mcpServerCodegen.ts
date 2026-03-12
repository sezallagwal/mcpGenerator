import type { WorkflowDefinition } from "./types.js";
import type { FullEndpoint } from "./parser/types.js";

const OPERATION_PERMISSION_MAP: Array<{ pattern: RegExp; permissions: string[] }> = [
  { pattern: /channels[._-]invite/, permissions: ["add-user-to-joined-room", "add-user-to-any-c-room"] },
  { pattern: /groups[._-]invite/, permissions: ["add-user-to-joined-room"] },
  { pattern: /channels[._-]create/, permissions: ["create-c"] },
  { pattern: /groups[._-]create/, permissions: ["create-p"] },
  { pattern: /im[._-]create|dm[._-]create/, permissions: ["create-d"] },
  { pattern: /chat[._-]postMessage|chat[._-]sendMessage/, permissions: ["create-d"] },
  { pattern: /chat[._-]delete|chat[._-]update/, permissions: ["delete-message"] },
  { pattern: /channels[._-]kick|groups[._-]kick/, permissions: ["remove-user"] },
  { pattern: /users[._-]info|users[._-]list/, permissions: ["view-full-other-user-info"] },
];

const BASE_BOT_PERMISSIONS = ["create-personal-access-tokens"];

export function deriveRequiredPermissions(workflows: WorkflowDefinition[]): string[] {
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
    const base: Record<string, unknown> = {
      id: step.id,
      label: step.label,
      type: step.config.type,
      dependsOn: step.dependsOn || [],
    };

    switch (step.config.type) {
      case "api_call":
        base.operationId = step.config.operationId;
        base.inputMapping = step.config.inputMapping;
        if (step.config.outputPath) base.outputPath = step.config.outputPath;
        if (step.config.forEach) base.forEach = step.config.forEach;
        if (step.config.as) base.as = step.config.as;
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
        break;
      case "sampling":
        base.prompt = step.config.prompt;
        if (step.config.content) base.content = step.config.content;
        if (step.config.systemPrompt)
          base.systemPrompt = step.config.systemPrompt;
        if (step.config.maxTokens) base.maxTokens = step.config.maxTokens;
        if (
          detectJsonIntentFromStrings(
            step.config.systemPrompt,
            step.config.prompt,
          )
        ) {
          base.responseFormat = "json";
        }
        break;
      case "elicitation":
        base.message = step.config.message;
        base.requestedSchema = step.config.requestedSchema;
        if (step.config.onDecline) base.onDecline = step.config.onDecline;
        break;
      case "transform":
        base.expression = step.config.expression;
        break;
      case "conditional":
        base.condition = step.config.condition;
        base.thenStep = step.config.thenStep;
        if (step.config.elseStep) base.elseStep = step.config.elseStep;
        break;
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
  options?: { bridged?: boolean },
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
  const bridged = options?.bridged ?? false;
  const transportNote = bridged ? "stdio + HTTP bridge" : "stdio";

  const requiredPerms = deriveRequiredPermissions(workflows);
  const derivedPermEntries = requiredPerms
    .map((p) => `                { _id: "${esc(p)}", roles: ["admin", "owner", "moderator", "bot"] },`)
    .join("\n");

  return `#!/usr/bin/env node
/**
 * ${esc(serverName)} — MCP Server
 * Generated by rc-mcp-generator on ${new Date().toISOString().split("T")[0]}
 *
 * Workflow tools: ${workflows.length} (each chains API calls internally)
 * Capabilities: ${capabilities.join(", ")}
 * Transport: ${transportNote}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
${bridged ? 'import { createServer, type IncomingMessage, type ServerResponse } from "node:http";\n' : ""}${workflowImports.join("\n")}

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
${
  bridged
    ? `
  const allTools = [
${workflows.map((_, i) => `    wfTool${i},`).join("\n")}
  ];
`
    : ""
}
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("${esc(serverName)} running — ${workflows.length} workflow tools");
${
  bridged
    ? `
  // ─── HTTP Bridge for RC App ─────────────────────────────────────────────
  const MAX_BODY_BYTES = 1_048_576; // 1 MB limit
  const PREFERRED_PORT = parseInt(process.env.MCP_HTTP_PORT || "3001", 10);
  const MAX_PORT_ATTEMPTS = 10;
  let actualPort = PREFERRED_PORT;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    console.error(\`[HTTP] \${req.method} \${req.url} from \${req.socket.remoteAddress}\`);

    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    let body = "";
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }));
        return;
      }
      body += chunk;
    }

    try {
      const rpc = JSON.parse(body);
      const id = rpc.id ?? null;

      if (rpc.method === "tools/list") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id,
          result: {
            tools: allTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          },
        }));
        return;
      }

      if (rpc.method === "tools/call") {
        const { name, arguments: callArgs = {} } = rpc.params || {};
        console.error(\`[HTTP] tools/call → \${name}\`);
        const tool = allTools.find((t) => t.name === name);
        if (!tool) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: \`Unknown tool: \${name}\` }], isError: true } }));
          return;
        }
        const result = await tool.handler(callArgs);
        const resultText = result?.content?.[0]?.text || '';
        const isErr = result?.isError || resultText.includes('"status":"error"');
        console.error(\`[HTTP] tools/call ← \${name} \${isErr ? 'FAILED' : 'completed'}\`);
        if (isErr) console.error(\`[HTTP] Error detail: \${resultText.substring(0, 500)}\`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: \`Unknown method: \${rpc.method}\` } }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    }
  });

  // Try preferred port, then increment up to MAX_PORT_ATTEMPTS times
  async function findAvailablePort(start: number, attempts: number): Promise<number> {
    const net = await import("node:net");
    for (let port = start; port < start + attempts; port++) {
      const available = await new Promise<boolean>((resolve) => {
        const tester = net.createServer();
        tester.once("error", () => resolve(false));
        tester.listen(port, () => { tester.close(() => resolve(true)); });
      });
      if (available) return port;
    }
    return -1; // all ports in use
  }

  findAvailablePort(PREFERRED_PORT, MAX_PORT_ATTEMPTS).then((port) => {
    if (port === -1) {
      console.error(\`[WARN] Ports \${PREFERRED_PORT}-\${PREFERRED_PORT + MAX_PORT_ATTEMPTS - 1} all in use — HTTP bridge disabled. MCP stdio transport still active.\`);
      return;
    }
    actualPort = port;
    httpServer.listen(port, () => {
      if (port !== PREFERRED_PORT) {
        console.error(\`[HTTP] Port \${PREFERRED_PORT} in use — using port \${port} instead\`);
      }
      console.error(\`HTTP bridge listening on port \${port} for RC App connections\`);
      runAutoConfig();
    });
  });

  // ─── Auto-configure RC App settings & bot user ──────────────────────────
  // Called after HTTP bridge is listening (so actualPort is known).
  //
  // Phase A — Bot user provisioning (first run only, skipped when tokens exist):
  //   1. Create a dedicated bot user with role "bot"
  //   2. Grant bot role the permissions it needs (delete-message, mute-user, etc.)
  //   3. Temporarily disable email-2FA auto-opt-in so the bot can log in
  //   4. Log in as the bot, generate a PAT with bypassTwoFactor
  //   5. Re-enable 2FA, write bot credentials to .env, switch client identity
  //
  // Phase B — App settings (every run):
  //   1. mcp_server_url — so the RC App knows where to reach this MCP server
  //   2. bot_username   — so the RC App ignores messages from this bot user
  //
  // Resolution order:
  //   App ID:   RC_APP_ID env  →  ../rc-app/app.json
  //   Self URL: MCP_SELF_URL env  →  host.docker.internal:PORT  →  localhost:PORT
  function runAutoConfig() {
  (async () => {
    try {
      const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dns = await import("node:dns/promises");

      const BOT_USERNAME = "${esc(serverName)}-bot";
      const thisDir = dirname(fileURLToPath(import.meta.url));
      let pendingBotAuth: { token: string; userId: string } | null = null;

      // ── Phase A: Bot user provisioning ────────────────────────────────
      // Skip if bot tokens already exist (from a previous run)
      if (!process.env.ROCKETCHAT_AUTH_TOKEN || !process.env.ROCKETCHAT_USER_ID) {
        const adminPassword = process.env.ROCKETCHAT_PASSWORD || "";
        if (!adminPassword) {
          console.error("[Auto-config] No ROCKETCHAT_PASSWORD — cannot provision bot user.");
        } else {
          console.error("[Auto-config] Provisioning bot user...");
          const twoFaHeaders = {
            "x-2fa-code": get2faHash(adminPassword),
            "x-2fa-method": "password",
          };

          // A1. Create bot user (ignore 409 if already exists)
          const botPassword = \`Bot_\${Date.now().toString(36)}_\${Math.random().toString(36).slice(2, 10)}!A1\`;
          const createRes = await client.request("POST", "/api/v1/users.create", {
            auth: true,
            headers: twoFaHeaders,
            body: {
              username: BOT_USERNAME,
              name: "${esc(serverName)} Bot",
              email: \`\${BOT_USERNAME}@server.local\`,
              password: botPassword,
              roles: ["bot"],
              verified: true,
              joinDefaultChannels: false,
            },
          });
          if (createRes.isError && !createRes.content[0]?.text?.includes("already in use")) {
            console.error(\`[Auto-config] Failed to create bot user: \${createRes.content[0]?.text}\`);
          } else {
            if (!createRes.isError) console.error(\`[Auto-config] Created bot user: \${BOT_USERNAME}\`);
            else console.error(\`[Auto-config] Bot user \${BOT_USERNAME} already exists, reusing.\`);

            // A2. Grant necessary permissions to bot role
            const permsRes = await client.request("POST", "/api/v1/permissions.update", {
              auth: true,
              headers: twoFaHeaders,
              body: { permissions: [
${derivedPermEntries}
              ]},
            });
            if (!permsRes.isError) console.error("[Auto-config] Bot role permissions updated.");
            else console.error(\`[Auto-config] Warning: could not update permissions: \${permsRes.content[0]?.text}\`);

            // A3. Temporarily disable email-2FA so bot can log in
            let twoFaWasEnabled = false;
            const twoFaSettingRes = await client.request("GET", "/api/v1/settings/Accounts_TwoFactorAuthentication_By_Email_Enabled", { auth: true });
            if (!twoFaSettingRes.isError) {
              const twoFaData = JSON.parse(twoFaSettingRes.content[0]?.text || "{}");
              twoFaWasEnabled = twoFaData.value === true;
            }

            try {
              if (twoFaWasEnabled) {
                await client.request("POST", "/api/v1/settings/Accounts_TwoFactorAuthentication_By_Email_Enabled", {
                  auth: true,
                  headers: twoFaHeaders,
                  body: { value: false },
                });
                console.error("[Auto-config] Temporarily disabled email-2FA.");
              }

              // A4. Log in as the bot user
              // If the bot already existed, we need to reset its password first
              if (createRes.isError) {
                // Bot already existed — look up userId and reset password
                const infoRes = await client.request("GET", \`/api/v1/users.info?username=\${BOT_USERNAME}\`, { auth: true });
                if (infoRes.isError) {
                  console.error(\`[Auto-config] Could not look up bot user: \${infoRes.content[0]?.text}\`);
                }
                const botUserId = infoRes.isError ? undefined : JSON.parse(infoRes.content[0]?.text || "{}").user?._id;
                if (botUserId) {
                  // Ensure bot is active
                  await client.request("POST", "/api/v1/users.setActiveStatus", {
                    auth: true,
                    headers: twoFaHeaders,
                    body: { userId: botUserId, activeStatus: true, confirmRelinquish: false },
                  });
                  const resetRes = await client.request("POST", "/api/v1/users.update", {
                    auth: true,
                    headers: twoFaHeaders,
                    body: { userId: botUserId, data: { password: botPassword } },
                  });
                  if (resetRes.isError) {
                    console.error(\`[Auto-config] Password reset failed: \${resetRes.content[0]?.text}\`);
                  } else {
                    console.error(\`[Auto-config] Reset password for existing bot user.\`);
                  }
                }
              }

              const loginRes = await fetch(\`\${process.env.ROCKETCHAT_URL || "http://localhost:3000"}/api/v1/login\`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ user: BOT_USERNAME, password: botPassword }),
              });
              const loginData = await loginRes.json();
              if (!loginRes.ok || !loginData.data?.authToken) {
                console.error(\`[Auto-config] Bot login failed: \${JSON.stringify(loginData)}\`);
              } else {
                // A5. Generate PAT with bypassTwoFactor
                const botToken = loginData.data.authToken;
                const botUserId = loginData.data.userId;
                const patName = "mcp-server-" + Date.now();
                const patRes = await fetch(\`\${process.env.ROCKETCHAT_URL || "http://localhost:3000"}/api/v1/users.generatePersonalAccessToken\`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Auth-Token": botToken,
                    "X-User-Id": botUserId,
                    "x-2fa-code": get2faHash(botPassword),
                    "x-2fa-method": "password",
                  },
                  body: JSON.stringify({ tokenName: patName, bypassTwoFactor: true }),
                });
                const patData = await patRes.json();
                if (!patRes.ok || !patData.token) {
                  console.error(\`[Auto-config] Failed to generate PAT: \${JSON.stringify(patData)}\`);
                } else {
                  // A6. Write bot credentials to .env
                  const envPath = join(thisDir, "..", ".env");
                  let envContent = "";
                  if (existsSync(envPath)) envContent = readFileSync(envPath, "utf-8");

                  // Append or update bot token lines (handle commented lines from .env.example)
                  const tokenLine = \`ROCKETCHAT_AUTH_TOKEN=\${patData.token}\`;
                  const userIdLine = \`ROCKETCHAT_USER_ID=\${botUserId}\`;
                  envContent = envContent.replace(/^#?\s*ROCKETCHAT_AUTH_TOKEN=.*/m, tokenLine);
                  envContent = envContent.replace(/^#?\s*ROCKETCHAT_USER_ID=.*/m, userIdLine);
                  if (!envContent.includes(tokenLine)) envContent += \`\\n\${tokenLine}\\n\`;
                  if (!envContent.includes(userIdLine)) envContent += \`\${userIdLine}\\n\`;
                  writeFileSync(envPath, envContent);
                  console.error(\`[Auto-config] Bot credentials written to .env (PAT: \${patName})\`);

                  // A7. Save bot auth for identity switch after Phase B
                  pendingBotAuth = { token: patData.token, userId: botUserId };
                  console.error(\`[Auto-config] Bot identity ready: \${BOT_USERNAME} (switching after app settings)\`);
                }
              }
            } finally {
              // A8. Re-enable email-2FA if we disabled it
              if (twoFaWasEnabled) {
                await client.request("POST", "/api/v1/settings/Accounts_TwoFactorAuthentication_By_Email_Enabled", {
                  auth: true,
                  headers: twoFaHeaders,
                  body: { value: true },
                });
                console.error("[Auto-config] Re-enabled email-2FA.");
              }
            }
          }
        }
      } else {
        console.error("[Auto-config] Bot tokens found, skipping provisioning.");
      }

      // ── Phase B: App settings ─────────────────────────────────────────

      // B1. Determine RC App ID
      let appId = process.env.RC_APP_ID;
      if (!appId) {
        try {
          const appJsonPath = join(thisDir, "..", "..", "rc-app", "app.json");
          appId = JSON.parse(readFileSync(appJsonPath, "utf-8")).id;
        } catch {}
      }
      if (!appId) {
        console.error("[Auto-config] Skipped app settings — set RC_APP_ID or ensure ../rc-app/app.json exists");
        return;
      }

      // B2. Determine self URL
      let selfUrl = process.env.MCP_SELF_URL;
      if (!selfUrl) {
        let host = "localhost";
        try {
          await dns.lookup("host.docker.internal");
          host = "host.docker.internal";
        } catch {}
        selfUrl = \`http://\${host}:\${actualPort}\`;
      }

      // B3. Ensure admin auth for app settings (bot tokens can't manage apps)
      // On first run: pendingBotAuth is set but identity switch hasn't happened yet — client still has admin auth.
      // On subsequent runs: client has bot token from env — need temp admin login.
      const needsAdminLogin = !pendingBotAuth && process.env.ROCKETCHAT_AUTH_TOKEN;
      let botTokenBackup = process.env.ROCKETCHAT_AUTH_TOKEN || "";
      let botUserIdBackup = process.env.ROCKETCHAT_USER_ID || "";
      if (needsAdminLogin) {
        const adminUser = process.env.ROCKETCHAT_USER || "";
        const adminPass = process.env.ROCKETCHAT_PASSWORD || "";
        if (adminUser && adminPass) {
          try {
            const loginRes = await fetch(\`\${process.env.ROCKETCHAT_URL || "http://localhost:3000"}/api/v1/login\`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ user: adminUser, password: adminPass }),
            });
            const loginData = await loginRes.json();
            if (loginRes.ok && loginData.data?.authToken) {
              client.setAuth(loginData.data.authToken, loginData.data.userId);
              console.error("[Auto-config] Temporary admin login for app settings.");
            } else {
              console.error("[Auto-config] Admin login failed — app settings may not update.");
            }
          } catch {}
        }
      }

      const curSettings = await client.request("GET", \`/api/apps/\${appId}/settings\`, { auth: true });
      if (curSettings.isError) {
        console.error(\`[Auto-config] Could not read app settings (is the RC App deployed?): \${curSettings.content[0]?.text}\`);
        return;
      }
      const curData = JSON.parse(curSettings.content[0]?.text || "{}");

      const settingsToUpdate: { id: string; value: string }[] = [];

      // mcp_server_url
      const curUrl = curData.settings?.mcp_server_url?.value || curData.settings?.mcp_server_url?.packageValue || "";
      if (curUrl !== selfUrl) {
        settingsToUpdate.push({ id: "mcp_server_url", value: selfUrl });
      }

      // bot_username — set to the bot user so the RC App skips its messages
      const botUser = BOT_USERNAME;
      const curBotUser = curData.settings?.bot_username?.value || curData.settings?.bot_username?.packageValue || "";
      if (curBotUser !== botUser) {
        settingsToUpdate.push({ id: "bot_username", value: botUser });
      }

      if (settingsToUpdate.length === 0) {
        console.error("[Auto-config] All settings up to date.");
      } else {
        const updateRes = await client.request("POST", \`/api/apps/\${appId}/settings\`, {
          auth: true,
          body: { settings: settingsToUpdate },
        });
        if (!updateRes.isError) {
          for (const s of settingsToUpdate) {
            console.error(\`[Auto-config] Updated \${s.id} to \${s.value}\`);
          }
        } else {
          console.error(\`[Auto-config] Failed to update settings: \${updateRes.content[0]?.text}\`);
        }
      }

      // ── Final: Switch to bot identity ──────────────────────────────────
      if (pendingBotAuth) {
        client.setAuth(pendingBotAuth.token, pendingBotAuth.userId);
        console.error(\`[Auto-config] Switched to bot identity: \${BOT_USERNAME} (userId: \${pendingBotAuth.userId}, token: \${pendingBotAuth.token.slice(0, 8)}...)\`);
      } else if (needsAdminLogin && botTokenBackup) {
        // Restore bot identity after temporary admin login for Phase B
        client.setAuth(botTokenBackup, botUserIdBackup);
        console.error("[Auto-config] Restored bot identity after app settings update.");
      }
    } catch (e) {
      console.error(\`[Auto-config] Could not auto-configure: \${e instanceof Error ? e.message : e}\`);
    }
  })();
  } // end runAutoConfig
`
    : ""
}
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
