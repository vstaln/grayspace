export interface TerminalPromptCapture {
  command: string
  prompt: string
  bracketedPaste: boolean
}

export interface SubmittedTerminalPrompt {
  command: string
  prompt: string
}

export const EMPTY_TERMINAL_PROMPT_CAPTURE: TerminalPromptCapture = {
  command: '',
  prompt: '',
  bracketedPaste: false
}

const START_PASTE = '\x1b[200~'
const END_PASTE = '\x1b[201~'
// Sticky variant of the CSI pattern: matched at the current index without
// copying the rest of the chunk on every character (the old loop sliced the
// remainder per char, which turned a large paste into O(n^2) copies).
// eslint-disable-next-line no-control-regex
const CSI_STICKY = /\x1b\[[0-?]*[ -/]*[@-~]/y

const MAX_COMMAND_CHARS = 128
const MAX_PROMPT_CHARS = 12_000

export function captureTerminalInput(
  current: TerminalPromptCapture,
  data: string
): { capture: TerminalPromptCapture; submitted: SubmittedTerminalPrompt[] } {
  // Arrays of UTF-16 units (same granularity as the old per-char indexing),
  // capped only at observation points. Capping on every keystroke copied up
  // to 12KB per character; deferring it keeps a large paste linear while
  // producing byte-identical results: intermediate states are unobservable
  // except at submit, which caps the same way.
  const command: string[] = current.command.split('')
  const prompt: string[] = current.prompt.split('')
  let bracketedPaste = current.bracketedPaste
  const submitted: SubmittedTerminalPrompt[] = []

  let index = 0
  const length = data.length
  while (index < length) {
    if (data.startsWith(START_PASTE, index)) {
      bracketedPaste = true
      index += START_PASTE.length
      continue
    }
    if (data.startsWith(END_PASTE, index)) {
      bracketedPaste = false
      index += END_PASTE.length
      continue
    }
    if (data.charCodeAt(index) === 0x1b) {
      CSI_STICKY.lastIndex = index
      const csi = CSI_STICKY.exec(data)
      if (csi) {
        index += csi[0].length
        continue
      }
    }

    const char = data[index]
    index += 1
    if (bracketedPaste) {
      prompt.push(char)
      if (char === '\r' || char === '\n') command.length = 0
      else command.push(char)
      continue
    }
    if (char === '\r' || char === '\n') {
      const commandText = command.slice(-MAX_COMMAND_CHARS).join('')
      const promptText = prompt.slice(-MAX_PROMPT_CHARS).join('')
      if (commandText.trim() || promptText.trim()) submitted.push({ command: commandText, prompt: promptText })
      command.length = 0
      prompt.length = 0
    } else if (char === '\x7f' || char === '\b') {
      command.pop()
      prompt.pop()
    } else if (char === '\x15' || char === '\x03') {
      command.length = 0
      prompt.length = 0
    } else if (char >= ' ' || char === '\t') {
      command.push(char)
      prompt.push(char)
    }
  }

  return {
    capture: {
      command: command.slice(-MAX_COMMAND_CHARS).join(''),
      prompt: prompt.slice(-MAX_PROMPT_CHARS).join(''),
      bracketedPaste
    },
    submitted
  }
}
