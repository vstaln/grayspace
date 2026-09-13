import type { Core } from '../core/index.ts'
import { registerBrowserIpc } from './browser.ts'
import { registerChatIpc } from './chat.ts'
import { registerCanvasIpc } from './canvas.ts'
import { registerCodeIpc } from './code.ts'
import { registerFilesystemIpc } from './filesystem.ts'
import { registerGitIpc } from './git.ts'
import { registerIntegrationsIpc } from './integrations.ts'
import { registerOrchestrationIpc } from './orchestration.ts'
import { registerPlannerIpc } from './planner.ts'
import { registerSettingsIpc } from './settings.ts'
import { registerSystemIpc } from './system.ts'
import { registerTerminalIpc } from './terminals.ts'
import { USER_ACTOR_ID } from './shared.ts'
import type { IpcDeps } from './types.ts'
import { registerWindowIpc } from './window.ts'
import { registerWorkspaceIpc } from './workspace.ts'

export { USER_ACTOR_ID } from './shared.ts'
export {
  clearMountedTerminals,
  focusedTerminalId,
  forgetTerminalOrigin,
  isTerminalMounted,
  originTerminalId
} from './terminalFocus.ts'
export { quoteWin32CmdArg, unwrap } from './shared.ts'
export type { IpcDeps } from './types.ts'


export function registerIpc(deps: IpcDeps): void {
  deps.core.actors.register({
    id: USER_ACTOR_ID,
    type: 'user',
    label: deps.state.settings.userName || 'You',
    transport: 'ipc'
  })

  registerWindowIpc(deps)
  registerTerminalIpc(deps)
  registerWorkspaceIpc(deps)
  registerFilesystemIpc(deps)
  registerGitIpc(deps)
  registerSystemIpc(deps)
  registerSettingsIpc(deps)
  registerIntegrationsIpc(deps)
  registerCanvasIpc(deps)
  registerCodeIpc(deps)
  registerPlannerIpc(deps)
  registerOrchestrationIpc(deps)
  registerBrowserIpc(deps)
  registerChatIpc(deps)
}

export type { Core }
