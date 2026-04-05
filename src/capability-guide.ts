import type { CompactEndpoint } from "./mcp-server/parser/types.js";
import { resolveEventInfo } from "./rc-app/parser.js";

/** Inline hints appended to confusing endpoints: `Summary (hint) → operationId` */
const ENDPOINT_ANNOTATIONS: Record<string, string> = {
  // messaging — postMessage vs sendMessage
  "post-api-v1-chat_postMessage": "resolves #channel and @user names",
  "post-api-v1-chat_sendMessage": "needs rid; supports tmid for threads",
  // messaging — search
  "get-api-v1-chat_search":
    "searches message text content by keyword in a room",
  // messaging — DM history vs messages
  "get-api-v1-im_history": "time-range filter: oldest/latest",
  "get-api-v1-im_messages": "paginated; no time filter",
  // messaging — discussions
  "get-api-v1-chat_getDiscussions": "use rooms_getDiscussions instead",
  // rooms — channel lists
  "get-api-v1-channels_list": "all channels; sortable; full objects with _id",
  "get-api-v1-channels_list_joined": "only user's joined channels",
  // rooms — discussions
  "get-api-v1-rooms_getDiscussions": "preferred over chat variant",
  // rooms — history vs messages
  "get-api-v1-channels_history": "time-range: oldest/latest params",
  "get-api-v1-groups_history": "time-range; private groups",
  "get-api-v1-channels_messages": "paginated; public channels",
  "get-api-v1-groups_messages": "paginated; private groups",
  // user-management
  "post-api-v1-users_create": "admin-only",
  "post-api-v1-users_register": "self-registration",
  // statistics — engagement
  "get-api-v1-engagement-dashboard-messages-top-five-popular-channels":
    "max 5; no _id; analytics only",
};

/** Notes placed at the top of a domain section, before its endpoint entries. */
const DOMAIN_NOTES: Record<string, string> = {
  rooms:
    "channels_* = public only. groups_* = private only. rooms_* = any type. Prefer rooms_* when type unknown.",
};

export { ENDPOINT_ANNOTATIONS, DOMAIN_NOTES };

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
    const items = [...entries].map(([summary, opId]) => {
      const hint = ENDPOINT_ANNOTATIONS[opId];
      return hint ? `${summary} (${hint}) → ${opId}` : `${summary} → ${opId}`;
    });
    const note = DOMAIN_NOTES[domain];
    sections.push(
      note
        ? `## ${domain}\n${note}\n${items.join(", ")}`
        : `## ${domain}\n${items.join(", ")}`,
    );
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
}

