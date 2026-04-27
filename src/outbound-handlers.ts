import { resolve as pathResolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { FleetConfig, InstanceConfig } from "./types.js";
import type { ChannelAdapter } from "./channel/types.js";
import type { IpcClient } from "./channel/ipc-bridge.js";
import type { Logger } from "./logger.js";
import type { RoutingEngine } from "./routing-engine.js";
import type { InstanceLifecycle, LifecycleCreateArgs } from "./instance-lifecycle.js";
import type { EventLog } from "./event-log.js";
import type { CostGuard } from "./cost-guard.js";
import type { z } from "zod";
import {
  BroadcastArgs,
  CreateInstanceArgs,
  CreateTeamArgs,
  DelegateTaskArgs,
  DeleteInstanceArgs,
  DeleteTeamArgs,
  DeployTemplateArgs,
  DescribeInstanceArgs,
  ListDeploymentsArgs,
  ListInstancesArgs,
  ListTeamsArgs,
  ReplaceInstanceArgs,
  ReportResultArgs,
  RequestInformationArgs,
  SendToInstanceArgs,
  StartInstanceArgs,
  TeardownDeploymentArgs,
  UpdateTeamArgs,
  validateArgs,
} from "./outbound-schemas.js";

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
  /**
   * Optional fleet-wide cost guard. When set, outbound dispatch handlers
   * short-circuit and surface a warning to the sender if the target is over
   * its daily limit (Feature #24). FleetManager already wires this field; the
   * interface declaration just exposes it to handler code. Null when cost
   * guard is disabled in fleet config.
   */
  readonly costGuard: CostGuard | null;
  lastActivityMs(name: string): number;
  startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void>;
  connectIpcToInstance(name: string): Promise<void>;
  saveFleetConfig(): void;
  queueMirrorMessage?(text: string): void;
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

const HOME_DIR = homedir();

/**
 * Sanitize an error for inclusion in outbound responses sent to agents.
 * Logs the full error server-side, then returns a redacted message that
 * drops the user's home directory and truncates length. Agents get enough
 * context to react without leaking host layout.
 */
function sanitizeError(err: unknown, ctx: OutboundContext, operation: string): string {
  const e = err instanceof Error ? err : new Error(String(err));
  ctx.logger.warn({ err: e, operation }, `${operation} failed`);
  let msg = e.message || String(err);
  if (HOME_DIR) msg = msg.split(HOME_DIR).join("~");
  if (msg.length > 300) msg = msg.slice(0, 297) + "...";
  return msg;
}

// ── Handler implementations ─────────────────────────────────────────────

const sendToInstance: Handler = (ctx, rawArgs, respond, meta) => {
  const v = validateArgs(SendToInstanceArgs, rawArgs, "send_to_instance");
  if (!v.ok) { respond(null, v.error); return; }
  const { instance_name: targetName, message, request_kind: reqKind, requires_reply, task_summary, working_directory, branch, correlation_id: parsedCorrelationId } = v.data;

  // Feature #24: cost-guard pre-check. Surface the limit to the sender
  // immediately rather than dispatch a message that the target instance
  // cannot act on (the limit handler pauses the target). `report_result`
  // funnels through this handler with `request_kind: "report"` and is
  // exempt — terminal status updates must reach the orchestrator even when
  // the target is paused, otherwise the merge gate stalls. Null-safe: if
  // the fleet has no cost guard configured, isLimited is never called.
  if (reqKind !== "report" && ctx.costGuard?.isLimited(targetName)) {
    const limitUsd = (ctx.costGuard.getLimitCents() / 100).toFixed(2);
    respond(null, `cost-guard: instance '${targetName}' has reached its daily cost limit ($${limitUsd}). Message not delivered — target is paused. Wait for daily reset or escalate to operator.`);
    return;
  }

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

  const correlationId = parsedCorrelationId || `cid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  if (reqKind) ipcMeta.request_kind = reqKind;
  if (requires_reply != null) ipcMeta.requires_reply = String(requires_reply);
  if (task_summary) ipcMeta.task_summary = task_summary;
  if (working_directory) ipcMeta.working_directory = working_directory;
  if (branch) ipcMeta.branch = branch;

  targetIpc.send({ type: "fleet_inbound", targetSession, content: message, meta: ipcMeta });

  // Cross-instance topic notifications for visibility.
  // general_topic instances are always skipped (keep General clean).
  // Target topic: task/query → full message; report/update → silent; other → short summary.
  // Sender topic: always show full outbound message (so users can see what the agent sent).
  const requestKind = ipcMeta.request_kind;
  const groupId = ctx.fleetConfig?.channel?.group_id;
  if (groupId && ctx.adapter) {
    const instances = ctx.fleetConfig?.instances ?? {};
    const notificationLabel = `${senderLabel} → ${targetName}`;

    // ── Target topic notification ──
    const skipTargetNotification = requestKind === "report" || requestKind === "update";
    if (!skipTargetNotification) {
      const targetInstance = instances[targetInstanceName];
      const targetTopicId = targetInstance?.topic_id;
      const targetIsGeneral = targetInstance?.general_topic === true;
      if (targetTopicId && !targetIsGeneral && !ctx.sessionRegistry.has(targetName)) {
        const showFull = requestKind === "task" || requestKind === "query";
        const text = showFull
          ? `${notificationLabel}:\n${message}`
          : `${notificationLabel}: ${ipcMeta.task_summary ?? `${message.slice(0, 100)}${message.length > 100 ? "…" : ""}`}`;
        ctx.adapter.sendText(String(groupId), text, { threadId: String(targetTopicId) })
          .catch(e => ctx.logger.warn({ err: e }, "Failed to post target topic notification"));
      }
    }

    // ── Sender topic notification ──
    const senderInstance = instances[meta.instanceName];
    const senderTopicId = senderInstance?.topic_id;
    const senderIsGeneral = senderInstance?.general_topic === true;
    if (senderTopicId && !senderIsGeneral) {
      ctx.adapter.sendText(String(groupId), `${notificationLabel}:\n${message}`, { threadId: String(senderTopicId) })
        .catch(e => ctx.logger.warn({ err: e }, "Failed to post sender topic notification"));
    }
  }

  ctx.logger.info(`✉ ${senderLabel} → ${targetName}: ${(message ?? "").slice(0, 100)}`);
  const taskSummary = ipcMeta.task_summary || (message ?? "").slice(0, 200);
  ctx.eventLog?.logActivity("message", senderLabel, taskSummary, targetName, ipcMeta.request_kind);
  ctx.queueMirrorMessage?.(`${senderLabel} → ${targetName}: ${(message ?? "").slice(0, 500)}${(message ?? "").length > 500 ? " […]" : ""}`);
  respond({ sent: true, target: targetName, correlation_id: correlationId,
    ...(ctx.lifecycle.daemons.get(targetInstanceName)?.isErrorState && {
      warning: `${targetName} is currently in error state (rate-limited or paused). Message delivered but may not be processed.`,
    }),
  });
};

const listInstances: Handler = (ctx, rawArgs, respond, meta) => {
  const v = validateArgs(ListInstancesArgs, rawArgs, "list_instances");
  if (!v.ok) { respond(null, v.error); return; }
  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const filterTags = v.data.tags;
  let allInstances = Object.entries(ctx.fleetConfig?.instances ?? {})
    .filter(([name]) => name !== meta.instanceName && name !== senderLabel)
    .map(([name, config]) => ({
      name,
      type: "instance" as const,
      status: ctx.lifecycle.daemons.has(name) ? "running" : "stopped",
      working_directory: config.working_directory,
      topic_id: config.topic_id ?? null,
      display_name: config.display_name ?? null,
      description: config.description ?? null,
      backend: config.backend ?? "claude-code",
      tags: config.tags ?? [],
      last_activity: ctx.lastActivityMs(name) ? new Date(ctx.lastActivityMs(name)).toISOString() : null,
    }));
  if (filterTags?.length) {
    allInstances = allInstances.filter(i => i.tags.some(t => filterTags.includes(t)));
  }
  const externalSessions = [...ctx.sessionRegistry.entries()]
    .filter(([sessName]) => sessName !== senderLabel)
    .map(([sessName, hostInstance]) => ({ name: sessName, type: "session" as const, host: hostInstance }));
  respond({ instances: allInstances, external_sessions: externalSessions });
};

const describeInstance: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(DescribeInstanceArgs, rawArgs, "describe_instance");
  if (!v.ok) { respond(null, v.error); return; }
  const targetName = v.data.name;
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
      backend: config.backend ?? "claude-code",
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

const startInstance: Handler = async (ctx, rawArgs, respond) => {
  const v = validateArgs(StartInstanceArgs, rawArgs, "start_instance");
  if (!v.ok) { respond(null, v.error); return; }
  const targetName = v.data.name;
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
    respond(null, `Failed to start instance '${targetName}': ${sanitizeError(err, ctx, `start_instance(${targetName})`)}`);
  }
};

/** Wrap send_to_instance with pre-filled metadata fields. */
function wrapAsSend<T>(
  schema: z.ZodType<T>,
  toolName: string,
  buildArgs: (args: T) => { targetName: string; body: string; kind: string; reply: boolean; summary: string },
  warnMissing?: (ctx: OutboundContext, args: T, meta: OutboundMeta) => void,
): Handler {
  return (ctx, rawArgs, respond, meta) => {
    const v = validateArgs(schema, rawArgs, toolName);
    if (!v.ok) { respond(null, v.error); return; }
    if (warnMissing) warnMissing(ctx, v.data, meta);
    const { targetName, body, kind, reply, summary } = buildArgs(v.data);
    // Forward correlation_id verbatim if the caller supplied one.
    const extra = (v.data as { correlation_id?: string }).correlation_id
      ? { correlation_id: (v.data as { correlation_id?: string }).correlation_id }
      : {};
    const newArgs = {
      ...extra,
      instance_name: targetName,
      message: body,
      request_kind: kind,
      requires_reply: reply,
      task_summary: summary,
    };
    // Re-dispatch through the handler map
    return sendToInstance(ctx, newArgs, respond, meta);
  };
}

const requestInformation = wrapAsSend(
  RequestInformationArgs,
  "request_information",
  ({ target_instance, question, context }) => ({
    targetName: target_instance,
    body: context ? `${question}\n\nContext: ${context}` : question,
    kind: "query", reply: true,
    summary: question.slice(0, 120),
  }),
);

const delegateTask = wrapAsSend(
  DelegateTaskArgs,
  "delegate_task",
  ({ target_instance, task, success_criteria, context }) => {
    let body = task;
    if (success_criteria) body += `\n\nSuccess criteria: ${success_criteria}`;
    if (context) body += `\n\nContext: ${context}`;
    return { targetName: target_instance, body, kind: "task", reply: true, summary: task.slice(0, 120) };
  },
);

const reportResult = wrapAsSend(
  ReportResultArgs,
  "report_result",
  ({ target_instance, summary, artifacts }) => {
    let body = summary;
    if (artifacts) body += `\n\nArtifacts: ${artifacts}`;
    return { targetName: target_instance, body, kind: "report", reply: false, summary: summary.slice(0, 120) };
  },
  (ctx, args, meta) => {
    if (!args.correlation_id) {
      ctx.logger.warn({ instanceName: meta.instanceName, targetName: args.target_instance }, "report_result called without correlation_id");
    }
  },
);

const createInstance: Handler = async (ctx, rawArgs, respond) => {
  const v = validateArgs(CreateInstanceArgs, rawArgs, "create_instance");
  if (!v.ok) { respond(null, v.error); return; }
  await ctx.lifecycle.handleCreate(v.data, respond);
};

const deleteInstance: Handler = async (ctx, rawArgs, respond, meta) => {
  const v = validateArgs(DeleteInstanceArgs, rawArgs, "delete_instance");
  if (!v.ok) { respond(null, v.error); return; }
  const targetName = v.data.name;
  const caller = meta.instanceName;
  const callerConfig = ctx.fleetConfig?.instances[caller];
  const isSelf = targetName === caller;
  const isCoordinator = callerConfig?.general_topic === true;
  if (!isSelf && !isCoordinator) {
    respond(null, `delete_instance denied: '${caller}' may only delete itself (coordinator instances may delete any)`);
    return;
  }
  await ctx.lifecycle.handleDelete(v.data, respond);
};

const replaceInstance: Handler = async (ctx, rawArgs, respond) => {
  const v = validateArgs(ReplaceInstanceArgs, rawArgs, "replace_instance");
  if (!v.ok) { respond(null, v.error); return; }
  await ctx.lifecycle.handleReplace(v.data, respond);
};

const broadcast: Handler = (ctx, rawArgs, respond, meta) => {
  const v = validateArgs(BroadcastArgs, rawArgs, "broadcast");
  if (!v.ok) { respond(null, v.error); return; }
  const { message, targets, team: teamName, tags: filterTags, task_summary, request_kind, requires_reply } = v.data;

  const senderLabel = meta.senderSessionName ?? meta.instanceName;

  // Resolve target list: team, explicit targets, tag filter, or all running
  let targetNames: string[];
  if (teamName) {
    const teamDef = ctx.fleetConfig?.teams?.[teamName];
    if (!teamDef) { respond(null, `Team not found: ${teamName}`); return; }
    // Silently skip members that are not currently running
    targetNames = teamDef.members.filter(n => n !== meta.instanceName && n !== senderLabel && ctx.instanceIpcClients.has(n));
  } else if (targets?.length) {
    targetNames = targets;
  } else if (filterTags?.length) {
    // Filter by tags from fleet config
    targetNames = Object.entries(ctx.fleetConfig?.instances ?? {})
      .filter(([name, config]) => name !== meta.instanceName && name !== senderLabel
        && config.tags?.some((t: string) => filterTags.includes(t)))
      .map(([name]) => name);
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
    if (request_kind) ipcMeta.request_kind = request_kind;
    if (requires_reply != null) ipcMeta.requires_reply = String(requires_reply);
    if (task_summary) ipcMeta.task_summary = task_summary;

    targetIpc.send({ type: "fleet_inbound", targetSession: targetName, content: message, meta: ipcMeta });
    sentTo.push(targetName);
  }

  ctx.logger.info(`📢 ${senderLabel} broadcast to ${sentTo.length} instances: ${(message).slice(0, 80)}`);
  const summary = task_summary || message.slice(0, 200);
  for (const target of sentTo) {
    ctx.eventLog?.logActivity("message", senderLabel, summary, target);
  }
  ctx.queueMirrorMessage?.(`📢 ${senderLabel} → [${sentTo.join(", ")}]: ${message.slice(0, 500)}${message.length > 500 ? " […]" : ""}`);
  respond({ sent_to: sentTo, failed, count: sentTo.length });
};

// ── Teams ────────────────────────────────────────────────────────────────

const createTeam: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(CreateTeamArgs, rawArgs, "create_team");
  if (!v.ok) { respond(null, v.error); return; }
  const { name, members, description } = v.data;
  if (!ctx.fleetConfig) { respond(null, "Fleet config not available"); return; }
  const invalid = members.filter(m => !ctx.fleetConfig!.instances[m]);
  if (invalid.length) { respond(null, `Invalid instance names: ${invalid.join(", ")}`); return; }
  ctx.fleetConfig.teams ??= {};
  if (ctx.fleetConfig.teams[name]) { respond(null, `Team already exists: ${name}`); return; }
  ctx.fleetConfig.teams[name] = { members, ...(description ? { description } : {}) };
  ctx.saveFleetConfig();
  respond({ created: name, members });
};

const deleteTeam: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(DeleteTeamArgs, rawArgs, "delete_team");
  if (!v.ok) { respond(null, v.error); return; }
  const { name } = v.data;
  if (!ctx.fleetConfig?.teams?.[name]) { respond(null, `Team not found: ${name}`); return; }
  delete ctx.fleetConfig.teams[name];
  ctx.saveFleetConfig();
  respond({ deleted: name });
};

const listTeams: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(ListTeamsArgs, rawArgs, "list_teams");
  if (!v.ok) { respond(null, v.error); return; }
  const teams = ctx.fleetConfig?.teams ?? {};
  const result = Object.entries(teams).map(([name, def]) => ({
    name,
    description: def.description ?? null,
    members: def.members.map(m => ({
      name: m,
      running: ctx.lifecycle.daemons.has(m),
    })),
  }));
  respond(result);
};

const updateTeam: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(UpdateTeamArgs, rawArgs, "update_team");
  if (!v.ok) { respond(null, v.error); return; }
  const { name, add, remove } = v.data;
  if (!ctx.fleetConfig?.teams?.[name]) { respond(null, `Team not found: ${name}`); return; }
  const team = ctx.fleetConfig.teams[name];
  if (add?.length) {
    const invalid = add.filter(m => !ctx.fleetConfig!.instances[m]);
    if (invalid.length) { respond(null, `Invalid instance names: ${invalid.join(", ")}`); return; }
    team.members = [...new Set([...team.members, ...add])];
  }
  if (remove?.length) {
    team.members = team.members.filter(m => !remove.includes(m));
  }
  ctx.saveFleetConfig();
  respond({ name, members: team.members });
};

// ── Fleet Templates ────────────────────────────────────────────────────

const deployTemplate: Handler = async (ctx, rawArgs, respond) => {
  const v = validateArgs(DeployTemplateArgs, rawArgs, "deploy_template");
  if (!v.ok) { respond(null, v.error); return; }
  const { template: templateName, directory: rawDirectory, name: deploymentNameArg, branch } = v.data;
  const deploymentName = deploymentNameArg || templateName;

  // Reject relative paths; require absolute or ~-prefixed. Resolve and normalize (collapses `..`).
  const expanded = rawDirectory.replace(/^~/, process.env.HOME || "~");
  if (!isAbsolute(expanded)) {
    respond(null, `deploy_template: directory must be an absolute path (got: ${rawDirectory})`);
    return;
  }
  const directory = pathResolve(expanded);
  if (!ctx.fleetConfig) { respond(null, "Fleet config not available"); return; }

  const template = ctx.fleetConfig.templates?.[templateName];
  if (!template) {
    respond(null, `Template not found: "${templateName}". Available: ${Object.keys(ctx.fleetConfig.templates ?? {}).join(", ") || "(none)"}`);
    return;
  }

  // Check for existing deployment with the same name
  const existingDeployment = Object.values(ctx.fleetConfig.instances)
    .some(inst => inst.tags?.includes(`deployment:${deploymentName}`));
  if (existingDeployment) {
    respond(null, `Deployment "${deploymentName}" already exists. Use a different name or teardown first.`);
    return;
  }

  // Check team name collision early
  if (template.team) {
    ctx.fleetConfig.teams ??= {};
    if (ctx.fleetConfig.teams[deploymentName]) {
      respond(null, `Team "${deploymentName}" already exists`);
      return;
    }
  }

  const createdInstances: Array<{ name: string; role: string; model?: string; backend?: string }> = [];

  try {
    for (const [role, instanceDef] of Object.entries(template.instances)) {
      // Resolve profile: instance-level fields override profile defaults
      if (instanceDef.profile) {
        const profile = ctx.fleetConfig.profiles?.[instanceDef.profile];
        if (!profile) {
          throw new Error(`Profile "${instanceDef.profile}" not found for role "${role}". Available: ${Object.keys(ctx.fleetConfig.profiles ?? {}).join(", ") || "(none)"}`);
        }
        // Apply profile defaults only for fields not set on the instance
        if (!instanceDef.backend && profile.backend) instanceDef.backend = profile.backend;
        if (!instanceDef.model && profile.model) instanceDef.model = profile.model;
        if (!instanceDef.model_failover && profile.model_failover) instanceDef.model_failover = profile.model_failover;
        if (!instanceDef.tool_set && profile.tool_set) instanceDef.tool_set = profile.tool_set;
        if (instanceDef.lightweight == null && profile.lightweight != null) instanceDef.lightweight = profile.lightweight;
      }

      const topicName = `${deploymentName}-${role}`;
      const deploymentTags = [
        `deployment:${deploymentName}`,
        `template:${templateName}`,
        `role:${role}`,
        ...(instanceDef.tags ?? []),
      ];
      const createArgs: LifecycleCreateArgs = {
        directory,
        topic_name: topicName,
        ...(instanceDef.description ? { description: instanceDef.description } : {}),
        ...(instanceDef.model ? { model: instanceDef.model } : {}),
        ...(instanceDef.backend ? { backend: instanceDef.backend } : {}),
        ...(instanceDef.model_failover ? { model_failover: instanceDef.model_failover } : {}),
        ...(instanceDef.systemPrompt ? { systemPrompt: instanceDef.systemPrompt } : {}),
        ...(instanceDef.tool_set ? { tool_set: instanceDef.tool_set } : {}),
        ...(instanceDef.skipPermissions != null ? { skipPermissions: instanceDef.skipPermissions } : {}),
        ...(instanceDef.lightweight != null ? { lightweight: instanceDef.lightweight } : {}),
        ...(instanceDef.workflow !== undefined ? { workflow: instanceDef.workflow } : {}),
        tags: deploymentTags,
        ...(branch ? { branch: `${deploymentName}-${role}`, start_point: branch } : {}),
      };

      // Create instance via handleCreate with a promise wrapper
      const result = await new Promise<{ success: boolean; name?: string; status?: string; error?: string }>((resolve) => {
        ctx.lifecycle.handleCreate(createArgs, (res, err) => {
          if (err) resolve({ success: false, error: err });
          else {
            const r = res as { name: string; status?: string };
            resolve({ success: true, name: r.name, status: r.status });
          }
        });
      });

      if (!result.success) {
        throw new Error(`Failed to create instance for role "${role}": ${result.error}`);
      }

      // Detect duplicate directory collision (handleCreate returns already_exists)
      if (result.status === "already_exists") {
        throw new Error(`Instance for role "${role}" conflicts with existing instance "${result.name}" (same working directory). Use branch parameter for separate worktrees.`);
      }

      const instanceName = result.name!;
      const config = ctx.fleetConfig.instances[instanceName];

      createdInstances.push({
        name: instanceName,
        role,
        model: config.model,
        backend: config.backend,
      });
    }

    // Create team if requested
    let teamName: string | undefined;
    if (template.team) {
      teamName = deploymentName;
      ctx.fleetConfig.teams![teamName] = {
        members: createdInstances.map(i => i.name),
        description: template.description,
      };
      ctx.saveFleetConfig();
    }

    respond({
      success: true,
      deployment: deploymentName,
      template: templateName,
      instances: createdInstances,
      ...(teamName ? { team: teamName } : {}),
    });
  } catch (err) {
    // Full rollback: delete all created instances (best-effort)
    const rollbackErrors: string[] = [];
    for (const inst of createdInstances) {
      try {
        await new Promise<void>((resolve) => {
          ctx.lifecycle.handleDelete(
            { name: inst.name, delete_topic: true },
            (_res, delErr) => {
              if (delErr) rollbackErrors.push(`${inst.name}: ${delErr}`);
              resolve();
            },
          );
        });
      } catch (e) {
        rollbackErrors.push(`${inst.name}: ${sanitizeError(e, ctx, `deploy_template.rollback(${inst.name})`)}`);
      }
    }
    const rollbackNote = rollbackErrors.length
      ? ` Rollback errors (manual cleanup needed): ${rollbackErrors.join("; ")}`
      : " All created instances rolled back.";
    respond(null, `${sanitizeError(err, ctx, "deploy_template")}${rollbackNote}`);
  }
};

const teardownDeployment: Handler = async (ctx, rawArgs, respond) => {
  const v = validateArgs(TeardownDeploymentArgs, rawArgs, "teardown_deployment");
  if (!v.ok) { respond(null, v.error); return; }
  const { name } = v.data;

  if (!ctx.fleetConfig) { respond(null, "Fleet config not available"); return; }

  // Find instances by deployment tag
  const deploymentTag = `deployment:${name}`;
  const deploymentInstances = Object.entries(ctx.fleetConfig.instances)
    .filter(([_, config]) => config.tags?.includes(deploymentTag))
    .map(([instanceName]) => instanceName);

  if (deploymentInstances.length === 0) {
    respond(null, `No deployment found with name "${name}"`);
    return;
  }

  const deleted: string[] = [];
  const errors: string[] = [];

  for (const instanceName of deploymentInstances) {
    try {
      await new Promise<void>((resolve) => {
        ctx.lifecycle.handleDelete(
          { name: instanceName, delete_topic: true },
          (_res, err) => {
            if (err) errors.push(`${instanceName}: ${err}`);
            else deleted.push(instanceName);
            resolve();
          },
        );
      });
    } catch (e) {
      errors.push(`${instanceName}: ${sanitizeError(e, ctx, `teardown_deployment(${instanceName})`)}`);
    }
  }

  // Delete team if exists (best-effort)
  let teamDeleted = false;
  if (ctx.fleetConfig.teams?.[name]) {
    delete ctx.fleetConfig.teams[name];
    ctx.saveFleetConfig();
    teamDeleted = true;
  }

  respond({
    success: errors.length === 0,
    deployment: name,
    deleted,
    team_deleted: teamDeleted,
    ...(errors.length ? { errors } : {}),
  });
};

const listDeployments: Handler = (ctx, rawArgs, respond) => {
  const v = validateArgs(ListDeploymentsArgs, rawArgs, "list_deployments");
  if (!v.ok) { respond(null, v.error); return; }
  if (!ctx.fleetConfig) { respond(null, "Fleet config not available"); return; }

  // Aggregate instances by deployment tag
  const deployments = new Map<string, { template: string | null; instances: Array<{ name: string; role: string | null; running: boolean }> }>();

  for (const [name, config] of Object.entries(ctx.fleetConfig.instances)) {
    const deployTag = config.tags?.find(t => t.startsWith("deployment:"));
    if (!deployTag) continue;

    const deploymentName = deployTag.slice("deployment:".length);
    if (!deployments.has(deploymentName)) {
      const templateTag = config.tags?.find(t => t.startsWith("template:"));
      deployments.set(deploymentName, {
        template: templateTag ? templateTag.slice("template:".length) : null,
        instances: [],
      });
    }

    const roleTag = config.tags?.find(t => t.startsWith("role:"));
    deployments.get(deploymentName)!.instances.push({
      name,
      role: roleTag ? roleTag.slice("role:".length) : null,
      running: ctx.lifecycle.has(name),
    });
  }

  const result = [...deployments.entries()].map(([name, data]) => ({
    name,
    template: data.template,
    instances: data.instances,
    team: ctx.fleetConfig?.teams?.[name] ? name : null,
  }));

  respond(result);
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
  ["replace_instance", replaceInstance],
  ["create_team", createTeam],
  ["delete_team", deleteTeam],
  ["list_teams", listTeams],
  ["update_team", updateTeam],
  ["deploy_template", deployTemplate],
  ["teardown_deployment", teardownDeployment],
  ["list_deployments", listDeployments],
]);
