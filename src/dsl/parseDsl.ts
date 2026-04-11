/**
 * DSL Parser for the generate tool.
 *
 * Parses a flat, keyword-based DSL into the same object shape that the
 * old Zod schema produced, so the downstream pipeline is unchanged.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface ParseDslResult {
  projectName: string;
  description: string;
  workflows: DslWorkflow[];
  webhookEndpoints?: DslWebhook[];
}

export interface DslWorkflow {
  name: string;
  description: string;
  params?: Record<string, unknown>;
  steps: DslStep[];
}

export interface DslStep {
  id: string;
  label?: string;
  type: string;
  dependsOn?: string[];
  operationId?: string;
  inputMapping?: Record<string, unknown>;
  outputPath?: string;
  forEach?: string;
  as?: string;
  prompt?: string;
  systemPrompt?: string;
  maxTokens?: number;
  responseFormat?: string;
  content?: Array<
    { type: "text"; text: string } | { type: "image"; url: string }
  >;
  expression?: string;
  condition?: string;
  thenStep?: string;
  elseStep?: string;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  onDecline?: string;
  continueOnError?: boolean;
}

export interface DslWebhook {
  path: string;
  description: string;
  methods: ("get" | "post")[];
}

// ── Error helper ─────────────────────────────────────────────────────────

class DslParseError extends Error {
  constructor(line: number, message: string) {
    super(`Line ${line}: ${message}`);
    this.name = "DslParseError";
  }
}

// ── Value parsing helpers ────────────────────────────────────────────────

/** Infer the JS type of a value string: number, JSON object/array, or string. */
function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Number (integer or float, not template strings that start with digits)
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && !trimmed.includes("{{")) {
    return Number(trimmed);
  }

  // JSON object or array
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON — treat as string
    }
  }

  return trimmed;
}

/**
 * Reconstruct a nested object from a dot-path and a value.
 * `buildDotPath("message.rid", val)` → `{ message: { rid: val } }`
 */
function buildDotPath(
  dotPath: string,
  value: unknown,
): Record<string, unknown> {
  const segments = dotPath.split(".");
  if (segments.length === 1) {
    return { [segments[0]]: value };
  }
  const result: Record<string, unknown> = {};
  let current = result;
  for (let i = 0; i < segments.length - 1; i++) {
    const next: Record<string, unknown> = {};
    current[segments[i]] = next;
    current = next;
  }
  current[segments[segments.length - 1]] = value;
  return result;
}

/** Deep-merge b into a (mutates a). Arrays are replaced, not merged. */
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, bVal] of Object.entries(b)) {
    const aVal = a[key];
    if (
      aVal &&
      typeof aVal === "object" &&
      !Array.isArray(aVal) &&
      bVal &&
      typeof bVal === "object" &&
      !Array.isArray(bVal)
    ) {
      deepMerge(
        aVal as Record<string, unknown>,
        bVal as Record<string, unknown>,
      );
    } else {
      a[key] = bVal;
    }
  }
  return a;
}

// ── Main parser ──────────────────────────────────────────────────────────

type ParserState = "ROOT" | "WORKFLOW" | "STEP" | "WEBHOOK";

