import type {
  WorkflowDefinition,
  WorkflowStep,
  StepConfig,
  ApiCallStep,
  SamplingStep,
  ElicitationStep,
  TransformStep,
  ConditionalStep,
  PersistenceConfig,
} from "./types.js";
import type { JSONSchema7 } from "json-schema";

export interface ComposeWorkflowInput {
  name: string;
  description: string;
  triggerEvent?: string;
  command?: string;
  params: JSONSchema7;
  steps: ComposeStepInput[];
  persistence?: PersistenceConfig;
}

export interface ComposeStepInput {
  id: string;
  label: string;
  config: StepConfig;
  dependsOn?: string[];
}

export interface ComposerWarning {
  stepId: string | null;
  code:
    | "UNUSED_SAMPLING"
    | "ORPHANED_STEP"
    | "MULTIPLE_ROOTS"
    | "DUPLICATE_API_CALL"
    | "DEEP_CHAIN"
    | "IMPLICIT_DEP_ADDED"
    | "DATA_FLOW_WARNING"
    | "STATIC_SAMPLING_PROMPT"
    | "HARDCODED_RID"
    | "TEMPLATE_AUTO_WRAPPED"
    | "AS_VAR_REWRITTEN"
    | "REQUEST_BODY_UNWRAPPED"
    | "EVENT_PARAM_REWRITTEN"
    | "PARAM_SUBFIELD_UNKNOWN"
    | "SAMPLING_SCHEMA_MISMATCH"
    | "FIELD_STRIPPED"
    | "FIELD_AUTO_SET";
  message: string;
}

export interface ComposeWorkflowResult {
  workflow: WorkflowDefinition;
  executionOrder: string[];
  summary: {
    stepCount: number;
    apiCalls: string[];
    usesSampling: boolean;
    usesElicitation: boolean;
    hasConditionals: boolean;
  };
  warnings: ComposerWarning[];
}

export class ComposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposerError";
  }
}

function validateUniqueIds(steps: ComposeStepInput[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new ComposerError(`Duplicate step ID: "${step.id}"`);
    }
    ids.add(step.id);
  }
}

function validateReferences(steps: ComposeStepInput[]): void {
  const ids = new Set(steps.map((s) => s.id));

  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!ids.has(dep)) {
          throw new ComposerError(
            `Step "${step.id}" depends on unknown step "${dep}"`,
          );
        }
        if (dep === step.id) {
          throw new ComposerError(`Step "${step.id}" cannot depend on itself`);
        }
      }
    }

    if (step.config.type === "conditional") {
      const cfg = step.config as ConditionalStep;
      if (!ids.has(cfg.thenStep)) {
        throw new ComposerError(
          `Step "${step.id}" references unknown thenStep "${cfg.thenStep}"`,
        );
      }
      if (cfg.elseStep && !ids.has(cfg.elseStep)) {
        throw new ComposerError(
          `Step "${step.id}" references unknown elseStep "${cfg.elseStep}"`,
        );
      }
    }
  }
}

function detectCycles(steps: ComposeStepInput[]): void {
  const adj = new Map<string, string[]>();
  for (const step of steps) {
    adj.set(step.id, step.dependsOn ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      throw new ComposerError(
        `Circular dependency detected: ${cycle.join(" → ")}`,
      );
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    for (const dep of adj.get(node) ?? []) {
      dfs(dep, [...path, node]);
    }

    inStack.delete(node);
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      dfs(step.id, []);
    }
  }
}

function normalizeStepFields(steps: ComposeStepInput[]): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  for (const step of steps) {
    const cfg = step.config as unknown as Record<string, unknown>;
    if (cfg.type === "api_call") {
      if (cfg.as && !cfg.forEach) {
        delete cfg.as;
        warnings.push({
          stepId: step.id,
          code: "FIELD_STRIPPED",
          message: `Stripped "as" from step "${step.id}" — "as" is only used with "forEach" for iteration. Step results are accessed via steps.${step.id}`,
        });
      }
      if (cfg.forEach && !cfg.as) {
        cfg.as = `${step.id}_item`;
        warnings.push({
          stepId: step.id,
          code: "FIELD_AUTO_SET",
          message: `Auto-set as="${cfg.as}" for step "${step.id}" — "as" names the loop variable in forEach iteration`,
        });
      }
    }
  }
  return warnings;
}

function validateStepConfig(step: ComposeStepInput): void {
  const cfg = step.config;
  switch (cfg.type) {
    case "api_call":
      if (!cfg.operationId) {
        throw new ComposerError(
          `Step "${step.id}" (api_call): operationId is required`,
        );
      }
      break;
    case "sampling":
      if (!cfg.prompt) {
        throw new ComposerError(
          `Step "${step.id}" (sampling): prompt is required`,
        );
      }
      if (cfg.content) {
        for (const item of cfg.content) {
          if (item.type === "text" && !item.text) {
            throw new ComposerError(
              `Step "${step.id}" (sampling): content text item requires a text field`,
            );
          }
          if (item.type === "image" && !item.url) {
            throw new ComposerError(
              `Step "${step.id}" (sampling): content image item requires a url field`,
            );
          }
        }
      }
      break;
    case "elicitation":
      if (!cfg.message) {
        throw new ComposerError(
          `Step "${step.id}" (elicitation): message is required`,
        );
      }
      if (!cfg.requestedSchema) {
        throw new ComposerError(
          `Step "${step.id}" (elicitation): requestedSchema is required`,
        );
      }
      break;
    case "transform":
      if (!cfg.expression) {
        throw new ComposerError(
          `Step "${step.id}" (transform): expression is required`,
        );
      }
      break;
    case "conditional":
      if (!cfg.condition) {
        throw new ComposerError(
          `Step "${step.id}" (conditional): condition is required`,
        );
      }
      if (!cfg.thenStep) {
        throw new ComposerError(
          `Step "${step.id}" (conditional): thenStep is required`,
        );
      }
      break;
    default:
      throw new ComposerError(
        `Step "${step.id}": unknown step type "${(cfg as any).type}"`,
      );
  }
}

