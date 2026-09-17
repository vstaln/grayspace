// Reset modes owned by the exited process before handing input to a new shell.
export const APP_OWNED_MODE_RESET =
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?2004l\x1b[?2026l\x1b[?25h\x1b[?7h\x1b[?6l\x1b[4l\x1b[r'

export function terminalRestoreData(scrollback: string, live: boolean): string {
  // A live snapshot may stop inside an escape sequence or synchronized frame.
  // Only the process's next output may complete it or change cursor visibility.
  const marker = live ? '' :
    `${APP_OWNED_MODE_RESET}\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n`
  return `\x1b[0m${scrollback}${marker}`
}
