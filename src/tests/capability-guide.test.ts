import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCapabilityGuide,
  formatAppEventsGuide,
  getEventParamName,
  getEventShapes,
  APP_EVENTS,
} from "../capability-guide.js";
import { resolveEventInfo } from "../rc-app/parser.js";
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
    assert.ok(
      result.includes(
        "Send Message (needs rid; supports tmid for threads; does NOT resolve @here, @all, @user mentions or #channel names \u2014 use postMessage if you need mention pings or channel-name lookup) → post-api-v1-chat_sendMessage",
      ),
    );
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
    assert.ok(
      result.includes(
        "Post Message (resolves #channel and @user names; processes @here/@all mentions; use when sending by channel name) → post-api-v1-chat_postMessage",
      ),
    );
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
    // Domain note line sits between header and entries, so find the entries line by content
    const entriesLine = lines.slice(roomsIdx + 1).find((l) => l.includes("→"));
    assert.ok(entriesLine, "should have an entries line with →");
    assert.ok(entriesLine.includes("Create Channel → op1"));
    assert.ok(entriesLine.includes("Create Room → op2"));
    assert.ok(entriesLine.includes("Create Team → op3"));
  });

  it("annotates confusing endpoints with inline hints", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Post Message",
        operationId: "post-api-v1-chat_postMessage",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Search Message",
        operationId: "get-api-v1-chat_search",
      }),
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Delete Message",
        operationId: "post-api-v1-chat_delete",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    // Annotated endpoints include the hint
    assert.ok(
      result.includes(
        "Post Message (resolves #channel and @user names; processes @here/@all mentions; use when sending by channel name) → post-api-v1-chat_postMessage",
      ),
    );
    assert.ok(
      result.includes(
        "Search Message (searches message text content by keyword in a room) → get-api-v1-chat_search",
      ),
    );
    // Non-annotated endpoint stays plain
    assert.ok(result.includes("Delete Message → post-api-v1-chat_delete"));
    assert.ok(!result.includes("Delete Message ("));
  });

  it("adds domain note at top of rooms section", () => {
    const endpoints = [
      makeEndpoint({
        domain: "rooms",
        tag: "Channels",
        summary: "Get Channel List",
        operationId: "get-api-v1-channels_list",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    const lines = result.split("\n");
    const roomsIdx = lines.findIndex((l) => l.startsWith("## rooms"));
    assert.ok(roomsIdx >= 0);
    // Note line should be right after the header
    assert.ok(
      lines[roomsIdx + 1].includes("channels_* = public only"),
      "domain note should appear after ## rooms header",
    );
    // Entries should follow the note
    assert.ok(
      lines[roomsIdx + 2].includes(
        "Get Channel List (all channels; sortable; full objects with _id) → get-api-v1-channels_list",
      ),
    );
  });

  it("does NOT add domain note for domains without one", () => {
    const endpoints = [
      makeEndpoint({
        domain: "messaging",
        tag: "Chat",
        summary: "Send Message",
        operationId: "post-api-v1-chat_sendMessage",
      }),
    ];
    const result = formatCapabilityGuide(endpoints);

    const lines = result.split("\n");
    const msgIdx = lines.findIndex((l) => l.startsWith("## messaging"));
    assert.ok(msgIdx >= 0);
    // Very next line should be entries, not a note
    assert.ok(
      lines[msgIdx + 1].includes("→"),
      "messaging section should have entries immediately after header",
    );
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
    assert.ok(result.includes("triggerEvent"));
    assert.ok(result.includes("eventInterfaces"));
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

  it("every entry resolves param, shapeKey, and shape at runtime", () => {
    for (const [category, entries] of Object.entries(APP_EVENTS)) {
      for (const entry of entries) {
        const infoMap = resolveEventInfo([entry.name]);
        const info = infoMap[entry.name];
        assert.ok(
          info,
          `resolveEventInfo returned nothing for ${entry.name} in ${category}`,
        );
        assert.ok(
          info.param.length > 0,
          `Empty param for ${entry.name} in ${category}`,
        );
        assert.ok(
          info.shapeKey.length > 0,
          `Empty shapeKey for ${entry.name} in ${category}`,
        );
        assert.ok(
          info.shape,
          `No shape resolved for ${entry.name} (shapeKey: ${info.shapeKey}) in ${category}`,
        );
      }
    }
  });
});

describe("resolveEventInfo", () => {
  it("returns param, shapeKey, and shape for a known interface", () => {
    const result = resolveEventInfo(["IPostMessageSent"]);
    const info = result["IPostMessageSent"];
    assert.ok(info);
    assert.equal(info.param, "message");
    assert.equal(info.shapeKey, "IMessage");
    assert.ok(info.shape);
    assert.ok("text?" in info.shape || "sender" in info.shape);
  });

  it("returns empty record for unknown interface", () => {
    const result = resolveEventInfo(["INonExistent"]);
    assert.deepEqual(result, {});
  });

  it("batches multiple interfaces in one call", () => {
    const result = resolveEventInfo([
      "IPostMessageSent",
      "IPostRoomCreate",
      "IPostUserCreated",
    ]);
    assert.equal(Object.keys(result).length, 3);
    assert.equal(result["IPostMessageSent"].param, "message");
    assert.equal(result["IPostRoomCreate"].param, "room");
    assert.equal(result["IPostUserCreated"].param, "context");
  });

  it("deduplicates shared shapeKeys across interfaces", () => {
    // IPostMessageSent and IPostMessageDeleted both use IMessage
    const result = resolveEventInfo([
      "IPostMessageSent",
      "IPostMessageDeleted",
    ]);
    assert.equal(result["IPostMessageSent"].shapeKey, "IMessage");
    assert.equal(result["IPostMessageDeleted"].shapeKey, "IMessage");
    assert.deepEqual(
      result["IPostMessageSent"].shape,
      result["IPostMessageDeleted"].shape,
    );
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
      }
    }
  });
});
