import { APP_OWNED_MODE_RESET } from '../../../shared/terminalModes.ts'

export { APP_OWNED_MODE_RESET }

export function terminalRestoreData(scrollback: string, live: boolean): string {
  // A live snapshot may stop inside an escape sequence or synchronized frame.
  // Only the process's next output may complete it or change cursor visibility.
  const marker = live ? '' :
    `${APP_OWNED_MODE_RESET}\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n`
  return `\x1b[0m${scrollback}${marker}`
}
