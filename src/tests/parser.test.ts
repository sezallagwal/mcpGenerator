import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listEndpoints,
  getFullEndpoints,
  getAvailableDomains,
  getSpecStats,
} from "../mcp-server/parser/index.js";
import { mapOpenApiSchemaToJsonSchema } from "../mcp-server/parser/schema-mapper.js";
import { VALID_DOMAINS } from "../mcp-server/parser/types.js";
import type { OpenAPIV3 } from "openapi-types";

describe("getAvailableDomains", () => {
  it("returns all 12 domains", () => {
    const domains = getAvailableDomains();
    assert.equal(domains.length, 12);
    assert.deepStrictEqual(domains, VALID_DOMAINS);
  });

  it("returns a copy, not the original array", () => {
    const a = getAvailableDomains();
    const b = getAvailableDomains();
    assert.notEqual(a, b);
    assert.deepStrictEqual(a, b);
  });
});

describe("listEndpoints", () => {
  it("returns endpoints for authentication domain", async () => {
    const eps = await listEndpoints(["authentication"]);
    assert.ok(eps.length > 0, "should have endpoints");
    const login = eps.find((e) => e.operationId === "post-api-v1-login");
    assert.ok(login, "should have login endpoint");
    assert.equal(login!.method, "POST");
    assert.equal(login!.path, "/api/v1/login");
    assert.equal(login!.domain, "authentication");
  });

  it("returns endpoints for messaging domain", async () => {
    const eps = await listEndpoints(["messaging"]);
    assert.ok(eps.length > 5, "messaging should have many endpoints");
    for (const ep of eps) {
      assert.equal(ep.domain, "messaging");
    }
  });

  it("returns endpoints from multiple domains", async () => {
    const eps = await listEndpoints(["authentication", "rooms"]);
    const domains = new Set(eps.map((e) => e.domain));
    assert.ok(domains.has("authentication"));
    assert.ok(domains.has("rooms"));
  });

  it("throws on invalid domain", async () => {
    await assert.rejects(
      () => listEndpoints(["nonexistent" as any]),
      /Invalid domain/,
    );
  });

  it("compact endpoints have required fields", async () => {
    const eps = await listEndpoints(["authentication"]);
    for (const ep of eps) {
      assert.ok(ep.operationId, "should have operationId");
      assert.ok(ep.method, "should have method");
      assert.ok(ep.path, "should have path");
      assert.ok(ep.summary, "should have summary");
      assert.ok(ep.domain, "should have domain");
      assert.ok(ep.tag, "should have tag");
    }
  });

  it("tag field contains the OpenAPI tag from the spec", async () => {
    const eps = await listEndpoints(["messaging"]);
    const tags = new Set(eps.map((e) => e.tag));
    assert.ok(tags.has("Chat"), "messaging should have Chat tag");
    assert.ok(tags.has("DM"), "messaging should have DM tag");
  });

  it("all endpoints have a non-empty tag", async () => {
    const eps = await listEndpoints(["omnichannel"]);
    for (const ep of eps) {
      assert.ok(
        ep.tag.length > 0,
        `${ep.operationId} should have non-empty tag`,
      );
    }
  });

  it("operationIds are unique within a domain", async () => {
    const eps = await listEndpoints(["messaging"]);
    const ids = eps.map((e) => e.operationId);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, "operationIds should be unique");
  });
});

