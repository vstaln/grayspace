import type { CanvasStore, CanvasWidget } from './canvasState.ts'
import type { Core } from './core/index.ts'
import type { AppState } from './appState.ts'

export interface BotCommandDeps {
  core: Core
  canvas: CanvasStore
  state: AppState
  /** Actor id the resulting bus commands are attributed to ('telegram'). */
  actorId: string
}

const HELP_TEXT = [
  'Доступные команды:',
  '/help — этот список',
  '/status — статус подключения и текущий терминал',
  '/terminals — список открытых терминалов',
  '/use <номер> — сделать терминал целевым (номер из /terminals)',
  '/new [название] — создать новый терминал и сделать его целевым',
  '/stop — прервать текущую команду в целевом терминале (Ctrl+C)',
  '',
  'Любой другой текст отправляется как ввод в целевой терминал.'
].join('\n')

function listTerminalWidgets(canvas: CanvasStore): CanvasWidget[] {
  return canvas.listWidgets().filter((w) => w.kind === 'terminal')
}

function formatTerminalList(widgets: CanvasWidget[], targetId: string | undefined): string {
  if (widgets.length === 0) return 'Терминалов на холсте нет. Создайте новый: /new'
  return widgets
    .map((w, i) => `${i + 1}. ${w.title || w.id}${w.id === targetId ? '  ← текущий' : ''}`)
    .join('\n')
}

/**
 * Parses and runs a `/command`. Returns the reply text, or null when `text`
 * is not a command at all (the caller then forwards it as raw terminal input,
 * same as before commands existed).
 */
export async function handleBotCommand(text: string, deps: BotCommandDeps): Promise<string | null> {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [rawCmd, ...rest] = trimmed.split(/\s+/)
  // Telegram suffixes commands with the bot's own username in group chats, e.g. "/status@MyBot".
  const cmd = rawCmd.slice(1).split('@')[0].toLowerCase()
  const arg = rest.join(' ').trim()
  const { core, canvas, state, actorId } = deps

  switch (cmd) {
    case 'help':
    case 'start':
      return HELP_TEXT

    case 'status': {
      const targetId = state.settings.targetTerminalId
      const widget = targetId ? canvas.listWidgets().find((w) => w.id === targetId) : undefined
      return [
        'OrcSpace: бот подключён.',
        targetId
          ? `Целевой терминал: ${widget?.title || targetId}`
          : 'Целевой терминал не выбран — см. /terminals и /use.'
      ].join('\n')
    }

    case 'terminals':
      return formatTerminalList(listTerminalWidgets(canvas), state.settings.targetTerminalId)

    case 'use': {
      const widgets = listTerminalWidgets(canvas)
      const index = Number.parseInt(arg, 10)
      if (!arg || !Number.isInteger(index) || index < 1 || index > widgets.length) {
        return widgets.length
          ? `Укажите номер терминала от 1 до ${widgets.length} (см. /terminals).`
          : 'Терминалов на холсте нет. Создайте новый: /new'
      }
      const widget = widgets[index - 1]
      state.patchSettings({ targetTerminalId: widget.id })
      return `Целевой терминал: ${widget.title || widget.id}`
    }

    case 'new': {
      const result = await core.bus.submit<{ id: string; title: string }>({
        actorId,
        type: 'terminal.create',
        target: 'terminal:new',
        payload: arg ? { title: arg, agentOwned: true } : { agentOwned: true }
      })
      if (!result.ok) return `Не удалось создать терминал: ${result.message}`
      state.patchSettings({ targetTerminalId: result.data.id })
      return `Создан терминал «${result.data.title}» — он теперь целевой.`
    }

    case 'stop': {
      const targetId = state.settings.targetTerminalId
      if (!targetId) return 'Целевой терминал не выбран.'
      const result = await core.bus.submit({
        actorId,
        type: 'terminal.input',
        target: `terminal:${targetId}`,
        payload: { data: '\x03' }
      })
      return result.ok ? 'Отправлено Ctrl+C в целевой терминал.' : `Не удалось: ${result.message}`
    }

    default:
      return `Неизвестная команда: /${cmd}. Список команд — /help`
  }
}
