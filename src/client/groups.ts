/** Groups are optional: existing codes belong to Ungrouped until moved. */
export type Group = { id: string; name: string }
export type GroupFilter = 'all' | 'ungrouped' | string

export function entriesInGroup<T extends { groupId: string | null }>(entries: T[], filter: GroupFilter): T[] {
  if (filter === 'all') return entries
  if (filter === 'ungrouped') return entries.filter((entry) => entry.groupId === null)
  return entries.filter((entry) => entry.groupId === filter)
}
