import type { CompactEndpoint } from "./mcp-server/parser/types.js";

export function formatCapabilityGuide(endpoints: CompactEndpoint[]): string {
  if (endpoints.length === 0) {
    return "No endpoints found.";
  }

  const byDomain = new Map<string, Map<string, string>>();

  for (const ep of endpoints) {
    let entries = byDomain.get(ep.domain);
    if (!entries) {
      entries = new Map();
      byDomain.set(ep.domain, entries);
    }
    if (!entries.has(ep.summary)) {
      entries.set(ep.summary, ep.operationId);
    }
  }

  const sections: string[] = [];
  for (const [domain, entries] of byDomain) {
    const items = [...entries].map(([summary, opId]) => `${summary} → ${opId}`);
    sections.push(`## ${domain}\n${items.join(", ")}`);
  }

  return (
    `── Capability Guide ──\n\n` +
    sections.join("\n\n") +
    `\n\nUse the operationIds (after →) in workflow steps. Call get_endpoint_schemas with your chosen operationIds to get exact request/response schemas.`
  );
}

interface AppEventEntry {
  name: string;
  desc: string;
  param?: string;
  shapeKey?: string;
}

const SHAPES: Record<string, Record<string, unknown>> = {
  IMessage: {
    id: "string?",
    text: "string?",
    room: {
      id: "string",
      displayName: "string?",
      slugifiedName: "string",
      type: "string",
    },
    sender: {
      id: "string",
      username: "string",
      name: "string",
      roles: "string[]",
    },
    threadId: "string?",
    emoji: "string?",
    alias: "string?",
    attachments: "array?",
    customFields: "object?",
    pinned: "boolean?",
    type: "string?",
  },
  IRoom: {
    id: "string",
    displayName: "string?",
    slugifiedName: "string",
    type: "string",
    creator: { id: "string", username: "string", name: "string" },
    isDefault: "boolean?",
    isReadOnly: "boolean?",
    description: "string?",
    customFields: "object?",
  },
  IRoomUserJoinedContext: {
    joiningUser: {
      id: "string",
      username: "string",
      name: "string",
      roles: "string[]",
    },
    room: {
      id: "string",
      displayName: "string?",
      slugifiedName: "string",
      type: "string",
    },
    inviter: { id: "string?", username: "string?" },
  },
  IRoomUserLeaveContext: {
    leavingUser: {
      id: "string",
      username: "string",
      name: "string",
      roles: "string[]",
    },
    room: {
      id: "string",
      displayName: "string?",
      slugifiedName: "string",
      type: "string",
    },
    removedBy: { id: "string?", username: "string?" },
  },
  IMessageReactionContext: {
    reaction: "string",
    isReacted: "boolean",
    message: {
      id: "string?",
      text: "string?",
      room: { id: "string", type: "string" },
      sender: { id: "string", username: "string" },
    },
    user: { id: "string", username: "string" },
  },
  IMessageFollowContext: {
    message: {
      id: "string?",
      text: "string?",
      room: { id: "string", type: "string" },
      sender: { id: "string", username: "string" },
    },
    user: { id: "string", username: "string" },
    isFollowed: "boolean",
  },
  IMessagePinContext: {
    message: {
      id: "string?",
      text: "string?",
      room: { id: "string", type: "string" },
      sender: { id: "string", username: "string" },
    },
    user: { id: "string", username: "string" },
    isPinned: "boolean",
  },
  IMessageStarContext: {
    message: {
      id: "string?",
      text: "string?",
      room: { id: "string", type: "string" },
      sender: { id: "string", username: "string" },
    },
    user: { id: "string", username: "string" },
    isStarred: "boolean",
  },
  IMessageReportContext: {
    message: {
      id: "string?",
      text: "string?",
      room: { id: "string", type: "string" },
      sender: { id: "string", username: "string" },
    },
    user: { id: "string", username: "string" },
    reason: "string",
  },
  ILivechatRoom: {
    id: "string",
    displayName: "string?",
    slugifiedName: "string",
    type: "string",
    visitor: {
      id: "string?",
      token: "string",
      username: "string",
      name: "string",
    },
    department: "string?",
    servedBy: { id: "string?", username: "string?" },
    isOpen: "boolean",
    closedBy: { id: "string?", username: "string?" },
  },
  ILivechatEventContext: {
    agent: { id: "string", username: "string", name: "string" },
    room: {
      id: "string",
      displayName: "string?",
      type: "string",
      visitor: { token: "string", name: "string" },
    },
  },
  ILivechatTransferEventContext: {
    type: "string",
    room: { id: "string", displayName: "string?", type: "string" },
    from: { id: "string", username: "string" },
    to: { id: "string", username: "string" },
  },
  IVisitor: {
    id: "string?",
    token: "string",
    username: "string",
    name: "string",
    department: "string?",
    phone: "string?",
    visitorEmails: "array?",
    customFields: "object?",
  },
  ILivechatDepartmentEventContext: {
    department: {
      id: "string",
      name: "string?",
      email: "string?",
      description: "string?",
    },
  },
  IUser: {
    id: "string",
    username: "string",
    name: "string",
    emails: "array",
    type: "string",
    isEnabled: "boolean",
    roles: "string[]",
    status: "string",
    statusText: "string?",
  },
  IUserContext: {
    user: {
      id: "string",
      username: "string",
      name: "string",
      roles: "string[]",
      status: "string",
    },
    performedBy: { id: "string?", username: "string?" },
  },
  IUserStatusContext: {
    user: { id: "string", username: "string", name: "string" },
    currentStatus: "string",
    previousStatus: "string",
  },
  IPreEmailSentContext: {
    email: {
      from: "string?",
      to: "string?",
      cc: "string?",
      bcc: "string?",
      replyTo: "string?",
      subject: "string?",
      text: "string?",
      html: "string?",
    },
    context: "string",
  },
  IFileUploadContext: {
    file: { name: "string", size: "number", type: "string" },
    content: "any",
  },
  IExternalComponent: {
    appId: "string",
    name: "string",
    description: "string",
    icon: "string?",
    url: "string?",
  },
};

