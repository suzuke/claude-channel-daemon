import type { FleetConfig, InstanceConfig } from "./types.js";
import type { ChannelAdapter } from "./channel/types.js";
import type { IpcClient } from "./channel/ipc-bridge.js";
import type { Logger } from "./logger.js";
import type { RoutingEngine } from "./routing-engine.js";
import type { InstanceLifecycle } from "./instance-lifecycle.js";
import type { EventLog } from "./event-log.js";

/** Shared context available to all outbound tool handlers. */
export interface OutboundContext {
  readonly fleetConfig: FleetConfig | null;
  readonly adapter: ChannelAdapter | null;
  readonly logger: Logger;
  readonly routing: RoutingEngine;
  readonly instanceIpcClients: Map<string, IpcClient>;
  readonly lifecycle: InstanceLifecycle;
  readonly sessionRegistry: Map<string, string>;
  readonly eventLog: EventLog | null;
  lastActivityMs(name: string): number;
  startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void>;
  connectIpcToInstance(name: string): Promise<void>;
}

/** Metadata extracted from the raw outbound message. */
export interface OutboundMeta {
  instanceName: string;
  requestId: number | undefined;
  fleetRequestId: string | undefined;
  senderSessionName: string | undefined;
}

type Respond = (result: unknown, error?: string) => void;
type Handler = (ctx: OutboundContext, args: Record<string, unknown>, respond: Respond, meta: OutboundMeta) => Promise<void> | void;

// ── Handler implementations ─────────────────────────────────────────────

const sendToInstance: Handler = (ctx, args, respond, meta) => {
  const targetName = args.instance_name as string;
  const message = args.message as string | undefined;
  if (!targetName) { respond(null, "send_to_instance: missing required argument 'instance_name'"); return; }
  if (!message) { respond(null, "send_to_instance: missing required argument 'message'"); return; }
  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const isExternalSender = meta.senderSessionName != null && meta.senderSessionName !== meta.instanceName;

  let targetIpc = ctx.instanceIpcClients.get(targetName);
  let targetSession: string = targetName;
  let targetInstanceName = targetName;

  if (!targetIpc) {
    const hostInstance = ctx.sessionRegistry.get(targetName);
    if (hostInstance) {
      targetIpc = ctx.instanceIpcClients.get(hostInstance);
      targetSession = targetName;
      targetInstanceName = hostInstance;
    }
  }

  if (!targetIpc) {
    const existsInConfig = targetName in (ctx.fleetConfig?.instances ?? {});
    if (existsInConfig) {
      respond(null, `Instance '${targetName}' is stopped. Use start_instance('${targetName}') to start it first.`);
    } else {
      respond(null, `Instance or session not found: ${targetName}`);
    }
    return;
  }

  const correlationId = (args.correlation_id as string) || `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ipcMeta: Record<string, string> = {
    chat_id: "",
    message_id: `xmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    user: `instance:${senderLabel}`,
    user_id: `instance:${senderLabel}`,
    ts: new Date().toISOString(),
    thread_id: "",
    from_instance: senderLabel,
    correlation_id: correlationId,
  };
  if (args.request_kind) ipcMeta.request_kind = args.request_kind as string;
  if (args.requires_reply != null) ipcMeta.requires_reply = String(args.requires_reply);
  if (args.task_summary) ipcMeta.task_summary = args.task_summary as string;
  if (args.working_directory) ipcMeta.working_directory = args.working_directory as string;
  if (args.branch) ipcMeta.branch = args.branch as string;

  targetIpc.send({ type: "fleet_inbound", targetSession, content: message, meta: ipcMeta });

  // Post to channel topics for visibility
  const groupId = ctx.fleetConfig?.channel?.group_id;
  if (groupId && ctx.adapter) {
    const senderTopicId = ctx.fleetConfig?.instances[meta.instanceName]?.topic_id;
    const targetTopicId = ctx.fleetConfig?.instances[targetInstanceName]?.topic_id;
    if (senderTopicId && !isExternalSender) {
      ctx.adapter.sendText(String(groupId), `→ ${targetName}:\n${message}`, {
        threadId: String(senderTopicId),
      }).catch(e => ctx.logger.warn({ err: e }, "Failed to post cross-instance notification"));
    }
    if (targetTopicId && !ctx.sessionRegistry.has(targetName)) {
      ctx.adapter.sendText(String(groupId), `← ${senderLabel}:\n${message}`, {
        threadId: String(targetTopicId),
      }).catch(e => ctx.logger.warn({ err: e }, "Failed to post cross-instance notification"));
    }
  }

  ctx.logger.info(`✉ ${senderLabel} → ${targetName}: ${(message ?? "").slice(0, 100)}`);
  const taskSummary = ipcMeta.task_summary || (message ?? "").slice(0, 200);
  ctx.eventLog?.logActivity("message", senderLabel, taskSummary, targetName, ipcMeta.request_kind);
  respond({ sent: true, target: targetName, correlation_id: correlationId });
};

