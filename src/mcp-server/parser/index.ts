import SwaggerParser from "@apidevtools/swagger-parser";
import { OpenAPIV3 } from "openapi-types";
import type { JSONSchema7 } from "json-schema";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapOpenApiSchemaToJsonSchema } from "./schema-mapper.js";
import type { Domain, CompactEndpoint, FullEndpoint } from "./types.js";
import { VALID_DOMAINS } from "./types.js";

const SPEC_BASE_URL =
  "https://raw.githubusercontent.com/RocketChat/Rocket.Chat-Open-API/main";

const specCache = new Map<Domain, OpenAPIV3.Document>();

const domainIndex = new Map<string, Domain>();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "..", ".cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getSpecUrl(domain: Domain): string {
  return `${SPEC_BASE_URL}/${domain}.yaml`;
}

function readDiskCache(domain: Domain): OpenAPIV3.Document | null {
  const cachePath = join(CACHE_DIR, `${domain}.json`);
  if (!existsSync(cachePath)) return null;

  const age = Date.now() - statSync(cachePath).mtimeMs;
  if (age > CACHE_TTL_MS) return null;

  try {
    return JSON.parse(readFileSync(cachePath, "utf-8")) as OpenAPIV3.Document;
  } catch {
    return null;
  }
}

function writeDiskCache(domain: Domain, api: OpenAPIV3.Document): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, `${domain}.json`), JSON.stringify(api));
  } catch {
    // Non-fatal — disk cache is best-effort
  }
}

