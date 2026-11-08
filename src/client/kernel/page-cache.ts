/** Small, format-neutral cache helper for cursor-paged search results. */

/**
 * Keep the first page and the pages around the current one.
 *
 * Page loads are sequential, so a small neighbour set is enough to make previous/
 * next cheap without letting a long walk retain every page it ever visited.
 * @param cache - page number to results.
 * @param page - page currently being shown.
 */
export function trimPageCache<T>(cache: Map<number, T>, page: number): void {
  const keep = new Set([0, page - 1, page, page + 1])
  for (const key of cache.keys()) {
    if (!keep.has(key)) cache.delete(key)
  }
}
