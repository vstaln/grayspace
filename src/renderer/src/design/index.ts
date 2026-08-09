import { inject } from './css'
import { appStylesheet } from './stylesheet'

export * from './tokens'
export { compile, inject } from './css'
export type { Sheet, StyleRules, StyleValue } from './css'

/**
 * Mounts the app's stylesheet. Called once from the renderer entry, after the
 * Tailwind import, so the `base` / `components` layers Tailwind declares already
 * exist and these rules slot into them at the right precedence.
 */
export function installStyles(): void {
  inject('workspace-styles', appStylesheet)
}
