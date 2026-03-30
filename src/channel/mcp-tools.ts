/** Pure tool schema definitions — no runtime dependencies, safe to import in tests. */

export const TOOLS = [
    {
      name: "reply",
      description:
        "Reply on the channel. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach. IMPORTANT: chat_id and thread_id must come from the inbound <channel> message — never infer them from instance names or topic_ids.",
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
    {
      name: "send_to_instance",
      description: "Send a message to another Claude instance. The message appears in their channel as a passive notification — they decide whether to respond. Use this to share information, request reviews, or coordinate work across instances.",
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
      description:
        "Start a stopped CCD instance. Use list_instances() first to check available instances and their status. " +
        "Only needed when the target instance status is 'stopped'.",
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
      description:
        "Create a new CCD instance bound to a project directory, with a new Telegram topic. " +
        "Use this when the user wants to add a new project to the fleet. " +
        "The directory must exist. Returns the instance name and topic ID.",
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
            description: "Claude model to use for this instance. Omit to use the default (usually opus).",
            enum: ["sonnet", "opus", "haiku"],
          },
          branch: {
            type: "string",
            description: "Git branch name. When specified, creates a git worktree from the directory's repo and uses it as the working directory. If the branch doesn't exist, it will be created.",
          },
        },
        required: ["directory"],
      },
    },
    {
      name: "delete_instance",
      description:
        "Delete a CCD instance: stop daemon, remove from fleet config, clean up worktree if applicable, and optionally delete the Telegram topic. " +
        "Use this when an instance is no longer needed (e.g., feature branch work is done).",
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
];
