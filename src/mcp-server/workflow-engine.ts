export interface StepDefinition {
  id: string;
  label: string;
  type: "api_call" | "sampling" | "elicitation" | "transform" | "conditional";
  dependsOn?: string[];
  continueOnError?: boolean;
  operationId?: string;
  inputMapping?: Record<string, unknown>;
  outputPath?: string;
  forEach?: string;
  as?: string;
  prompt?: string;
  content?: Array<
    { type: "text"; text: string } | { type: "image"; url: string }
  >;
  systemPrompt?: string;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  responseSchema?: Record<string, string>;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  onDecline?: "abort" | "skip_remaining";
  expression?: string;
  condition?: string;
  thenStep?: string;
  elseStep?: string;
}

export interface EndpointInfo {
  method: string;
  path: string;
}

export interface DeferredAction {
  stepId: string;
  operationId: string;
  method: string;
  path: string;
  payload: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
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

const JS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
  "arguments",
  "eval",
]);

function isValidParamName(name: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) && !JS_RESERVED.has(name);
}

/** Build JS scope: params + steps + bare param keys as identifiers; locals (forEach vars) shadow params. */
function buildJsScope(
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
  locals: Record<string, unknown> = {},
): { argNames: string[]; argValues: unknown[] } {
  const scope = new Map<string, unknown>();
  scope.set("params", params);
  scope.set("steps", steps);
  for (const [k, v] of Object.entries(params)) {
    if (isValidParamName(k)) scope.set(k, v);
  }
  for (const [k, v] of Object.entries(locals)) {
    if (isValidParamName(k)) scope.set(k, v);
  }
  return { argNames: [...scope.keys()], argValues: [...scope.values()] };
}

export function resolveTemplate(
  template: string,
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
  locals: Record<string, unknown> = {},
): string {
  const cleaned = template
    .replace(/\{\{\[params\.([^\]]+)\]\}\}/g, "{{params.$1}}")
    .replace(/\{\{\[steps\.([^\]]+)\]\}\}/g, "{{steps.$1}}");

  const { argNames: scopeNames, argValues: scopeValues } = buildJsScope(
    params,
    steps,
    locals,
  );

  return cleaned.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    try {
      validateExpression(expr.trim(), "template");
      const fn = new Function(
        ...scopeNames,
        `"use strict"; return (${expr.trim()});`,
      );
      const val = fn(...scopeValues);
      return typeof val === "object" && val !== null
        ? JSON.stringify(val)
        : String(val ?? "");
    } catch {
      return "";
    }
  });
}

function resolveValue(
  value: unknown,
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
  locals: Record<string, unknown> = {},
): unknown {
  if (typeof value === "string" && value.includes("{{")) {
    const result = resolveTemplate(value, params, steps, locals);
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (Array.isArray(value)) {
    return value.map((el) => resolveValue(el, params, steps, locals));
  }
  if (typeof value === "object" && value !== null) {
    return resolveMapping(
      value as Record<string, unknown>,
      params,
      steps,
      locals,
    );
  }
  return value;
}

export function resolveMapping(
  mapping: Record<string, unknown>,
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
  locals: Record<string, unknown> = {},
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    resolved[key] = resolveValue(value, params, steps, locals);
  }
  return resolved;
}

export function extractPath(result: unknown, path: string): unknown {
  const parsed = parseResult(result);
  return path.split(".").reduce((o: any, k: string) => o?.[k], parsed);
}

export function detectJsonIntent(step: StepDefinition): boolean {
  const haystack =
    `${step.systemPrompt || ""} ${step.prompt || ""}`.toLowerCase();
  return (
    haystack.includes("json") ||
    haystack.includes("respond with a json") ||
    haystack.includes("respond only with") ||
    haystack.includes("return a json") ||
    haystack.includes("output format:")
  );
}

