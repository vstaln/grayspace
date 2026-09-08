import { inject } from './css'
import { appStylesheet } from './stylesheet'
import { resetSheet } from './reset'

export * from './tokens'
export { compile, inject } from './css'
export type { Sheet, StyleRules, StyleValue } from './css'
















export function installStyles(): void {
  inject('workspace-reset', { '@layer base': resetSheet })
  inject('workspace-styles', appStylesheet)
}