const STEP_REF_RE = /\{\{steps\.(\w+)/g;
const PARAM_REF_RE = /\{\{params\.([\w.]+)/g;
const BARE_STEP_REF_RE = /\bsteps\.(\w+)/g;
const STEP_FIELD_ACCESS_RE = /steps\.(\w+)\.(\w+)/g;

const JS_BUILTIN_METHODS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "startsWith",
  "endsWith",
  "match",
  "matchAll",
  "search",
  "replace",
  "replaceAll",
  "slice",
  "substring",
  "substr",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "split",
  "repeat",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "at",
  "concat",
  "normalize",
  "map",
  "filter",
  "find",
  "findIndex",
  "every",
  "some",
  "reduce",
  "forEach",
  "flat",
  "flatMap",
  "join",
  "reverse",
  "sort",
  "push",
  "pop",
  "shift",
  "unshift",
  "fill",
  "copyWithin",
  "entries",
  "keys",
  "values",
  "toString",
  "valueOf",
  "toJSON",
  "hasOwnProperty",
  "length",
]);

function findLiteralRid(mapping: Record<string, unknown>): string | null {
  function check(val: unknown): string | null {
    if (typeof val === "string" && !val.includes("{{")) return val;
    return null;
  }
  if ("rid" in mapping) {
    const lit = check(mapping.rid);
    if (lit) return lit;
  }
  for (const v of Object.values(mapping)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const nested = v as Record<string, unknown>;
      if ("rid" in nested) {
        const lit = check(nested.rid);
        if (lit) return lit;
      }
    }
  }
  return null;
}

function collectStringsDeep(obj: unknown, out: string[]): void {
  if (typeof obj === "string") {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectStringsDeep(item, out);
  } else if (typeof obj === "object" && obj !== null) {
    for (const val of Object.values(obj)) collectStringsDeep(val, out);
  }
}

function extractTemplateStrings(config: StepConfig): string[] {
  const strings: string[] = [];
  switch (config.type) {
    case "api_call": {
      if (config.inputMapping) {
        collectStringsDeep(
          config.inputMapping as Record<string, unknown>,
          strings,
        );
      }
      if (config.forEach) strings.push(config.forEach);
      break;
    }
    case "sampling": {
      strings.push(config.prompt);
      if (config.systemPrompt) strings.push(config.systemPrompt);
      if (config.content) {
        for (const item of config.content) {
          if (item.type === "text") strings.push(item.text);
          else if (item.type === "image") strings.push(item.url);
        }
      }
      break;
    }
    case "elicitation": {
      strings.push(config.message);
      break;
    }
    case "transform": {
      strings.push(config.expression);
      break;
    }
    case "conditional": {
      strings.push(config.condition);
      break;
    }
  }
  return strings;
}

function extractStepRefs(config: StepConfig): Set<string> {
  const refs = new Set<string>();
  const isJsContext =
    config.type === "transform" || config.type === "conditional";
  for (const str of extractTemplateStrings(config)) {
    for (const match of str.matchAll(STEP_REF_RE)) {
      refs.add(match[1]);
    }
    if (isJsContext) {
      for (const match of str.matchAll(BARE_STEP_REF_RE)) {
        refs.add(match[1]);
      }
    }
  }
  return refs;
}

function injectImplicitDependencies(
  steps: ComposeStepInput[],
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const ids = new Set(steps.map((s) => s.id));

  for (const step of steps) {
    const deps = new Set(step.dependsOn ?? []);

    const refs = extractStepRefs(step.config);
    for (const refId of refs) {
      if (ids.has(refId) && refId !== step.id && !deps.has(refId)) {
        deps.add(refId);
        warnings.push({
          stepId: step.id,
          code: "IMPLICIT_DEP_ADDED",
          message: `Auto-fixed: "${step.id}" references "${refId}" in templates — dependsOn updated automatically (no action needed).`,
        });
      }
    }

    step.dependsOn = deps.size > 0 ? [...deps] : undefined;
  }

  for (const step of steps) {
    if (step.config.type !== "conditional") continue;
    const cfg = step.config as ConditionalStep;
    for (const targetId of [cfg.thenStep, cfg.elseStep]) {
      if (!targetId) continue;
      const target = steps.find((s) => s.id === targetId);
      if (!target) continue;
      const targetDeps = new Set(target.dependsOn ?? []);
      if (!targetDeps.has(step.id)) {
        targetDeps.add(step.id);
        target.dependsOn = [...targetDeps];
        warnings.push({
          stepId: target.id,
          code: "IMPLICIT_DEP_ADDED",
          message: `Auto-fixed: "${target.id}" is a branch target of conditional "${step.id}" — dependsOn updated automatically (no action needed).`,
        });
      }
    }
  }

  return warnings;
}

function validateTemplateReferences(
  steps: ComposeStepInput[],
  params: JSONSchema7,
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    if (step.config.type === "api_call" && (step.config as any).as) {
      stepIds.add((step.config as any).as);
    }
  }
  const paramProps = new Set(
    params.properties ? Object.keys(params.properties) : [],
  );

  for (const step of steps) {
    const templates = extractTemplateStrings(step.config);
    for (const tmpl of templates) {
      for (const match of tmpl.matchAll(STEP_REF_RE)) {
        const refId = match[1];
        if (!stepIds.has(refId)) {
          throw new ComposerError(
            `Step "${step.id}" references unknown step "${refId}" in template: "${tmpl.slice(0, 80)}"`,
          );
        }
      }
      if (paramProps.size > 0) {
        for (const match of tmpl.matchAll(PARAM_REF_RE)) {
          const fullPath = match[1];
          const segments = fullPath.split(".");
          const topField = segments[0];
          if (!paramProps.has(topField)) {
            throw new ComposerError(
              `Step "${step.id}" references "params.${topField}" but "${topField}" is not in the workflow params schema. Available: ${[...paramProps].join(", ") || "(none)"}`,
            );
          }
          if (segments.length > 1) {
            const subWarning = validateParamSubField(
              segments,
              params,
              step.id,
              fullPath,
            );
            if (subWarning) warnings.push(subWarning);
          }
        }
      }
    }
  }
  return warnings;
}