async function getDomainSpec(domain: Domain): Promise<OpenAPIV3.Document> {
  const memCached = specCache.get(domain);
  if (memCached) return memCached;

  const diskCached = readDiskCache(domain);
  if (diskCached) {
    specCache.set(domain, diskCached);
    return diskCached;
  }

  const url = getSpecUrl(domain);
  let api: OpenAPIV3.Document;
  try {
    api = (await SwaggerParser.dereference(url)) as OpenAPIV3.Document;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch OpenAPI spec for "${domain}" from GitHub.\n` +
        `URL: ${url}\n` +
        `Cause: ${msg}\n\n` +
        `Check your network connection, or try again later if GitHub is down.`,
    );
  }
  specCache.set(domain, api);
  writeDiskCache(domain, api);
  return api;
}

function summarizeBodySchema(
  schema: OpenAPIV3.SchemaObject,
): string | undefined {
  const variants = (schema as any).oneOf ?? (schema as any).anyOf;
  if (Array.isArray(variants)) {
    const allKeys = new Set<string>();
    for (const v of variants) {
      if (v.properties) {
        for (const k of Object.keys(v.properties)) allKeys.add(k);
      }
    }
    return allKeys.size > 0 ? [...allKeys].join(", ") : undefined;
  }

  const props = schema.properties;
  if (!props || typeof props !== "object") return undefined;

  const parts: string[] = [];
  for (const [key, val] of Object.entries(props)) {
    const inner = val as OpenAPIV3.SchemaObject;
    if (inner.type === "object" && inner.properties) {
      const innerKeys = Object.keys(inner.properties).join(",");
      parts.push(`${key}{${innerKeys}}`);
    } else {
      parts.push(key);
    }
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function extractCompactEndpoints(
  api: OpenAPIV3.Document,
  domain: Domain,
): CompactEndpoint[] {
  const results: CompactEndpoint[] = [];
  if (!api.paths) return results;

  const usedIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const operation = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
      if (!operation) continue;

      const operationId = deduplicateId(
        sanitizeOperationId(operation.operationId, method, path),
        usedIds,
      );

      let bodyFields: string | undefined;
      const reqBody = operation.requestBody as
        | OpenAPIV3.RequestBodyObject
        | undefined;
      if (reqBody?.content) {
        const mediaType =
          reqBody.content["application/json"] ??
          Object.values(reqBody.content)[0];
        if (mediaType?.schema) {
          bodyFields = summarizeBodySchema(
            mediaType.schema as OpenAPIV3.SchemaObject,
          );
        }
      }

      const ep: CompactEndpoint = {
        operationId,
        method: method.toUpperCase(),
        path,
        summary:
          operation.summary ||
          operation.description?.slice(0, 80) ||
          `${method.toUpperCase()} ${path}`,
        domain,
        tag: operation.tags?.[0] ?? "Other",
      };
      if (bodyFields) ep.bodyFields = bodyFields;
      results.push(ep);
    }
  }

  return results;
}

function extractFullEndpoints(
  api: OpenAPIV3.Document,
  domain: Domain,
  filterIds?: Set<string>,
  maxDepth?: number,
): FullEndpoint[] {
  const results: FullEndpoint[] = [];
  if (!api.paths) return results;

  const globalSecurity = api.security || [];
  const usedIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(api.paths)) {
    if (!pathItem) continue;

    for (const method of Object.values(OpenAPIV3.HttpMethods)) {
      const operation = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
      if (!operation) continue;

      const operationId = deduplicateId(
        sanitizeOperationId(operation.operationId, method, path),
        usedIds,
      );

      if (filterIds && !filterIds.has(operationId)) continue;

      const allParams = mergeParameters(
        pathItem.parameters as OpenAPIV3.ParameterObject[] | undefined,
        operation.parameters as OpenAPIV3.ParameterObject[] | undefined,
      );

      const inputSchema = buildInputSchema(allParams, operation.requestBody);

      let requestBody: FullEndpoint["requestBody"];
      if (operation.requestBody) {
        const rb = operation.requestBody as OpenAPIV3.RequestBodyObject;
        const jsonContent = rb.content?.["application/json"];
        if (jsonContent?.schema) {
          requestBody = {
            contentType: "application/json",
            schema: mapOpenApiSchemaToJsonSchema(
              jsonContent.schema as OpenAPIV3.SchemaObject,
              undefined,
              maxDepth,
            ),
            required: rb.required ?? false,
          };
        }
      }

      let responseSchema: import("json-schema").JSONSchema7 | undefined;
      if (operation.responses) {
        const successResp =
          (operation.responses["200"] as
            | OpenAPIV3.ResponseObject
            | undefined) ??
          (operation.responses["201"] as OpenAPIV3.ResponseObject | undefined);
        if (successResp?.content?.["application/json"]?.schema) {
          responseSchema = mapOpenApiSchemaToJsonSchema(
            successResp.content["application/json"]
              .schema as OpenAPIV3.SchemaObject,
            undefined,
            maxDepth,
          );
        }
      }

      const security =
        operation.security === undefined
          ? globalSecurity
          : operation.security || [];

      const summary =
        operation.summary ||
        operation.description?.slice(0, 80) ||
        `${method.toUpperCase()} ${path}`;

      const ep: FullEndpoint = {
        operationId,
        method: method.toUpperCase(),
        path,
        summary,
        description: operation.description || summary,
        domain,
        parameters: allParams,
        requestBody,
        security,
        inputSchema,
      };
      if (responseSchema) ep.responseSchema = responseSchema;
      results.push(ep);
    }
  }

  return results;
}

function sanitizeOperationId(
  raw: string | undefined,
  method: string,
  path: string,
): string {
  const base = raw || `${method}_${path.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return base.replace(/\./g, "_").replace(/[^a-z0-9_-]/gi, "_");
}

function deduplicateId(id: string, usedIds: Set<string>): string {
  if (!usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let counter = 1;
  while (usedIds.has(`${id}_${counter}`)) counter++;
  const unique = `${id}_${counter}`;
  usedIds.add(unique);
  return unique;
}

function mergeParameters(
  pathParams?: OpenAPIV3.ParameterObject[],
  opParams?: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  const path = pathParams || [];
  const op = opParams || [];
  const merged: OpenAPIV3.ParameterObject[] = [];

  path.concat(op).forEach((param) => {
    const idx = merged.findIndex(
      (p) => p.name === param.name && p.in === param.in,
    );
    if (idx >= 0) {
      merged[idx] = param;
    } else {
      merged.push(param);
    }
  });

  return merged;
}

const AUTH_HEADER_PARAMS = new Set(["X-Auth-Token", "X-User-Id"]);

function buildInputSchema(
  params: OpenAPIV3.ParameterObject[],
  requestBody?: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject,
): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {};
  const required: string[] = [];

  for (const param of params) {
    if (!param.name || !param.schema) continue;
    if (param.in === "header" && AUTH_HEADER_PARAMS.has(param.name)) continue;
    const paramSchema = mapOpenApiSchemaToJsonSchema(
      param.schema as OpenAPIV3.SchemaObject,
    );
    if (param.description && typeof paramSchema === "object") {
      paramSchema.description = param.description;
    }
    properties[param.name] = paramSchema;
    if (param.required) required.push(param.name);
  }

  if (requestBody && !("$ref" in requestBody)) {
    const rb = requestBody as OpenAPIV3.RequestBodyObject;
    const jsonContent = rb.content?.["application/json"];
    if (jsonContent?.schema) {
      properties["requestBody"] = mapOpenApiSchemaToJsonSchema(
        jsonContent.schema as OpenAPIV3.SchemaObject,
      );
      if (rb.required) required.push("requestBody");
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 && { required }),
  };
}

export async function listEndpoints(
  domains: Domain[],
): Promise<CompactEndpoint[]> {
  for (const domain of domains) {
    if (!VALID_DOMAINS.includes(domain)) {
      throw new Error(
        `Invalid domain: "${domain}". Valid domains: ${VALID_DOMAINS.join(", ")}`,
      );
    }
  }

  const domainsToFetch: Domain[] = domains.includes("authentication")
    ? domains
    : [...domains, "authentication"];

  const specs = await Promise.all(domainsToFetch.map((d) => getDomainSpec(d)));

  const requestedSet = new Set(domains);
  const results: CompactEndpoint[] = [];
  for (let i = 0; i < domainsToFetch.length; i++) {
    const extracted = extractCompactEndpoints(specs[i], domainsToFetch[i]);
    for (const ep of extracted) domainIndex.set(ep.operationId, ep.domain);
    if (requestedSet.has(domainsToFetch[i])) results.push(...extracted);
  }

  return results;
}

export async function getFullEndpoints(
  operationIds: string[],
  domains?: Domain[],
  maxDepth?: number,
): Promise<FullEndpoint[]> {
  let domainsToSearch: Domain[];
  if (domains) {
    domainsToSearch = domains;
  } else if (domainIndex.size > 0) {
    const indexed = new Set<Domain>();
    let hasUnknown = false;
    for (const id of operationIds) {
      const d = domainIndex.get(id);
      if (d) indexed.add(d);
      else hasUnknown = true;
    }
    domainsToSearch = hasUnknown ? VALID_DOMAINS : [...indexed];
  } else {
    domainsToSearch = VALID_DOMAINS;
  }
  const idSet = new Set(operationIds);

  const specs = await Promise.all(domainsToSearch.map((d) => getDomainSpec(d)));

  const results: FullEndpoint[] = [];
  for (let i = 0; i < domainsToSearch.length; i++) {
    const extracted = extractFullEndpoints(
      specs[i],
      domainsToSearch[i],
      idSet,
      maxDepth,
    );
    results.push(...extracted);
    for (const ep of extracted) idSet.delete(ep.operationId);
    if (idSet.size === 0) break;
  }

  if (idSet.size > 0) {
    const normalize = (s: string) => s.toLowerCase().replace(/[_-]/g, "-");
    const missingNorm = new Map<string, string>();
    for (const id of idSet) missingNorm.set(normalize(id), id);

    for (let i = 0; i < domainsToSearch.length; i++) {
      if (missingNorm.size === 0) break;
      const allEps = extractFullEndpoints(
        specs[i],
        domainsToSearch[i],
        undefined,
        maxDepth,
      );
      for (const ep of allEps) {
        const normId = normalize(ep.operationId);
        if (
          missingNorm.has(normId) &&
          !results.some((r) => r.operationId === ep.operationId)
        ) {
          results.push(ep);
          missingNorm.delete(normId);
        }
      }
    }
  }

  return results;
}

export function getAvailableDomains(): Domain[] {
  return [...VALID_DOMAINS];
}

export async function getSpecStats(): Promise<{
  totalEndpoints: number;
  totalSchemaBytes: number;
}> {
  const allEndpoints = await listEndpoints(VALID_DOMAINS);
  const specs = await Promise.all(VALID_DOMAINS.map((d) => getDomainSpec(d)));
  const totalSchemaBytes = specs.reduce(
    (sum, spec) => sum + JSON.stringify(spec).length,
    0,
  );
  return { totalEndpoints: allEndpoints.length, totalSchemaBytes };
}

export type { Domain, CompactEndpoint, FullEndpoint };
