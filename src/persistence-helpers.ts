export const COMMAND_BRIDGE_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    room: {
      type: "object",
      description: "Room where the command was invoked",
      properties: {
        id: { type: "string", description: "Room ID" },
        type: {
          type: "string",
          description:
            "Room type: c (channel), p (private), d (DM), l (livechat)",
        },
        displayName: {
          type: "string",
          description: "Human-readable room name",
        },
      },
    },
    sender: {
      type: "object",
      description: "User who invoked the command",
      properties: {
        id: { type: "string", description: "User ID" },
        username: { type: "string", description: "Username" },
        name: { type: "string", description: "Display name" },
      },
    },
    query: {
      type: "string",
      description: "Full argument string after /command",
    },
    threadId: {
      type: "string",
      description:
        "Parent message ID if command was typed inside a thread (use as tmid for thread replies)",
    },
    triggerId: {
      type: "string",
      description: "UI trigger ID for interactive elements",
    },
  },
};

/** Map event-side keyPath to command-side equivalent (falls back to canonical key for the model). */
export function deriveCommandKeyPath(
  model: string,
  originalKeyPath: string,
): string {
  const cmdProps = COMMAND_BRIDGE_PARAMS.properties as Record<string, unknown>;
  const topField = originalKeyPath.split(".")[0];
  if (topField in cmdProps) return originalKeyPath;
  switch (model) {
    case "room":
      return "room.id";
    case "user":
      return "sender.id";
    default:
      return "room.id";
  }
}

/** Auto-inject read-only persistence into command workflows that reference a sibling's stateParam. */
export function autoInjectPersistence(
  rawWorkflows: Array<{
    name: string;
    triggerEvent?: string;
    persistence?: {
      model: string;
      keyPath: string;
      stateParam: string;
      defaultState: unknown;
      updateFromStep?: string;
    };
    steps: unknown[];
  }>,
): string[] {
  const warnings: string[] = [];

  const persistenceByStateParam = new Map<
    string,
    NonNullable<(typeof rawWorkflows)[number]["persistence"]>
  >();
  for (const raw of rawWorkflows) {
    if (raw.persistence?.stateParam) {
      persistenceByStateParam.set(raw.persistence.stateParam, raw.persistence);
    }
  }
  if (persistenceByStateParam.size === 0) return warnings;

  for (const raw of rawWorkflows) {
    if (raw.triggerEvent || raw.persistence) continue;
    const stepsJson = JSON.stringify(raw.steps);
    for (const [stateParam, srcConfig] of persistenceByStateParam) {
      if (stepsJson.includes(`params.${stateParam}`)) {
        raw.persistence = {
          model: srcConfig.model,
          keyPath: deriveCommandKeyPath(srcConfig.model, srcConfig.keyPath),
          stateParam: srcConfig.stateParam,
          defaultState: srcConfig.defaultState,
        };
        warnings.push(
          `[${raw.name}] auto-injected read-only persistence ` +
            `(stateParam="${stateParam}") from sibling workflow.`,
        );
        break;
      }
    }
  }

  return warnings;
}

/** Levenshtein edit-distance (two-row DP, O(min(a,b)) memory). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Fuzzy-match segment → candidate: case-insensitive → Lev=1 → suffix → contains → Lev≤2, preferring required fields. */
export function findBestPropertyMatch(
  segment: string,
  candidates: string[],
  optionalSet?: Set<string>,
): string | null {
  if (candidates.length === 0) return null;
  const lower = segment.toLowerCase();

  const uniqueRequired = (matches: string[]): string | null => {
    if (!optionalSet || optionalSet.size === 0) return null;
    const required = matches.filter((m) => !optionalSet.has(m));
    return required.length === 1 ? required[0] : null;
  };

  // 1. Case-insensitive exact
  const exact = candidates.find((c) => c.toLowerCase() === lower);
  if (exact) return exact;

  // 2. Levenshtein = 1, unique (or unique required)
  const lev1 = candidates.filter(
    (c) => levenshtein(c.toLowerCase(), lower) === 1,
  );
  if (lev1.length === 1) return lev1[0];
  if (lev1.length > 1) {
    const pick = uniqueRequired(lev1);
    if (pick) return pick;
  }

  // 3. Suffix match (candidates whose lowercased form ends with the segment)
  const suffixMatches = candidates.filter((c) =>
    c.toLowerCase().endsWith(lower),
  );
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) {
    // Prefer required properties, then pick shortest
    if (optionalSet && optionalSet.size > 0) {
      const required = suffixMatches.filter((m) => !optionalSet.has(m));
      if (required.length > 0) {
        return required.sort((a, b) => a.length - b.length)[0];
      }
    }
    return suffixMatches.sort((a, b) => a.length - b.length)[0];
  }

  // 4. Contains match, unique (or unique required)
  const containsMatches = candidates.filter(
    (c) => c.toLowerCase().includes(lower) && c.toLowerCase() !== lower,
  );
  if (containsMatches.length === 1) return containsMatches[0];
  if (containsMatches.length > 1) {
    const pick = uniqueRequired(containsMatches);
    if (pick) return pick;
  }

  // 5. Levenshtein ≤ 2, unique (or unique required)
  const lev2 = candidates.filter(
    (c) => levenshtein(c.toLowerCase(), lower) <= 2,
  );
  if (lev2.length === 1) return lev2[0];
  if (lev2.length > 1) {
    const pick = uniqueRequired(lev2);
    if (pick) return pick;
  }

  return null;
}

