




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