export function extractJson(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const closer = ch === "{" ? "}" : "]";

    for (
      let end = text.lastIndexOf(closer);
      end >= i;
      end = text.lastIndexOf(closer, end - 1)
    ) {
      const candidate = text.substring(i, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function parseResult(result: unknown): unknown {
  const r = result as any;
  if (!r?.content?.[0]?.text) return result;
  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return r.content[0].text;
  }
}

interface ExecutionState {
  params: Record<string, unknown>;
  stepResults: Record<string, any>;
  stepStatus: Record<string, "success" | "skipped" | "error">;
  stepErrors: Record<string, string>;
  completedSteps: string[];
  nextStepOverride: string | null;
  skipStep: string | null;
  stepDeps: Record<string, string[]>;
  deferredActions: DeferredAction[];
  botUsernames: Set<string>;
}

export function shouldRun(stepId: string, state: ExecutionState): boolean {
  if (state.skipStep === stepId) {
    state.skipStep = null;
    state.stepResults[stepId] = null;
    state.stepStatus[stepId] = "skipped";
    return false;
  }
  if (state.nextStepOverride !== null) {
    if (stepId === state.nextStepOverride) {
      state.nextStepOverride = null;
      return true;
    }
    return false;
  }
  const deps = state.stepDeps[stepId] || [];
  // Phase 1: Wait until every dependency reaches a terminal state
  const allTerminal = deps.every(
    (d) =>
      state.completedSteps.includes(d) || state.stepStatus[d] === "skipped",
  );
  if (!allTerminal) return false;
  // Phase 2: Skip only when ALL deps were skipped (no useful input)
  if (deps.length > 0 && deps.every((d) => state.stepStatus[d] === "skipped")) {
    state.stepResults[stepId] = null;
    state.stepStatus[stepId] = "skipped";
    return false;
  }
  // Phase 3: At least one dep succeeded — run this step
  return true;
}

// ── Bot message filtering ─────────────────────────────────────────────────
// Search/read endpoints return { messages: [...] } where each message has
// .u.username. To prevent the bot's own messages from polluting its own
// search results (e.g. "⏳ Running /kb ..." appearing in chat_search), we
// strip messages authored by any of the bot's known identities.
const MESSAGE_READ_OPS =
  /chat[._-](search|getPinnedMessages|getStarredMessages|getMentionedMessages|getThreadMessages)|channels[._-](history|messages)|groups[._-](history|messages)|im[._-](history|messages)/;

export function filterBotMessages(
  result: unknown,
  botUsernames: Set<string>,
): unknown {
  if (!botUsernames.size || typeof result !== "object" || result === null)
    return result;

  const obj = result as Record<string, unknown>;
  if (Array.isArray(obj.messages)) {
    obj.messages = (obj.messages as Array<Record<string, any>>).filter(
      (m) => !botUsernames.has(m?.u?.username),
    );
  }
  return result;
}

export function shouldFilterBotMessages(
  operationId: string | undefined,
): boolean {
  return !!operationId && MESSAGE_READ_OPS.test(operationId);
}

// ── Message size safety ───────────────────────────────────────────────────
// RC's Message_MaxAllowedSize (default 5000) rejects oversized messages
// with error-message-size-exceeded. Truncate msg/text fields before POSTing
// to prevent cascading failures (error → huge error msg → also too big).
const MSG_WRITE_OPS =
  /chat[._-](sendMessage|postMessage|update)|channels[._-]setTopic|groups[._-]setTopic/;
const RC_MSG_MAX = 4000;

export function truncateMessageFields(
  payload: Record<string, unknown>,
  operationId: string | undefined,
): void {
  if (!operationId || !MSG_WRITE_OPS.test(operationId)) return;

  // chat.sendMessage: { message: { msg } }
  const message = payload.message as Record<string, unknown> | undefined;
  if (
    message &&
    typeof message.msg === "string" &&
    message.msg.length > RC_MSG_MAX
  ) {
    message.msg = message.msg.slice(0, RC_MSG_MAX) + "\n…(truncated)";
  }
  // chat.postMessage: { msg } or { text }
  if (typeof payload.msg === "string" && payload.msg.length > RC_MSG_MAX) {
    payload.msg = payload.msg.slice(0, RC_MSG_MAX) + "\n…(truncated)";
  }
  if (typeof payload.text === "string" && payload.text.length > RC_MSG_MAX) {
    payload.text = payload.text.slice(0, RC_MSG_MAX) + "\n…(truncated)";
  }
}

async function executeApiCall(
  step: StepDefinition,
  state: ExecutionState,
  client: any,
  endpoints: Record<string, EndpointInfo>,
): Promise<void> {
  if (step.forEach && step.as) {
    const collectionExpr = step.forEach;
    const itemVar = step.as;
    const raw = resolveValue(collectionExpr, state.params, state.stepResults);
    const collection = Array.isArray(raw) ? raw : [];
    const results: unknown[] = [];

    for (const item of collection) {
      try {
        const augmentedSteps = {
          ...state.stepResults,
          [itemVar]: item,
        };
        // Inject the forEach variable directly into scope so bare {{room._id}} works
        const locals: Record<string, unknown> = { [itemVar]: item };
        const args = resolveMapping(
          step.inputMapping || {},
          state.params,
          augmentedSteps,
          locals,
        );
        const result = await executeSingleApiCall(
          step,
          args as Record<string, unknown>,
          state,
          client,
          endpoints,
        );
        results.push(result);
      } catch (err) {
        console.error(
          `[forEach] ${step.id} iteration failed:`,
          err instanceof Error ? err.message : err,
        );
        results.push(null);
      }
    }

    state.stepResults[step.id] = results;
    state.stepStatus[step.id] = "success";
    state.completedSteps.push(step.id);
    return;
  }

  const mapping = step.inputMapping || {};
  const args = resolveMapping(mapping, state.params, state.stepResults);
  const result = await executeSingleApiCall(
    step,
    args as Record<string, unknown>,
    state,
    client,
    endpoints,
  );

  // executeSingleApiCall already applies outputPath + parseResult,
  // so just store the result directly — no double-extraction.
  state.stepResults[step.id] = result;
  state.stepStatus[step.id] = "success";
  state.completedSteps.push(step.id);
}

const MONGO_ID_RE = /^[A-Za-z0-9]{17,24}$/;
function looksLikeMongoId(v: string): boolean {
  return MONGO_ID_RE.test(v);
}

const ROOM_ERROR_RE =
  /error-room-not-found|error-invalid-room|error-channel-not-found|Channel not found|Room not found|not-found/i;

const MSG_CHANNEL_ERROR_RE =
  /error-not-allowed|not-authorized|error-room-not-found|error-invalid-room|Channel not found|Room not found|not-found/i;

const MSG_POST_OPS = /chat[._-](postMessage|sendMessage)/;

// ── Channel access helpers ────────────────────────────────────────────────
// These handle the full lifecycle: create if needed → bot joins → invite members.
// Used both by the channels_create duplicate handler and the message-posting
// auto-recovery, so the logic is in one place.

async function botJoinChannel(roomId: string, client: any): Promise<void> {
  try {
    await client.request("POST", "/api/v1/channels.join", {
      auth: true,
      body: { roomId },
    });
  } catch {
    // Already a member or can't join — either way, continue
  }
}

async function inviteMembers(
  roomId: string,
  members: string[],
  isGroup: boolean,
  client: any,
): Promise<void> {
  if (members.length === 0) return;
  const inviteEndpoint = isGroup
    ? "/api/v1/groups.invite"
    : "/api/v1/channels.invite";
  for (const member of members) {
    try {
      const body = looksLikeMongoId(member)
        ? { roomId, userId: member }
        : { roomId, username: member };
      await client.request("POST", inviteEndpoint, { auth: true, body });
    } catch {}
  }
}

function getMirrorPath(path: string): string | null {
  if (path.includes("/channels."))
    return path.replace("/channels.", "/groups.");
  if (path.includes("/groups.")) return path.replace("/groups.", "/channels.");
  return null;
}

async function resolveRoomId(
  roomName: string,
  client: any,
): Promise<string | null> {
  const encoded = encodeURIComponent(roomName);
  try {
    const info = await client.request(
      "GET",
      `/api/v1/channels.info?roomName=${encoded}`,
      { auth: true },
    );
    const parsed = parseResult(info) as any;
    if (parsed?.channel?._id) return parsed.channel._id;
  } catch {}
  try {
    const info = await client.request(
      "GET",
      `/api/v1/groups.info?roomName=${encoded}`,
      { auth: true },
    );
    const parsed = parseResult(info) as any;
    if (parsed?.group?._id) return parsed.group._id;
  } catch {}
  return null;
}

async function resolveUserId(
  username: string,
  client: any,
): Promise<string | null> {
  try {
    const info = await client.request(
      "GET",
      `/api/v1/users.info?username=${encodeURIComponent(username)}`,
      { auth: true },
    );
    const parsed = parseResult(info) as any;
    if (parsed?.user?._id) return parsed.user._id;
  } catch {}
  return null;
}

async function resolveUsername(
  userId: string,
  client: any,
): Promise<string | null> {
  try {
    const info = await client.request(
      "GET",
      `/api/v1/users.info?userId=${encodeURIComponent(userId)}`,
      { auth: true },
    );
    const parsed = parseResult(info) as any;
    if (parsed?.user?.username) return parsed.user.username;
  } catch {}
  return null;
}

async function normalizePayload(
  payload: Record<string, unknown>,
  client: any,
): Promise<void> {
  if (typeof payload.name === "string") {
    payload.name = payload.name
      .toLowerCase()
      .replace(/[^a-z0-9\-_.]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);
  }

  for (const field of ["roomId", "rid"] as const) {
    if (
      typeof payload[field] === "string" &&
      !looksLikeMongoId(payload[field] as string)
    ) {
      const val = payload[field] as string;
      if (val === "GENERAL" || val.length === 0) continue;
      const resolved = await resolveRoomId(val, client);
      if (resolved) payload[field] = resolved;
    }
  }

  if (
    typeof payload.userId === "string" &&
    !looksLikeMongoId(payload.userId as string)
  ) {
    const resolved = await resolveUserId(payload.userId as string, client);
    if (resolved) payload.userId = resolved;
  }

  if (Array.isArray(payload.members)) {
    const resolved: string[] = [];
    for (const member of payload.members as string[]) {
      if (typeof member === "string" && looksLikeMongoId(member)) {
        const username = await resolveUsername(member, client);
        resolved.push(username || member);
      } else {
        resolved.push(member as string);
      }
    }
    const adminUser = process.env.ROCKETCHAT_USER;
    if (adminUser && !resolved.includes(adminUser)) {
      resolved.push(adminUser);
    }
    payload.members = resolved;
  }

  // Prefix bare channel names with "#" for the RC postMessage API
  if (typeof payload.channel === "string" && payload.channel.length > 0) {
    const ch = payload.channel;
    if (!ch.startsWith("#") && !ch.startsWith("@") && !looksLikeMongoId(ch)) {
      payload.channel = `#${ch}`;
    }
  }

  if (payload.channel === "@admin") {
    const adminUser = process.env.ROCKETCHAT_USER;
    if (adminUser) payload.channel = `@${adminUser}`;
  }
}

async function executeSingleApiCall(
  step: StepDefinition,
  payload: Record<string, unknown>,
  state: ExecutionState,
  client: any,
  endpoints: Record<string, EndpointInfo>,
): Promise<unknown> {
  const ep = endpoints[step.operationId!];
  const method = ep?.method?.toUpperCase() || "GET";
  const path = ep?.path || "";

  if (step.inputMapping) {
    for (const [key, raw] of Object.entries(step.inputMapping)) {
      if (typeof raw !== "string" || !raw.includes("{{")) continue;
      const resolved = payload[key];
      if (resolved !== "" && resolved !== undefined && resolved !== null)
        continue;

      // Check if the root reference actually exists in params/steps
      const paramMatch = raw.match(/\{\{\s*params\.(\w+)/);
      const stepMatch = raw.match(/\{\{\s*steps\.(\w+)/);

      if (paramMatch && !(paramMatch[1] in state.params)) {
        // Root param doesn't exist — genuinely optional (e.g. threadId absent)
        delete payload[key];
      } else if (stepMatch && !(stepMatch[1] in state.stepResults)) {
        // Referenced step hasn't run — strip
        delete payload[key];
      } else {
        // Root exists but resolved to empty — that's a real problem
        throw new Error(
          `Parameter "${key}" resolved to empty (template: ${raw}). ` +
            `The referenced value exists but is empty or broken.`,
        );
      }
    }
  }

  await normalizePayload(payload, client);
  truncateMessageFields(payload, step.operationId);

  // Coerce stringified-JSON values back to objects so they serialize correctly
  if (method === "GET") {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && /^[\[{]/.test(v)) {
        try {
          payload[k] = JSON.parse(v);
        } catch {}
      }
    }
  }

  const result = await client.request(
    method,
    method === "GET"
      ? path +
          "?" +
          new URLSearchParams(
            Object.entries(payload).reduce(
              (a, [k, v]) => ({
                ...a,
                [k]:
                  typeof v === "object" && v !== null
                    ? JSON.stringify(v)
                    : String(v ?? ""),
              }),
              {} as Record<string, string>,
            ),
          ).toString()
      : path,
    {
      auth: true,
      ...(method !== "GET" ? { body: payload } : {}),
    },
  );

  if (result.isError) {
    const errorText = result.content?.[0]?.text || "Unknown API error";

    if (
      errorText.includes("error-duplicate-channel-name") ||
      errorText.includes("duplicate")
    ) {
      const name = payload.name as string;
      const members = Array.isArray(payload.members)
        ? (payload.members as string[])
        : [];
      try {
        if (name) {
          const roomId = await resolveRoomId(name, client);
          if (roomId) {
            const isGroup = ep?.path?.includes("groups.");
            // Bot must be a member to post later
            await botJoinChannel(roomId, client);
            await inviteMembers(roomId, members, !!isGroup, client);
            const infoEndpoint = isGroup
              ? `/api/v1/groups.info?roomId=${encodeURIComponent(roomId)}`
              : `/api/v1/channels.info?roomId=${encodeURIComponent(roomId)}`;
            const info = await client.request("GET", infoEndpoint, {
              auth: true,
            });
            if (!info.isError) return parseResult(info);
          }
        }
      } catch {}
    }

    const mirrorPath = getMirrorPath(path);
    if (mirrorPath && ROOM_ERROR_RE.test(errorText)) {
      try {
        const mirrorResult = await client.request(
          method,
          method === "GET"
            ? mirrorPath +
                "?" +
                new URLSearchParams(
                  Object.entries(payload).reduce(
                    (a, [k, v]) => ({
                      ...a,
                      [k]:
                        typeof v === "object" && v !== null
                          ? JSON.stringify(v)
                          : String(v ?? ""),
                    }),
                    {} as Record<string, string>,
                  ),
                ).toString()
            : mirrorPath,
          {
            auth: true,
            ...(method !== "GET" ? { body: payload } : {}),
          },
        );
        if (!mirrorResult.isError) {
          const parsed = step.outputPath
            ? extractPath(mirrorResult, step.outputPath)
            : parseResult(mirrorResult);
          if (
            state.botUsernames.size &&
            shouldFilterBotMessages(step.operationId)
          )
            filterBotMessages(parsed, state.botUsernames);
          return parsed;
        }
      } catch {}
    }

    // ── Message-post auto-recovery ──────────────────────────────────────
    // If chat.postMessage / chat.sendMessage fails because the bot isn't
    // in the target channel, try to join (or create) it and retry once.
    if (
      step.operationId &&
      MSG_POST_OPS.test(step.operationId) &&
      MSG_CHANNEL_ERROR_RE.test(errorText)
    ) {
      // Resolve target channel from payload
      const channel =
        (payload.channel as string) ||
        ((payload.message as any)?.rid as string) ||
        "";
      if (channel) {
        try {
          // channel could be "#name", "@user", bare name, or a roomId
          const channelName = channel.startsWith("#")
            ? channel.slice(1)
            : channel.startsWith("@")
              ? null
              : !looksLikeMongoId(channel)
                ? channel
                : null;
          let roomId: string | null = null;

          if (channelName) {
            // Try to resolve by name
            roomId = await resolveRoomId(channelName, client);
            if (!roomId) {
              // Channel doesn't exist — create it
              try {
                const createRes = await client.request(
                  "POST",
                  "/api/v1/channels.create",
                  { auth: true, body: { name: channelName } },
                );
                const parsed = parseResult(createRes) as any;
                roomId = parsed?.channel?._id || null;
              } catch {}
              if (!roomId) roomId = await resolveRoomId(channelName, client);
            }
          } else if (looksLikeMongoId(channel)) {
            roomId = channel;
          }

          if (roomId) {
            await botJoinChannel(roomId, client);
            // Retry the original request
            const retryResult = await client.request(method, path, {
              auth: true,
              ...(method !== "GET" ? { body: payload } : {}),
            });
            if (!retryResult.isError) {
              const parsed = step.outputPath
                ? extractPath(retryResult, step.outputPath)
                : parseResult(retryResult);
              return parsed;
            }
          }
        } catch {}
      }
    }

    throw new Error(errorText);
  }

  const parsed = step.outputPath
    ? extractPath(result, step.outputPath)
    : parseResult(result);
  if (state.botUsernames.size && shouldFilterBotMessages(step.operationId))
    filterBotMessages(parsed, state.botUsernames);
  return parsed;
}

async function callGeminiDirect(
  userParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  >,
  opts: { systemPrompt?: string; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const genConfig: Record<string, unknown> = {
    maxOutputTokens: Math.max(opts.maxTokens || 1000, 1024),
  };
  if (opts.jsonMode) {
    genConfig.responseMimeType = "application/json";
    genConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: userParts }],
    generationConfig: genConfig,
  };
  if (opts.systemPrompt) {
    body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const data = (await resp.json()) as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

let _geminiCliAvailable: boolean | null = null;

function isGeminiCliAvailable(): boolean {
  if (_geminiCliAvailable !== null) return _geminiCliAvailable;
  try {
    execFileSync("gemini", ["--version"], { timeout: 5000, stdio: "ignore" });
    _geminiCliAvailable = true;
  } catch {
    _geminiCliAvailable = false;
  }
  return _geminiCliAvailable;
}

export function _resetCliCache(): void {
  _geminiCliAvailable = null;
}

async function callGeminiCli(
  prompt: string,
  opts: { systemPrompt?: string; maxTokens?: number; jsonMode?: boolean },
): Promise<string> {
  let fullPrompt = "";
  if (opts.systemPrompt) {
    fullPrompt += `[System Instructions]\n${opts.systemPrompt}\n\n[User Message]\n`;
  }
  fullPrompt += prompt;
  if (opts.jsonMode) {
    fullPrompt +=
      "\n\nRespond with ONLY valid JSON. No markdown fences, no explanation.";
  }

  const timeout = parseInt(process.env.GEMINI_CLI_TIMEOUT || "60000", 10);
  const args = [
    "-p",
    fullPrompt,
    "--output-format",
    "json",
    "--allowed-mcp-server-names",
    "_none_",
    "-e",
    "_none_",
  ];

  try {
    const { stdout, stderr } = await execFileAsync("gemini", args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB — generous for large responses
      env: { ...process.env, NO_COLOR: "1" },
    });

    if (stderr) {
      console.error(`[sampling/cli] stderr: ${stderr.substring(0, 500)}`);
    }

    if (!stdout || stdout.trim().length === 0) {
      const rateMsg = stderr?.match(
        /exhausted your capacity.*?reset after (\d+)s/i,
      );
      if (rateMsg) {
        throw new Error(
          `Gemini API rate limited (resets in ${rateMsg[1]}s). Increase GEMINI_CLI_TIMEOUT or wait.`,
        );
      }
      throw new Error("Gemini CLI returned empty output");
    }
    try {
      const parsed = JSON.parse(stdout);
      return parsed.response ?? "";
    } catch {
      console.error(
        `[sampling/cli] Failed to parse CLI output (${stdout.length} bytes): ${stdout.substring(0, 300)}`,
      );
      throw new Error(
        `Gemini CLI returned invalid JSON (${stdout.length} bytes). First 200 chars: ${stdout.substring(0, 200)}`,
      );
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        "Gemini CLI not found. Install with: npm install -g @google/gemini-cli",
      );
    }
    if (err.killed) {
      const stderrHint = err.stderr?.toString() || "";
      const rateMsg = stderrHint.match(
        /exhausted your capacity.*?reset after (\d+)s/i,
      );
      if (rateMsg) {
        throw new Error(
          `Gemini CLI timed out after ${timeout}ms (rate limited — resets in ${rateMsg[1]}s). Set GEMINI_CLI_TIMEOUT=120000 in .env.`,
        );
      }
      throw new Error(
        `Gemini CLI timed out after ${timeout}ms. Set GEMINI_CLI_TIMEOUT in .env to increase.`,
      );
    }
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    if (stdout || stderr) {
      console.error(
        `[sampling/cli] CLI failed. stdout (${stdout.length}b): ${stdout.substring(0, 300)}`,
      );
      console.error(
        `[sampling/cli] stderr (${stderr.length}b): ${stderr.substring(0, 500)}`,
      );
    }
    throw new Error(`Gemini CLI error: ${stderr || err.message}`);
  }
}

function buildFullPrompt(step: StepDefinition, state: ExecutionState): string {
  let prompt: string;
  if (step.content && step.content.length > 0) {
    prompt = step.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => resolveTemplate(c.text, state.params, state.stepResults))
      .join("\n");
  } else {
    prompt = resolveTemplate(
      step.prompt || "",
      state.params,
      state.stepResults,
    );
  }

  // Auto-inject responseSchema into the prompt so the LLM knows the exact shape
  if (step.responseSchema && Object.keys(step.responseSchema).length > 0) {
    const fields = Object.entries(step.responseSchema)
      .map(([name, type]) => `- ${name} (${type})`)
      .join("\n");
    prompt += `\n\nYou MUST respond with a JSON object containing exactly these fields:\n${fields}`;
  }

  return prompt;
}

async function executeSampling(
  step: StepDefinition,
  state: ExecutionState,
  server: any,
): Promise<void> {
  let text = "";

  const buildMcpMessages = (): Array<{
    role: "user";
    content: { type: string; text?: string; data?: string; mimeType?: string };
  }> => {
    const messages: Array<{
      role: "user";
      content: {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      };
    }> = [];
    if (step.content && step.content.length > 0) {
      for (const item of step.content) {
        if (item.type === "text") {
          messages.push({
            role: "user",
            content: {
              type: "text",
              text: resolveTemplate(item.text, state.params, state.stepResults),
            },
          });
        } else if (item.type === "image") {
          messages.push({
            role: "user",
            content: { type: "image", data: "", mimeType: "image/png" },
          });
        }
      }
    } else {
      const prompt = resolveTemplate(
        step.prompt || "",
        state.params,
        state.stepResults,
      );
      messages.push({
        role: "user",
        content: { type: "text", text: prompt },
      });
    }
    return messages;
  };

  const buildGeminiParts = async (): Promise<
    Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>
  > => {
    const parts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    > = [];
    if (step.content && step.content.length > 0) {
      for (const item of step.content) {
        if (item.type === "text") {
          parts.push({
            text: resolveTemplate(item.text, state.params, state.stepResults),
          });
        } else if (item.type === "image") {
          const imgUrl = resolveTemplate(
            item.url,
            state.params,
            state.stepResults,
          );
          const imgResp = await fetch(imgUrl);
          const imgBuf = Buffer.from(await imgResp.arrayBuffer());
          const imgType = imgResp.headers.get("content-type") || "image/png";
          parts.push({
            inlineData: { mimeType: imgType, data: imgBuf.toString("base64") },
          });
        }
      }
    } else {
      const prompt = resolveTemplate(
        step.prompt || "",
        state.params,
        state.stepResults,
      );
      parts.push({ text: prompt });
    }
    return parts;
  };

  let usedPath: "cli" | "direct" | "mcp" | "" = "";
  const hasImageContent = step.content?.some((c) => c.type === "image");
  const jsonMode = step.responseFormat === "json" || detectJsonIntent(step);

  const hasApiKey = !!(
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  );
  if (hasApiKey) {
    const parts = await buildGeminiParts();
    text = await callGeminiDirect(parts, {
      systemPrompt: step.systemPrompt,
      maxTokens: step.maxTokens,
      jsonMode,
    });
    usedPath = "direct";
  }

  if (!usedPath && !hasImageContent && isGeminiCliAvailable()) {
    const prompt = buildFullPrompt(step, state);
    text = await callGeminiCli(prompt, {
      systemPrompt: step.systemPrompt,
      maxTokens: step.maxTokens,
      jsonMode,
    });
    usedPath = "cli";
  }

  if (!usedPath && server?.server?.createMessage) {
    try {
      const messages = buildMcpMessages();

      if (step.content) {
        let msgIdx = 0;
        for (const item of step.content) {
          if (item.type === "image") {
            const imgUrl = resolveTemplate(
              item.url,
              state.params,
              state.stepResults,
            );
            const imgResp = await fetch(imgUrl);
            const imgBuf = Buffer.from(await imgResp.arrayBuffer());
            const imgType = imgResp.headers.get("content-type") || "image/png";
            messages[msgIdx] = {
              role: "user",
              content: {
                type: "image",
                data: imgBuf.toString("base64"),
                mimeType: imgType,
              },
            };
          }
          msgIdx++;
        }
      }

      const result = await server.server.createMessage({
        messages: messages as any,
        maxTokens: step.maxTokens || 1000,
        ...(step.systemPrompt ? { systemPrompt: step.systemPrompt } : {}),
        modelPreferences: { intelligencePriority: 0.8, speedPriority: 0.5 },
      });
      text = result.content.type === "text" ? result.content.text : "";
      usedPath = "mcp";
    } catch {
      // MCP sampling failed — fall through to error
    }
  }

  if (!usedPath) {
    throw new Error(
      "No sampling provider available. Install Gemini CLI (npm i -g @google/gemini-cli) and sign in with Google, " +
        "set GEMINI_API_KEY for direct API access, or connect via an MCP client that supports sampling.",
    );
  }

  let resultValue: unknown = text;
  if (step.responseFormat === "json" || detectJsonIntent(step)) {
    try {
      resultValue = JSON.parse(text);
    } catch {
      const extracted = extractJson(text);
      if (extracted !== null) {
        resultValue = JSON.parse(extracted);
      } else {
        console.error(
          `[sampling] JSON requested but AI returned non-JSON: "${text.substring(0, 100)}" — storing as raw text`,
        );
      }
    }
  }

  // Validate response shape against responseSchema if present
  if (
    step.responseSchema &&
    typeof resultValue === "object" &&
    resultValue !== null &&
    !Array.isArray(resultValue)
  ) {
    for (const field of Object.keys(step.responseSchema)) {
      if (!(field in (resultValue as Record<string, unknown>))) {
        console.error(
          `[sampling] ${step.id}: expected field "${field}" missing from AI response`,
        );
      }
    }
  }

  state.stepResults[step.id] = resultValue;
  state.stepStatus[step.id] = "success";
  state.completedSteps.push(step.id);
}

async function executeElicitation(
  step: StepDefinition,
  state: ExecutionState,
  server: any,
): Promise<ToolResult | null> {
  const msg = resolveTemplate(
    step.message || "",
    state.params,
    state.stepResults,
  );
  const result = await server.server.elicitInput({
    message: msg,
    requestedSchema: step.requestedSchema || {},
  });

  if (result.action !== "accept") {
    if (step.onDecline === "abort") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "aborted",
                reason: `User declined at step: ${step.label}`,
                completedSteps: state.completedSteps,
                stepResults: state.stepResults,
              },
              null,
              2,
            ),
          },
        ],
      };
    } else if (step.onDecline === "skip_remaining") {
      state.stepResults[step.id] = null;
      state.stepStatus[step.id] = "skipped";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "partial",
                reason: "User declined — remaining steps skipped",
                completedSteps: state.completedSteps,
                stepResults: state.stepResults,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  }

  state.stepResults[step.id] = result.content;
  state.stepStatus[step.id] = "success";
  state.completedSteps.push(step.id);
  return null;
}

