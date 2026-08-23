import { inject } from './css'
import { appStylesheet } from './stylesheet'
import { resetSheet } from './reset'

export * from './tokens'
export { compile, inject } from './css'
export type { Sheet, StyleRules, StyleValue } from './css'

/**
 * Mounts the app's stylesheet. Called once from the renderer entry, right after
 * the UnoCSS virtual import: the element reset goes in first so utilities and
 * the app rules win ties against it, then the app stylesheet itself.
 */
export function installStyles(): void {
  inject('workspace-reset', resetSheet)
  inject('workspace-styles', appStylesheet)
}
