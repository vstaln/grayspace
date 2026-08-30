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
 *
 * The reset has to sit in a real cascade layer, not just earlier in the
 * document. Its opening `*, ::before, ::after { margin: 0 }` carries the same
 * (zero) specificity as the utilities UnoCSS writes with `:where()` —
 * `space-y-*` and `space-x-*` compile to `:where(.space-y-4 > :not(:last-child))`
 * — and it is injected *after* the Uno stylesheet, so the tie went to the
 * reset and every one of those utilities silently collapsed to zero. Layered
 * rules always lose to unlayered ones, so `@layer base` settles it. The layer
 * is opened here, before `appStylesheet`'s own `@layer base`, keeping the
 * original order: app rules still win ties against the reset.
 */
export function installStyles(): void {
  inject('workspace-reset', { '@layer base': resetSheet })
  inject('workspace-styles', appStylesheet)
}
