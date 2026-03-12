import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCapabilityGuide,
  formatAppEventsGuide,
  formatEventShapesGuide,
  getEventParamName,
  getEventShapes,
  APP_EVENTS,
  SHAPES,
  stringifyShape,
} from "../capability-guide.js";
import type { CompactEndpoint } from "../mcp-server/parser/types.js";

function makeEndpoint(
  overrides: Partial<CompactEndpoint> = {},
): CompactEndpoint {
  return {
    operationId: "test-op",
    method: "GET",
    path: "/api/v1/test",
    summary: "Test Endpoint",
    domain: "messaging" as CompactEndpoint["domain"],
    tag: "Chat",
    ...overrides,
  };
}

describe("formatCapabilityGuide", () => {
  it("returns 'No endpoints found.' for empty input", () => {
    const result = formatCapabilityGuide([]);
    assert.equal(result, "No endpoints found.");
  });

  it("groups endpoints by domain with summary → operationId format", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Send Message",
        operationId: "post-api-v1-chat_sendMessage",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Delete Message",
        operationId: "post-api-v1-chat_delete",
      }),
      makeEndpoint({
        domain: "rooms",
        tag: "Rooms",
        summary: "Create Room",
        operationId: "post-api-v1-channels_create",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    assert.ok(result.includes("## messaging"));
    assert.ok(result.includes("## rooms"));
    assert.ok(result.includes("Send Message → post-api-v1-chat_sendMessage"));
    assert.ok(result.includes("Delete Message → post-api-v1-chat_delete"));
    assert.ok(result.includes("Create Room → post-api-v1-channels_create"));
  });

  it("does NOT include tag names in output", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Send Message",
      }),
      makeEndpoint({ domain: "rooms", tag: "Rooms", summary: "Create Room" }),
    ];
    const result = formatCapabilityGuide(endpoints);

    assert.ok(!result.includes("### Chat"));
    assert.ok(!result.includes("### Rooms"));
    assert.ok(!result.includes("**Chat**"));
    assert.ok(!result.includes("**Rooms**"));
  });

  it("deduplicates identical summaries within a domain (keeps first operationId)", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Send Message",
        operationId: "op1",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "DM",
        summary: "Send Message",
        operationId: "op2",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Delete Message",
        operationId: "op3",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    const count = result.split("Send Message").length - 1;
    assert.equal(count, 1, "Send Message should appear exactly once");
    assert.ok(result.includes("Send Message → op1"));
    assert.ok(!result.includes("Send Message → op2"));
  });

  it("shows ALL endpoints (no truncation)", () => {
    const endpoints = Array.from({ length: 20 }, (_, i) =>
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: `Action ${i + 1}`,
        operationId: `op${i}`,
      }),
    );
    const result = formatCapabilityGuide(endpoints);

    assert.ok(result.includes("Action 1 → op0"));
    assert.ok(result.includes("Action 10 → op9"));
    assert.ok(result.includes("Action 20 → op19"));
    assert.ok(!result.includes("+"));
    assert.ok(!result.includes("more"));
  });

  it("does NOT append bodyFields (moved to get_endpoint_schemas)", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Post Message",
        operationId: "post-api-v1-chat_postMessage",
        bodyFields: "channel, text, alias, emoji, avatar",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Delete Message",
        operationId: "post-api-v1-chat_delete",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);
    assert.ok(result.includes("Post Message → post-api-v1-chat_postMessage"));
    assert.ok(!result.includes("[channel, text"));
    assert.ok(result.includes("Delete Message → post-api-v1-chat_delete"));
  });

  it("includes guide header and footer", () => {
    const endpoints = [makeEndpoint()];
    const result = formatCapabilityGuide(endpoints);

    assert.ok(result.includes("Capability Guide"));
    assert.ok(result.includes("operationId"));
  });

  it("handles multiple domains", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Send Message",
        operationId: "op1",
      }),
      makeEndpoint({
        domain: "rooms",
        tag: "Rooms",
        summary: "Create Room",
        operationId: "op2",
      }),
      makeEndpoint({
        domain: "authentication",
        tag: "Authentication",
        summary: "Login",
        operationId: "op3",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    assert.ok(result.includes("## messaging"));
    assert.ok(result.includes("## rooms"));
    assert.ok(result.includes("## authentication"));
  });

  it("handles single endpoint correctly", () => {
    const endpoints = [
      makeEndpoint({
        domain: "rooms",
        tag: "Rooms",
        summary: "Mute User",
        operationId: "post-api-v1-rooms_muteUser",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    assert.ok(result.includes("## rooms"));
    assert.ok(result.includes("Mute User → post-api-v1-rooms_muteUser"));
  });

  it("merges endpoints from different tags within same domain", () => {
    const endpoints = [
      makeEndpoint({
        domain: "rooms",
        tag: "Channels",
        summary: "Create Channel",
        operationId: "op1",
      }),
      makeEndpoint({
        domain: "rooms",
        tag: "Rooms",
        summary: "Create Room",
        operationId: "op2",
      }),
      makeEndpoint({
        domain: "rooms",
        tag: "Teams",
        summary: "Create Team",
        operationId: "op3",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    const lines = result.split("\n");
    const roomsIdx = lines.findIndex((l) => l.startsWith("## rooms"));
    assert.ok(roomsIdx >= 0);
    const summaryLine = lines[roomsIdx + 1];
    assert.ok(summaryLine.includes("Create Channel → op1"));
    assert.ok(summaryLine.includes("Create Room → op2"));
    assert.ok(summaryLine.includes("Create Team → op3"));
  });
});

describe("formatAppEventsGuide", () => {
  it("includes App Events header with total count", () => {
    const result = formatAppEventsGuide();
    assert.ok(result.includes("App Events"));
    assert.ok(result.includes("realtime handlers"));
    assert.match(result, /47 realtime handlers/);
  });

  it("groups events by category with counts", () => {
    const result = formatAppEventsGuide();
    assert.ok(result.includes("## messages (17)"));
    assert.ok(result.includes("## rooms (10)"));
    assert.ok(result.includes("## livechat (10)"));
    assert.ok(result.includes("## users (6)"));
    assert.ok(result.includes("## email (1)"));
    assert.ok(result.includes("## uploads (1)"));
    assert.ok(result.includes("## externalComponent (2)"));
  });

  it("includes interface names with descriptions (no param names)", () => {
    const result = formatAppEventsGuide();
    assert.ok(result.includes("IPostMessageSent \u2014 after message sent"));
    assert.ok(
      result.includes("IPostRoomUserJoined \u2014 after user joins room"),
    );
    assert.ok(result.includes("IPostUserCreated \u2014 new user registered"));
    assert.ok(
      result.includes("IPreEmailSent \u2014 before outgoing email sent"),
    );
    assert.ok(!result.includes("(message)"));
    assert.ok(!result.includes("(context)"));
  });

  it("includes footer with get_endpoint_schemas instruction", () => {
    const result = formatAppEventsGuide();
    assert.ok(result.includes("eventInterfaces"));
    assert.ok(result.includes("generate"));
    assert.ok(result.includes("get_endpoint_schemas"));
  });

  it("does not include deprecated interfaces", () => {
    const result = formatAppEventsGuide();
    assert.ok(!result.includes("ILivechatRoomClosedHandler"));
    assert.ok(!result.includes("DEPRECATED"));
  });

  it("covers all expected categories", () => {
    const categories = Object.keys(APP_EVENTS);
    assert.deepEqual(categories.sort(), [
      "email",
      "externalComponent",
      "livechat",
      "messages",
      "rooms",
      "uploads",
      "users",
    ]);
  });

  it("has exactly 47 total entries (deprecated excluded)", () => {
    const total = Object.values(APP_EVENTS).reduce(
      (sum, entries) => sum + entries.length,
      0,
    );
    assert.equal(total, 47);
  });

  it("every entry has a non-empty name and desc", () => {
    for (const [category, entries] of Object.entries(APP_EVENTS)) {
      for (const entry of entries) {
        assert.ok(entry.name.length > 0, `Empty name in ${category}`);
        assert.ok(
          entry.desc.length > 0,
          `Empty desc for ${entry.name} in ${category}`,
        );
        assert.ok(
          entry.name.startsWith("I"),
          `Interface name ${entry.name} should start with I`,
        );
      }
    }
  });

  it("every entry has param and shapeKey", () => {
    for (const [category, entries] of Object.entries(APP_EVENTS)) {
      for (const entry of entries) {
        assert.ok(
          entry.param && entry.param.length > 0,
          `Missing param for ${entry.name} in ${category}`,
        );
        assert.ok(
          entry.shapeKey && entry.shapeKey.length > 0,
          `Missing shapeKey for ${entry.name} in ${category}`,
        );
        assert.ok(
          SHAPES[entry.shapeKey],
          `shapeKey "${entry.shapeKey}" for ${entry.name} not found in SHAPES`,
        );
      }
    }
  });
});

describe("formatEventShapesGuide", () => {
  it("includes header and footer", () => {
    const result = formatEventShapesGuide();
    assert.ok(result.includes("Event Param Shapes"));
    assert.ok(result.includes("params"));
    assert.ok(result.includes("Nested fields"));
  });

  it("deduplicates interfaces sharing the same shape", () => {
    const result = formatEventShapesGuide();
    const messageLine = result
      .split("\n")
      .find((l) => l.includes("IPostMessageSent.message"));
    assert.ok(messageLine, "Should have a line for IPostMessageSent");
    assert.ok(
      messageLine!.includes("IPostMessageDeleted.message"),
      "Should group IPostMessageDeleted on same line",
    );
  });

  it("shows nested field structure", () => {
    const result = formatEventShapesGuide();
    assert.ok(result.includes("sender: { id, username"));
    assert.ok(result.includes("creator: { id, username"));
  });

  it("uses id not _id", () => {
    const result = formatEventShapesGuide();
    assert.ok(!result.includes("_id"));
  });

  it("covers all SHAPES entries", () => {
    const result = formatEventShapesGuide();
    for (const [key, shape] of Object.entries(SHAPES)) {
      const str = stringifyShape(shape);
      assert.ok(
        result.includes(str),
        `Shape for ${key} not found in guide output`,
      );
    }
  });
});

describe("getEventParamName", () => {
  it("returns 'message' for IPostMessageSent", () => {
    assert.equal(getEventParamName("IPostMessageSent"), "message");
  });

  it("returns 'room' for IPostRoomCreate", () => {
    assert.equal(getEventParamName("IPostRoomCreate"), "room");
  });

  it("returns 'context' for IPostRoomUserJoined", () => {
    assert.equal(getEventParamName("IPostRoomUserJoined"), "context");
  });

  it("returns 'context' for IPostUserCreated", () => {
    assert.equal(getEventParamName("IPostUserCreated"), "context");
  });

  it("returns 'externalComponent' for IPostExternalComponentOpened", () => {
    assert.equal(
      getEventParamName("IPostExternalComponentOpened"),
      "externalComponent",
    );
  });

  it("returns null for unknown interface", () => {
    assert.equal(getEventParamName("INonExistent"), null);
  });

  it("returns a param name for every APP_EVENTS entry", () => {
    for (const entries of Object.values(APP_EVENTS)) {
      for (const entry of entries) {
        const result = getEventParamName(entry.name);
        assert.ok(result, `No param for ${entry.name}`);
        assert.equal(result, entry.param);
      }
    }
  });
});
