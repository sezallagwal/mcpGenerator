import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listEndpoints,
  getFullEndpoints,
  getAvailableDomains,
} from "./mcp-server/parser/index.js";
import {
  generateRestClientCode,
  generateMcpServerPackageJson,
  generateMcpServerTsConfig,
  generateMcpServerEnvExample,
  generateTestSetupCode,
  generateToolTestCode,
  generateMcpServerReadme,
} from "./mcp-server/mcpServerTemplates.js";

import {
  generateWorkflowToolCode,
  generateMcpServerEntryCode,
  generateWorkflowReadme,
} from "./mcp-server/mcpServerCodegen.js";
import {
  composeWorkflowDefinition,
  ComposerError,
} from "./mcp-server/workflowComposer.js";
import type { WorkflowDefinition } from "./mcp-server/types.js";
import { injectEnsureChannelSteps } from "./mcp-server/ensureChannelInjector.js";
import { generateRcAppProject } from "./rc-app/rcAppGenerator.js";
import { getCapabilities } from "./rc-app/parser.js";
import { toPascalCase } from "./utils.js";
import {
  formatCapabilityGuide,
  formatAppEventsGuide,
  getEventParamName,
  getEventShapes,
} from "./capability-guide.js";

function shapeToJsonSchema(
  shape: Record<string, unknown>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(shape)) {
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      props[key.replace(/\?$/, "")] = {
        type: "object",
        properties: shapeToJsonSchema(val as Record<string, unknown>),
      };
    } else {
      props[key.replace(/\?$/, "")] = { type: "string" };
    }
  }
  return props;
}

function deriveEventParamsSchema(
  eventInterfaceNames: string[],
  persistence?: { stateParam: string },
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const shapes = getEventShapes(eventInterfaceNames);
  for (const ifaceName of eventInterfaceNames) {
    const paramName = getEventParamName(ifaceName);
    if (paramName && !properties[paramName]) {
      const shapeEntry = shapes[ifaceName];
      const shapeObj = shapeEntry?.[paramName];
      if (shapeObj && typeof shapeObj === "object") {
        properties[paramName] = {
          type: "object",
          description: `Event data from ${ifaceName}`,
          properties: shapeToJsonSchema(shapeObj as Record<string, unknown>),
        };
      } else {
        properties[paramName] = {
          type: "object",
          description: `Event data from ${ifaceName}`,
        };
      }
    }
  }
  if (persistence?.stateParam) {
    properties[persistence.stateParam] = {
      type: "object",
      description: "Persisted state",
    };
  }
  return {
    type: "object" as const,
    properties,
  };
}

function getAcceptedFields(schema: Record<string, unknown>): Set<string> {
  const fields = new Set<string>();

  const variants = (schema.oneOf ?? schema.anyOf) as
    | Record<string, unknown>[]
    | undefined;
  if (variants) {
    for (const v of variants) {
      const props = v.properties as Record<string, unknown> | undefined;
      if (props) {
        for (const key of Object.keys(props)) fields.add(key);
      }
    }
    return fields;
  }

  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return fields;

  for (const key of Object.keys(props)) {
    fields.add(key);
  }

  return fields;
}

const server = new McpServer({
  name: "mcp-generator",
  version: "0.1.0",
});

