import type { WorkflowDefinition, WorkflowStep } from "./types.js";

const CHANNELS_CREATE_OP = "post-api-v1-channels_create";
const POST_MESSAGE_OP = "post-api-v1-chat_postMessage";

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

    const ensureStep: WorkflowStep = {
      id: ensureId,
      label: `Ensure ${channel} channel exists`,
      config: {
        type: "api_call",
        operationId: CHANNELS_CREATE_OP,
        inputMapping: { name: channel.slice(1) },
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
