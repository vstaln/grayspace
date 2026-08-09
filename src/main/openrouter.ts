const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface OpenRouterHandlers {
  onDelta(text: string): void
  onDone(): void
  onError(message: string): void
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
  error?: { message?: string }
}

/**
 * Streams a single-turn OpenRouter chat completion over SSE. There is no
 * conversation history sent — each chat message is its own one-shot prompt,
 * matching how the CLI-backed providers in this panel already work.
 */
export async function streamOpenRouter(
  apiKey: string,
  model: string,
  prompt: string,
  handlers: OpenRouterHandlers,
  signal: AbortSignal
): Promise<void> {
  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter asks for these on free-tier requests; harmless to send always.
        'HTTP-Referer': 'https://workspace.local',
        'X-Title': 'Workspace'
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
      signal
    })
  } catch (err) {
    if (signal.aborted) return
    return handlers.onError(`Не удалось подключиться к OpenRouter: ${String(err)}`)
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    return handlers.onError(
      res.status === 401
        ? 'OpenRouter отклонил ключ — проверьте, что он скопирован верно'
        : `OpenRouter вернул ${res.status}: ${body.slice(0, 300) || res.statusText}`
    )
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') return handlers.onDone()
        try {
          const event = JSON.parse(payload) as StreamChunk
          if (event.error?.message) return handlers.onError(event.error.message)
          const text = event.choices?.[0]?.delta?.content
          if (text) handlers.onDelta(text)
        } catch {
          /* SSE keep-alive comments and the like are expected here */
        }
      }
    }
    handlers.onDone()
  } catch (err) {
    if (!signal.aborted) handlers.onError(String(err))
  }
}
