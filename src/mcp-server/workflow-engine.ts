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

export function resolveTemplate(
  template: string,
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
): string {
  const cleaned = template
    .replace(/\{\{\[params\.([^\]]+)\]\}\}/g, "{{params.$1}}")
    .replace(/\{\{\[steps\.([^\]]+)\]\}\}/g, "{{steps.$1}}");

  return cleaned.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    try {
      validateExpression(expr.trim(), "template");
      const fn = new Function(
        "params",
        "steps",
        `"use strict"; return (${expr.trim()});`,
      );
      const val = fn(params, steps);
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
): unknown {
  if (typeof value === "string" && value.includes("{{")) {
    const result = resolveTemplate(value, params, steps);
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (Array.isArray(value)) {
    return value.map((el) => resolveValue(el, params, steps));
  }
  if (typeof value === "object" && value !== null) {
    return resolveMapping(value as Record<string, unknown>, params, steps);
  }
  return value;
}

export function resolveMapping(
  mapping: Record<string, unknown>,
  params: Record<string, unknown>,
  steps: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    resolved[key] = resolveValue(value, params, steps);
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
  completedSteps: string[];
  nextStepOverride: string | null;
  skipStep: string | null;
  stepDeps: Record<string, string[]>;
  deferredActions: DeferredAction[];
}

export function shouldRun(stepId: string, state: ExecutionState): boolean {
  if (state.skipStep === stepId) {
    state.skipStep = null;
    state.stepResults[stepId] = { result: null, status: "skipped" };
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
  if (deps.some((d) => state.stepResults[d]?.status === "skipped")) {
    state.stepResults[stepId] = { result: null, status: "skipped" };
    return false;
  }
  return deps.every((d) => state.completedSteps.includes(d));
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
      const augmentedSteps = {
        ...state.stepResults,
        [itemVar]: { result: item, status: "success" },
      };
      const args = resolveMapping(
        step.inputMapping || {},
        state.params,
        augmentedSteps,
      );
      const result = await executeSingleApiCall(
        step,
        args as Record<string, unknown>,
        state,
        client,
        endpoints,
      );
      results.push(result);
    }

    state.stepResults[step.id] = { result: results, status: "success" };
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

  if (step.outputPath) {
    state.stepResults[step.id] = {
      result: extractPath({ result } as any, step.outputPath),
      status: "success",
    };
  } else {
    state.stepResults[step.id] = { result, status: "success" };
  }
  state.completedSteps.push(step.id);
}

const MONGO_ID_RE = /^[A-Za-z0-9]{17,24}$/;
function looksLikeMongoId(v: string): boolean {
  return MONGO_ID_RE.test(v);
}

const ROOM_ERROR_RE =
  /error-room-not-found|error-invalid-room|error-channel-not-found|Channel not found|Room not found|not-found/i;

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
      if (typeof raw === "string" && raw.includes("{{")) {
        const resolved = payload[key];
        if (resolved === "" || resolved === undefined || resolved === null) {
          throw new Error(
            `Parameter "${key}" resolved to empty (template: ${raw}). ` +
              `This usually means an optional event field is absent.`,
          );
        }
      }
    }
  }

  await normalizePayload(payload, client);

  const result = await client.request(
    method,
    method === "GET"
      ? path +
          "?" +
          new URLSearchParams(
            Object.entries(payload).reduce(
              (a, [k, v]) => ({ ...a, [k]: String(v) }),
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
            if (members.length > 0) {
              const inviteEndpoint = isGroup
                ? "/api/v1/groups.invite"
                : "/api/v1/channels.invite";
              for (const member of members) {
                try {
                  const body = looksLikeMongoId(member)
                    ? { roomId, userId: member }
                    : { roomId, username: member };
                  await client.request("POST", inviteEndpoint, {
                    auth: true,
                    body,
                  });
                } catch {}
              }
            }
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
                    (a, [k, v]) => ({ ...a, [k]: String(v) }),
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
          if (step.outputPath)
            return extractPath(mirrorResult, step.outputPath);
          return parseResult(mirrorResult);
        }
      } catch {}
    }

    throw new Error(errorText);
  }

  if (step.outputPath) {
    return extractPath(result, step.outputPath);
  }
  return parseResult(result);
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
  if (step.content && step.content.length > 0) {
    return step.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => resolveTemplate(c.text, state.params, state.stepResults))
      .join("\n");
  }
  return resolveTemplate(step.prompt || "", state.params, state.stepResults);
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

  state.stepResults[step.id] = {
    result: resultValue,
    status: "success",
  };
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
      state.stepResults[step.id] = { result: null, status: "skipped" };
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

  state.stepResults[step.id] = {
    result: result.content,
    status: "success",
  };
  state.completedSteps.push(step.id);
  return null;
}

function executeTransform(step: StepDefinition, state: ExecutionState): void {
  const expr = step.expression || "null";
  validateExpression(expr, "transform");
  let fn: Function;
  try {
    fn = new Function("steps", "params", `"use strict"; return (${expr});`);
  } catch {
    const withReturn = autoReturn(expr);
    fn = new Function("steps", "params", `"use strict"; ${withReturn}`);
  }
  const result = fn(state.stepResults, state.params);
  state.stepResults[step.id] = {
    result,
    status: "success",
  };
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
  const fn = new Function(
    "steps",
    "params",
    `"use strict"; return !!(${expr});`,
  );

  let conditionResult: boolean;
  try {
    conditionResult = fn(state.stepResults, state.params);
  } catch {
    conditionResult = false;
  }

  state.stepResults[step.id] = {
    result: conditionResult,
    status: "success",
  };

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
}

export async function runWorkflow(
  options: WorkflowEngineOptions,
  steps: StepDefinition[],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const { server, client, endpoints, name, extra } = options;

  const state: ExecutionState = {
    params: args,
    stepResults: {},
    completedSteps: [],
    nextStepOverride: null,
    skipStep: null,
    stepDeps: Object.fromEntries(steps.map((s) => [s.id, s.dependsOn || []])),
    deferredActions: [],
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
        } else if (state.stepResults[step.id]?.status === "skipped") {
          log(`[${step.id}] SKIPPED (dependency skipped or branch not taken)`);
          remaining.delete(step.id);
        }
      }

      if (ready.length === 0) {
        for (const id of remaining) {
          if (!state.stepResults[id]) {
            state.stepResults[id] = { result: null, status: "skipped" };
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
            state.stepResults[step.id] = {
              result: null,
              status: "error",
              error: errMsg,
            };
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
              state.stepResults[step.id] = {
                result: null,
                status: "error",
                error: errMsg,
              };
              state.completedSteps.push(step.id);
            } else {
              throw result.reason;
            }
          }
        }
      }

      for (const step of batch) {
        const sr = state.stepResults[step.id];
        if (sr) {
          const preview =
            typeof sr?.result === "string"
              ? sr.result.substring(0, 200)
              : JSON.stringify(sr?.result)?.substring(0, 200);
          log(`[${step.id}] → ${sr?.status}: ${preview}`);
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