describe("getFullEndpoints", () => {
  it("returns full details for login endpoint", async () => {
    const eps = await getFullEndpoints(["post-api-v1-login"]);
    assert.equal(eps.length, 1);
    const login = eps[0];
    assert.equal(login.operationId, "post-api-v1-login");
    assert.equal(login.method, "POST");
    assert.equal(login.path, "/api/v1/login");
    assert.ok(login.inputSchema, "should have inputSchema");
    assert.equal(login.inputSchema.type, "object");
  });

  it("returns full details for GET endpoint with query params", async () => {
    const eps = await getFullEndpoints(["get-api-v1-channels_list"]);
    assert.equal(eps.length, 1);
    const ep = eps[0];
    assert.equal(ep.method, "GET");
    const queryParams = ep.parameters.filter((p) => p.in === "query");
    assert.ok(queryParams.length > 0, "GET endpoint should have query params");
  });

  it("login inputSchema does NOT include X-Auth-Token or X-User-Id", async () => {
    const eps = await getFullEndpoints(["post-api-v1-login"]);
    const schema = eps[0].inputSchema;
    const props = (schema as any).properties || {};
    assert.equal(
      props["X-Auth-Token"],
      undefined,
      "login should not require X-Auth-Token in schema",
    );
    assert.equal(
      props["X-User-Id"],
      undefined,
      "login should not require X-User-Id in schema",
    );
  });

  it("authenticated endpoint inputSchema does NOT include auth headers", async () => {
    const eps = await getFullEndpoints(["get-api-v1-channels_list"]);
    const schema = eps[0].inputSchema;
    const props = (schema as any).properties || {};
    assert.equal(
      props["X-Auth-Token"],
      undefined,
      "auth header should be stripped from inputSchema",
    );
    assert.equal(
      props["X-User-Id"],
      undefined,
      "auth header should be stripped from inputSchema",
    );
  });

  it("authenticated endpoint still has auth params in parameters array", async () => {
    const eps = await getFullEndpoints(["get-api-v1-channels_list"]);
    const authParam = eps[0].parameters.find(
      (p) => p.name === "X-Auth-Token" && p.in === "header",
    );
    assert.ok(
      authParam,
      "X-Auth-Token should still be in parameters for template use",
    );
  });

  it("returns empty array for unknown operationIds", async () => {
    const eps = await getFullEndpoints(["nonexistent-endpoint-id"]);
    assert.equal(eps.length, 0);
  });

  it("returns only requested endpoints (partial match)", async () => {
    const eps = await getFullEndpoints(["post-api-v1-login", "nonexistent-id"]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].operationId, "post-api-v1-login");
  });

  it("handles cross-domain endpoint requests", async () => {
    const eps = await getFullEndpoints([
      "post-api-v1-login", // authentication domain
      "get-api-v1-channels_list", // rooms domain
    ]);
    assert.equal(eps.length, 2);
    const domains = new Set(eps.map((e) => e.domain));
    assert.ok(domains.size === 2, "should span multiple domains");
  });

  it("full endpoints have requestBody for POST endpoints", async () => {
    const eps = await getFullEndpoints(["post-api-v1-login"]);
    assert.ok(eps[0].requestBody, "POST login should have requestBody");
    assert.equal(eps[0].requestBody!.contentType, "application/json");
  });

  it("uses domain index from listEndpoints to avoid fetching all domains", async () => {
    await listEndpoints(["authentication"]);
    const eps = await getFullEndpoints(["post-api-v1-login"]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].operationId, "post-api-v1-login");
    assert.equal(eps[0].domain, "authentication");
  });
});

