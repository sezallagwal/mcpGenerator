import type { WorkflowDefinition, WorkflowStep } from "./types.js";

const CHANNELS_CREATE_OP = "post-api-v1-channels_create";
const POST_MESSAGE_OP = "post-api-v1-chat_postMessage";
const SEND_MESSAGE_OP = "post-api-v1-chat_sendMessage";

/**
 * For each hardcoded channel reference (#foo) in a postMessage/sendMessage step,
 * inject an ensure_* step (channels.create) before it so the channel exists.
 *
 * When the associated message step references {{params.sender}}, the ensure step
 * also passes members: [sender.id] so the user is auto-invited to the channel
 * (both on fresh creation and via the duplicate-channel fallback in the engine).
 */
export function injectEnsureChannelSteps(wf: WorkflowDefinition): void {
  const channelFirstIdx = new Map<string, number>();
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (step.config.type !== "api_call") continue;
    if (step.config.operationId !== POST_MESSAGE_OP) continue;
    const channel = step.config.inputMapping?.channel;
    if (typeof channel !== "string" || !channel.startsWith("#")) continue;
    if (channel.includes("{{")) continue;
    if (!channelFirstIdx.has(channel)) {
      channelFirstIdx.set(channel, i);
    }
  }

  if (channelFirstIdx.size === 0) return;

  const channelName = (ch: string) => ch.slice(1);
  for (const channel of [...channelFirstIdx.keys()]) {
    const slug = channelName(channel).replace(/[^a-zA-Z0-9]/g, "_");
    const hasEnsure = wf.steps.some((s) => {
      if (
        s.id === `ensure_${slug}` ||
        (s.id.startsWith("ensure_") && s.id.endsWith(`_${slug}`))
      )
        return true;
      if (
        s.config.type === "api_call" &&
        s.config.operationId === CHANNELS_CREATE_OP &&
        s.config.inputMapping?.name === channelName(channel)
      )
        return true;
      return false;
    });
    if (hasEnsure) channelFirstIdx.delete(channel);
  }

  if (channelFirstIdx.size === 0) return;

  const sorted = [...channelFirstIdx.entries()].sort((a, b) => b[1] - a[1]);

  for (const [channel, firstIdx] of sorted) {
    const slug = channel.slice(1).replace(/[^a-zA-Z0-9]/g, "_");
    const ensureId = `ensure_${slug}`;
    const postStep = wf.steps[firstIdx];

    // Check if the associated postMessage step (or any nearby step posting to
    // this channel) references {{params.sender}} — if so, automatically invite
    // the sender to the channel so they can see the message.
    const senderReferenced = wf.steps.some((s) => {
      if (s.config.type !== "api_call") return false;
      if (
        s.config.operationId !== POST_MESSAGE_OP &&
        s.config.operationId !== SEND_MESSAGE_OP
      )
        return false;
      const mapping = s.config.inputMapping;
      if (!mapping) return false;
      const json = JSON.stringify(mapping);
      return json.includes("params.sender") && json.includes(channel);
    });
    // Also check more broadly: does any step in the workflow reference sender?
    const hasSenderParam = wf.steps.some((s) => {
      const json = JSON.stringify(s.config);
      return json.includes("params.sender");
    });

    const inputMapping: Record<string, unknown> = { name: channel.slice(1) };
    if (senderReferenced || hasSenderParam) {
      // channels.create API accepts usernames in members[] (not IDs).
      // The engine's duplicate handler also handles usernames correctly.
      inputMapping.members = ["{{params.sender.username}}"];
    }

    const ensureStep: WorkflowStep = {
      id: ensureId,
      label: `Ensure ${channel} channel exists`,
      config: {
        type: "api_call",
        operationId: CHANNELS_CREATE_OP,
        inputMapping,
      },
      dependsOn: postStep.dependsOn ? [...postStep.dependsOn] : [],
    };

    wf.steps.splice(firstIdx, 0, ensureStep);

    for (const step of wf.steps) {
      if (step.config.type !== "api_call") continue;
      if (step.config.operationId !== POST_MESSAGE_OP) continue;
      if (step.config.inputMapping?.channel !== channel) continue;
      if (!step.dependsOn) step.dependsOn = [];
      if (!step.dependsOn.includes(ensureId)) {
        step.dependsOn.push(ensureId);
      }
    }

    if (!wf.requiredEndpoints.includes(CHANNELS_CREATE_OP)) {
      wf.requiredEndpoints.push(CHANNELS_CREATE_OP);
    }
  }
}
