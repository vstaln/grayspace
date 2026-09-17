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
const CSI = /^\x1b\[[0-?]*[ -/]*[@-~]/

export function captureTerminalInput(
  current: TerminalPromptCapture,
  data: string
): { capture: TerminalPromptCapture; submitted: SubmittedTerminalPrompt[] } {
  let command = current.command
  let prompt = current.prompt
  let bracketedPaste = current.bracketedPaste
  const submitted: SubmittedTerminalPrompt[] = []

  for (let index = 0; index < data.length;) {
    const remaining = data.slice(index)
    if (remaining.startsWith(START_PASTE)) {
      bracketedPaste = true
      index += START_PASTE.length
      continue
    }
    if (remaining.startsWith(END_PASTE)) {
      bracketedPaste = false
      index += END_PASTE.length
      continue
    }
    const csi = remaining.match(CSI)?.[0]
    if (csi) {
      index += csi.length
      continue
    }

    const char = data[index]
    index += 1
    if (bracketedPaste) {
      prompt = `${prompt}${char}`.slice(-12_000)
      command = char === '\r' || char === '\n'
        ? ''
        : `${command}${char}`.slice(-128)
      continue
    }
    if (char === '\r' || char === '\n') {
      if (command.trim() || prompt.trim()) submitted.push({ command, prompt })
      command = ''
      prompt = ''
    } else if (char === '\x7f' || char === '\b') {
      command = command.slice(0, -1)
      prompt = prompt.slice(0, -1)
    } else if (char === '\x15' || char === '\x03') {
      command = ''
      prompt = ''
    } else if (char >= ' ' || char === '\t') {
      command = `${command}${char}`.slice(-128)
      prompt = `${prompt}${char}`.slice(-12_000)
    }
  }

  return { capture: { command, prompt, bracketedPaste }, submitted }
}
