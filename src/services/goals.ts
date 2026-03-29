// IPC abstraction for goals — components use this, never window.api directly.
import type { Goal, GoalType, GoalPeriod } from '../types'

export const goalsService = {
  getAll:     (): Promise<Goal[]>  => window.api.goals.getAll(),
  create:     (payload: { type: GoalType; title: string; period?: GoalPeriod; targetMinutes?: number; targetCount?: number }): Promise<Goal> =>
    window.api.goals.create(payload),
  update:     (id: string, patch: { title?: string; period?: GoalPeriod | null; targetMinutes?: number | null; targetCount?: number | null }): Promise<void> =>
    window.api.goals.update(id, patch),
  delete:     (id: string): Promise<void>  => window.api.goals.delete(id),
  addItem:    (goalId: string, itemId: string): Promise<void> => window.api.goals.addItem(goalId, itemId),
  removeItem:       (goalId: string, itemId: string): Promise<void> => window.api.goals.removeItem(goalId, itemId),
  upsertPeriodGoal: (type: 'time' | 'count', period: GoalPeriod, target: number | null): Promise<Goal | null> =>
    window.api.goals.upsertPeriodGoal(type, period, target),
}