function validateParamSubField(
  segments: string[],
  schema: JSONSchema7,
  stepId: string,
  fullPath: string,
): ComposerWarning | null {
  let current: JSONSchema7 | boolean | undefined = schema;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!current || typeof current === "boolean") return null;
    const props: Record<string, JSONSchema7 | boolean> | undefined = (
      current as JSONSchema7
    ).properties as Record<string, JSONSchema7 | boolean> | undefined;
    if (!props) return null; // No properties defined — can't validate further
    if (!(seg in props)) {
      // Segment not found in this object's properties
      const available = Object.keys(props);
      const parentPath =
        i === 0 ? "params" : `params.${segments.slice(0, i).join(".")}`;
      return {
        stepId,
        code: "PARAM_SUBFIELD_UNKNOWN",
        message: `Step "${stepId}" references "params.${fullPath}" but "${seg}" is not a known property of ${parentPath}. Available: ${available.join(", ")}`,
      };
    }
    const next: JSONSchema7 | boolean = props[seg];
    if (typeof next === "boolean") return null;
    // If this is a leaf type, everything after is JS — allow
    if (i < segments.length - 1 && next.type !== "object" && !next.properties) {
      return null;
    }
    current = next;
  }
  return null;
}

const STEP_OUTPUT_TYPES: Record<
  StepConfig["type"],
  "string" | "boolean" | "object" | "unknown"
> = {
  sampling: "unknown", // JSON auto-parsed at runtime — may be string or object
  conditional: "boolean",
  api_call: "object",
  elicitation: "object",
  transform: "unknown",
};

function validateDataFlowTypes(steps: ComposeStepInput[]): void {
  const stepById = new Map(steps.map((s) => [s.id, s]));

  for (const step of steps) {
    const templates = extractTemplateStrings(step.config);
    for (const tmpl of templates) {
      for (const match of tmpl.matchAll(STEP_FIELD_ACCESS_RE)) {
        const refStepId = match[1];
        const field = match[2];
        if (JS_BUILTIN_METHODS.has(field)) continue;
        const refStep = stepById.get(refStepId);
        if (!refStep) continue;

        const outputType = STEP_OUTPUT_TYPES[refStep.config.type];
        if (outputType === "string") {
          throw new ComposerError(
            `Step "${step.id}" accesses ".${field}" on step "${refStepId}" (${refStep.config.type}), ` +
              `but ${refStep.config.type} results are plain text strings with no properties. ` +
              `Fix: (1) Add a systemPrompt to step "${refStepId}" asking the LLM to respond in JSON only, ` +
              `(2) Add a transform step after "${refStepId}" with expression 'JSON.parse(steps.${refStepId})', ` +
              `then (3) reference 'steps.<transform_step>.${field}' instead. ` +
              `Alternatively, evaluate the raw string directly (e.g. 'steps.${refStepId}.includes("...")').`,
          );
        }
        if (outputType === "boolean") {
          throw new ComposerError(
            `Step "${step.id}" accesses ".${field}" on step "${refStepId}" (conditional), ` +
              `but conditional results are booleans with no properties. ` +
              `Use the boolean value directly: 'steps.${refStepId} === true'.`,
          );
        }
      }
    }
  }
}

/**
 * For each sampling step with responseFormat: "json", scan all downstream steps
 * for references like steps.<samplingId>.result.<field>. Infer a responseSchema
 * from those references — field names + rough types — and set it on the step config.
 */
function inferSamplingResponseSchemas(
  steps: ComposeStepInput[],
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];

  // Identify sampling steps that produce JSON
  const jsonSamplingIds = new Set<string>();
  for (const step of steps) {
    if (step.config.type === "sampling") {
      const cfg = step.config as import("./types.js").SamplingStep;
      if (cfg.responseFormat === "json") {
        jsonSamplingIds.add(step.id);
      }
    }
  }
  if (jsonSamplingIds.size === 0) return warnings;

  // Collect all field accesses per sampling step from downstream steps
  const fieldAccesses = new Map<string, Map<string, string>>();
  for (const id of jsonSamplingIds) fieldAccesses.set(id, new Map());

  // Regex that captures: steps.<id>.<field> and optionally a trailing method/operator
  const FIELD_CONTEXT_RE =
    /steps\.(\w+)\.(\w+)\s*(?:===\s*(true|false)|\.join\b|\.map\b|\.filter\b|\.length\b|\.includes\b)?/g;

  for (const step of steps) {
    const templates = extractTemplateStrings(step.config);
    for (const tmpl of templates) {
      for (const match of tmpl.matchAll(FIELD_CONTEXT_RE)) {
        const refId = match[1];
        const field = match[2];
        const boolLiteral = match[3];
        if (!fieldAccesses.has(refId)) continue;
        if (JS_BUILTIN_METHODS.has(field)) continue;
        const fields = fieldAccesses.get(refId)!;
        if (fields.has(field)) continue; // first wins

        // Infer type from context
        let inferredType = "string";
        if (boolLiteral === "true" || boolLiteral === "false") {
          inferredType = "boolean";
        } else if (
          /\.join\b|\.map\b|\.filter\b|\.length\b/.test(
            tmpl.slice(match.index!, match.index! + match[0].length + 10),
          )
        ) {
          inferredType = "array";
        }
        fields.set(field, inferredType);
      }
    }
  }

  // Apply inferred schemas to the sampling step configs
  for (const [stepId, fields] of fieldAccesses) {
    if (fields.size === 0) continue;
    const step = steps.find((s) => s.id === stepId)!;
    const cfg = step.config as import("./types.js").SamplingStep;
    const schema: Record<string, string> = {};
    for (const [name, type] of fields) schema[name] = type;
    cfg.responseSchema = schema;

    // Warn if any field isn't mentioned in the prompt
    const promptText =
      `${cfg.prompt || ""} ${cfg.systemPrompt || ""}`.toLowerCase();
    for (const field of fields.keys()) {
      if (!promptText.includes(field.toLowerCase())) {
        warnings.push({
          stepId,
          code: "SAMPLING_SCHEMA_MISMATCH",
          message: `Step "${stepId}" result field "${field}" is used by downstream steps but not mentioned in the sampling prompt — the AI may not include it.`,
        });
      }
    }
  }

  return warnings;
}

