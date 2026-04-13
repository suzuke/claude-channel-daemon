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
  respond({ sent: true, target: targetName, correlation_id: correlationId });
};

const listInstances: Handler = (ctx, args, respond, meta) => {
  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const filterTags = args.tags as string[] | undefined;
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

const replaceInstance: Handler = async (ctx, args, respond) => {
  await ctx.lifecycle.handleReplace(args, respond);
};

const broadcast: Handler = (ctx, args, respond, meta) => {
  const message = args.message as string;
  if (!message) { respond(null, "broadcast: missing required argument 'message'"); return; }

  const senderLabel = meta.senderSessionName ?? meta.instanceName;
  const targets = args.targets as string[] | undefined;

  // Resolve target list: team, explicit targets, tag filter, or all running
  let targetNames: string[];
  const teamName = args.team as string | undefined;
  const filterTags = args.tags as string[] | undefined;
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
  ctx.queueMirrorMessage?.(`📢 ${senderLabel} → [${sentTo.join(", ")}]: ${message.slice(0, 500)}${message.length > 500 ? " […]" : ""}`);
  respond({ sent_to: sentTo, failed, count: sentTo.length });
};

// ── Teams ────────────────────────────────────────────────────────────────

const createTeam: Handler = (ctx, args, respond) => {
  const name = args.name as string;
  const members = args.members as string[];
  const description = args.description as string | undefined;
  if (!name || !Array.isArray(members)) { respond(null, "create_team: name and members are required"); return; }
  if (!ctx.fleetConfig) { respond(null, "Fleet config not available"); return; }
  const invalid = members.filter(m => !ctx.fleetConfig!.instances[m]);
  if (invalid.length) { respond(null, `Invalid instance names: ${invalid.join(", ")}`); return; }
  ctx.fleetConfig.teams ??= {};
  if (ctx.fleetConfig.teams[name]) { respond(null, `Team already exists: ${name}`); return; }
  ctx.fleetConfig.teams[name] = { members, ...(description ? { description } : {}) };
  ctx.saveFleetConfig();
  respond({ created: name, members });
};

const deleteTeam: Handler = (ctx, args, respond) => {
  const name = args.name as string;
  if (!ctx.fleetConfig?.teams?.[name]) { respond(null, `Team not found: ${name}`); return; }
  delete ctx.fleetConfig.teams[name];
  ctx.saveFleetConfig();
  respond({ deleted: name });
};

const listTeams: Handler = (ctx, _args, respond) => {
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

const updateTeam: Handler = (ctx, args, respond) => {
  const name = args.name as string;
  if (!ctx.fleetConfig?.teams?.[name]) { respond(null, `Team not found: ${name}`); return; }
  const team = ctx.fleetConfig.teams[name];
  const add = args.add as string[] | undefined;
  const remove = args.remove as string[] | undefined;
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

const deployTemplate: Handler = async (ctx, args, respond) => {
  const templateName = args.template as string;
  const rawDirectory = args.directory as string | undefined;
  const directory = rawDirectory?.replace(/^~/, process.env.HOME || "~");
  const deploymentName = (args.name as string) || templateName;
  const branch = args.branch as string | undefined;

  if (!templateName) { respond(null, "deploy_template: missing required argument 'template'"); return; }
  if (!directory) { respond(null, "deploy_template: missing required argument 'directory'"); return; }
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
      const createArgs: Record<string, unknown> = {
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
        rollbackErrors.push(`${inst.name}: ${(e as Error).message}`);
      }
    }
    const rollbackNote = rollbackErrors.length
      ? ` Rollback errors (manual cleanup needed): ${rollbackErrors.join("; ")}`
      : " All created instances rolled back.";
    respond(null, `${(err as Error).message}${rollbackNote}`);
  }
};

const teardownDeployment: Handler = async (ctx, args, respond) => {
  const name = args.name as string;

  if (!name) { respond(null, "teardown_deployment: missing required argument 'name'"); return; }
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
      errors.push(`${instanceName}: ${(e as Error).message}`);
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

const listDeployments: Handler = (ctx, _args, respond) => {
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
