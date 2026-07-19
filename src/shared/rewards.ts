export const PRESET_REWARDS = [
  {
    id: "reward_writing",
    name: "指定 AI 写东西",
    description: "给 AI 一个主题，由 ta 专门为你写。",
    cost: 15,
    sortOrder: 10
  },
  {
    id: "reward_listen",
    name: "“AI 听你的”券",
    description: "在双方边界内，今天由你做一次主。",
    cost: 20,
    sortOrder: 20
  }
] as const;

export const LEGACY_PRESET_REWARD_COPY = [
  {
    id: "reward_writing",
    name: "指定 AI 写东西",
    description: "给 AI 一个主题，由它专门为你写。"
  }
] as const;

export const RETIRED_PRESET_REWARDS = [
  {
    id: "reward_clauro_5",
    name: "clauro 5 额度",
    description: "兑换 5 额度 clauro。",
    cost: 5
  },
  {
    id: "reward_song",
    name: "点歌权",
    description: "指定一首想听的歌。",
    cost: 5
  }
] as const;

function replaceAiLabel(value: string, aiLabel: string): string {
  return value.replaceAll("AI", aiLabel);
}

export function presentRewardItem<
  T extends { id: string; name: string; description: string }
>(item: T, aiLabel: string): T {
  const preset = PRESET_REWARDS.find((candidate) => candidate.id === item.id);
  if (!preset) return item;
  const legacy = LEGACY_PRESET_REWARD_COPY.find((candidate) => candidate.id === item.id);
  return {
    ...item,
    name: item.name === preset.name ? replaceAiLabel(item.name, aiLabel) : item.name,
    description:
      item.description === preset.description || item.description === legacy?.description
        ? replaceAiLabel(preset.description, aiLabel)
        : item.description
  };
}

export function presentRewardSnapshot(value: string, aiLabel: string): string {
  const preset = PRESET_REWARDS.find((candidate) => candidate.name === value);
  return preset ? replaceAiLabel(value, aiLabel) : value;
}

export function presentLedgerReason(value: string, aiLabel: string): string {
  const prefix = "Redeemed: ";
  if (!value.startsWith(prefix)) return value;
  const rewardName = value.slice(prefix.length);
  const presented = presentRewardSnapshot(rewardName, aiLabel);
  return presented === rewardName ? value : `${prefix}${presented}`;
}
