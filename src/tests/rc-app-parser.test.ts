import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  listCapabilities,
  parseAllCapabilities,
  getCapabilities,
  getAvailableCategories,
  getCapabilitiesByCategory,
  clearCapabilityCache,
} from "../rc-app/parser.js";
import type {
  AppCapability,
  CompactCapability,
  MethodSignature,
} from "../rc-app/types.js";

beforeEach(() => {
  clearCapabilityCache();
});

describe("RC Apps-Engine Parser — Discovery", () => {
  it("should discover capabilities from installed package", () => {
    const caps = parseAllCapabilities();
    assert.ok(caps.length > 0, "Should find at least one capability");
    assert.ok(
      caps.length >= 40,
      `Expected 40+ capabilities, found ${caps.length}`,
    );
  });

  it("should return consistent results on repeated calls (caching)", () => {
    const first = parseAllCapabilities();
    const second = parseAllCapabilities();
    assert.strictEqual(first, second, "Should return same cached reference");
  });

  it("should return fresh results after cache clear", () => {
    const first = parseAllCapabilities();
    clearCapabilityCache();
    const second = parseAllCapabilities();
    assert.notStrictEqual(
      first,
      second,
      "Should return new reference after cache clear",
    );
    assert.strictEqual(
      first.length,
      second.length,
      "Same number of capabilities",
    );
  });
});

describe("RC Apps-Engine Parser — Categories", () => {
  it("should discover known categories", () => {
    const categories = getAvailableCategories();
    assert.ok(
      categories.includes("messages"),
      "Should have 'messages' category",
    );
    assert.ok(categories.includes("rooms"), "Should have 'rooms' category");
    assert.ok(
      categories.includes("livechat"),
      "Should have 'livechat' category",
    );
    assert.ok(categories.includes("users"), "Should have 'users' category");
  });

  it("should filter by category", () => {
    const messageCaps = getCapabilitiesByCategory("messages");
    assert.ok(messageCaps.length > 0, "Should find message capabilities");
    for (const cap of messageCaps) {
      assert.strictEqual(cap.category, "messages");
    }
  });

  it("should return empty for non-existent category", () => {
    const caps = getCapabilitiesByCategory("nonexistent");
    assert.strictEqual(caps.length, 0);
  });
});

describe("RC Apps-Engine Parser — Compact Listing", () => {
  it("should return compact summaries", () => {
    const compact = listCapabilities();
    assert.ok(compact.length > 0);

    for (const cap of compact) {
      assert.ok(cap.interfaceName, "Should have interface name");
      assert.ok(cap.category, "Should have category");
      assert.ok(cap.summary, "Should have summary");
      assert.ok(cap.methodNames.length > 0, "Should have at least one method");
      assert.strictEqual(typeof cap.deprecated, "boolean");
    }
  });

  it("should include known interfaces", () => {
    const compact = listCapabilities();
    const names = compact.map((c) => c.interfaceName);
    assert.ok(
      names.includes("IPostMessageSent"),
      "Should include IPostMessageSent",
    );
    assert.ok(
      names.includes("IPreRoomCreatePrevent"),
      "Should include IPreRoomCreatePrevent",
    );
    assert.ok(
      names.includes("IPostUserCreated"),
      "Should include IPostUserCreated",
    );
  });
});

describe("RC Apps-Engine Parser — Full Details", () => {
  it("should get full details for IPostMessageSent", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap, "Should find IPostMessageSent");
    assert.strictEqual(cap.interfaceName, "IPostMessageSent");
    assert.strictEqual(cap.category, "messages");
    assert.strictEqual(cap.deprecated, false);
    assert.ok(cap.importPath.includes("IPostMessageSent"));
  });

  it("should extract method signatures for IPostMessageSent", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);
    assert.ok(cap.methods.length >= 1, "Should have at least execute method");

    const execute = cap.methods.find((m) =>
      m.name.includes("executePostMessageSent"),
    );
    assert.ok(execute, "Should have executePostMessageSent method");
    assert.strictEqual(execute.isOptional, false, "Execute method is required");
    assert.strictEqual(execute.returnType, "Promise<void>");

    assert.ok(execute.parameters.length >= 3, "Should have 3+ parameters");
    const msgParam = execute.parameters[0];
    assert.strictEqual(msgParam.name, "message");
    assert.strictEqual(msgParam.type, "IMessage");
  });

  it("should detect optional check method", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);

    const check = cap.methods.find((m) => m.name.includes("check"));
    assert.ok(check, "Should have a check method");
    assert.strictEqual(
      check.isOptional,
      true,
      "Check method should be optional",
    );
    assert.strictEqual(check.returnType, "Promise<boolean>");
  });

  it("should extract accessor parameters", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);

    const execute = cap.methods.find((m) => m.name.includes("execute"))!;
    const paramNames = execute.parameters.map((p) => p.name);
    const paramTypes = execute.parameters.map((p) => p.type);

    assert.ok(paramNames.includes("read"), "Should have 'read' param");
    assert.ok(paramNames.includes("http"), "Should have 'http' param");
    assert.ok(paramTypes.includes("IRead"), "Should have IRead type");
    assert.ok(paramTypes.includes("IHttp"), "Should have IHttp type");
  });

  it("should extract JSDoc descriptions", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);
    assert.ok(cap.jsDoc, "Should have interface-level JSDoc");

    const execute = cap.methods.find((m) => m.name.includes("execute"))!;
    assert.ok(execute.jsDoc, "Execute method should have JSDoc");
  });
});