/** Auto-correct skipped domain keys (params.room → params.message.room) in event workflows. */
export function autoCorrectEventParamRefs(
  raw: { name: string; steps: any[] },
  domainKeys: Set<string>,
  eventShape: Record<string, Record<string, unknown>>,
): string[] {
  const warnings: string[] = [];

  const subFieldToDomain = new Map<string, string>();
  for (const dk of domainKeys) {
    const shape = eventShape[dk];
    if (shape && typeof shape === "object") {
      for (const subKey of Object.keys(shape)) {
        const cleanKey = subKey.replace(/\?$/, "");
        if (!domainKeys.has(cleanKey) && !subFieldToDomain.has(cleanKey)) {
          subFieldToDomain.set(cleanKey, dk);
        }
      }
    }
  }
  if (subFieldToDomain.size === 0) return warnings;

  // Regex: {{params.X...}} in templates OR bare params.X in JS expressions
  const TMPL_PARAM = /\{\{params\.(\w+)/g;
  const BARE_PARAM = /\bparams\.(\w+)/g;

  for (const step of raw.steps) {
    const cfg = step as Record<string, unknown>;
    // Collect all string fields that might contain param references
    const strFields: Array<{ obj: Record<string, unknown>; key: string }> = [];
    for (const field of [
      "expression",
      "condition",
      "prompt",
      "systemPrompt",
      "message",
      "forEach",
    ]) {
      if (typeof cfg[field] === "string") {
        strFields.push({ obj: cfg, key: field });
      }
    }
    // Also walk inputMapping values
    if (cfg.inputMapping && typeof cfg.inputMapping === "object") {
      const walkMapping = (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === "string") {
            strFields.push({ obj, key: k });
          } else if (v && typeof v === "object" && !Array.isArray(v)) {
            walkMapping(v as Record<string, unknown>);
          }
        }
      };
      walkMapping(cfg.inputMapping as Record<string, unknown>);
    }

    for (const { obj, key } of strFields) {
      let val = obj[key] as string;
      let changed = false;
      // Replace {{params.X...}} patterns
      val = val.replace(TMPL_PARAM, (_match, topField: string) => {
        if (domainKeys.has(topField)) return _match; // already correct
        const dk = subFieldToDomain.get(topField);
        if (dk) {
          changed = true;
          return `{{params.${dk}.${topField}`;
        }
        return _match;
      });
      // Replace bare params.X patterns (JS contexts)
      val = val.replace(BARE_PARAM, (_match, topField: string) => {
        if (domainKeys.has(topField)) return _match;
        const dk = subFieldToDomain.get(topField);
        if (dk) {
          changed = true;
          return `params.${dk}.${topField}`;
        }
        return _match;
      });
      if (changed) {
        const oldVal = obj[key] as string;
        obj[key] = val;
        warnings.push(
          `[${raw.name}] Auto-corrected event param ref in step "${step.id}": "${oldVal.slice(0, 60)}" → "${val.slice(0, 60)}"`,
        );
      }
    }
  }
  return warnings;
}