server.registerTool(
  "get_capability_guide",
  {
    description:
      "Returns ALL Rocket.Chat API endpoints (with operationIds) and App event interfaces in one guide. " +
      "This is the discovery tool — call it FIRST. " +
      "API entries show 'summary → operationId' — use operationIds in workflow steps. " +
      "App Events section lists realtime event interfaces — pick them for generate's eventInterfaces when the prompt describes a trigger ('when X happens'). " +
      "After picking ALL needed operationIds and eventInterfaces, call get_endpoint_schemas ONCE with ALL of them in a single call BEFORE writing workflows.",
    inputSchema: {},
  },
  async () => {
    try {
      const endpoints = await listEndpoints(getAvailableDomains());
      const guide = formatCapabilityGuide(endpoints) + formatAppEventsGuide();
      return {
        content: [{ type: "text" as const, text: guide }],
      };
    } catch (err) {
      const domains = getAvailableDomains();
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Failed to generate capability guide: ${err instanceof Error ? err.message : String(err)}\n\n` +
              `Available domains: ${domains.join(", ")}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "get_endpoint_schemas",
  {
    description:
      "Get exact request body schemas, response schemas, and event param shapes for chosen operationIds and eventInterfaces. " +
      "Call this AFTER get_capability_guide, BEFORE generate. " +
      "IMPORTANT: Pass ALL operationIds you need in a SINGLE call — do NOT split across multiple calls. There is no limit on array size. " +
      "Returns the exact nested structure for each endpoint's request and response, " +
      "plus event param shapes so you can write inputMappings with exact field names. " +
      "Use the response schema to know the exact shape of step results (for {{steps.X.result.Y}} references).",
    inputSchema: {
      operationIds: z.array(z.string()),
      eventInterfaces: z.array(z.string()).optional(),
    },
  },
  async ({ operationIds, eventInterfaces }) => {
    try {
      const mirrorIds = new Set<string>();
      for (const id of operationIds) {
        if (id.includes("channels")) mirrorIds.add(id.replace("channels", "groups"));
        else if (id.includes("groups")) mirrorIds.add(id.replace("groups", "channels"));
      }
      const expandedIds = [...new Set([...operationIds, ...mirrorIds])];
      const endpoints = await getFullEndpoints(expandedIds);

      const schemas: Record<string, Record<string, unknown>> = {};
      for (const ep of endpoints) {
        const entry: Record<string, unknown> = {
          method: ep.method,
          path: ep.path,
        };
        const isProps = (ep.inputSchema as Record<string, unknown>)?.properties as
          | Record<string, unknown>
          | undefined;
        if (isProps?.requestBody) {
          entry.requestBody = isProps.requestBody;
        } else if (isProps && Object.keys(isProps).length > 0) {
          entry.queryParameters = ep.inputSchema;
        }
        if (ep.responseSchema) {
          entry.response = ep.responseSchema;
        }
        schemas[ep.operationId] = entry;
      }

      const matched = new Set(endpoints.map((e) => e.operationId));
      const unmatched = operationIds.filter((id) => !matched.has(id));

      const result: Record<string, unknown> = { endpoints: schemas };

      if (unmatched.length > 0) {
        result.unmatchedOperationIds = unmatched;
      }

      if (eventInterfaces && eventInterfaces.length > 0) {
        result.eventShapes = getEventShapes(eventInterfaces);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get endpoint schemas: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "generate",
  {
    description:
      "Generate a complete linked project: an MCP Server (workflow tools) and optionally an RC App (realtime event handlers). " +
      "Each workflow becomes one tool that chains API calls, AI reasoning (sampling), and user confirmation (elicitation). " +
      "If eventInterfaces are provided, an RC App is ALSO generated alongside, pre-wired via an HTTP bridge. " +
      "Output: a monorepo under projects/<projectName>/ with mcp-server/ (always) and rc-app/ (if events needed). " +
      "Call ONCE with ALL workflows complete. See GEMINI.md for full schema and examples.",
    inputSchema: {
      projectName: z.string(),
      description: z.string(),
      workflows: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          params: z.record(z.string(), z.any()).optional(),
          steps: z.array(
            z.object({
              id: z.string(),
              label: z.string().optional(),
              type: z.enum([
                "api_call",
                "transform",
                "sampling",
                "conditional",
                "elicitation",
              ]),
              dependsOn: z.array(z.string()).optional(),
              operationId: z.string().optional(),
              inputMapping: z.record(z.string(), z.any()).optional(),
              continueOnError: z.boolean().optional(),
              outputPath: z.string().optional(),
              forEach: z.string().optional(),
              as: z.string().optional(),
              prompt: z.string().optional(),
              systemPrompt: z.string().optional(),
              maxTokens: z.number().optional(),
              message: z.string().optional(),
              requestedSchema: z.record(z.string(), z.any()).optional(),
              expression: z.string().optional(),
              condition: z.string().optional(),
              thenStep: z.string().optional(),
              elseStep: z.string().optional(),
            }),
          ),
          persistence: z
            .object({
              model: z.enum(["user", "room", "misc"]),
              keyPath: z.string(),
              stateParam: z.string(),
              defaultState: z.record(z.string(), z.any()),
              updateFromStep: z.string().optional(),
            })
            .optional(),
        }),
      ),
      eventInterfaces: z.array(z.string()).optional(),
      webhookEndpoints: z
        .array(
          z.object({
            path: z.string(),
            description: z.string(),
            methods: z.array(z.enum(["get", "post"])),
          }),
        )
        .optional(),
      extraCommands: z
        .array(
          z.object({
            command: z.string(),
            description: z.string(),
            workflowName: z.string().optional(),
          }),
        )
        .optional(),
    },
  },
  async ({
    projectName,
    description: projectDescription,
    workflows: rawWorkflows,
    eventInterfaces: eventInterfaceNames,
    webhookEndpoints,
    extraCommands,
  }) => {
    try {
      if (!rawWorkflows || rawWorkflows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide at least one workflow via 'workflows'.",
            },
          ],
          isError: true,
        };
      }

      const needsRcApp = eventInterfaceNames && eventInterfaceNames.length > 0;

      const workflowDefs: WorkflowDefinition[] = [];
      const allComposerWarnings: string[] = [];
      for (const raw of rawWorkflows) {
        try {
          let effectiveParams = raw.params as
            | Record<string, unknown>
            | undefined;
          if (needsRcApp) {
            const derived = deriveEventParamsSchema(
              eventInterfaceNames!,
              raw.persistence as { stateParam: string } | undefined,
            );
            if (raw.params && Object.keys(raw.params).length > 0) {
              allComposerWarnings.push(
                `[${raw.name}] Workflow declared params schema was overridden with event-derived schema. ` +
                  `Handler passes { ${Object.keys((derived as any).properties).join(", ")} }, not the declared schema.`,
              );
            }
            effectiveParams = derived;
          }

          const result = composeWorkflowDefinition({
            name: raw.name,
            description: raw.description,
            params: (effectiveParams ?? {
              type: "object",
              properties: {},
            }) as any,
            steps: (raw.steps as any[]).map((s: any) => {
              const { id, label, type, dependsOn, ...rest } = s;
              const config: Record<string, unknown> = { type };
              for (const [k, v] of Object.entries(rest)) {
                if (v !== undefined) config[k] = v;
              }
              const effectiveLabel =
                label ??
                id
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c: string) => c.toUpperCase());
              return {
                id,
                label: effectiveLabel,
                config: config as any,
                ...(dependsOn ? { dependsOn } : {}),
              };
            }),
            persistence: raw.persistence as any,
          });
          workflowDefs.push(result.workflow);
          for (const w of result.warnings) {
            allComposerWarnings.push(`[${raw.name}] ${w.message}`);
          }
        } catch (err) {
          const msg =
            err instanceof ComposerError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Workflow "${raw.name}" composition failed: ${msg}`,
              },
            ],
            isError: true,
          };
        }
      }

      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectName)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "projectName must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.",
            },
          ],
          isError: true,
        };
      }

      const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
      const projectDir = join(extensionRoot, "projects", projectName);
      const mcpServerDir = join(projectDir, "mcp-server");
      const rcAppDir = join(projectDir, "rc-app");

      for (const wf of workflowDefs) {
        injectEnsureChannelSteps(wf);
      }

      const allEndpointIds = new Set<string>();
      for (const wf of workflowDefs) {
        for (const epId of wf.requiredEndpoints) {
          allEndpointIds.add(epId);
        }
      }

      const endpoints = await getFullEndpoints([...allEndpointIds]);

      const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, "-");
      const specIdByNorm = new Map(
        endpoints.map((ep) => [normalize(ep.operationId), ep.operationId]),
      );
      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type === "api_call") {
            const cfg = step.config as { operationId: string };
            const exact = specIdByNorm.get(normalize(cfg.operationId));
            if (exact && exact !== cfg.operationId) {
              cfg.operationId = exact;
            }
          }
        }
        wf.requiredEndpoints = wf.requiredEndpoints.map(
          (id) => specIdByNorm.get(normalize(id)) ?? id,
        );
      }

      const resolvedIds = new Set(endpoints.map((ep) => ep.operationId));
      const unresolvedErrors: string[] = [];
      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type === "api_call") {
            const cfg = step.config as { operationId: string };
            if (!resolvedIds.has(cfg.operationId)) {
              const suggestions = [...resolvedIds]
                .filter((id) => {
                  const norm = normalize(cfg.operationId);
                  const normId = normalize(id);
                  return (
                    normId.includes(norm.split("-").slice(-1)[0]) ||
                    norm.includes(normId.split("-").slice(-1)[0])
                  );
                })
                .slice(0, 3);
              const hint =
                suggestions.length > 0
                  ? ` Did you mean: ${suggestions.join(", ")}?`
                  : " Use get_endpoint_schemas to verify operationIds.";
              unresolvedErrors.push(
                `Workflow "${wf.name}", step "${step.id}": operationId "${cfg.operationId}" not found in any RC API spec.${hint}`,
              );
            }
          }
        }
      }

      if (unresolvedErrors.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unresolved operationIds:\n\n${unresolvedErrors.join("\n\n")}\n\nCall get_endpoint_schemas with the correct operationIds from get_capability_guide.`,
            },
          ],
          isError: true,
        };
      }

      const epById = new Map(endpoints.map((ep) => [ep.operationId, ep]));

      const CHANNEL_GROUP_PAIRS: Record<string, string> = {
        "post-api-v1-channels_create": "post-api-v1-groups_create",
        "post-api-v1-channels_invite": "post-api-v1-groups_invite",
        "get-api-v1-channels_info":    "get-api-v1-groups_info",
        "post-api-v1-channels_join":   "post-api-v1-groups_invite",
        "post-api-v1-groups_create":   "post-api-v1-channels_create",
        "post-api-v1-groups_invite":   "post-api-v1-channels_invite",
        "get-api-v1-groups_info":      "get-api-v1-channels_info",
      };

      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type !== "api_call") continue;
          const cfg = step.config as { operationId: string; inputMapping?: Record<string, unknown> };
          if (!cfg.inputMapping) continue;
          const mapping = cfg.inputMapping;
          const typeVal = typeof mapping.type === "string" ? mapping.type.toLowerCase() : "";
          if (!typeVal) continue;

          const isChannelOp = cfg.operationId.includes("channels_");
          const isGroupOp = cfg.operationId.includes("groups_");
          const wantsPrivate = typeVal === "p" || typeVal === "private";
          const wantsPublic = typeVal === "c" || typeVal === "public";

          if (isChannelOp && wantsPrivate && CHANNEL_GROUP_PAIRS[cfg.operationId]) {
            cfg.operationId = CHANNEL_GROUP_PAIRS[cfg.operationId];
            delete mapping.type;
          } else if (isGroupOp && wantsPublic && CHANNEL_GROUP_PAIRS[cfg.operationId]) {
            cfg.operationId = CHANNEL_GROUP_PAIRS[cfg.operationId];
            delete mapping.type;
          }
        }
      }

      const validationErrors: string[] = [];
      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type !== "api_call") continue;
          const cfg = step.config as {
            operationId: string;
            inputMapping?: Record<string, unknown>;
          };

          const ep = epById.get(cfg.operationId);
          if (!ep) continue;

          const schema = (ep.requestBody?.schema ?? ep.inputSchema) as
            | Record<string, unknown>
            | undefined;
          if (!schema) continue;

          const schemaFields = getAcceptedFields(schema);
          if (schemaFields.size === 0) continue;

          const mappingKeys = new Set(
            cfg.inputMapping ? Object.keys(cfg.inputMapping) : [],
          );

          const unknown = [...mappingKeys].filter((k) => !schemaFields.has(k));
          if (unknown.length > 0) {
            const expected = [...schemaFields].join(", ");
            validationErrors.push(
              `Workflow "${wf.name}", step "${step.id}": field(s) [${unknown.join(", ")}] not found in ${cfg.operationId} schema. Expected fields: ${expected}`,
            );
          }

          const required = (schema.required ?? []) as string[];
          const missing = required.filter((f) => !mappingKeys.has(f));
          if (missing.length > 0) {
            validationErrors.push(
              `Workflow "${wf.name}", step "${step.id}": required field(s) [${missing.join(", ")}] missing from inputMapping for ${cfg.operationId}. ` +
                `Add them to inputMapping using {{params.*}} or {{steps.*}} references.`,
            );
          }
        }
      }

      if (validationErrors.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Input mapping validation failed:\n\n${validationErrors.join("\n\n")}\n\nFix the field names and try again.`,
            },
          ],
          isError: true,
        };
      }

      const hasAuth = endpoints.some(
        (ep) =>
          ep.security.length > 0 ||
          ep.parameters.some((p) => p.name === "X-Auth-Token"),
      );
      const hasLogin = endpoints.some(
        (ep) => ep.operationId === "post-api-v1-login",
      );
      if (hasAuth && !hasLogin) {
        const [loginEp] = await getFullEndpoints(["post-api-v1-login"]);
        if (loginEp) endpoints.unshift(loginEp);
      }

      const serverName = projectName;
      const mcpFiles: Record<string, string> = {
        "src/server.ts": generateMcpServerEntryCode(
          serverName,
          workflowDefs,
          endpoints,
          { bridged: !!needsRcApp },
        ),
        "src/rc-client.ts": generateRestClientCode(),
        "package.json": generateMcpServerPackageJson(serverName),
        "tsconfig.json": generateMcpServerTsConfig(),
        ".env.example": generateMcpServerEnvExample({
          bridged: !!needsRcApp,
          usesSampling: workflowDefs.some((w) => w.usesSampling),
        }),
        ".env": generateMcpServerEnvExample({
          bridged: !!needsRcApp,
          usesSampling: workflowDefs.some((w) => w.usesSampling),
        }),
        "src/tests/setup.ts": generateTestSetupCode(
          workflowDefs.map((wf) => wf.name),
        ),
        "README.md":
          generateMcpServerReadme(serverName, endpoints) +
          generateWorkflowReadme(workflowDefs),
      };

      for (const wf of workflowDefs) {
        mcpFiles[`src/tools/${wf.name}.ts`] = generateWorkflowToolCode(wf);
        mcpFiles[`src/tests/${wf.name}.test.ts`] = generateToolTestCode(wf);
      }

      mkdirSync(join(mcpServerDir, "src", "tools"), { recursive: true });
      mkdirSync(join(mcpServerDir, "src", "tests"), { recursive: true });
      mkdirSync(join(mcpServerDir, "src", "engine"), { recursive: true });

      for (const [filePath, content] of Object.entries(mcpFiles)) {
        writeFileSync(join(mcpServerDir, filePath), content, "utf-8");
      }

      const engineSrc = join(
        dirname(fileURLToPath(import.meta.url)),
        "mcp-server",
        "workflow-engine.ts",
      );
      const engineDest = join(
        mcpServerDir,
        "src",
        "engine",
        "workflow-engine.ts",
      );
      writeFileSync(engineDest, readFileSync(engineSrc, "utf-8"), "utf-8");

      let rcAppResult:
        | import("./rc-app/rcAppGenerator.js").GenerateRcAppResult
        | null = null;

      if (needsRcApp) {
        const resolvedInterfaces =
          eventInterfaceNames && eventInterfaceNames.length > 0
            ? getCapabilities(eventInterfaceNames)
            : [];

        if (eventInterfaceNames && eventInterfaceNames.length > 0) {
          const found = new Set(resolvedInterfaces.map((c) => c.interfaceName));
          const notFound = eventInterfaceNames.filter((n) => !found.has(n));
          if (notFound.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Unknown event interfaces: ${notFound.join(", ")}.\nCheck the App Events section from get_capability_guide for available interfaces.`,
                },
              ],
              isError: true,
            };
          }
        }

        const defaultToolName = workflowDefs[0].name;
        const eventWorkflowMap: Record<string, string> = {};
        for (const iface of resolvedInterfaces) {
          eventWorkflowMap[iface.interfaceName] = defaultToolName;
        }

        const workflowNames = new Set(workflowDefs.map((wf) => wf.name));
        const validExtraCommands = (extraCommands ?? []).filter((cmd) => {
          if (/api[-_]v\d/i.test(cmd.command)) return false;
          if (cmd.workflowName && !workflowNames.has(cmd.workflowName))
            return false;
          return true;
        });

        rcAppResult = generateRcAppProject({
          appName: projectName,
          description: projectDescription,
          outputDir: projectDir,
          projectDirOverride: rcAppDir,
          workflows: workflowDefs,
          extraCommands: validExtraCommands,
          webhookEndpoints,
          eventInterfaces: resolvedInterfaces,
          eventWorkflowMap,
        });
      }

      try {
        console.error(`[npm] Installing mcp-server dependencies…`);
        execSync("npm install --silent", { cwd: mcpServerDir, stdio: "pipe" });
        console.error(`[npm] mcp-server dependencies installed.`);
      } catch (err) {
        console.error(
          `[npm] mcp-server install failed: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (needsRcApp) {
        try {
          console.error(`[npm] Installing rc-app dependencies…`);
          execSync("npm install --silent", { cwd: rcAppDir, stdio: "pipe" });
          console.error(`[npm] rc-app dependencies installed.`);
        } catch (err) {
          console.error(
            `[npm] rc-app install failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      let geminiLinked = false;
      try {
        const mcpServerName = projectName.replace(/_/g, "-");
        const settingsPath = join(
          process.env.HOME || process.env.USERPROFILE || "~",
          ".gemini",
          "settings.json",
        );
        let settings: Record<string, any> = {};
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        } catch {}
        if (!settings.mcpServers) settings.mcpServers = {};
        settings.mcpServers[mcpServerName] = {
          command: "node",
          args: [
            "--env-file-if-exists=.env",
            "--import",
            "tsx",
            "src/server.ts",
          ],
          cwd: mcpServerDir,
        };
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        geminiLinked = true;
      } catch {
        // Non-fatal — user can link manually
      }

      const wfFeatures: string[] = [];
      if (workflowDefs.some((w) => w.usesSampling)) wfFeatures.push("sampling");
      if (workflowDefs.some((w) => w.usesElicitation))
        wfFeatures.push("elicitation");

      const wfTable = workflowDefs
        .map((w) => {
          const badges =
            [
              w.usesSampling ? "AI" : "",
              w.usesElicitation ? "Human-in-loop" : "",
            ]
              .filter(Boolean)
              .join(", ") || "Pure automation";
          return `    ${w.name} (${w.steps.length} steps, ${badges})`;
        })
        .join("\n");

      const treeLines = [
        `${projectName}/`,
        `├── mcp-server/`,
        `│   ├── src/server.ts       (MCP server — stdio transport)`,
        `│   ├── src/rc-client.ts    (RC REST API client)`,
        `│   ├── src/tools/          (${workflowDefs.length} workflow tools)`,
        `│   ├── package.json`,
        `│   ├── .env.example`,
        `│   └── .env               (fill in your credentials)`,
      ];

      if (rcAppResult) {
        treeLines.push(`├── rc-app/`);
        treeLines.push(`│   ├── ${toPascalCase(projectName)}App.ts`);
        if (rcAppResult.commands.length > 0)
          treeLines.push(
            `│   ├── commands/          (${rcAppResult.commands.length} slash commands)`,
          );
        if (rcAppResult.eventInterfaces.length > 0)
          treeLines.push(
            `│   ├── handlers/          (${rcAppResult.eventInterfaces.join(", ")})`,
          );
        treeLines.push(
          `│   ├── bridge/            (HTTP bridge → mcp-server)`,
          `│   └── package.json`,
        );
      }

      const tree = treeLines.filter(Boolean).join("\n  ");

      const summaryParts = [
        `Project "${projectName}" created at: ${projectDir}`,
        ``,
        `Workflows:`,
        wfTable,
        ``,
        `  ${tree}`,
        ``,
        `MCP Server:`,
        `  Workflow tools: ${workflowDefs.length}`,
        `  Capabilities: tools${wfFeatures.map((f) => `, ${f}`).join("")}`,
        `  Files: ${Object.keys(mcpFiles).length}`,
      ];

      if (rcAppResult) {
        summaryParts.push(
          ``,
          `RC App (bridged to MCP Server):`,
          `  Event interfaces: ${rcAppResult.eventInterfaces.join(", ") || "none"}`,
          `  Slash commands: ${rcAppResult.commands.join(", ") || "none"}`,
          `  Webhooks: ${rcAppResult.webhooks.join(", ") || "none"}`,
          `  Files: ${rcAppResult.filesWritten}`,
        );
      }

      if (geminiLinked) {
        summaryParts.push(
          ``,
          `Gemini CLI:`,
          `  ✓ Auto-registered as "${projectName.replace(/_/g, "-")}" in ~/.gemini/settings.json`,
          `  The MCP server will be available as a Gemini CLI tool on next session.`,
        );
      }

      summaryParts.push(
        ``,
        `Setup:`,
        `  ✓ npm install already ran for mcp-server${rcAppResult ? " and rc-app" : ""}`,
        `  Edit ${mcpServerDir}/.env with your Rocket.Chat credentials`,
        `  # Then restart Gemini CLI — the MCP server will authenticate automatically`,
      );

      if (rcAppResult) {
        summaryParts.push(
          ``,
          `  # Deploy the RC App`,
          `  cd ${rcAppDir}`,
          `  rc-apps deploy --url http://localhost:3000 -u admin -p admin`,
        );
      }

      if (allComposerWarnings.length > 0) {
        summaryParts.push(
          ``,
          `ℹ️  Composer Notes (${allComposerWarnings.length} — all auto-resolved, no action needed):`,
        );
        for (const w of allComposerWarnings) {
          summaryParts.push(`  ${w}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: summaryParts.join("\n") }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Generation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