function executeTransform(step: StepDefinition, state: ExecutionState): void {
  const expr = step.expression || "null";
  validateExpression(expr, "transform");
  const { argNames, argValues } = buildJsScope(state.params, state.stepResults);
  let fn: Function;
  try {
    fn = new Function(...argNames, `"use strict"; return (${expr});`);
  } catch {
    const withReturn = autoReturn(expr);
    fn = new Function(...argNames, `"use strict"; ${withReturn}`);
  }
  const result = fn(...argValues);
  state.stepResults[step.id] = result;
  state.stepStatus[step.id] = "success";
  state.completedSteps.push(step.id);
}

export function autoReturn(expr: string): string {
  try {
    new Function(`"use strict"; ${expr}`);
    return expr;
  } catch {
    // continue to fixup
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
    new Function(`"use strict"; ${candidate}`);
    return candidate;
  } catch {
    return expr;
  }
}

function executeConditional(step: StepDefinition, state: ExecutionState): void {
  const expr = step.condition || "false";
  validateExpression(expr, "conditional");
  const { argNames, argValues } = buildJsScope(state.params, state.stepResults);
  const fn = new Function(...argNames, `"use strict"; return !!(${expr});`);

  let conditionResult: boolean;
  try {
    conditionResult = fn(...argValues);
  } catch {
    conditionResult = false;
  }

  state.stepResults[step.id] = conditionResult;
  state.stepStatus[step.id] = "success";

  if (conditionResult) {
    if (step.elseStep) {
      state.skipStep = step.elseStep;
    }
  } else {
    if (step.thenStep) {
      state.skipStep = step.thenStep;
    }
  }

  state.completedSteps.push(step.id);
}