const APP_EVENTS: Record<string, AppEventEntry[]> = {
  messages: [
    {
      name: "IPostMessageSent",
      desc: "after message sent",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPostMessageSentToBot",
      desc: "DM sent to bot",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPostMessageDeleted",
      desc: "after message deleted",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPostMessageUpdated",
      desc: "after message updated",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPostMessageReacted",
      desc: "reaction added/removed",
      param: "context",
      shapeKey: "IMessageReactionContext",
    },
    {
      name: "IPostMessageFollowed",
      desc: "message followed/unfollowed",
      param: "context",
      shapeKey: "IMessageFollowContext",
    },
    {
      name: "IPostMessagePinned",
      desc: "message pinned/unpinned",
      param: "context",
      shapeKey: "IMessagePinContext",
    },
    {
      name: "IPostMessageStarred",
      desc: "message starred/unstarred",
      param: "context",
      shapeKey: "IMessageStarContext",
    },
    {
      name: "IPostMessageReported",
      desc: "message reported",
      param: "context",
      shapeKey: "IMessageReportContext",
    },
    {
      name: "IPostSystemMessageSent",
      desc: "system message sent",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageSentPrevent",
      desc: "block message from being sent",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageSentExtend",
      desc: "enrich message before send",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageSentModify",
      desc: "modify message before send",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageDeletePrevent",
      desc: "block message deletion",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageUpdatedPrevent",
      desc: "block message update",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageUpdatedExtend",
      desc: "enrich message before update",
      param: "message",
      shapeKey: "IMessage",
    },
    {
      name: "IPreMessageUpdatedModify",
      desc: "modify message before update",
      param: "message",
      shapeKey: "IMessage",
    },
  ],
  rooms: [
    {
      name: "IPostRoomCreate",
      desc: "after room created",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPostRoomDeleted",
      desc: "after room deleted",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPostRoomUserJoined",
      desc: "after user joins room",
      param: "context",
      shapeKey: "IRoomUserJoinedContext",
    },
    {
      name: "IPostRoomUserLeave",
      desc: "after user leaves room",
      param: "context",
      shapeKey: "IRoomUserLeaveContext",
    },
    {
      name: "IPreRoomCreatePrevent",
      desc: "block room creation",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPreRoomCreateExtend",
      desc: "enrich room before creation",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPreRoomCreateModify",
      desc: "modify room before creation",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPreRoomDeletePrevent",
      desc: "block room deletion",
      param: "room",
      shapeKey: "IRoom",
    },
    {
      name: "IPreRoomUserJoined",
      desc: "before user joins room",
      param: "context",
      shapeKey: "IRoomUserJoinedContext",
    },
    {
      name: "IPreRoomUserLeave",
      desc: "before user leaves room",
      param: "context",
      shapeKey: "IRoomUserLeaveContext",
    },
  ],
  livechat: [
    {
      name: "IPostLivechatRoomStarted",
      desc: "livechat room started",
      param: "room",
      shapeKey: "ILivechatRoom",
    },
    {
      name: "IPostLivechatRoomClosed",
      desc: "livechat room closed",
      param: "room",
      shapeKey: "ILivechatRoom",
    },
    {
      name: "IPostLivechatAgentAssigned",
      desc: "agent assigned to livechat",
      param: "context",
      shapeKey: "ILivechatEventContext",
    },
    {
      name: "IPostLivechatAgentUnassigned",
      desc: "agent removed from livechat",
      param: "context",
      shapeKey: "ILivechatEventContext",
    },
    {
      name: "IPostLivechatRoomTransferred",
      desc: "livechat room transferred",
      param: "context",
      shapeKey: "ILivechatTransferEventContext",
    },
    {
      name: "IPostLivechatGuestSaved",
      desc: "visitor info saved",
      param: "context",
      shapeKey: "IVisitor",
    },
    {
      name: "IPostLivechatRoomSaved",
      desc: "livechat room info saved",
      param: "context",
      shapeKey: "ILivechatRoom",
    },
    {
      name: "IPostLivechatDepartmentRemoved",
      desc: "livechat department removed",
      param: "context",
      shapeKey: "ILivechatDepartmentEventContext",
    },
    {
      name: "IPostLivechatDepartmentDisabled",
      desc: "livechat department disabled",
      param: "context",
      shapeKey: "ILivechatDepartmentEventContext",
    },
    {
      name: "IPreLivechatRoomCreatePrevent",
      desc: "block livechat room creation",
      param: "room",
      shapeKey: "ILivechatRoom",
    },
  ],
  users: [
    {
      name: "IPostUserCreated",
      desc: "new user registered",
      param: "context",
      shapeKey: "IUserContext",
    },
    {
      name: "IPostUserUpdated",
      desc: "user profile updated",
      param: "context",
      shapeKey: "IUserContext",
    },
    {
      name: "IPostUserDeleted",
      desc: "user account deleted",
      param: "context",
      shapeKey: "IUserContext",
    },
    {
      name: "IPostUserLoggedIn",
      desc: "user logged in",
      param: "context",
      shapeKey: "IUser",
    },
    {
      name: "IPostUserLoggedOut",
      desc: "user logged out",
      param: "context",
      shapeKey: "IUser",
    },
    {
      name: "IPostUserStatusChanged",
      desc: "user status changed (online/away/busy/offline)",
      param: "context",
      shapeKey: "IUserStatusContext",
    },
  ],
  email: [
    {
      name: "IPreEmailSent",
      desc: "before outgoing email sent",
      param: "context",
      shapeKey: "IPreEmailSentContext",
    },
  ],
  uploads: [
    {
      name: "IPreFileUpload",
      desc: "before file upload",
      param: "context",
      shapeKey: "IFileUploadContext",
    },
  ],
  externalComponent: [
    {
      name: "IPostExternalComponentOpened",
      desc: "external component opened",
      param: "externalComponent",
      shapeKey: "IExternalComponent",
    },
    {
      name: "IPostExternalComponentClosed",
      desc: "external component closed",
      param: "externalComponent",
      shapeKey: "IExternalComponent",
    },
  ],
};

