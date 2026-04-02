/** Pure tool schema definitions — no runtime dependencies, safe to import in tests. */

export const TOOLS = [
    {
      name: "reply",
      description:
        "Reply on the channel. Pass chat_id and thread_id from the inbound <channel> block — never infer from topic_ids.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "chat_id from the inbound <channel> block. Do NOT use an instance's topic_id here.",
          },
          text: { type: "string" },
          reply_to: {
            type: "string",
            description:
              "Message ID to thread under. Use message_id from the inbound <channel> block.",
          },
          thread_id: {
            type: "string",
            description:
              "Telegram topic thread ID. Use thread_id from the inbound <channel> block only. Never set this to an instance's topic_id from list_instances.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach.",
          },
          format: {
            type: "string",
            enum: ["text", "markdown"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a channel message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description:
        "Edit a message the bot previously sent. Useful for interim progress updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          text: { type: "string" },
          format: {
            type: "string",
            enum: ["text", "markdown"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description:
        "Download a file attachment from a channel message. Returns the local file path ready to Read.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: {
            type: "string",
            description: "The attachment_file_id from inbound meta",
          },
        },
        required: ["file_id"],
      },
    },
    {
      name: "create_schedule",
      description: "Create a cron-based schedule. When triggered, sends a message to the target instance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cron: { type: "string", description: "Cron expression, e.g. '0 7 * * *' (every day at 7 AM)" },
          message: { type: "string", description: "Message to inject when triggered" },
          target: { type: "string", description: "Target instance name. Defaults to this instance if omitted." },
          label: { type: "string", description: "Human-readable name for this schedule" },
          timezone: { type: "string", description: "IANA timezone, e.g. 'Asia/Taipei'. Defaults to Asia/Taipei." },
        },
        required: ["cron", "message"],
      },
    },
    {
      name: "list_schedules",
      description: "List all schedules. Optionally filter by target instance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "string", description: "Filter by target instance name" },
        },
      },
    },
    {
      name: "update_schedule",
      description: "Update an existing schedule. Only include fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Schedule ID" },
          cron: { type: "string", description: "New cron expression" },
          message: { type: "string", description: "New message" },
          target: { type: "string", description: "New target instance" },
          label: { type: "string", description: "New label" },
          timezone: { type: "string", description: "New timezone" },
          enabled: { type: "boolean", description: "Enable/disable the schedule" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_schedule",
      description: "Delete a schedule by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Schedule ID to delete" },
        },
        required: ["id"],
      },
    },
    // ── Fleet Task Board ──────────────────────────────────────────
    {
      name: "task",
      description: "Manage fleet task board. Actions: create (new task), list (show tasks), claim (assign to self), done (mark complete), update (change status/priority/assignee).",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["create", "list", "claim", "done", "update"], description: "Operation to perform" },
          title: { type: "string", description: "Task title (create)" },
          description: { type: "string", description: "Task details (create)" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Priority (create/update)" },
          assignee: { type: "string", description: "Instance name to assign (create/update)" },
          depends_on: { type: "array", items: { type: "string" }, description: "Task IDs this depends on (create)" },
          id: { type: "string", description: "Task ID (claim/done/update)" },
          result: { type: "string", description: "Completion summary (done)" },
          status: { type: "string", enum: ["open", "claimed", "done", "blocked", "cancelled"], description: "New status (update)" },
          filter_assignee: { type: "string", description: "Filter by assignee (list)" },
          filter_status: { type: "string", description: "Filter by status (list)" },
        },
        required: ["action"],
      },
    },
    // ── Shared Decisions ──────────────────────────────────────────
    {
      name: "post_decision",
      description: "Record a decision. scope='project' (default) is visible to instances sharing this working directory. scope='fleet' is visible to ALL instances regardless of directory — use for workflow rules, review policies, and team conventions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Short title for the decision" },
          content: { type: "string", description: "Full decision description" },
          scope: { type: "string", enum: ["project", "fleet"], description: "'project' (default) = same working directory. 'fleet' = all instances." },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for categorization" },
          ttl_days: { type: "number", description: "Days until auto-archive. Default: permanent. Set e.g. 7 for temporary decisions." },
          supersedes: { type: "string", description: "Decision ID to supersede (marks old one as superseded)" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "list_decisions",
      description: "List active decisions for this project. Returns decisions that were recorded by any instance sharing this working directory.",
      inputSchema: {
        type: "object" as const,
        properties: {
          include_archived: { type: "boolean", description: "Include archived/superseded decisions. Default: false" },
          tags: { type: "array", items: { type: "string" }, description: "Filter by tags" },
        },
      },
    },
    {
      name: "update_decision",
      description: "Update or archive an existing decision.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Decision ID" },
          content: { type: "string", description: "Updated content" },
          tags: { type: "array", items: { type: "string" }, description: "Updated tags" },
          ttl_days: { type: "number", description: "Updated TTL in days" },
          archive: { type: "boolean", description: "Set to true to archive this decision" },
        },
        required: ["id"],
      },
    },
    // ── Cross-instance communication ──────────────────────────────
    {
      name: "broadcast",
      description: "Send a message to multiple instances at once. Omit targets to send to all running instances.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to send" },
          targets: { type: "array", items: { type: "string" }, description: "Instance names. Omit for all running." },
          task_summary: { type: "string", description: "Brief summary shown in logs" },
          request_kind: { type: "string", enum: ["query", "task", "update"], description: "Message intent" },
          requires_reply: { type: "boolean", description: "Whether recipients should reply" },
        },
        required: ["message"],
      },
    },
    {
      name: "send_to_instance",
      description: "Send a message to another instance. Use for cross-instance communication.",
      inputSchema: {
        type: "object" as const,
        properties: {
          instance_name: {
            type: "string",
            description: "Name of the target instance (e.g., 'ccplugin', 'blog-t1385'). Use list_instances to see available instances.",
          },
          message: {
            type: "string",
            description: "The message to send to the target instance.",
          },
          request_kind: {
            type: "string",
            enum: ["query", "task", "report", "update"],
            description: "Categorizes the message intent. 'query' = asking a question, 'task' = delegating work, 'report' = returning results, 'update' = status notification.",
          },
          requires_reply: {
            type: "boolean",
            description: "Whether you expect the recipient to respond. Default: false.",
          },
          correlation_id: {
            type: "string",
            description: "Echo this from a previous message to link request-response pairs.",
          },
          task_summary: {
            type: "string",
            description: "Brief summary of the task or request (shown in logs and Telegram visibility posts).",
          },
          working_directory: {
            type: "string",
            description: "Working directory context to pass along (e.g. the repo path you are working in).",
          },
          branch: {
            type: "string",
            description: "Git branch context to pass along.",
          },
        },
        required: ["instance_name", "message"],
      },
    },
    {
      name: "request_information",
      description: "Ask another instance a question and expect a reply. Wrapper around send_to_instance with request_kind=query and requires_reply=true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to ask.",
          },
          question: {
            type: "string",
            description: "The question to ask.",
          },
          context: {
            type: "string",
            description: "Optional context to help the recipient answer.",
          },
        },
        required: ["target_instance", "question"],
      },
    },
    {
      name: "delegate_task",
      description: "Delegate a task to another instance and expect a result report back. Wrapper around send_to_instance with request_kind=task and requires_reply=true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to delegate to.",
          },
          task: {
            type: "string",
            description: "Description of the task to perform.",
          },
          success_criteria: {
            type: "string",
            description: "How the recipient should judge if the task is complete.",
          },
          context: {
            type: "string",
            description: "Optional background context for the task.",
          },
        },
        required: ["target_instance", "task"],
      },
    },
    {
      name: "report_result",
      description: "Report results back to an instance that delegated a task or asked a question. Wrapper around send_to_instance with request_kind=report.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to report to.",
          },
          correlation_id: {
            type: "string",
            description: "The correlation_id from the original request.",
          },
          summary: {
            type: "string",
            description: "Summary of the result.",
          },
          artifacts: {
            type: "string",
            description: "Optional details: file paths, commit hashes, URLs, etc.",
          },
        },
        required: ["target_instance", "summary"],
      },
    },
    {
      name: "describe_instance",
      description: "Get detailed information about a specific instance: description, working directory, status, tags, and recent activity.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Instance name to describe.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "list_instances",
      description: "List all currently running instances that you can send messages to.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "start_instance",
      description: "Start a stopped instance by name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "The instance name to start (from list_instances)",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "create_instance",
      description: "Create a new instance bound to a project directory with a channel topic.",
      inputSchema: {
        type: "object" as const,
        properties: {
          directory: {
            type: "string",
            description: "Absolute path or ~-prefixed path to the project directory",
          },
          topic_name: {
            type: "string",
            description: "Name for the Telegram topic. Defaults to directory basename.",
          },
          description: {
            type: "string",
            description: "Human-readable description of what this instance does (e.g., 'Daily secretary for scheduling and reminders').",
          },
          model: {
            type: "string",
            description: "Model to use. Claude: sonnet, opus, haiku. Codex: gpt-4o, gpt-5. Gemini: gemini-2.5-pro. Omit for default.",
          },
          backend: {
            type: "string",
            description: "CLI backend to use. Defaults to claude-code.",
            enum: ["claude-code", "gemini-cli", "codex", "opencode"],
          },
          branch: {
            type: "string",
            description: "Git branch name. When specified, creates a git worktree from the directory's repo and uses it as the working directory. If the branch doesn't exist, it will be created.",
          },
          detach: {
            type: "boolean",
            description: "Use detached HEAD (read-only). Useful for review instances that shouldn't commit to the branch.",
          },
          worktree_path: {
            type: "string",
            description: "Custom path for the git worktree. Defaults to sibling directory of the repo.",
          },
        },
        required: ["directory"],
      },
    },
    {
      name: "delete_instance",
      description: "Delete an instance: stop daemon, remove config, optionally delete topic.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "The instance name to delete (from list_instances)",
          },
          delete_topic: {
            type: "boolean",
            description: "Whether to also delete the Telegram topic. Defaults to false.",
          },
        },
        required: ["name"],
      },
    },
    // ── Repo checkout ──────────────────────────────────────────
    {
      name: "checkout_repo",
      description: "Mount another repo as a read-only worktree. Returns a local path you can Read files from. Use instance name or absolute path as source.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string", description: "Repo path (absolute or ~-prefixed) or instance name." },
          branch: { type: "string", description: "Branch or commit to checkout. Default: HEAD." },
        },
        required: ["source"],
      },
    },
    {
      name: "release_repo",
      description: "Remove a previously checked-out repo worktree.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "Path returned by checkout_repo." },
        },
        required: ["path"],
      },
    },
];

/** Predefined tool profiles to reduce token overhead per instance. */
export const TOOL_SETS: Record<string, string[]> = {
  full: TOOLS.map(t => t.name),
  standard: [
    "reply", "react", "edit_message",
    "send_to_instance", "broadcast", "list_instances", "describe_instance",
    "list_decisions", "post_decision", "task",
  ],
  minimal: ["reply", "send_to_instance", "list_decisions", "download_attachment"],
};
