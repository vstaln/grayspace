





export * from './api'
import type {
  BrowserApi,
  CanvasApi,
  CodeApi,
  ControlApi,
  FsApi,
  GitApi,
  MediaApi,
  MissionApi,
  OrchestrationApi,
  PlannerApi,
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
      media: MediaApi
      orchestration: OrchestrationApi
      mission: MissionApi
      planner: PlannerApi
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