describe("mapOpenApiSchemaToJsonSchema", () => {
  it("maps string type", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "string",
    } as OpenAPIV3.SchemaObject);
    assert.deepStrictEqual(result, { type: "string" });
  });

  it("maps integer to number", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "integer",
    } as OpenAPIV3.SchemaObject);
    assert.deepStrictEqual(result, { type: "number" });
  });

  it("maps nullable string", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "string",
      nullable: true,
    } as OpenAPIV3.SchemaObject);
    assert.deepStrictEqual(result, { type: ["string", "null"] });
  });

  it("maps object with properties", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name"],
    } as OpenAPIV3.SchemaObject);

    assert.equal(result.type, "object");
    assert.ok(result.properties);
    assert.deepStrictEqual(result.properties!["name"], { type: "string" });
    assert.deepStrictEqual(result.properties!["age"], { type: "number" });
    assert.deepStrictEqual(result.required, ["name"]);
  });

  it("maps array with items", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "array",
      items: { type: "string" },
    } as OpenAPIV3.SchemaObject);

    assert.equal(result.type, "array");
    assert.deepStrictEqual(result.items, { type: "string" });
  });

  it("handles enum", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "string",
      enum: ["a", "b", "c"],
    } as OpenAPIV3.SchemaObject);
    assert.deepStrictEqual(result.enum, ["a", "b", "c"]);
  });

  it("handles unresolved $ref gracefully", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      $ref: "#/components/schemas/Missing",
    } as OpenAPIV3.ReferenceObject);
    assert.deepStrictEqual(result, { type: "object" });
  });

  it("handles cycle detection", () => {
    const obj: any = { type: "object", properties: {} };
    obj.properties.self = obj;
    const result = mapOpenApiSchemaToJsonSchema(obj);
    assert.equal(result.type, "object");
    assert.ok(result.properties);
    assert.deepStrictEqual(result.properties!["self"], { type: "object" });
  });

  it("carries over description", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      type: "string",
      description: "A test field",
    } as OpenAPIV3.SchemaObject);
    assert.equal(result.description, "A test field");
  });

  it("handles oneOf", () => {
    const result = mapOpenApiSchemaToJsonSchema({
      oneOf: [{ type: "string" }, { type: "number" }],
    } as unknown as OpenAPIV3.SchemaObject);
    assert.ok(result.oneOf);
    assert.equal(result.oneOf!.length, 2);
  });

  it("oneOf/anyOf/allOf do not consume depth budget", () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: "object",
      oneOf: [
        {
          type: "object",
          properties: {
            roomId: { type: "string", description: "The channel ID" },
            userId: { type: "string", description: "The user ID" },
          },
          required: ["roomId", "userId"],
        } as OpenAPIV3.SchemaObject,
      ],
    } as unknown as OpenAPIV3.SchemaObject;

    const result = mapOpenApiSchemaToJsonSchema(schema, undefined, 2);
    assert.ok(result.oneOf, "oneOf should be present");
    const variant = result.oneOf![0] as Record<string, unknown>;
    const props = variant.properties as Record<string, Record<string, unknown>>;
    assert.ok(props, "variant should have properties");
    assert.equal(props.roomId.type, "string", "roomId should be string, not truncated to object");
    assert.equal(props.roomId.description, "The channel ID", "roomId description preserved");
    assert.equal(props.userId.type, "string", "userId should be string");

    const anyOfResult = mapOpenApiSchemaToJsonSchema(
      { anyOf: [{ type: "object", properties: { x: { type: "number" } } }] } as unknown as OpenAPIV3.SchemaObject,
      undefined, 2,
    );
    assert.equal(
      ((anyOfResult.anyOf![0] as any).properties.x as any).type,
      "number",
      "anyOf should not consume depth",
    );

    const allOfResult = mapOpenApiSchemaToJsonSchema(
      { allOf: [{ type: "object", properties: { y: { type: "boolean" } } }] } as unknown as OpenAPIV3.SchemaObject,
      undefined, 2,
    );
    assert.equal(
      ((allOfResult.allOf![0] as any).properties.y as any).type,
      "boolean",
      "allOf should not consume depth",
    );
  });
});

describe("GET endpoint inputSchema includes query params", () => {
  it("channels.info inputSchema has roomId or roomName", async () => {
    const [ep] = await getFullEndpoints(["get-api-v1-channels_info"]);
    assert.ok(ep, "channels.info endpoint should exist");
    assert.equal(ep.method, "GET");
    assert.equal(ep.requestBody, undefined, "GET endpoint should have no requestBody");
    const props = (ep.inputSchema as any).properties;
    assert.ok(props, "inputSchema should have properties");
    const paramNames = Object.keys(props);
    assert.ok(
      paramNames.includes("roomId") || paramNames.includes("roomName"),
      `inputSchema should include roomId or roomName, got: ${paramNames.join(", ")}`,
    );
  });
});

describe("all domains parse successfully", () => {
  for (const domain of VALID_DOMAINS) {
    it(`parses ${domain} domain`, async () => {
      const eps = await listEndpoints([domain]);
      assert.ok(eps.length > 0, `${domain} should have endpoints`);
      for (const ep of eps) {
        assert.equal(ep.domain, domain);
        assert.ok(ep.operationId);
        assert.ok(ep.method);
        assert.ok(ep.path);
      }
    });
  }
});

describe("getSpecStats", () => {
  it("returns totalEndpoints > 0", async () => {
    const stats = await getSpecStats();
    assert.ok(stats.totalEndpoints > 100, "RC API should have 100+ endpoints");
  });

  it("returns totalSchemaBytes > 0", async () => {
    const stats = await getSpecStats();
    assert.ok(
      stats.totalSchemaBytes > 10_000,
      "total schema should be at least 10 KB",
    );
  });

  it("totalEndpoints matches listEndpoints(all domains)", async () => {
    const stats = await getSpecStats();
    const all = await listEndpoints(VALID_DOMAINS);
    assert.equal(stats.totalEndpoints, all.length);
  });
});
