/**
 * Choose which animation clips should play together when a model has several.
 *
 * glTF exports one animation per Blender action. A typical rig therefore ends
 * up with a bone clip and a separate shape-key (facial) clip, which live on
 * different channels and are safe to layer. Two full-body clips, on the other
 * hand, target the same nodes and would fight over the same tracks.
 *
 * The rule is deliberately simple: keep the first clip that claims a track,
 * skip any later clip that overlaps an already claimed track, then put the clip
 * with the most tracks first so it becomes the time/primary clip.
 */

/**
 * Pick a default set of clips that can play simultaneously.
 * @param tracks - track names for each clip, in file order.
 * @returns active clip indexes, primary first.
 */
export function selectDefaultClips(tracks: readonly (readonly string[])[]): number[] {
  const claimed = new Set<string>()
  const chosen: number[] = []
  for (let index = 0; index < tracks.length; index += 1) {
    const names = tracks[index] ?? []
    if (names.some((name) => claimed.has(name))) continue
    chosen.push(index)
    for (const name of names) claimed.add(name)
  }
  // Most tracks first: a bone clip outranks a one-track facial clip and
  // becomes the time/duration source, even if the facial clip came first.
  return chosen.sort((left, right) => {
    const bySize = (tracks[right]?.length ?? 0) - (tracks[left]?.length ?? 0)
    return bySize !== 0 ? bySize : left - right
  })
}