function generateSemanticWarnings(
  steps: ComposeStepInput[],
  params?: JSONSchema7,
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  const hasParams =
    params &&
    Object.keys((params.properties as Record<string, unknown>) ?? {}).length >
      0;

  const referencedSteps = new Set<string>();
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) referencedSteps.add(dep);
    const refs = extractStepRefs(step.config);
    for (const r of refs) referencedSteps.add(r);
    if (step.config.type === "conditional") {
      const cfg = step.config as ConditionalStep;
      referencedSteps.add(cfg.thenStep);
      if (cfg.elseStep) referencedSteps.add(cfg.elseStep);
    }
  }

  for (const step of steps) {
    if (step.config.type === "sampling") {
      let referenced = false;
      for (const other of steps) {
        if (other.id === step.id) continue;
        const refs = extractStepRefs(other.config);
        if (refs.has(step.id)) {
          referenced = true;
          break;
        }
      }
      if (!referenced) {
        warnings.push({
          stepId: step.id,
          code: "UNUSED_SAMPLING",
          message: `Sampling step "${step.id}" result is never referenced by any other step. This wastes an LLM call.`,
        });
      }

      const cfg = step.config as SamplingStep;
      const allText = [
        cfg.prompt ?? "",
        cfg.systemPrompt ?? "",
        ...(cfg.content ?? []).map((c) =>
          c.type === "text" ? (c.text ?? "") : (c.url ?? ""),
        ),
      ].join(" ");
      const hasTemplateRef = /\{\{(params|steps)\./.test(allText);
      if (!hasTemplateRef && hasParams) {
        throw new ComposerError(
          `Sampling step "${step.id}" prompt does not reference any {{params.*}} or {{steps.*}} data. ` +
            `The AI will have no input to analyze. Include the relevant data in the prompt ` +
            `(e.g. {{params.message.text}}).`,
        );
      }
    }
  }

  const forward = new Map<string, Set<string>>();
  for (const step of steps) {
    if (!forward.has(step.id)) forward.set(step.id, new Set());
    for (const dep of step.dependsOn ?? []) {
      if (!forward.has(dep)) forward.set(dep, new Set());
      forward.get(dep)!.add(step.id);
    }
    if (step.config.type === "conditional") {
      const cfg = step.config as ConditionalStep;
      forward.get(step.id)!.add(cfg.thenStep);
      if (cfg.elseStep) forward.get(step.id)!.add(cfg.elseStep);
    }
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const step of steps) {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      reachable.add(step.id);
      queue.push(step.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of forward.get(id) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      warnings.push({
        stepId: step.id,
        code: "ORPHANED_STEP",
        message: `Step "${step.id}" is not reachable from any entry point. It will never execute.`,
      });
    }
  }

  const rootSteps = steps.filter(
    (s) => !s.dependsOn || s.dependsOn.length === 0,
  );
  if (rootSteps.length > 1) {
    const rootIds = rootSteps.map((s) => s.id);
    warnings.push({
      stepId: null,
      code: "MULTIPLE_ROOTS",
      message:
        `Workflow has ${rootSteps.length} root steps (no dependsOn): [${rootIds.join(", ")}]. ` +
        `Most workflows should have exactly 1 entry point. ` +
        `If these steps should run after other steps, add them to dependsOn.`,
    });
  }

  const opCounts = new Map<string, string[]>();
  for (const step of steps) {
    if (step.config.type === "api_call") {
      const opId = (step.config as ApiCallStep).operationId;
      const list = opCounts.get(opId) ?? [];
      list.push(step.id);
      opCounts.set(opId, list);
    }
  }
  for (const [opId, stepIds] of opCounts) {
    if (stepIds.length > 1) {
      warnings.push({
        stepId: null,
        code: "DUPLICATE_API_CALL",
        message: `Multiple steps (${stepIds.join(", ")}) call the same endpoint "${opId}". Is this intentional?`,
      });
    }
  }

  for (const step of steps) {
    if (step.config.type !== "api_call") continue;
    const cfg = step.config as ApiCallStep;
    if (
      !cfg.operationId.includes("chat_sendMessage") &&
      !cfg.operationId.includes("chat.sendMessage")
    )
      continue;
    const rid = findLiteralRid(cfg.inputMapping);
    if (rid) {
      warnings.push({
        stepId: step.id,
        code: "HARDCODED_RID",
        message:
          `Step "${step.id}" uses chat.sendMessage with hardcoded rid "${rid}". ` +
          `The rid field requires a room ID (e.g. "6oaKzj..."), not a channel name. ` +
          `Use "post-api-v1-chat-postMessage" with { channel: "#${rid}", text: "..." } instead, ` +
          `which resolves channel names natively.`,
      });
    }
  }

  const depthCache = new Map<string, number>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  function getDepth(id: string): number {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const step = stepMap.get(id);
    if (!step || !step.dependsOn || step.dependsOn.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const maxParent = Math.max(...step.dependsOn.map(getDepth));
    const depth = maxParent + 1;
    depthCache.set(id, depth);
    return depth;
  }
  for (const step of steps) {
    const depth = getDepth(step.id);
    if (depth > 8) {
      warnings.push({
        stepId: step.id,
        code: "DEEP_CHAIN",
        message: `Step "${step.id}" is ${depth} levels deep in the dependency chain. Consider simplifying.`,
      });
      break;
    }
  }

  return warnings;
}

function topologicalSort(steps: ComposeStepInput[]): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      adj.get(dep)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return order;
}

function validatePersistenceConfig(
  persistence: PersistenceConfig,
  steps: ComposeStepInput[],
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const stepIds = new Set(steps.map((s) => s.id));

  if (!persistence.keyPath || persistence.keyPath.trim() === "") {
    throw new ComposerError(
      'Persistence keyPath is required (e.g. "sender.username" for per-user state)',
    );
  }

  if (
    !persistence.stateParam ||
    !/^[a-zA-Z_]\w*$/.test(persistence.stateParam)
  ) {
    throw new ComposerError(
      `Invalid persistence stateParam "${persistence.stateParam}": must be a valid identifier`,
    );
  }

  if (persistence.updateFromStep) {
    if (!stepIds.has(persistence.updateFromStep)) {
      throw new ComposerError(
        `Persistence updateFromStep "${persistence.updateFromStep}" does not exist. ` +
          `Available steps: ${[...stepIds].join(", ")}`,
      );
    }
    const updateStep = steps.find((s) => s.id === persistence.updateFromStep);
    if (updateStep && updateStep.config.type !== "transform") {
      warnings.push({
        stepId: persistence.updateFromStep,
        code: "DATA_FLOW_WARNING",
        message:
          `Persistence updateFromStep "${persistence.updateFromStep}" is a ${updateStep.config.type} step. ` +
          `Consider using a transform step to produce a structured state object.`,
      });
    }
  }

  return warnings;
}

function normalizeEventParamShorthand(
  steps: ComposeStepInput[],
  params: JSONSchema7,
): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const paramProps = params.properties ? Object.keys(params.properties) : [];
  if (paramProps.length === 0) return warnings;

  // Collect forEach iteration variable names so we don't rewrite them as params
  const forEachAsVars = new Set<string>();
  for (const step of steps) {
    if (step.config.type === "api_call" && (step.config as ApiCallStep).as) {
      forEachAsVars.add((step.config as ApiCallStep).as!);
    }
  }

  const templateRewriters = paramProps
    .filter((name) => !forEachAsVars.has(name))
    .map((name) => ({
      name,
      re: new RegExp(`\\{\\{(?!params\\.)${name}\\.`, "g"),
      replacement: `{{params.${name}.`,
    }));

  const jsRewriters = paramProps
    .filter((name) => !forEachAsVars.has(name))
    .map((name) => ({
      name,
      re: new RegExp(`(?<!params\\.)\\b${name}\\.`, "g"),
      replacement: `params.${name}.`,
    }));

  type SubFieldRule = {
    subField: string;
    parent: string;
    templateRe: RegExp;
    templateReplacement: string;
    jsRe: RegExp;
    jsReplacement: string;
  };
  const subFieldRewriters: SubFieldRule[] = [];
  const paramPropSet = new Set(paramProps);

  for (const parentName of paramProps) {
    if (forEachAsVars.has(parentName)) continue;
    const parentSchema = params.properties![parentName] as
      | JSONSchema7
      | undefined;
    if (!parentSchema || typeof parentSchema === "boolean") continue;
    const subProps = parentSchema.properties
      ? Object.keys(parentSchema.properties)
      : [];
    for (const subName of subProps) {
      if (paramPropSet.has(subName)) continue;
      subFieldRewriters.push({
        subField: subName,
        parent: parentName,
        templateRe: new RegExp(`\\{\\{params\\.${subName}\\.`, "g"),
        templateReplacement: `{{params.${parentName}.${subName}.`,
        jsRe: new RegExp(`\\bparams\\.${subName}\\.`, "g"),
        jsReplacement: `params.${parentName}.${subName}.`,
      });
    }
  }

  function rewriteTemplate(
    stepId: string,
    value: string,
    fieldName: string,
  ): string {
    let result = value;
    for (const rule of templateRewriters) {
      const rewritten = result.replace(rule.re, rule.replacement);
      if (rewritten !== result) {
        warnings.push({
          stepId,
          code: "EVENT_PARAM_REWRITTEN",
          message: `Rewritten event param shorthand in ${fieldName}: "${rule.name}." → "params.${rule.name}."`,
        });
        result = rewritten;
      }
    }
    for (const rule of subFieldRewriters) {
      const rewritten = result.replace(
        rule.templateRe,
        rule.templateReplacement,
      );
      if (rewritten !== result) {
        warnings.push({
          stepId,
          code: "EVENT_PARAM_REWRITTEN",
          message: `Rewritten sub-field shorthand in ${fieldName}: "params.${rule.subField}." → "params.${rule.parent}.${rule.subField}."`,
        });
        result = rewritten;
      }
    }
    return result;
  }

  function rewriteJs(stepId: string, value: string, fieldName: string): string {
    let result = value;
    for (const rule of jsRewriters) {
      const rewritten = result.replace(rule.re, rule.replacement);
      if (rewritten !== result) {
        warnings.push({
          stepId,
          code: "EVENT_PARAM_REWRITTEN",
          message: `Rewritten event param shorthand in ${fieldName}: "${rule.name}." → "params.${rule.name}."`,
        });
        result = rewritten;
      }
    }
    for (const rule of subFieldRewriters) {
      const rewritten = result.replace(rule.jsRe, rule.jsReplacement);
      if (rewritten !== result) {
        warnings.push({
          stepId,
          code: "EVENT_PARAM_REWRITTEN",
          message: `Rewritten sub-field shorthand in ${fieldName}: "params.${rule.subField}." → "params.${rule.parent}.${rule.subField}."`,
        });
        result = rewritten;
      }
    }
    return result;
  }

  function rewriteValue(
    stepId: string,
    value: unknown,
    fieldName: string,
  ): unknown {
    if (typeof value === "string")
      return rewriteTemplate(stepId, value, fieldName);
    if (Array.isArray(value))
      return value.map((item, i) =>
        rewriteValue(stepId, item, `${fieldName}[${i}]`),
      );
    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = rewriteValue(stepId, v, `${fieldName}.${k}`);
      }
      return result;
    }
    return value;
  }

  for (const step of steps) {
    const cfg = step.config;
    switch (cfg.type) {
      case "api_call": {
        const apiCfg = cfg as ApiCallStep;
        if (apiCfg.inputMapping) {
          apiCfg.inputMapping = rewriteValue(
            step.id,
            apiCfg.inputMapping,
            "inputMapping",
          ) as Record<string, unknown>;
        }
        if (apiCfg.forEach) {
          apiCfg.forEach = rewriteTemplate(step.id, apiCfg.forEach, "forEach");
        }
        break;
      }
      case "sampling": {
        const sCfg = cfg as SamplingStep;
        sCfg.prompt = rewriteTemplate(step.id, sCfg.prompt, "prompt");
        if (sCfg.systemPrompt)
          sCfg.systemPrompt = rewriteTemplate(
            step.id,
            sCfg.systemPrompt,
            "systemPrompt",
          );
        if (sCfg.content) {
          for (const item of sCfg.content) {
            if (item.type === "text")
              item.text = rewriteTemplate(step.id, item.text, "content.text");
          }
        }
        break;
      }
      case "elicitation": {
        const eCfg = cfg as ElicitationStep;
        eCfg.message = rewriteTemplate(step.id, eCfg.message, "message");
        break;
      }
      case "conditional": {
        const cCfg = cfg as ConditionalStep;
        cCfg.condition = rewriteJs(step.id, cCfg.condition, "condition");
        break;
      }
      case "transform": {
        const tCfg = cfg as TransformStep;
        tCfg.expression = rewriteJs(step.id, tCfg.expression, "expression");
        break;
      }
    }
  }

  return warnings;
}

