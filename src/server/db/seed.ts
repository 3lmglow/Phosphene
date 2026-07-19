import { and, eq, sql } from "drizzle-orm";
import {
  LEGACY_PRESET_REWARD_COPY,
  PRESET_REWARDS,
  RETIRED_PRESET_REWARDS
} from "../../shared/rewards";
import { getDb } from "./client";
import { achievements, appSettings, rewardItems, statistics } from "./schema";

const achievementDefinitions = [
  ["first_task", "第一束光", "完成第一个任务", "completed", 1, "sparkles"],
  ["streak_3", "微光成线", "连续完成 3 天", "streak", 3, "flame"],
  ["streak_7", "七日轨迹", "连续完成 7 天", "streak", 7, "orbit"],
  ["streak_14", "双周恒星", "连续完成 14 天", "streak", 14, "moon"],
  ["streak_30", "月相完整", "连续完成 30 天", "streak", 30, "eclipse"],
  ["streak_100", "恒久余辉", "连续完成 100 天", "streak", 100, "sun"],
  ["active_7", "七次抵达", "累计坚持 7 天", "active_days", 7, "calendar-heart"],
  ["active_30", "三十次回应", "累计坚持 30 天", "active_days", 30, "calendar-check"],
  ["active_100", "百日私语", "累计坚持 100 天", "active_days", 100, "milestone"],
  ["active_365", "绕日一周", "累计坚持 365 天", "active_days", 365, "infinity"],
  ["completed_10", "十次兑现", "累计完成 10 个任务", "completed", 10, "check-check"],
  ["completed_50", "稳定回声", "累计完成 50 个任务", "completed", 50, "waves"],
  ["completed_100", "百次应答", "累计完成 100 个任务", "completed", 100, "gem"],
  ["completed_500", "心照不宣", "累计完成 500 个任务", "completed", 500, "crown"],
  ["hard_1", "第一次越界线", "第一次完成 hard 任务", "hard", 1, "mountain"],
  ["hard_10", "迎难而上", "完成 10 个 hard 任务", "hard", 10, "shield"],
  ["hard_50", "锋芒已成", "完成 50 个 hard 任务", "hard", 50, "swords"],
  ["challenge_1", "接受挑战", "第一次完成 challenge", "challenge", 1, "timer"],
  ["surprise_1", "拆开惊喜", "第一次完成 surprise", "surprise", 1, "gift"],
  ["earned_100", "攒下星尘", "累计获得 100 积分", "earned", 100, "coins"],
  ["earned_500", "星尘成河", "累计获得 500 积分", "earned", 500, "badge-dollar-sign"],
  ["earned_1000", "千点余辉", "累计获得 1000 积分", "earned", 1000, "star"],
  ["earned_5000", "私人星系", "累计获得 5000 积分", "earned", 5000, "galaxy"],
  ["redemption_1", "第一次许愿", "完成第一次兑换", "redemptions", 1, "ticket"],
  ["redemption_10", "愿望熟客", "完成 10 次兑换", "redemptions", 10, "heart-handshake"]
] as const;

export async function seedDatabase(): Promise<void> {
  const db = getDb();
  await db
    .insert(appSettings)
    .values({ id: 1 })
    .onConflictDoNothing();
  await db
    .insert(statistics)
    .values({ id: 1 })
    .onConflictDoNothing();

  await db
    .insert(rewardItems)
    .values(PRESET_REWARDS.map((reward) => ({ ...reward })))
    .onConflictDoNothing();

  // Migrate exact built-in copy from older installations while preserving any
  // text that the owner has customized.
  for (const legacy of LEGACY_PRESET_REWARD_COPY) {
    const current = PRESET_REWARDS.find((reward) => reward.id === legacy.id);
    if (!current) continue;
    await db
      .update(rewardItems)
      .set({ description: current.description, updatedAt: new Date() })
      .where(
        and(
          eq(rewardItems.id, legacy.id),
          eq(rewardItems.name, legacy.name),
          eq(rewardItems.description, legacy.description)
        )
      );
  }

  // Remove retired defaults from existing installations without touching a
  // reward that its owner has already customized into something else.
  for (const retired of RETIRED_PRESET_REWARDS) {
    await db
      .update(rewardItems)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(rewardItems.id, retired.id),
          eq(rewardItems.name, retired.name),
          eq(rewardItems.description, retired.description),
          eq(rewardItems.cost, retired.cost)
        )
      );
  }

  await db
    .insert(achievements)
    .values(
      achievementDefinitions.map(([id, name, description, category, threshold, icon], sortOrder) => ({
        id,
        name,
        description,
        category,
        threshold,
        icon,
        sortOrder
      }))
    )
    .onConflictDoNothing();

  // Refresh SQLite planner statistics after the built-in data is present.
  await db.run(sql`analyze`);
}
