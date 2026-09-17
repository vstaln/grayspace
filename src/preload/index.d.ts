





export * from './api'
import type {
  BrowserApi,
  ChatApi,
  CanvasApi,
  CodeApi,
  ControlApi,
  FsApi,
  GitApi,
  MediaApi,
  OrchestrationApi,
  PlannerApi,
  RendererStateApi,
  SettingsApi,
  SystemApi,
  TerminalApi,
  WindowApi,
  WorkspaceApi
} from './api'

declare global {
  interface Window {
    api: {
      terminal: TerminalApi
      control: ControlApi
      workspace: WorkspaceApi
      settings: SettingsApi
      chat: ChatApi
      media: MediaApi
      orchestration: OrchestrationApi
      planner: PlannerApi
      rendererState: RendererStateApi
      canvas: CanvasApi
      code: CodeApi
      git: GitApi
      fs: FsApi
      system: SystemApi
      browser: BrowserApi
      window: WindowApi
    }
  }
}
