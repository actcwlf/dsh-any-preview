/**
 * Bounds for the current skinned/animated pose.
 *
 * `Box3.setFromObject` uses a mesh's bind-pose geometry box. That is enough to
 * place the camera before playback, but an animation can lift an arm or move a
 * root well outside it. Three's `SkinnedMesh.computeBoundingBox()` walks the
 * deformed vertices, so sampling a few clip times gives the camera and grid a
 * box that matches what the viewer actually renders.
 */

/** Above this many skinned vertices, fall back to bone positions. */
const MAX_SKINNED_VERTICES = 500_000

/**
 * Compute a world-space bounding box for the current pose.
 * @param THREE - three.js module.
 * @param root - loaded model root.
 * @returns a box in the root's parent space; callers can union samples.
 */
export function computeAnimatedBounds(THREE: any, root: any): any {
  const box = new THREE.Box3()
  root.updateMatrixWorld(true)
  root.traverse((child: any) => {
    if (child.isSkinnedMesh === true && child.geometry?.attributes?.position) {
      const count = child.geometry.attributes.position.count
      if (count <= MAX_SKINNED_VERTICES && typeof child.computeBoundingBox === 'function') {
        child.skeleton?.update?.()
        child.computeBoundingBox()
        if (child.boundingBox !== null && child.boundingBox !== undefined) {
          box.union(child.boundingBox.clone().applyMatrix4(child.matrixWorld))
        }
        return
      }
      // A very dense mesh: bone joints are cheaper than walking every vertex
      // and still capture limbs that left the bind-pose box.
      child.skeleton?.bones?.forEach((bone: any) => {
        box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld))
      })
      box.expandByObject(child)
      return
    }
    if (child.isMesh === true) box.expandByObject(child)
  })
  if (box.isEmpty()) box.setFromObject(root)
  return box
}