export function formatAppEventsGuide(): string {
  const sections: string[] = [];
  let total = 0;

  for (const [category, entries] of Object.entries(APP_EVENTS)) {
    total += entries.length;
    const items = entries.map((e) => `${e.name} — ${e.desc}`);
    sections.push(`## ${category} (${entries.length})\n${items.join(", ")}`);
  }

  return (
    `\n\n── App Events (${total} realtime handlers — use when prompt says "when X happens, do Y") ──\n\n` +
    sections.join("\n\n") +
    `\n\nPick interface names and pass them as eventInterfaces to generate. ` +
    `Call get_endpoint_schemas with eventInterfaces to get exact param shapes before writing workflows.`
  );
}

function stringifyShape(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "object" && val !== null) {
      parts.push(`${key}: ${stringifyShape(val as Record<string, unknown>)}`);
    } else {
      const s = String(val);
      parts.push(s.endsWith("?") ? `${key}?` : key);
    }
  }
  return `{ ${parts.join(", ")} }`;
}

export function formatEventShapesGuide(): string {
  const byShape = new Map<string, string[]>();

  for (const entries of Object.values(APP_EVENTS)) {
    for (const e of entries) {
      if (!e.param || !e.shapeKey) continue;
      const key = `${e.param}|${e.shapeKey}`;
      const list = byShape.get(key) ?? [];
      list.push(`${e.name}.${e.param}`);
      byShape.set(key, list);
    }
  }

  const lines: string[] = [];
  for (const [key, names] of byShape) {
    const shapeKey = key.split("|")[1];
    const shape = SHAPES[shapeKey];
    if (!shape) continue;
    lines.push(`${names.join(" | ")}: ${stringifyShape(shape)}`);
  }

  return (
    `\n\n── Event Param Shapes (access via {{params.<param>.<field>}}) ──\n\n` +
    lines.join("\n") +
    `\n\nNested fields shown as { key: { subkey } }. Use exact field names in workflow templates.`
  );
}

export function getEventShapes(
  interfaceNames: string[],
): Record<string, { param: string; shape: Record<string, unknown> }> {
  const result: Record<
    string,
    { param: string; shape: Record<string, unknown> }
  > = {};
  for (const ifaceName of interfaceNames) {
    for (const entries of Object.values(APP_EVENTS)) {
      const found = entries.find((e) => e.name === ifaceName);
      if (found?.param && found.shapeKey && SHAPES[found.shapeKey]) {
        result[ifaceName] = {
          param: found.param,
          shape: SHAPES[found.shapeKey],
        };
        break;
      }
    }
  }
  return result;
}

export function getEventParamName(interfaceName: string): string | null {
  for (const entries of Object.values(APP_EVENTS)) {
    const found = entries.find((e) => e.name === interfaceName);
    if (found?.param) return found.param;
  }
  return null;
}

export { APP_EVENTS, SHAPES, stringifyShape };