/** Collect all string fields (expressions, prompts, inputMapping values) that may contain param refs. */
function collectStringFields(
  cfg: Record<string, unknown>,
): Array<{ obj: Record<string, unknown>; key: string }> {
  const strFields: Array<{ obj: Record<string, unknown>; key: string }> = [];
  for (const field of [
    "expression",
    "condition",
    "prompt",
    "systemPrompt",
    "message",
    "forEach",
  ]) {
    if (typeof cfg[field] === "string") {
      strFields.push({ obj: cfg, key: field });
    }
  }
  if (cfg.inputMapping && typeof cfg.inputMapping === "object") {
    const walkMapping = (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") {
          strFields.push({ obj, key: k });
        } else if (v && typeof v === "object" && !Array.isArray(v)) {
          walkMapping(v as Record<string, unknown>);
        }
      }
    };
    walkMapping(cfg.inputMapping as Record<string, unknown>);
  }
  return strFields;
}

/** Walk params.X.Y.Z paths against event shape tree — fuzzy-correct mismatched segments, hard-error on fabricated ones. */
export function autoCorrectDeepParamRefs(
  raw: { name: string; steps: any[] },
  domainKeys: Set<string>,
  eventShape: Record<string, Record<string, unknown>>,
): string[] {
  const warnings: string[] = [];

  const TMPL_FULL = /\{\{params\.([\w]+(?:\.[\w]+)*)/g;
  const BARE_FULL = /\bparams\.([\w]+(?:\.[\w]+)*)/g;

  for (const step of raw.steps) {
    const cfg = step as Record<string, unknown>;
    const strFields = collectStringFields(cfg);

    for (const { obj, key } of strFields) {
      let val = obj[key] as string;
      let changed = false;

      const correctPath = (fullPath: string): string => {
        const segments = fullPath.split(".");
        const domain = segments[0];

        if (!domainKeys.has(domain)) return fullPath;

        const domainShape = eventShape[domain];
        if (!domainShape || typeof domainShape !== "object") return fullPath;

        let currentLevel: unknown = domainShape;

        for (let i = 1; i < segments.length; i++) {
          if (typeof currentLevel !== "object" || currentLevel === null) {
            return segments.join(".");
          }

          const shapeObj = currentLevel as Record<string, unknown>;
          const cleanKeys = Object.keys(shapeObj).map((k) =>
            k.replace(/\?$/, ""),
          );
          const seg = segments[i];

          const cleanToOriginal = new Map<string, string>();
          for (const k of Object.keys(shapeObj)) {
            cleanToOriginal.set(k.replace(/\?$/, ""), k);
          }

          if (cleanKeys.includes(seg)) {
            const origKey = cleanToOriginal.get(seg)!;
            currentLevel = shapeObj[origKey];
          } else if (cleanKeys.length > 0) {
            const optionalSet = new Set<string>();
            for (const [clean, orig] of cleanToOriginal) {
              if (orig.endsWith("?")) optionalSet.add(clean);
            }
            const match = findBestPropertyMatch(seg, cleanKeys, optionalSet);
            if (match) {
              const parentPath =
                i === 1
                  ? `params.${domain}`
                  : `params.${segments.slice(0, i).join(".")}`;
              warnings.push(
                `[${raw.name}] Auto-corrected deep param ref in step "${(step as any).id}": ` +
                  `"${seg}" → "${match}" under ${parentPath}. ` +
                  `Available: ${cleanKeys.join(", ")}`,
              );
              segments[i] = match;
              changed = true;
              const origKey = cleanToOriginal.get(match)!;
              currentLevel = shapeObj[origKey];
            } else {
              const parentPath =
                i === 1
                  ? `params.${domain}`
                  : `params.${segments.slice(0, i).join(".")}`;
              throw new Error(
                `[${raw.name}] Step "${(step as any).id}" references "params.${fullPath}" ` +
                  `but "${seg}" is not a known property of ${parentPath}. ` +
                  `Available: ${cleanKeys.join(", ")}`,
              );
            }
          } else {
            return segments.join(".");
          }
        }
        return segments.join(".");
      };

      val = val.replace(TMPL_FULL, (_match, fullPath: string) => {
        const corrected = correctPath(fullPath);
        return `{{params.${corrected}`;
      });

      val = val.replace(BARE_FULL, (_match, fullPath: string) => {
        const corrected = correctPath(fullPath);
        return `params.${corrected}`;
      });

      if (changed) {
        const oldVal = obj[key] as string;
        obj[key] = val;
      }
    }
  }
  return warnings;
}