const listInstances: Handler = (ctx, _args, respond, meta) => {
  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const allInstances = Object.entries(ctx.fleetConfig?.instances ?? {})
    .filter(([name]) => name !== meta.instanceName && name !== senderLabel)
    .map(([name, config]) => ({
      name,
      type: "instance" as const,
      status: ctx.lifecycle.daemons.has(name) ? "running" : "stopped",
      working_directory: config.working_directory,
      topic_id: config.topic_id ?? null,
      description: config.description ?? null,
      tags: config.tags ?? [],
      last_activity: ctx.lastActivityMs(name) ? new Date(ctx.lastActivityMs(name)).toISOString() : null,
    }));
  const externalSessions = [...ctx.sessionRegistry.entries()]
    .filter(([sessName]) => sessName !== senderLabel)
    .map(([sessName, hostInstance]) => ({ name: sessName, type: "session" as const, host: hostInstance }));
  respond({ instances: allInstances, external_sessions: externalSessions });
};

const describeInstance: Handler = (ctx, args, respond) => {
  const targetName = args.name as string;
  const config = ctx.fleetConfig?.instances[targetName];
  if (config) {
    respond({
      name: targetName,
      type: "instance",
      description: config.description ?? null,
      tags: config.tags ?? [],
      working_directory: config.working_directory,
      status: ctx.lifecycle.daemons.has(targetName) ? "running" : "stopped",
      topic_id: config.topic_id ?? null,
      model: config.model ?? null,
      last_activity: ctx.lastActivityMs(targetName) ? new Date(ctx.lastActivityMs(targetName)).toISOString() : null,
      worktree_source: config.worktree_source ?? null,
    });
    return;
  }
  const hostInstance = ctx.sessionRegistry.get(targetName);
  if (hostInstance) {
    respond({ name: targetName, type: "session", host: hostInstance, status: "running" });
    return;
  }
  respond(null, `Instance or session '${targetName}' not found`);
};

const startInstance: Handler = async (ctx, args, respond) => {
  const targetName = args.name as string;
  if (ctx.lifecycle.daemons.has(targetName)) {
    respond({ success: true, status: "already_running" });
    return;
  }
  const targetConfig = ctx.fleetConfig?.instances[targetName];
  if (!targetConfig) {
    respond(null, `Instance '${targetName}' not found in fleet config`);
    return;
  }
  try {
    await ctx.startInstance(targetName, targetConfig, true);
    await ctx.connectIpcToInstance(targetName);
    respond({ success: true, status: "started" });
  } catch (err) {
    respond(null, `Failed to start instance '${targetName}': ${(err as Error).message}`);
  }
};

/** Wrap send_to_instance with pre-filled metadata fields. */
function wrapAsSend(
  buildArgs: (args: Record<string, unknown>) => { targetName: string; body: string; kind: string; reply: boolean; summary: string },
  warnMissing?: (ctx: OutboundContext, args: Record<string, unknown>, meta: OutboundMeta) => void,
): Handler {
  return (ctx, args, respond, meta) => {
    if (warnMissing) warnMissing(ctx, args, meta);
    const { targetName, body, kind, reply, summary } = buildArgs(args);
    const newArgs = { ...args, instance_name: targetName, message: body, request_kind: kind, requires_reply: reply, task_summary: summary };
    // Re-dispatch through the handler map
    return sendToInstance(ctx, newArgs, respond, meta);
  };
}