const APP_EVENTS: Record<string, AppEventEntry[]> = {
  messages: [
    {
      name: "IPostMessageSent",
      desc: "after message sent",
    },
    {
      name: "IPostMessageSentToBot",
      desc: "DM sent to bot",
    },
    {
      name: "IPostMessageDeleted",
      desc: "after message deleted",
    },
    {
      name: "IPostMessageUpdated",
      desc: "after message updated",
    },
    {
      name: "IPostMessageReacted",
      desc: "reaction added/removed",
    },
    {
      name: "IPostMessageFollowed",
      desc: "message followed/unfollowed",
    },
    {
      name: "IPostMessagePinned",
      desc: "message pinned/unpinned",
    },
    {
      name: "IPostMessageStarred",
      desc: "message starred/unstarred",
    },
    {
      name: "IPostMessageReported",
      desc: "message reported",
    },
    {
      name: "IPostSystemMessageSent",
      desc: "system message sent",
    },
    {
      name: "IPreMessageSentPrevent",
      desc: "block message from being sent",
    },
    {
      name: "IPreMessageSentExtend",
      desc: "enrich message before send",
    },
    {
      name: "IPreMessageSentModify",
      desc: "modify message before send",
    },
    {
      name: "IPreMessageDeletePrevent",
      desc: "block message deletion",
    },
    {
      name: "IPreMessageUpdatedPrevent",
      desc: "block message update",
    },
    {
      name: "IPreMessageUpdatedExtend",
      desc: "enrich message before update",
    },
    {
      name: "IPreMessageUpdatedModify",
      desc: "modify message before update",
    },
  ],
  rooms: [
    {
      name: "IPostRoomCreate",
      desc: "after room created",
    },
    {
      name: "IPostRoomDeleted",
      desc: "after room deleted",
    },
    {
      name: "IPostRoomUserJoined",
      desc: "after user joins room",
    },
    {
      name: "IPostRoomUserLeave",
      desc: "after user leaves room",
    },
    {
      name: "IPreRoomCreatePrevent",
      desc: "block room creation",
    },
    {
      name: "IPreRoomCreateExtend",
      desc: "enrich room before creation",
    },
    {
      name: "IPreRoomCreateModify",
      desc: "modify room before creation",
    },
    {
      name: "IPreRoomDeletePrevent",
      desc: "block room deletion",
    },
    {
      name: "IPreRoomUserJoined",
      desc: "before user joins room",
    },
    {
      name: "IPreRoomUserLeave",
      desc: "before user leaves room",
    },
  ],
  livechat: [
    {
      name: "IPostLivechatRoomStarted",
      desc: "livechat room started",
    },
    {
      name: "IPostLivechatRoomClosed",
      desc: "livechat room closed",
    },
    {
      name: "IPostLivechatAgentAssigned",
      desc: "agent assigned to livechat",
    },
    {
      name: "IPostLivechatAgentUnassigned",
      desc: "agent removed from livechat",
    },
    {
      name: "IPostLivechatRoomTransferred",
      desc: "livechat room transferred",
    },
    {
      name: "IPostLivechatGuestSaved",
      desc: "visitor info saved",
    },
    {
      name: "IPostLivechatRoomSaved",
      desc: "livechat room info saved",
    },
    {
      name: "IPostLivechatDepartmentRemoved",
      desc: "livechat department removed",
    },
    {
      name: "IPostLivechatDepartmentDisabled",
      desc: "livechat department disabled",
    },
    {
      name: "IPreLivechatRoomCreatePrevent",
      desc: "block livechat room creation",
    },
  ],
  users: [
    {
      name: "IPostUserCreated",
      desc: "new user registered",
    },
    {
      name: "IPostUserUpdated",
      desc: "user profile updated",
    },
    {
      name: "IPostUserDeleted",
      desc: "user account deleted",
    },
    {
      name: "IPostUserLoggedIn",
      desc: "user logged in",
    },
    {
      name: "IPostUserLoggedOut",
      desc: "user logged out",
    },
    {
      name: "IPostUserStatusChanged",
      desc: "user status changed (online/away/busy/offline)",
    },
  ],
  email: [
    {
      name: "IPreEmailSent",
      desc: "before outgoing email sent",
    },
  ],
  uploads: [
    {
      name: "IPreFileUpload",
      desc: "before file upload",
    },
  ],
  externalComponent: [
    {
      name: "IPostExternalComponentOpened",
      desc: "external component opened",
    },
    {
      name: "IPostExternalComponentClosed",
      desc: "external component closed",
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
    `\n\nUse interface names as \`triggerEvent\` on individual workflows. ` +
    `Call get_endpoint_schemas with eventInterfaces to get exact param shapes before writing workflows.`
  );
}

export function getEventShapes(
  interfaceNames: string[],
): Record<string, Record<string, unknown>> {
  const infoMap = resolveEventInfo(interfaceNames);
  const result: Record<string, Record<string, unknown>> = {};
  for (const ifaceName of interfaceNames) {
    const info = infoMap[ifaceName];
    if (info?.shape) {
      result[ifaceName] = { [info.param]: info.shape };
    }
  }
  return result;
}

export function getEventParamName(interfaceName: string): string | null {
  const infoMap = resolveEventInfo([interfaceName]);
  return infoMap[interfaceName]?.param ?? null;
}

export { APP_EVENTS };
