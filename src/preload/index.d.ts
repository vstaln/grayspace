// The renderer-facing contract for window.api. The actual type definitions
// live in ./api.ts so the preload implementation (./index.ts) can import and
// implement them without a self-referencing .d.ts — keeping the two halves of
// the bridge in sync is a compile error, not a runtime surprise. Everything
// here is re-exported unchanged, so `import type { AppSettings } from
// '../../../preload/index.d'` keeps working as before.
export * from './api'
import type {
  BrainApi,
  BrowserApi,
  CanvasApi,
  ControlApi,
  CoordinationApi,
  FsApi,
  GitApi,
  McpApi,
  MediaApi,
  PlannerApi,
  SettingsApi,
  SystemApi,
  TelegramApi,
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
      mcp: McpApi
      telegram: TelegramApi
      media: MediaApi
      coordination: CoordinationApi
      planner: PlannerApi
      brain: BrainApi
      canvas: CanvasApi
      git: GitApi
      fs: FsApi
      system: SystemApi
      browser: BrowserApi
      window: WindowApi
    }
  }
}