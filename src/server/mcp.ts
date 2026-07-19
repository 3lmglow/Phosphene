import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { z } from "zod";
import {
  AI_PROOF_REQUIREMENTS,
  RECURRENCE_MODES,
  REVEAL_MODES,
  TASK_DIFFICULTIES,
  TASK_STATUSES,
  TASK_TYPES,
  VERIFICATION_MODES
} from "../shared/constants";
import {
  adjustPointsSchema,
  createTaskSchema,
  manageTaskSchema,
  rewardManageSchema,
  taskQuerySchema
} from "../shared/schemas";
import {
  adjustPoints,
  createTask,
  getOverview,
  manageRewards,
  manageTask,
  queryHistory,
  queryTasks
} from "./services/domain";
import { getObject } from "./services/storage";

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { result: data }
  };
}

const idempotencyKey = () =>
  z
    .string()
    .min(8)
    .max(128)
    .describe(
      "A stable unique key for this intended write. Reuse the same key only when retrying the exact same operation."
    );

async function taskResultWithProofImages(data: any) {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [{ type: "text", text: JSON.stringify(data, null, 2) }];
  const assets = (data.items ?? [])
    .flatMap((task: any) => task.submissions ?? [])
    .flatMap((submission: any) => submission.assets ?? [])
    .slice(0, 12);
  for (const asset of assets) {
    const preview = await getObject(asset.previewKey);
    content.push({ type: "image", data: preview.toString("base64"), mimeType: asset.mimeType });
  }
  return { content, structuredContent: { result: data } };
}

function createMcpServer() {
  const server = new McpServer(
    { name: "Phosphene", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );

  server.tool(
    "create_task",
    "Create a one-time task or a recurring daily task for the user. Respect the user's configured boundaries. Do not request image-only proof: use none, text, or text_and_image so every reviewed submission includes readable text.",
    {
      title: z.string().min(1).max(120),
      description: z.string().max(4000).optional(),
      type: z.enum(TASK_TYPES),
      difficulty: z.enum(TASK_DIFFICULTIES).default("easy"),
      base_points: z.number().int().min(1).max(10000),
      verification_mode: z.enum(VERIFICATION_MODES).default("self"),
      proof_requirement: z.enum(AI_PROOF_REQUIREMENTS).default("none"),
      recurrence: z.enum(RECURRENCE_MODES).default("once"),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      daily_deadline_time: z.string().default("23:59"),
      deadline: z.string().optional(),
      reveal_mode: z.enum(REVEAL_MODES).default("immediate"),
      visible_at: z.string().optional(),
      related_task_id: z.string().optional(),
      idempotency_key: idempotencyKey()
    },
    async (args) => result(await createTask(createTaskSchema.parse(args), "AI"))
  );

  server.tool(
    "query_tasks",
    "Find tasks and, when requested, their proof submissions. Hidden surprises are visible to AI.",
    {
      task_id: z.string().optional(),
      status: z.enum(TASK_STATUSES).optional(),
      type: z.enum(TASK_TYPES).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      include_proof: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
      cursor: z.string().optional()
    },
    async (args) => {
      const input = taskQuerySchema.parse(args);
      const data = await queryTasks(input, "AI");
      return input.include_proof ? taskResultWithProofImages(data) : result(data);
    }
  );

  server.tool(
    "manage_task",
    "Edit, cancel, fail, review, pause, or resume a task/series. Rejecting a submission requires a useful reason. Pausing a recurring series immediately removes its pending current occurrence while preserving submitted or completed work. Use an idempotency key for every write.",
    {
      action: z.enum(["edit", "cancel", "fail", "review", "pause_series", "resume_series"]),
      task_id: z.string().optional(),
      series_id: z.string().optional(),
      scope: z.enum(["occurrence", "this_and_future"]).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      difficulty: z.enum(TASK_DIFFICULTIES).optional(),
      base_points: z.number().int().optional(),
      deadline: z.string().optional(),
      decision: z.enum(["approve", "reject"]).optional(),
      reason: z.string().optional().describe("Required for rejection; explain what the user should add or change."),
      idempotency_key: idempotencyKey()
    },
    async (args) => result(await manageTask(manageTaskSchema.parse(args), "AI"))
  );

  server.tool(
    "get_overview",
    "Get balance, streaks, lifetime statistics, today's state, queues, labels, timezone, boundaries, and recent achievements. The server owns scoring; use timezone only when reasoning about local dates or creating timed tasks.",
    {},
    async () => result(await getOverview())
  );

  server.tool(
    "query_history",
    "Query completed/final tasks, point ledger, redemptions, or audit history.",
    {
      kind: z.enum(["all", "tasks", "points", "redemptions", "audit"]).default("all"),
      limit: z.number().int().min(1).max(100).default(30)
    },
    async (args) => result(await queryHistory(args))
  );

  server.tool(
    "manage_rewards",
    "List and configure reward items or fulfill a user's redemption. Archive removes a reward from the user's storefront without breaking history; restore makes it available again. AI cannot redeem on the user's behalf.",
    {
      action: z.enum(["list", "create", "update", "archive", "restore", "list_redemptions", "fulfill_redemption"]),
      include_archived: z.boolean().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      cost: z.number().int().optional(),
      reward_id: z.string().optional(),
      status: z.enum(["pending", "fulfilled", "cancelled"]).optional(),
      redemption_id: z.string().optional(),
      note: z.string().optional(),
      idempotency_key: idempotencyKey()
        .optional()
        .describe(
          "Required for create, update, archive, restore, and fulfill_redemption. Reuse it only when retrying the exact same write."
        )
    },
    async (args) => result(await manageRewards(rewardManageSchema.parse(args), "AI"))
  );

  server.tool(
    "adjust_points",
    "Grant a bonus, apply a penalty within the user's daily limit, or record a correction.",
    {
      kind: z.enum(["bonus", "penalty", "correction"]),
      amount: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
      reason: z.string().min(1).max(1000),
      related_task_id: z.string().optional(),
      idempotency_key: idempotencyKey()
    },
    async (args) => result(await adjustPoints(adjustPointsSchema.parse(args), "AI"))
  );

  return server;
}

export async function handleMcp(request: Request, response: Response) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
}
