/**
 * Ambient declarations for packages this plugin only consumes at runtime.
 *
 * The type check exists to catch mistakes in *this* code — an undefined
 * identifier, a wrong block shape — not to validate React or three.js, whose
 * type packages are not installed in this package. React is declared with the
 * few signatures the code actually uses, so JSX and hooks type-check without
 * pulling in @types/react.
 */

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    [name: string]: any
  }
  interface ElementChildrenAttribute {
    children: Record<string, never>
  }
}

declare module 'react' {
  export type ReactNode = any
  export type CSSProperties = Record<string, unknown>
  export type ComponentType<P = Record<string, never>> = (props: P) => JSX.Element
  export type SyntheticEvent<T = Element> = {
    readonly currentTarget: T
    preventDefault(): void
    stopPropagation(): void
  }
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useRef<T>(initial: T): { current: T }
  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void]
  const react: unknown
  export default react
}

declare module 'react/jsx-runtime' {
  export const jsx: unknown
  export const jsxs: unknown
  export const Fragment: unknown
}

declare module 'three'
declare module 'three/addons/*'

/** Host-side Node built-ins; their types live in the repository, not here. */
declare module 'node:fs/promises'
declare module 'node:path'
declare module 'node:zlib'