const requestInformation = wrapAsSend((args) => {
  const targetName = args.target_instance as string;
  const question = args.question as string;
  const context = args.context as string | undefined;
  return {
    targetName,
    body: context ? `${question}\n\nContext: ${context}` : question,
    kind: "query", reply: true,
    summary: question.slice(0, 120),
  };
});

const delegateTask = wrapAsSend((args) => {
  const targetName = args.target_instance as string;
  const task = args.task as string;
  const criteria = args.success_criteria as string | undefined;
  const context = args.context as string | undefined;
  let body = task;
  if (criteria) body += `\n\nSuccess criteria: ${criteria}`;
  if (context) body += `\n\nContext: ${context}`;
  return { targetName, body, kind: "task", reply: true, summary: task.slice(0, 120) };
});

const reportResult = wrapAsSend(
  (args) => {
    const targetName = args.target_instance as string;
    const summary = args.summary as string;
    const artifacts = args.artifacts as string | undefined;
    let body = summary;
    if (artifacts) body += `\n\nArtifacts: ${artifacts}`;
    return { targetName, body, kind: "report", reply: false, summary: summary.slice(0, 120) };
  },
  (ctx, args, meta) => {
    if (!args.correlation_id) {
      ctx.logger.warn({ instanceName: meta.instanceName, targetName: args.target_instance }, "report_result called without correlation_id");
    }
  },
);

const createInstance: Handler = async (ctx, args, respond) => {
  await ctx.lifecycle.handleCreate(args, respond);
};

const deleteInstance: Handler = async (ctx, args, respond) => {
  await ctx.lifecycle.handleDelete(args, respond);
};

const broadcast: Handler = (ctx, args, respond, meta) => {
  const message = args.message as string;
  if (!message) { respond(null, "broadcast: missing required argument 'message'"); return; }

  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const targets = args.targets as string[] | undefined;

  // Resolve target list: explicit or all running (excluding sender)
  let targetNames: string[];
  if (targets?.length) {
    targetNames = targets;
  } else {
    targetNames = [...ctx.instanceIpcClients.keys()].filter(n => n !== meta.instanceName && n !== senderLabel);
  }

  const sentTo: string[] = [];
  const failed: string[] = [];
  for (const targetName of targetNames) {
    const targetIpc = ctx.instanceIpcClients.get(targetName) ?? ctx.instanceIpcClients.get(ctx.sessionRegistry.get(targetName) ?? "");
    if (!targetIpc) { failed.push(targetName); continue; }

    const correlationId = `bcast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ipcMeta: Record<string, string> = {
      chat_id: "", message_id: `bcast-${Date.now()}`, user: `instance:${senderLabel}`,
      user_id: `instance:${senderLabel}`, ts: new Date().toISOString(), thread_id: "",
      from_instance: senderLabel, correlation_id: correlationId,
    };
    if (args.request_kind) ipcMeta.request_kind = args.request_kind as string;
    if (args.requires_reply != null) ipcMeta.requires_reply = String(args.requires_reply);
    if (args.task_summary) ipcMeta.task_summary = args.task_summary as string;

    targetIpc.send({ type: "fleet_inbound", targetSession: targetName, content: message, meta: ipcMeta });
    sentTo.push(targetName);
  }

  ctx.logger.info(`📢 ${senderLabel} broadcast to ${sentTo.length} instances: ${(message).slice(0, 80)}`);
  const summary = (args.task_summary as string) || message.slice(0, 200);
  for (const target of sentTo) {
    ctx.eventLog?.logActivity("message", senderLabel, summary, target);
  }
  respond({ sent_to: sentTo, failed, count: sentTo.length });
};

// ── Registry ────────────────────────────────────────────────────────────

export const outboundHandlers = new Map<string, Handler>([
  ["send_to_instance", sendToInstance],
  ["broadcast", broadcast],
  ["list_instances", listInstances],
  ["request_information", requestInformation],
  ["delegate_task", delegateTask],
  ["report_result", reportResult],
  ["describe_instance", describeInstance],
  ["start_instance", startInstance],
  ["create_instance", createInstance],
  ["delete_instance", deleteInstance],
]);
