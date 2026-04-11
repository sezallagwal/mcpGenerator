import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listEndpoints,
  getFullEndpoints,
  getLastCorrectedIds,
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
import { formatCapabilityGuide } from "./capability-guide.js";
import { parseDsl } from "./dsl/parseDsl.js";

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
      "Returns ALL Rocket.Chat API endpoints (with operationIds) in one guide. " +
      "This is the discovery tool — call it FIRST. " +
      "API entries show 'summary → operationId' — use operationIds in workflow steps. " +
      "After picking ALL needed operationIds, call get_endpoint_schemas ONCE with ALL of them in a single call BEFORE writing workflows.",
    inputSchema: {},
  },
  async () => {
    try {
      const endpoints = await listEndpoints(getAvailableDomains());
      const guide = formatCapabilityGuide(endpoints);
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
      "Get exact request/response schemas for chosen operationIds. " +
      "Call this AFTER get_capability_guide, BEFORE writing your DSL for generate. " +
      "IMPORTANT: Pass ALL operationIds you need in a SINGLE call — do NOT split across multiple calls. There is no limit on array size. " +
      "Returns request body schemas (exact field names for inputMapping) and response shape summaries (for {{steps.X.result.Y}} references). " +
      "If you need both channels_* and groups_* variants, request both explicitly.",
    inputSchema: {
      operationIds: z.array(z.string()),
    },
  },
  async ({ operationIds }) => {
    try {
      const endpoints = await getFullEndpoints(operationIds, undefined, 5);

      const schemas: Record<string, Record<string, unknown>> = {};
      for (const ep of endpoints) {
        const entry: Record<string, unknown> = {
          method: ep.method,
          path: ep.path,
        };
        const isProps = (ep.inputSchema as Record<string, unknown>)
          ?.properties as Record<string, unknown> | undefined;
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

      // Enrich ambiguous schema fields with domain knowledge
      const chCreate = schemas["post-api-v1-channels_create"];
      if (chCreate) {
        const chProps = (chCreate.requestBody as any)?.properties;
        if (chProps?.members) {
          chProps.members.description =
            "An array of usernames (NOT user IDs) to add to the channel. " +
            'Use sender.username, not sender.id. Example: ["john.doe"]';
        }
      }

      const matched = new Set(endpoints.map((e) => e.operationId));
      const corrected = getLastCorrectedIds();
      const unmatched = operationIds.filter(
        (id) => !matched.has(id) && !corrected.has(id),
      );

      const result: Record<string, unknown> = { endpoints: schemas };

      if (corrected.size > 0) {
        result.correctedOperationIds = Object.fromEntries(corrected);
      }
      if (unmatched.length > 0) {
        result.unmatchedOperationIds = unmatched;
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
      "Generate a complete MCP server project from a DSL definition. " +
      "Each workflow becomes one tool that chains API calls, AI reasoning (sampling), and user confirmation (elicitation). " +
      "Output: a project under projects/<projectName>/mcp-server/ with stdio transport. " +
      "Call ONCE with the complete DSL.",
    inputSchema: {
      dsl: z
        .string()
        .describe(
          "Complete project definition in DSL format. See system instructions for DSL syntax.",
        ),
    },
  },
  async ({ dsl }) => {
    try {
      let parsed;
      try {
        parsed = parseDsl(dsl);
      } catch (parseErr) {
        return {
          content: [
            {
              type: "text" as const,
              text: `DSL parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            },
          ],
          isError: true,
        };
      }

      const {
        projectName,
        description: projectDescription,
        workflows: rawWorkflows,
      } = parsed;

      if (!rawWorkflows || rawWorkflows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide at least one workflow in the DSL.",
            },
          ],
          isError: true,
        };
      }

      const allComposerWarnings: string[] = [];

      const workflowDefs: WorkflowDefinition[] = [];
      for (const raw of rawWorkflows) {
        try {
          const effectiveParams = raw.params ?? {
            type: "object",
            properties: {},
          };

          const result = composeWorkflowDefinition({
            name: raw.name,
            description: raw.description,
            params: effectiveParams as any,
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

      // Levenshtein helper for fuzzy operationId matching in generate
      const lev = (a: string, b: string): number => {
        const m = a.length,
          n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
          const curr = [i];
          for (let j = 1; j <= n; j++) {
            curr[j] =
              a[i - 1] === b[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
          }
          prev = curr;
        }
        return prev[n];
      };

      const resolvedIds = new Set(endpoints.map((ep) => ep.operationId));
      const unresolvedErrors: string[] = [];
      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type === "api_call") {
            const cfg = step.config as { operationId: string };
            if (!resolvedIds.has(cfg.operationId)) {
              // Tier 3: Levenshtein fuzzy match (distance ≤ 2)
              const normCfg = normalize(cfg.operationId).replace(/[_-]/g, "");
              let bestMatch = "";
              let bestDist = 3; // threshold + 1
              for (const id of resolvedIds) {
                const d = lev(normCfg, normalize(id).replace(/[_-]/g, ""));
                if (d < bestDist) {
                  bestDist = d;
                  bestMatch = id;
                }
              }
              if (bestMatch) {
                allComposerWarnings.push(
                  `[${wf.name}] Auto-corrected operationId: "${cfg.operationId}" → "${bestMatch}" (Levenshtein distance ${bestDist})`,
                );
                cfg.operationId = bestMatch;
              } else {
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
        "get-api-v1-channels_info": "get-api-v1-groups_info",
        "post-api-v1-channels_join": "post-api-v1-groups_invite",
        "post-api-v1-groups_create": "post-api-v1-channels_create",
        "post-api-v1-groups_invite": "post-api-v1-channels_invite",
        "get-api-v1-groups_info": "get-api-v1-channels_info",
      };

      for (const wf of workflowDefs) {
        for (const step of wf.steps) {
          if (step.config.type !== "api_call") continue;
          const cfg = step.config as {
            operationId: string;
            inputMapping?: Record<string, unknown>;
          };
          if (!cfg.inputMapping) continue;
          const mapping = cfg.inputMapping;
          const typeVal =
            typeof mapping.type === "string" ? mapping.type.toLowerCase() : "";
          if (!typeVal) continue;

          const isChannelOp = cfg.operationId.includes("channels_");
          const isGroupOp = cfg.operationId.includes("groups_");
          const wantsPrivate = typeVal === "p" || typeVal === "private";
          const wantsPublic = typeVal === "c" || typeVal === "public";

          if (
            isChannelOp &&
            wantsPrivate &&
            CHANNEL_GROUP_PAIRS[cfg.operationId]
          ) {
            cfg.operationId = CHANNEL_GROUP_PAIRS[cfg.operationId];
            delete mapping.type;
          } else if (
            isGroupOp &&
            wantsPublic &&
            CHANNEL_GROUP_PAIRS[cfg.operationId]
          ) {
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
            allComposerWarnings.push(
              `[${wf.name}] Step "${step.id}": field(s) [${unknown.join(", ")}] not in ${cfg.operationId} schema (expected: ${expected}). ` +
                `Unknown fields are passed through — the API will ignore them.`,
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
        ),
        "src/rc-client.ts": generateRestClientCode(),
        "package.json": generateMcpServerPackageJson(serverName),
        "tsconfig.json": generateMcpServerTsConfig(),
        ".env.example": generateMcpServerEnvExample({
          usesSampling: workflowDefs.some((w) => w.usesSampling),
        }),
        ".env": generateMcpServerEnvExample({
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

      // Generate .vscode/mcp.json for VS Code Copilot
      let vscodeMcpLinked = false;
      try {
        const mcpServerName = projectName.replace(/_/g, "-");
        const vscodeMcpDir = join(projectDir, ".vscode");
        mkdirSync(vscodeMcpDir, { recursive: true });
        const vscodeMcpConfig = {
          servers: {
            [mcpServerName]: {
              command: "node",
              args: [
                "--env-file-if-exists=.env",
                "--import",
                "tsx",
                "src/server.ts",
              ],
              cwd: join(projectDir, "mcp-server"),
            },
          },
        };
        writeFileSync(
          join(vscodeMcpDir, "mcp.json"),
          JSON.stringify(vscodeMcpConfig, null, 2) + "\n",
          "utf-8",
        );
        vscodeMcpLinked = true;
      } catch {
        // Non-fatal
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
        `├── .vscode/mcp.json        (VS Code Copilot MCP config)`,
        `├── mcp-server/`,
        `│   ├── src/server.ts       (MCP server — stdio transport)`,
        `│   ├── src/rc-client.ts    (RC REST API client)`,
        `│   ├── src/tools/          (${workflowDefs.length} workflow tools)`,
        `│   ├── package.json`,
        `│   ├── .env.example`,
        `│   └── .env               (fill in your credentials)`,
      ];

      const tree = treeLines.filter(Boolean).join("\n  ");

      // Build detailed notes for the user (written to file)
      const detailParts = [
        `# Generation Notes — ${projectName}`,
        ``,
        `**Created at:** ${projectDir}`,
        ``,
        `## Workflows`,
        wfTable,
        ``,
        `## Project Structure`,
        `  ${tree}`,
        ``,
        `## MCP Server`,
        `  Workflow tools: ${workflowDefs.length}`,
        `  Capabilities: tools${wfFeatures.map((f) => `, ${f}`).join("")}`,
        `  Files: ${Object.keys(mcpFiles).length}`,
      ];

      if (geminiLinked) {
        detailParts.push(
          ``,
          `## Gemini CLI`,
          `  ✓ Auto-registered as "${projectName.replace(/_/g, "-")}" in ~/.gemini/settings.json`,
          `  The MCP server will be available as a Gemini CLI tool on next session.`,
        );
      }

      if (vscodeMcpLinked) {
        detailParts.push(
          ``,
          `## VS Code Copilot`,
          `  ✓ Generated .vscode/mcp.json — open this project in VS Code to use the MCP tools.`,
        );
      }

      detailParts.push(
        ``,
        `## Setup`,
        `  ✓ .env pre-populated from .env.example`,
        `  Run \`npm install\` in mcp-server/`,
      );

      if (allComposerWarnings.length > 0) {
        detailParts.push(
          ``,
          `## Composer Notes (${allComposerWarnings.length} — all auto-resolved, no action needed)`,
          ...allComposerWarnings.map((w) => `- ${w}`),
        );
      }

      // Write full details to GENERATION_NOTES.md for the user
      writeFileSync(
        join(projectDir, "GENERATION_NOTES.md"),
        detailParts.join("\n"),
        "utf-8",
      );

      // Return terse summary to LLM to avoid post-generate echoing
      const totalFiles =
        Object.keys(mcpFiles).length + 1 + (vscodeMcpLinked ? 1 : 0); // +1 for GENERATION_NOTES.md, +1 for .vscode/mcp.json
      const terseSummary = `Success. Project "${projectName}" generated at ${projectDir}. ${workflowDefs.length} workflows, ${totalFiles} files. See GENERATION_NOTES.md for setup and details.`;

      return {
        content: [{ type: "text" as const, text: terseSummary }],
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
