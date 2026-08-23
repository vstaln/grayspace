/**
 * The IPC surface, decomposed into one registrar per domain under `ipc/`.
 * This file is a compatibility barrel: `index.ts` and the tests import from
 * here, exactly as they did when everything lived in one 800-line module.
 */
export {
  registerIpc,
  USER_ACTOR_ID,
  focusedTerminalId,
  originTerminalId,
  forgetTerminalOrigin,
  isTerminalMounted,
  clearMountedTerminals,
  quoteWin32CmdArg
} from './ipc/index.ts'

export { registerIpc as registerIpcHandlers } from './ipc/index.ts'
