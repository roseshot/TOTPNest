/** Keep dashboard details aligned with the currently visible search results. */
export function visibleEntries<T extends { issuer: string; account: string }>(
  entries: T[], search: string
): T[] {
  const query = search.trim().toLocaleLowerCase()
  return entries.filter((entry) =>
    (entry.issuer + ' ' + entry.account).toLocaleLowerCase().includes(query))
}

export function activeEntry<T extends { id: string }>(visible: T[], selectedId: string | null): T | undefined {
  return visible.find((entry) => entry.id === selectedId) || visible[0]
}
