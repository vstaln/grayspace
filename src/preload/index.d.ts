// The renderer-facing contract for window.api. The actual type definitions
// live in ./api.ts so the preload implementation (./index.ts) can import and
// implement them without a self-referencing .d.ts — keeping the two halves of
// the bridge in sync is a compile error, not a runtime surprise. Everything
// here is re-exported unchanged, so `import type { AppSettings } from
// '../../../preload/index.d'` keeps working as before.
export * from './api'
import type {
  BrowserApi,
  CanvasApi,
  CodeApi,
  ControlApi,
  CoordinationApi,
  FsApi,
  GitApi,
  MediaApi,
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
      coordination: CoordinationApi
      orchestration: OrchestrationApi
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