export interface WorkflowEngineOptions {
  server: any;
  client: any;
  endpoints: Record<string, EndpointInfo>;
  name: string;
  extra?: any;
  botUsernames?: string[];
}

export async function runWorkflow(
  options: WorkflowEngineOptions,
  steps: StepDefinition[],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { server, client, endpoints, name, extra, botUsernames } = options;

  const state: ExecutionState = {
    params: args,
    stepResults: {},
    stepStatus: {},
    stepErrors: {},
    completedSteps: [],
    nextStepOverride: null,
    skipStep: null,
    stepDeps: Object.fromEntries(steps.map((s) => [s.id, s.dependsOn || []])),
    deferredActions: [],
    botUsernames: new Set(botUsernames ?? []),
  };

  const log = (msg: string) => console.error(`[${name}] ${msg}`);

  const progressToken = extra?._meta?.progressToken;
  const sendProgress = async (completed: number, message: string) => {
    if (progressToken && extra?.sendNotification) {
      try {
        await extra.sendNotification({
          method: "notifications/progress" as const,
          params: {
            progressToken,
            progress: completed,
            total: steps.length,
            message,
          },
        });
      } catch {
        // Non-fatal — client may not support progress
      }
    }
  };

  const executeStep = async (
    step: StepDefinition,
  ): Promise<ToolResult | null> => {
    switch (step.type) {
      case "api_call":
        await executeApiCall(step, state, client, endpoints);
        return null;
      case "sampling":
        await executeSampling(step, state, server);
        return null;
      case "elicitation":
        return executeElicitation(step, state, server);
      case "transform":
        executeTransform(step, state);
        return null;
      case "conditional":
        executeConditional(step, state);
        return null;
      default:
        throw new Error(
          `Unknown step type "${step.type}" in step "${step.id}"`,
        );
    }
  };

  const mustRunAlone = (type: string) =>
    type === "conditional" || type === "elicitation";

  try {
    const remaining = new Set(steps.map((s) => s.id));
    const stepById = new Map(steps.map((s) => [s.id, s]));

    while (remaining.size > 0) {
      if (state.nextStepOverride && !remaining.has(state.nextStepOverride)) {
        state.nextStepOverride = null;
      }
      if (state.skipStep && !remaining.has(state.skipStep)) {
        state.skipStep = null;
      }

      const ready: StepDefinition[] = [];
      for (const id of remaining) {
        const step = stepById.get(id)!;
        if (shouldRun(step.id, state)) {
          ready.push(step);
        } else if (state.stepStatus[step.id] === "skipped") {
          log(`[${step.id}] SKIPPED (dependency skipped or branch not taken)`);
          remaining.delete(step.id);
        }
      }

      if (ready.length === 0) {
        for (const id of remaining) {
          if (!state.stepStatus[id]) {
            state.stepResults[id] = null;
            state.stepStatus[id] = "skipped";
          }
        }
        break;
      }

      const soloStep = ready.find((s) => mustRunAlone(s.type));
      const batch = soloStep ? [soloStep] : ready;

      await sendProgress(
        state.completedSteps.length,
        batch.length === 1
          ? batch[0].label
          : `${batch.length} steps in parallel`,
      );

      if (batch.length === 1) {
        const step = batch[0];
        log(`[${step.id}] ${step.label}...`);
        try {
          const earlyReturn = await executeStep(step);
          if (earlyReturn) return earlyReturn;
        } catch (stepErr) {
          if (step.continueOnError) {
            const errMsg =
              stepErr instanceof Error ? stepErr.message : String(stepErr);
            log(`[${step.id}] ERROR (continuing): ${errMsg}`);
            state.stepResults[step.id] = null;
            state.stepStatus[step.id] = "error";
            state.stepErrors[step.id] = errMsg;
            state.completedSteps.push(step.id);
          } else {
            throw stepErr;
          }
        }
        remaining.delete(step.id);
      } else {
        log(
          `Running ${batch.length} steps in parallel: ${batch.map((s) => s.id).join(", ")}`,
        );
        const results = await Promise.allSettled(
          batch.map(async (step) => {
            log(`[${step.id}] ${step.label}...`);
            await executeStep(step);
            return step;
          }),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const step = batch[i];
          remaining.delete(step.id);

          if (result.status === "rejected") {
            if (step.continueOnError) {
              const errMsg =
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason);
              log(`[${step.id}] ERROR (continuing): ${errMsg}`);
              state.stepResults[step.id] = null;
              state.stepStatus[step.id] = "error";
              state.stepErrors[step.id] = errMsg;
              state.completedSteps.push(step.id);
            } else {
              throw result.reason;
            }
          }
        }
      }

      for (const step of batch) {
        const sr = state.stepResults[step.id];
        if (sr !== undefined) {
          const preview =
            typeof sr === "string"
              ? sr.substring(0, 200)
              : JSON.stringify(sr)?.substring(0, 200);
          log(`[${step.id}] → ${state.stepStatus[step.id]}: ${preview}`);
        }
      }
    }

    log(`Workflow completed. Steps: ${state.completedSteps.join(" → ")}`);
    await sendProgress(steps.length, "Complete");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "success",
              completedSteps: state.completedSteps,
              stepResults: state.stepResults,
              ...(Object.keys(state.stepErrors).length > 0
                ? { stepErrors: state.stepErrors }
                : {}),
              ...(state.deferredActions.length > 0
                ? { deferredActions: state.deferredActions }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR at step execution: ${message}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: "error",
              error: message,
              completedSteps: state.completedSteps,
              stepResults: state.stepResults,
              ...(Object.keys(state.stepErrors).length > 0
                ? { stepErrors: state.stepErrors }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
}