describe("RC Apps-Engine Parser — Computed Property Names", () => {
  it("should resolve [AppMethod.X] to actual method names", () => {
    const [cap] = getCapabilities(["IPostUserCreated"]);
    assert.ok(cap, "Should find IPostUserCreated");

    const method = cap.methods[0];
    assert.ok(method, "Should have a method");
    assert.ok(
      method.name.includes("executePostUserCreated"),
      `Method name should be resolved, got: ${method.name}`,
    );
  });

  it("should resolve computed names for livechat interfaces", () => {
    const [cap] = getCapabilities(["IPostLivechatAgentAssigned"]);
    assert.ok(cap, "Should find IPostLivechatAgentAssigned");

    const method = cap.methods[0];
    assert.ok(
      method.name.includes("executePostLivechatAgentAssigned"),
      `Expected resolved name, got: ${method.name}`,
    );
  });

  it("should resolve computed names for email interface", () => {
    const [cap] = getCapabilities(["IPreEmailSent"]);
    assert.ok(cap, "Should find IPreEmailSent");

    const method = cap.methods[0];
    assert.ok(
      method.name.includes("executePreEmailSent"),
      `Expected resolved name, got: ${method.name}`,
    );
  });
});

describe("RC Apps-Engine Parser — Edge Cases", () => {
  it("should handle deprecated interfaces", () => {
    const caps = parseAllCapabilities();
    const deprecated = caps.filter((c) => c.deprecated);
    const handler = deprecated.find(
      (c) => c.interfaceName === "ILivechatRoomClosedHandler",
    );
    assert.ok(handler, "Should find deprecated ILivechatRoomClosedHandler");
  });

  it("should handle multi-method interfaces (UIKit)", () => {
    const caps = parseAllCapabilities();
    const uikit = caps.find(
      (c) => c.interfaceName === "IUIKitInteractionHandler",
    );
    if (uikit) {
      assert.ok(
        uikit.methods.length >= 3,
        `UIKit handler should have 3+ methods, found ${uikit.methods.length}`,
      );
    }
  });

  it("should return empty for unknown interface names", () => {
    const caps = getCapabilities(["IDoesNotExist"]);
    assert.strictEqual(caps.length, 0);
  });

  it("should handle multiple interface lookups at once", () => {
    const caps = getCapabilities([
      "IPostMessageSent",
      "IPostRoomCreate",
      "IPreFileUpload",
    ]);
    assert.strictEqual(caps.length, 3);
    const names = caps.map((c) => c.interfaceName);
    assert.ok(names.includes("IPostMessageSent"));
    assert.ok(names.includes("IPostRoomCreate"));
    assert.ok(names.includes("IPreFileUpload"));
  });

  it("should have optional modify param for some livechat handlers", () => {
    const [cap] = getCapabilities(["IPostLivechatAgentAssigned"]);
    assert.ok(cap);
    const method = cap.methods[0];
    const modifyParam = method.parameters.find((p) => p.name === "modify");
    if (modifyParam) {
      assert.strictEqual(
        modifyParam.isOptional,
        true,
        "modify should be optional for IPostLivechatAgentAssigned",
      );
    }
  });
});

describe("RC Apps-Engine Parser — Domain Coverage", () => {
  it("should find message-related capabilities", () => {
    const caps = getCapabilitiesByCategory("messages");
    assert.ok(
      caps.length >= 10,
      `Expected 10+ message caps, found ${caps.length}`,
    );

    const names = caps.map((c) => c.interfaceName);
    assert.ok(names.includes("IPostMessageSent"));
    assert.ok(names.includes("IPreMessageSentPrevent"));
    assert.ok(names.includes("IPostMessageDeleted"));
  });

  it("should find room-related capabilities", () => {
    const caps = getCapabilitiesByCategory("rooms");
    assert.ok(caps.length >= 5, `Expected 5+ room caps, found ${caps.length}`);
  });

  it("should find livechat-related capabilities", () => {
    const caps = getCapabilitiesByCategory("livechat");
    assert.ok(
      caps.length >= 5,
      `Expected 5+ livechat caps, found ${caps.length}`,
    );
  });

  it("should find user-related capabilities", () => {
    const caps = getCapabilitiesByCategory("users");
    assert.ok(caps.length >= 3, `Expected 3+ user caps, found ${caps.length}`);
  });
});

describe("RC Apps-Engine Parser — Import Paths", () => {
  it("should generate correct import paths", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);
    assert.ok(
      cap.importPath.includes("definition/messages/IPostMessageSent"),
      `Import path should include definition path, got: ${cap.importPath}`,
    );
  });

  it("should generate different import paths per category", () => {
    const caps = getCapabilities([
      "IPostMessageSent",
      "IPostRoomCreate",
      "IPostUserCreated",
    ]);
    const paths = caps.map((c) => c.importPath);
    assert.ok(paths[0].includes("messages"));
    assert.ok(paths[1].includes("rooms"));
    assert.ok(paths[2].includes("users"));
  });
});

describe("RC Apps-Engine Parser — Return Types", () => {
  it("should extract Promise<void> for post-event handlers", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);
    const execute = cap.methods.find((m) => m.name.includes("execute"))!;
    assert.strictEqual(execute.returnType, "Promise<void>");
  });

  it("should extract Promise<boolean> for prevent handlers", () => {
    const [cap] = getCapabilities(["IPreRoomCreatePrevent"]);
    assert.ok(cap);
    const execute = cap.methods.find((m) => m.name.includes("execute"))!;
    assert.strictEqual(execute.returnType, "Promise<boolean>");
  });

  it("should extract Promise<boolean> for check methods", () => {
    const [cap] = getCapabilities(["IPostMessageSent"]);
    assert.ok(cap);
    const check = cap.methods.find((m) => m.name.includes("check"))!;
    assert.strictEqual(check.returnType, "Promise<boolean>");
  });
});