/**
 * Escape a string literal for use inside double-quoted JS strings.
 */
function escapeStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Convert Handlebars-style block helpers to JS expressions.
 * Supports {{#each collection}}...{{/each}} and {{#if cond}}...{{else}}...{{/if}}.
 * Throws ComposerError for unsupported or nested blocks.
 */
function convertHandlebarsBlocks(
  input: string,
  stepId: string,
  fieldName: string,
  warnings: ComposerWarning[],
): string {
  let result = input;

  // Detect unsupported block helpers ({{#unless}}, {{#with}}, etc.)
  const unsupportedBlock = result.match(/\{\{#(?!each\b|if\b)(\w+)/);
  if (unsupportedBlock) {
    throw new ComposerError(
      `Step "${stepId}" field "${fieldName}" uses unsupported Handlebars helper "{{#${unsupportedBlock[1]}}}". ` +
        `The template engine uses {{jsExpression}} syntax. ` +
        `Use JavaScript expressions instead (e.g. array.map(), ternary operators).`,
    );
  }

  // Convert {{#each collection}}...body...{{/each}}
  const eachRe = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
  result = result.replace(eachRe, (_, collection: string, body: string) => {
    const col = collection.trim();

    // Check for nested blocks — bail with clear error
    if (/\{\{#(each|if)\b/.test(body)) {
      throw new ComposerError(
        `Step "${stepId}" field "${fieldName}" uses nested Handlebars blocks which cannot be auto-converted. ` +
          `Use JavaScript expressions instead. Example: ` +
          `{{${col}.map(item => item.name + ": " + item.value).join("\\n")}}`,
      );
    }

    // Split body into static parts and dynamic {{this.X}} / {{this}} references
    // Build: collection.map(item => "static" + (item.field ?? "") + "static").join("")
    const parts: string[] = [];
    let lastIndex = 0;
    const refRe = /\{\{this(?:\.(\w+(?:\.\w+)*))?\}\}/g;
    let match;
    while ((match = refRe.exec(body)) !== null) {
      // Static part before this reference
      if (match.index > lastIndex) {
        parts.push(
          `"${escapeStringLiteral(body.slice(lastIndex, match.index))}"`,
        );
      }
      // Dynamic part
      const fieldPath = match[1];
      if (fieldPath) {
        parts.push(`(item.${fieldPath} ?? "")`);
      } else {
        parts.push(`(item ?? "")`);
      }
      lastIndex = match.index + match[0].length;
    }
    // Trailing static part
    if (lastIndex < body.length) {
      parts.push(`"${escapeStringLiteral(body.slice(lastIndex))}"`);
    }

    const mapBody = parts.length > 0 ? parts.join(" + ") : '""';
    const expr = `{{${col}.map(item => ${mapBody}).join("")}}`;

    // Validate the generated expression compiles
    try {
      const innerExpr = expr.slice(2, -2); // strip {{ }}
      new Function("steps", "params", `"use strict"; return (${innerExpr});`);
    } catch {
      throw new ComposerError(
        `Step "${stepId}" field "${fieldName}": auto-converted Handlebars {{#each}} failed to compile. ` +
          `Original: "${_.trim()}". Converted: "${expr}". ` +
          `Use JavaScript expressions directly instead.`,
      );
    }

    warnings.push({
      stepId,
      code: "FIELD_STRIPPED",
      message: `Auto-converted Handlebars {{#each}} to JS in ${fieldName}`,
    });
    return expr;
  });

  // Convert {{#if cond}}...then...{{else}}...else...{{/if}}
  // and {{#if cond}}...then...{{/if}}
  const ifElseRe =
    /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g;
  result = result.replace(
    ifElseRe,
    (_, condition: string, thenBody: string, elseBody: string) => {
      const cond = condition.trim();
      if (
        /\{\{#(each|if)\b/.test(thenBody) ||
        /\{\{#(each|if)\b/.test(elseBody)
      ) {
        throw new ComposerError(
          `Step "${stepId}" field "${fieldName}" uses nested Handlebars blocks inside {{#if}} which cannot be auto-converted.`,
        );
      }
      const thenStr = escapeStringLiteral(thenBody);
      const elseStr = escapeStringLiteral(elseBody);
      warnings.push({
        stepId,
        code: "FIELD_STRIPPED",
        message: `Auto-converted Handlebars {{#if}}...{{else}} to JS ternary in ${fieldName}`,
      });
      return `{{${cond} ? "${thenStr}" : "${elseStr}"}}`;
    },
  );

  const ifOnlyRe = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  result = result.replace(
    ifOnlyRe,
    (_, condition: string, thenBody: string) => {
      const cond = condition.trim();
      if (/\{\{#(each|if)\b/.test(thenBody)) {
        throw new ComposerError(
          `Step "${stepId}" field "${fieldName}" uses nested Handlebars blocks inside {{#if}} which cannot be auto-converted.`,
        );
      }
      const thenStr = escapeStringLiteral(thenBody);
      warnings.push({
        stepId,
        code: "FIELD_STRIPPED",
        message: `Auto-converted Handlebars {{#if}} to JS ternary in ${fieldName}`,
      });
      return `{{${cond} ? "${thenStr}" : ""}}`;
    },
  );

  return result;
}

function normalizeTemplateFields(steps: ComposeStepInput[]): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];

  const asVars = new Set<string>();
  for (const step of steps) {
    if (step.config.type === "api_call" && (step.config as ApiCallStep).as) {
      asVars.add((step.config as ApiCallStep).as!);
    }
  }

  function normalizeString(
    stepId: string,
    value: string,
    fieldName: string,
  ): string {
    // First: convert any Handlebars block syntax to JS expressions
    let result = /\{\{#/.test(value)
      ? convertHandlebarsBlocks(value, stepId, fieldName, warnings)
      : value;

    if (/^(steps|params)\.\w+(\.\w+)*$/.test(result)) {
      const wrapped = `{{${result}}}`;
      warnings.push({
        stepId,
        code: "TEMPLATE_AUTO_WRAPPED",
        message: `Auto-wrapped bare reference in ${fieldName}: "${value}" → "${wrapped}"`,
      });
      result = wrapped;
    }

    for (const asVar of asVars) {
      const asRefRe = new RegExp(
        `\\{\\{${asVar}\\.(\\w+(?:\\.\\w+)*)\\}\\}`,
        "g",
      );
      const rewritten = result.replace(asRefRe, `{{steps.${asVar}.$1}}`);
      if (rewritten !== result) {
        warnings.push({
          stepId,
          code: "AS_VAR_REWRITTEN",
          message: `Rewritten as-variable reference in ${fieldName}: "${result}" → "${rewritten}"`,
        });
        result = rewritten;
      }
    }

    // Auto-strip legacy .result. from step references (Gemini training data may still emit it)
    const stripped = result.replace(/\{\{(steps\.\w+)\.result\./g, "{{$1.");
    if (stripped !== result) {
      warnings.push({
        stepId,
        code: "FIELD_STRIPPED",
        message: `Auto-stripped legacy .result from step reference in ${fieldName}: "${result}" → "${stripped}"`,
      });
      result = stripped;
    }

    return result;
  }

  function normalizeValue(
    stepId: string,
    value: unknown,
    fieldName: string,
  ): unknown {
    if (typeof value === "string") {
      // Detect stringified JSON objects/arrays and parse them back to native types
      if (/^\s*[\[{]/.test(value)) {
        try {
          const parsed = JSON.parse(value);
          if (typeof parsed === "object" && parsed !== null) {
            warnings.push({
              stepId,
              code: "STRINGIFIED_JSON_PARSED",
              message: `Auto-parsed stringified JSON in ${fieldName}: "${value.length > 60 ? value.slice(0, 60) + "..." : value}"`,
            });
            return normalizeValue(stepId, parsed, fieldName);
          }
        } catch {}
      }
      return normalizeString(stepId, value, fieldName);
    }
    if (Array.isArray(value)) {
      return value.map((item, i) =>
        normalizeValue(stepId, item, `${fieldName}[${i}]`),
      );
    }
    if (typeof value === "object" && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = normalizeValue(stepId, v, `${fieldName}.${k}`);
      }
      return result;
    }
    return value;
  }

  for (const step of steps) {
    const cfg = step.config;
    switch (cfg.type) {
      case "api_call": {
        const apiCfg = cfg as ApiCallStep;

        if (apiCfg.inputMapping) {
          const keys = Object.keys(apiCfg.inputMapping);
          if (
            keys.length === 1 &&
            (keys[0] === "requestBody" || keys[0] === "body")
          ) {
            const inner = apiCfg.inputMapping[keys[0]];
            if (
              typeof inner === "object" &&
              inner !== null &&
              !Array.isArray(inner)
            ) {
              apiCfg.inputMapping = inner as Record<string, unknown>;
              warnings.push({
                stepId: step.id,
                code: "REQUEST_BODY_UNWRAPPED",
                message: `Auto-unwrapped "${keys[0]}" wrapper in inputMapping for step "${step.id}".`,
              });
            }
          }
        }

        if (apiCfg.inputMapping) {
          apiCfg.inputMapping = normalizeValue(
            step.id,
            apiCfg.inputMapping,
            "inputMapping",
          ) as Record<string, unknown>;
        }
        if (apiCfg.forEach) {
          apiCfg.forEach = normalizeString(step.id, apiCfg.forEach, "forEach");
        }
        break;
      }
      case "sampling": {
        const sCfg = cfg as SamplingStep;
        sCfg.prompt = normalizeString(step.id, sCfg.prompt, "prompt");
        if (sCfg.systemPrompt) {
          sCfg.systemPrompt = normalizeString(
            step.id,
            sCfg.systemPrompt,
            "systemPrompt",
          );
        }
        if (sCfg.content) {
          for (const item of sCfg.content) {
            if (item.type === "text") {
              item.text = normalizeString(step.id, item.text, "content.text");
            }
          }
        }
        break;
      }
      case "elicitation": {
        const eCfg = cfg as ElicitationStep;
        eCfg.message = normalizeString(step.id, eCfg.message, "message");
        break;
      }
      // transform and conditional use raw JS — do NOT normalize templates,
      // but DO strip legacy .result references
      case "transform": {
        const tCfg = cfg as TransformStep;
        const stripped = tCfg.expression.replace(
          /\bsteps\.(\w+)\.result\b/g,
          "steps.$1",
        );
        if (stripped !== tCfg.expression) {
          warnings.push({
            stepId: step.id,
            code: "FIELD_STRIPPED",
            message: `Auto-stripped legacy .result from transform expression: "${tCfg.expression}" → "${stripped}"`,
          });
          tCfg.expression = stripped;
        }
        break;
      }
      case "conditional": {
        const cCfg = cfg as ConditionalStep;
        const stripped = cCfg.condition.replace(
          /\bsteps\.(\w+)\.result\b/g,
          "steps.$1",
        );
        if (stripped !== cCfg.condition) {
          warnings.push({
            stepId: step.id,
            code: "FIELD_STRIPPED",
            message: `Auto-stripped legacy .result from conditional: "${cCfg.condition}" → "${stripped}"`,
          });
          cCfg.condition = stripped;
        }
        break;
      }
    }
  }

  return warnings;
}

function flattenNestedSteps(steps: ComposeStepInput[]): ComposerWarning[] {
  const warnings: ComposerWarning[] = [];
  const extracted: ComposeStepInput[] = [];

  for (const step of steps) {
    const cfg = step.config as unknown as Record<string, unknown>;
    for (const key of ["steps", "subSteps"] as const) {
      const nested = cfg[key];
      if (!Array.isArray(nested)) continue;
      for (const sub of nested) {
        if (sub && typeof sub === "object" && sub.id) {
          const subStep: ComposeStepInput = {
            id: sub.id,
            label: sub.label ?? sub.id,
            config: sub.config ?? sub,
            dependsOn: [step.id],
          };
          extracted.push(subStep);
          warnings.push({
            stepId: step.id,
            code: "IMPLICIT_DEP_ADDED",
            message: `Flattened nested step "${sub.id}" from "${step.id}.${key}" to top-level with dependsOn: ["${step.id}"]`,
          });
        }
      }
      delete cfg[key];
    }
  }

  steps.push(...extracted);
  return warnings;
}

export function composeWorkflowDefinition(
  input: ComposeWorkflowInput,
): ComposeWorkflowResult {
  const {
    name,
    description,
    triggerEvent,
    command,
    params,
    steps,
    persistence,
  } = input;

  if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new ComposerError(
      `Invalid workflow name "${name}": must be lowercase with underscores (e.g. "onboard_user")`,
    );
  }

  if (!description) {
    throw new ComposerError("Workflow description is required");
  }

  if (steps.length === 0) {
    throw new ComposerError("Workflow must have at least one step");
  }

  const flattenWarnings = flattenNestedSteps(steps);
  validateUniqueIds(steps);
  const fieldNormWarnings = normalizeStepFields(steps);
  for (const step of steps) {
    validateStepConfig(step);
  }

  const eventParamWarnings = normalizeEventParamShorthand(steps, params);

  const normalizationWarnings = normalizeTemplateFields(steps);

  validateReferences(steps);

  const implicitDepWarnings = injectImplicitDependencies(steps);

  detectCycles(steps);

  const templateRefWarnings = validateTemplateReferences(steps, params);

  validateDataFlowTypes(steps);

  const samplingSchemaWarnings = inferSamplingResponseSchemas(steps);

  const semanticWarnings = generateSemanticWarnings(steps, params);

  const persistenceWarnings = persistence
    ? validatePersistenceConfig(persistence, steps)
    : [];

  const allWarnings = [
    ...flattenWarnings,
    ...fieldNormWarnings,
    ...eventParamWarnings,
    ...normalizationWarnings,
    ...implicitDepWarnings,
    ...templateRefWarnings,
    ...samplingSchemaWarnings,
    ...semanticWarnings,
    ...persistenceWarnings,
  ];

  const executionOrder = topologicalSort(steps);

  const orderedSteps: WorkflowStep[] = executionOrder.map((id) => {
    const step = steps.find((s) => s.id === id)!;
    const ws: WorkflowStep = {
      id: step.id,
      label: step.label,
      config: step.config,
    };
    if (step.dependsOn && step.dependsOn.length > 0) {
      ws.dependsOn = step.dependsOn;
    }
    return ws;
  });

  const usesSampling = steps.some((s) => s.config.type === "sampling");
  const usesElicitation = steps.some((s) => s.config.type === "elicitation");
  const hasConditionals = steps.some((s) => s.config.type === "conditional");

  const requiredEndpoints = steps
    .filter((s) => s.config.type === "api_call")
    .map((s) => (s.config as ApiCallStep).operationId);

  const workflow: WorkflowDefinition = {
    name,
    description,
    ...(triggerEvent ? { triggerEvent } : {}),
    ...(command ? { command } : {}),
    params,
    steps: orderedSteps,
    requiredEndpoints,
    usesSampling,
    usesElicitation,
    ...(persistence ? { persistence } : {}),
  };

  return {
    workflow,
    executionOrder,
    summary: {
      stepCount: steps.length,
      apiCalls: requiredEndpoints,
      usesSampling,
      usesElicitation,
      hasConditionals,
    },
    warnings: allWarnings,
  };
}