export function parseDsl(dsl: string): ParseDslResult {
  const lines = dsl.split("\n");
  let lineNum = 0;

  let projectName: string | undefined;
  let projectDescription: string | undefined;
  const workflows: DslWorkflow[] = [];
  const webhooks: DslWebhook[] = [];

  let currentWorkflow: DslWorkflow | null = null;
  let currentStep: DslStep | null = null;
  let currentWebhook: DslWebhook | null = null;
  let state: ParserState = "ROOT";

  // Heredoc accumulator
  let heredocTarget: { obj: Record<string, unknown>; key: string } | null =
    null;
  let heredocLines: string[] = [];

  function finalizeStep() {
    if (currentStep && currentWorkflow) {
      currentWorkflow.steps.push(currentStep);
      currentStep = null;
    }
  }

  function finalizeWorkflow() {
    finalizeStep();
    if (currentWorkflow) {
      workflows.push(currentWorkflow);
      currentWorkflow = null;
    }
  }

  function finalizeWebhook() {
    if (currentWebhook) {
      webhooks.push(currentWebhook);
      currentWebhook = null;
    }
  }

  function err(msg: string): never {
    throw new DslParseError(lineNum, msg);
  }

  for (lineNum = 1; lineNum <= lines.length; lineNum++) {
    const rawLine = lines[lineNum - 1];

    // ── Heredoc accumulation ──
    if (heredocTarget) {
      if (rawLine.trim() === ">>>") {
        let heredocValue = heredocLines.join("\n");
        // Normalize triple+ braces → double braces at parse time (Bug 1 defense layer)
        heredocValue = heredocValue.replace(/\{{3,}([^}]+)\}{3,}/g, "{{$1}}");
        (heredocTarget.obj as any)[heredocTarget.key] = heredocValue;
        heredocTarget = null;
        heredocLines = [];
        continue;
      }
      heredocLines.push(rawLine);
      continue;
    }

    // Strip comments and trim
    // Only treat # as a comment if it's at the start of the trimmed line.
    // Inline # is NOT a comment — it conflicts with Rocket.Chat #channel names.
    let line: string;
    const trimmedRaw = rawLine.trim();
    if (trimmedRaw.startsWith("#")) {
      continue; // whole-line comment
    }
    line = rawLine.trimEnd();

    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // ── Top-level keywords ──
    if (trimmed.startsWith("PROJECT ")) {
      finalizeWorkflow();
      finalizeWebhook();
      state = "ROOT";
      projectName = trimmed.slice(8).trim();
      continue;
    }

    if (
      trimmed.startsWith("DESCRIPTION ") &&
      state === "ROOT" &&
      !currentWorkflow
    ) {
      projectDescription = trimmed.slice(12).trim();
      continue;
    }

    if (trimmed.startsWith("WORKFLOW ")) {
      finalizeWorkflow();
      finalizeWebhook();
      const name = trimmed.slice(9).trim();
      if (!name) err("WORKFLOW requires a name");
      currentWorkflow = { name, description: "", steps: [] };
      state = "WORKFLOW";
      continue;
    }

    if (trimmed.startsWith("WEBHOOK ")) {
      finalizeWorkflow();
      finalizeWebhook();
      const path = trimmed.slice(8).trim();
      if (!path) err("WEBHOOK requires a path");
      currentWebhook = { path, description: "", methods: [] };
      state = "WEBHOOK";
      continue;
    }

    // ── Webhook fields ──
    if (state === "WEBHOOK" && currentWebhook) {
      if (trimmed.startsWith("DESCRIPTION ")) {
        currentWebhook.description = trimmed.slice(12).trim();
        continue;
      }
      if (trimmed.startsWith("METHODS ")) {
        currentWebhook.methods = trimmed
          .slice(8)
          .trim()
          .split(/\s+/)
          .map((m) => m.toLowerCase() as "get" | "post");
        continue;
      }
      err(`Unknown keyword in WEBHOOK context: "${trimmed.split(" ")[0]}"`);
    }

    // ── STEP line starts a new step (even inside workflow context) ──
    if (trimmed.startsWith("STEP ") && currentWorkflow) {
      finalizeStep();
      // Parse: STEP id : type
      // or:    STEP id : type LABEL Some label text
      const afterStep = trimmed.slice(5).trim();
      const colonIdx = afterStep.indexOf(":");
      if (colonIdx < 0) err('STEP requires format "STEP id : type"');
      const id = afterStep.slice(0, colonIdx).trim();
      if (!id) err("STEP requires an id before ':'");
      const afterColon = afterStep.slice(colonIdx + 1).trim();
      // The type is the first word after colon
      const parts = afterColon.split(/\s+/);
      const type = parts[0];
      if (!type) err("STEP requires a type after ':'");
      const validTypes = [
        "api_call",
        "sampling",
        "elicitation",
        "transform",
        "conditional",
      ];
      if (!validTypes.includes(type)) {
        err(`Unknown step type "${type}". Valid: ${validTypes.join(", ")}`);
      }
      currentStep = { id, type };
      state = "STEP";
      continue;
    }

    // ── Workflow-level fields ──
    if (state === "WORKFLOW" && currentWorkflow && !currentStep) {
      if (trimmed.startsWith("DESCRIPTION ")) {
        currentWorkflow.description = trimmed.slice(12).trim();
        continue;
      }
      if (trimmed.startsWith("PARAM ")) {
        // PARAM name : type : description
        const afterParam = trimmed.slice(6).trim();
        const parts = afterParam.split(":").map((p) => p.trim());
        if (parts.length < 2)
          err('PARAM requires format "PARAM name : type : description"');
        const paramName = parts[0];
        const paramType = parts[1];
        const paramDesc = parts.slice(2).join(":").trim() || undefined;
        if (!paramName) err("PARAM requires a name");
        const validTypes = ["string", "number", "boolean", "object", "array"];
        if (!validTypes.includes(paramType)) {
          err(
            `PARAM type "${paramType}" invalid. Valid: ${validTypes.join(", ")}`,
          );
        }
        if (!currentWorkflow.params) {
          currentWorkflow.params = { type: "object", properties: {} };
        }
        const props = (currentWorkflow.params as any).properties;
        props[paramName] = paramDesc
          ? { type: paramType, description: paramDesc }
          : { type: paramType };
        continue;
      }
    }

    // ── Step-level fields ──
    if ((state === "STEP" || state === "WORKFLOW") && currentStep) {
      // LABEL
      if (trimmed.startsWith("LABEL ")) {
        currentStep.label = trimmed.slice(6).trim();
        continue;
      }

      // DEPENDS ON
      if (trimmed.startsWith("DEPENDS ON ")) {
        currentStep.dependsOn = trimmed.slice(11).trim().split(/\s+/);
        continue;
      }

      // OPERATION (api_call)
      if (trimmed.startsWith("OPERATION ")) {
        currentStep.operationId = trimmed.slice(10).trim();
        continue;
      }

      // OUTPUT_PATH (api_call)
      if (trimmed.startsWith("OUTPUT_PATH ")) {
        currentStep.outputPath = trimmed.slice(12).trim();
        continue;
      }

      // FOR_EACH (api_call)
      if (trimmed.startsWith("FOR_EACH ")) {
        currentStep.forEach = trimmed.slice(9).trim();
        continue;
      }

      // AS (api_call forEach variable name)
      if (trimmed.startsWith("AS ")) {
        currentStep.as = trimmed.slice(3).trim();
        continue;
      }

      // MAP (api_call inputMapping)
      if (trimmed.startsWith("MAP ")) {
        const afterMap = trimmed.slice(4).trim();
        const eqIdx = afterMap.indexOf("=");
        if (eqIdx < 0) err('MAP requires format "MAP path = value"');
        const dotPath = afterMap.slice(0, eqIdx).trim();
        const rawValue = afterMap.slice(eqIdx + 1).trim();
        if (!dotPath) err("MAP requires a field path before '='");

        if (rawValue === "<<<") {
          err(
            'MAP does not support heredoc (<<<). For complex or multi-line MAP values, ' +
            'use a transform step to build the text, then reference it: ' +
            'MAP text = {{steps.my_transform_step}}',
          );
        }

        const value = parseValue(rawValue);
        const nested = buildDotPath(dotPath, value);
        if (!currentStep.inputMapping) {
          currentStep.inputMapping = {};
        }
        deepMerge(currentStep.inputMapping, nested);
        continue;
      }

      // EXPRESSION (transform) — may be inline or heredoc
      if (trimmed.startsWith("EXPRESSION ") || trimmed === "EXPRESSION") {
        const rest = trimmed.slice(11).trim();
        if (rest === "<<<" || rest === "") {
          // Heredoc or next-line heredoc
          if (rest === "") {
            // Check if the NEXT non-blank line starts with <<<
            // For simplicity, treat bare EXPRESSION as start of heredoc
          }
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "expression",
          };
          heredocLines = [];
          if (rest !== "<<<") {
            // Inline single-line value
            currentStep.expression = rest;
            heredocTarget = null;
          }
          continue;
        }
        currentStep.expression = rest;
        continue;
      }

      // CONDITION (conditional)
      if (trimmed.startsWith("CONDITION ") || trimmed === "CONDITION") {
        const rest = trimmed.slice(10).trim();
        if (rest === "<<<") {
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "condition",
          };
          heredocLines = [];
          continue;
        }
        currentStep.condition = rest;
        continue;
      }

      // THEN (conditional)
      if (trimmed.startsWith("THEN ")) {
        currentStep.thenStep = trimmed.slice(5).trim();
        continue;
      }

      // ELSE (conditional)
      if (trimmed.startsWith("ELSE ")) {
        currentStep.elseStep = trimmed.slice(5).trim();
        continue;
      }

      // PROMPT (sampling) — may be heredoc
      if (trimmed.startsWith("PROMPT ") || trimmed === "PROMPT") {
        const rest = trimmed.slice(7).trim();
        if (rest === "<<<") {
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "prompt",
          };
          heredocLines = [];
          continue;
        }
        currentStep.prompt = rest;
        continue;
      }

      // SYSTEM_PROMPT (sampling) — may be heredoc
      if (trimmed.startsWith("SYSTEM_PROMPT ") || trimmed === "SYSTEM_PROMPT") {
        const rest = trimmed.slice(14).trim();
        if (rest === "<<<") {
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "systemPrompt",
          };
          heredocLines = [];
          continue;
        }
        currentStep.systemPrompt = rest;
        continue;
      }

      // MAX_TOKENS (sampling)
      if (trimmed.startsWith("MAX_TOKENS ")) {
        const val = parseInt(trimmed.slice(11).trim(), 10);
        if (isNaN(val)) err("MAX_TOKENS must be a number");
        currentStep.maxTokens = val;
        continue;
      }

      // RESPONSE_FORMAT (sampling)
      if (trimmed.startsWith("RESPONSE_FORMAT ")) {
        currentStep.responseFormat = trimmed.slice(16).trim();
        continue;
      }

      // CONTENT_TEXT (sampling content array)
      if (trimmed.startsWith("CONTENT_TEXT ") || trimmed === "CONTENT_TEXT") {
        const rest = trimmed.slice(13).trim();
        if (!currentStep.content) currentStep.content = [];
        if (rest === "<<<") {
          // Push a placeholder and use heredoc
          const item = { type: "text" as const, text: "" };
          currentStep.content.push(item);
          heredocTarget = {
            obj: item as unknown as Record<string, unknown>,
            key: "text",
          };
          heredocLines = [];
          continue;
        }
        currentStep.content.push({ type: "text", text: rest });
        continue;
      }

      // CONTENT_IMAGE (sampling content array)
      if (trimmed.startsWith("CONTENT_IMAGE ")) {
        const url = trimmed.slice(14).trim();
        if (!currentStep.content) currentStep.content = [];
        currentStep.content.push({ type: "image", url });
        continue;
      }

      // MESSAGE (elicitation)
      if (trimmed.startsWith("MESSAGE ") || trimmed === "MESSAGE") {
        const rest = trimmed.slice(8).trim();
        if (rest === "<<<") {
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "message",
          };
          heredocLines = [];
          continue;
        }
        currentStep.message = rest;
        continue;
      }

      // SCHEMA (elicitation requestedSchema) — inline JSON
      if (trimmed.startsWith("SCHEMA ") || trimmed === "SCHEMA") {
        const rest = trimmed.slice(7).trim();
        if (rest === "<<<") {
          // Heredoc JSON
          heredocTarget = {
            obj: currentStep as unknown as Record<string, unknown>,
            key: "requestedSchema",
          };
          heredocLines = [];
          continue;
        }
        try {
          currentStep.requestedSchema = JSON.parse(rest);
        } catch {
          err(`SCHEMA value must be valid JSON: ${rest.slice(0, 60)}`);
        }
        continue;
      }

      // ON_DECLINE (elicitation)
      if (trimmed.startsWith("ON_DECLINE ")) {
        currentStep.onDecline = trimmed.slice(11).trim();
        continue;
      }

      // CONTINUE_ON_ERROR
      if (trimmed === "CONTINUE_ON_ERROR") {
        currentStep.continueOnError = true;
        continue;
      }

      // If we reach here inside a STEP and it looks like a WORKFLOW or STEP keyword,
      // finalize the current step/workflow and reprocess
      if (
        trimmed.startsWith("WORKFLOW ") ||
        trimmed.startsWith("PROJECT ") ||
        trimmed.startsWith("WEBHOOK ")
      ) {
        // Reprocess this line from the top
        finalizeStep();
        if (trimmed.startsWith("WORKFLOW ")) {
          finalizeWorkflow();
          const name = trimmed.slice(9).trim();
          if (!name) err("WORKFLOW requires a name");
          currentWorkflow = { name, description: "", steps: [] };
          state = "WORKFLOW";
          continue;
        }
        // For PROJECT/WEBHOOK, let the next iteration handle it
        lineNum--; // reprocess
        state = "ROOT";
        finalizeWorkflow();
        continue;
      }

      // DESCRIPTION inside a step context → might be for a new workflow
      if (trimmed.startsWith("DESCRIPTION ") && currentWorkflow) {
        // If we're in step state, this could be a workflow-level description
        // that appears after steps (unlikely), or for the current workflow
        // before any step. Check if we actually have a step:
        if (state === "STEP") {
          // This is unusual — ignore or treat as label
          currentStep.label = trimmed.slice(12).trim();
          continue;
        }
        currentWorkflow.description = trimmed.slice(12).trim();
        continue;
      }

      // Check if this looks like content that leaked from a failed heredoc
      const firstChar = trimmed[0];
      if (
        firstChar === "*" ||
        firstChar === "-" ||
        firstChar === "•" ||
        trimmed.startsWith("{{") ||
        !/^[A-Z]/.test(trimmed)
      ) {
        err(
          `Unexpected content "${trimmed.slice(0, 40)}" in step "${currentStep.id}" — ` +
          `this looks like text that was meant to be inside a heredoc (<<<...>>>). ` +
          `Heredoc is supported by: EXPRESSION, CONDITION, PROMPT, SYSTEM_PROMPT, CONTENT_TEXT, MESSAGE, SCHEMA. ` +
          `MAP does NOT support heredoc — use a transform step for complex values.`,
        );
      }
      err(
        `Unknown keyword "${trimmed.split(" ")[0]}" in step "${currentStep.id}"`,
      );
    }

    // ── Workflow-level but not in step ──
    if (state === "WORKFLOW" && currentWorkflow) {
      err(
        `Unknown keyword "${trimmed.split(" ")[0]}" in workflow "${currentWorkflow.name}"`,
      );
    }

    // ── Root-level unknown ──
    if (state === "ROOT") {
      err(`Unexpected content at root level: "${trimmed.slice(0, 40)}"`);
    }
  }

  // ── Finalize anything in-progress ──
  if (heredocTarget) {
    err("Unterminated heredoc (missing >>>)");
  }
  finalizeWorkflow();
  finalizeWebhook();

  // ── Validate required fields ──
  if (!projectName) {
    throw new DslParseError(1, "Missing PROJECT declaration");
  }
  if (!projectDescription) {
    throw new DslParseError(1, "Missing project DESCRIPTION");
  }
  if (workflows.length === 0) {
    throw new DslParseError(1, "No WORKFLOW declarations found");
  }

  // ── Parse heredoc SCHEMA values (they come back as strings) ──
  for (const wf of workflows) {
    for (const step of wf.steps) {
      if (step.requestedSchema && typeof step.requestedSchema === "string") {
        try {
          step.requestedSchema = JSON.parse(
            step.requestedSchema as unknown as string,
          );
        } catch {
          throw new DslParseError(
            0,
            `Invalid JSON in SCHEMA for step "${step.id}": ${(step.requestedSchema as unknown as string).slice(0, 60)}`,
          );
        }
      }
    }
  }

  return {
    projectName,
    description: projectDescription,
    workflows,
    ...(webhooks.length > 0 ? { webhookEndpoints: webhooks } : {}),
  };
}
