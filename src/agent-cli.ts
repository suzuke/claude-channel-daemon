#!/usr/bin/env node
/**
 * agend-agent — thin CLI client for agent fleet operations.
 * Sends JSON POST to the daemon's /agent endpoint and prints JSON result.
 *
 * Usage: agend-agent <op> [args...]
 * Env:   AGEND_PORT (default 19280), AGEND_INSTANCE_NAME (required),
 *        AGEND_HOME (default ~/.agend)
 */
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PORT = parseInt(process.env.AGEND_PORT ?? "19280", 10);
const INSTANCE = process.env.AGEND_INSTANCE_NAME ?? "";
const DATA_DIR = process.env.AGEND_HOME || join(homedir(), ".agend");

function readInstanceToken(): string | null {
  if (!INSTANCE) return null;
  try {
    return readFileSync(join(DATA_DIR, "instances", INSTANCE, "agent.token"), "utf-8").trim();
  } catch {
    return null;
  }
}

function post(op: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ instance: INSTANCE, op, args });
    const token = readInstanceToken();
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    };
    if (token) headers["X-Agend-Instance-Token"] = token;
    const req = request({
      hostname: "127.0.0.1",
      port: PORT,
      path: "/agent",
      method: "POST",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => resolve(data));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function die(msg: string): never {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

async function main(): Promise<void> {
  const [,, op, ...rest] = process.argv;
  if (!op) die("Usage: agend-agent <op> [args...]");
  if (!INSTANCE) die("AGEND_INSTANCE_NAME not set");

  let args: Record<string, unknown> = {};

  switch (op) {
    // Channel
    case "reply": args = { text: rest[0] ?? "" }; break;
    case "react": args = { emoji: rest[0] ?? "", message_id: rest[1] }; break;
    case "edit": args = { message_id: rest[0], text: rest[1] ?? "" }; break;
    case "download": args = { file_id: rest[0] ?? "" }; break;

    // Communication
    case "send": args = { instance_name: rest[0], message: rest[1] ?? "", request_kind: rest[2] }; break;
    case "delegate": args = { target_instance: rest[0], task: rest[1] ?? "", success_criteria: rest[2], context: rest[3] }; break;
    case "report": args = { target_instance: rest[0], summary: rest[1] ?? "", correlation_id: rest[2], artifacts: rest[3] }; break;
    case "ask": args = { target_instance: rest[0], question: rest[1] ?? "", context: rest[2] }; break;
    case "broadcast": args = { message: rest[0] ?? "", team: rest[1] }; break;

    // Instance management
    case "list": break;
    case "describe": args = { name: rest[0] ?? "" }; break;
    case "start": args = { name: rest[0] ?? "" }; break;
    case "spawn": args = { directory: rest[0], topic_name: rest[1], backend: rest[2] }; break;
    case "delete": args = { name: rest[0] ?? "" }; break;
    case "replace": args = { name: rest[0] ?? "", reason: rest[1] }; break;
    case "rename": args = { name: rest[0] ?? "" }; break;
    case "set-description": args = { description: rest[0] ?? "" }; break;

    // Task board
    case "task": {
      const action = rest[0];
      switch (action) {
        case "create": args = { action, title: rest[1] ?? "", description: rest[2], priority: rest[3], assignee: rest[4] }; break;
        case "list": args = { action, filter_assignee: rest[1], filter_status: rest[2] }; break;
        case "claim": args = { action, id: rest[1] ?? "" }; break;
        case "done": args = { action, id: rest[1] ?? "", result: rest[2] }; break;
        case "update": args = { action, id: rest[1] ?? "", status: rest[2], priority: rest[3] }; break;
        default: args = { action: action ?? "" }; break;
      }
      break;
    }

    // Decisions
    case "decision-post": args = { title: rest[0] ?? "", content: rest[1] ?? "", scope: rest[2], tags: rest[3] }; break;
    case "decision-list": args = { include_archived: rest[0] === "true" }; break;
    case "decision-update": args = { id: rest[0] ?? "", content: rest[1], archive: rest[2] === "true" }; break;

    // Schedules
    case "schedule-create": args = { cron: rest[0] ?? "", message: rest[1] ?? "", target: rest[2], label: rest[3] }; break;
    case "schedule-list": args = { target: rest[0] }; break;
    case "schedule-update": args = { id: rest[0] ?? "", cron: rest[1], message: rest[2], enabled: rest[3] }; break;
    case "schedule-delete": args = { id: rest[0] ?? "" }; break;

    // Teams
    case "team-create": args = { name: rest[0] ?? "", members: rest.slice(1) }; break;
    case "team-list": break;
    case "team-delete": args = { name: rest[0] ?? "" }; break;
    case "team-update": args = { name: rest[0] ?? "", add: rest[1], remove: rest[2] }; break;

    // Deployments
    case "deploy": args = { template: rest[0] ?? "", directory: rest[1] ?? "", name: rest[2], branch: rest[3] }; break;
    case "teardown": args = { name: rest[0] ?? "" }; break;
    case "deploy-list": break;

    default: die(`Unknown op: ${op}`);
  }

  // Strip undefined values
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) delete args[k];
  }

  try {
    const result = await post(op, args);
    console.log(result);
  } catch (err) {
    die(`Connection failed: ${(err as Error).message}`);
  }
}

main();
