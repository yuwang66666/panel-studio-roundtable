import type { DiscussionStatus } from '@panel/contracts';
export const MAX_EXPERTS = 6;
export const transitions: Record<DiscussionStatus, DiscussionStatus[]> = {
  casting: ['awaiting_confirmation', 'failed'],
  awaiting_confirmation: ['running'],
  running: ['summarizing', 'failed', 'interrupted'],
  summarizing: ['completed', 'failed', 'interrupted'],
  completed: [],
  failed: ['casting', 'summarizing'],
  interrupted: ['summarizing'],
};
export function assertTransition(from: DiscussionStatus, to: DiscussionStatus) {
  if (!transitions[from].includes(to)) throw new Error(`非法状态迁移：${from} → ${to}`);
}
export function callBudget(experts: number, turns = 16) {
  return Math.max(120, experts * turns + turns + Math.ceil(turns / 3) + 4 + 2 + 20);
}
