/**
 * The private modes a terminal has to be put back into when nobody owns them.
 *
 * Three places need this: the main process, when a batch of output had to be
 * dropped; the renderer's parser queue, for the same reason on its side; and
 * the renderer's restore path, when a process exits or its history is replayed
 * into a shell that never asked for any of the modes in it.
 *
 * They lived as three separate literals, two of them byte-for-byte identical
 * across the main/renderer boundary. Nothing detects drift between copies of
 * an escape sequence: adding a newer mouse mode to one of them and not the
 * others would leave exactly the bug this text is about, in the two that were
 * missed. So the shared part is written once, here, and each use composes what
 * else it needs around it.
 */

/**
 * Every mouse reporting and focus mode an application can turn on.
 *
 * X10 (9), normal (1000), highlight (1001), button-event (1002), any-event
 * (1003), focus (1004), and the UTF-8/SGR/urxvt encodings (1005, 1006, 1015).
 * An application that dies with any of these set leaves the terminal typing
 * pointer movement into whatever it dropped back to.
 */
export const MOUSE_REPORTING_OFF =
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l'

/**
 * Cancel partial control state after output was dropped.
 *
 * Leads with CAN, which aborts a control sequence the lost bytes may have left
 * half-written, and ends by leaving synchronized update, showing the cursor
 * and resetting SGR — the attributes a truncated frame is most likely to have
 * been in the middle of.
 */
export const TERMINAL_OUTPUT_RESYNC =
  `\x18${MOUSE_REPORTING_OFF}\x1b[?2026l\x1b[?25h\x1b[0m`

/**
 * Reset modes owned by an exited process before handing input to a new shell.
 *
 * No CAN here: this runs at a point where the stream is intact and only the
 * *ownership* of the modes has changed. Beyond the mouse it also clears
 * bracketed paste (2004) and puts back the defaults a TUI routinely changes
 * and a shell prompt depends on: autowrap (7), origin mode (6), insert mode
 * (4) and the scrolling region.
 *
 * It ends by leaving the alternate screen, and that part is not optional.
 * Killing opencode the way a Bun panic does — no cleanup, no handlers — leaves
 * exactly this behind, measured on a real ConPTY:
 *
 *   alt-buffer switches: 1049h
 *   mouse mode switches: 1000h 1002h 1003h 1006h
 *
 * No `1049l`, no mouse off. Without the switch back, the card keeps showing
 * the dead application's last frame while the shell underneath it takes input
 * and prints where nobody can see it. Every user of this constant — a process
 * that exited, a session restored into a brand new shell, the user asking for
 * a reset — wants the normal screen back. The scrollback is on the normal
 * buffer, so nothing the user wants is lost by leaving the alternate one; the
 * only thing discarded is the frame of the application that died.
 */
export const APP_OWNED_MODE_RESET =
  `${MOUSE_REPORTING_OFF}\x1b[?2004l\x1b[?2026l\x1b[?25h\x1b[?7h\x1b[?6l\x1b[4l\x1b[r\x1b[?1049l`
