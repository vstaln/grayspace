








export const IS_MAC: boolean =
  typeof navigator !== 'undefined' &&


  (((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '')
    .toLowerCase()
    .includes('mac'))






export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'> | Pick<MouseEvent, 'ctrlKey' | 'metaKey'>
): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey
}







export function hasSecondaryModifier(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>
): boolean {
  return IS_MAC ? event.ctrlKey : event.metaKey
}


export const PRIMARY_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl'


export const ALT_KEY_LABEL = IS_MAC ? '⌥' : 'Alt'


export const SHIFT_KEY_LABEL = IS_MAC ? '⇧' : 'Shift'





export function shortcut(key: string, options?: { shift?: boolean; alt?: boolean }): string {
  const parts: string[] = [PRIMARY_KEY_LABEL]
  if (options?.alt) parts.push(ALT_KEY_LABEL)
  if (options?.shift) parts.push(SHIFT_KEY_LABEL)
  parts.push(key)
  return IS_MAC ? parts.join('') : parts.join('+')
}
