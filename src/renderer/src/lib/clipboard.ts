export async function copyText(text: string): Promise<boolean> {
  try {
    const systemCopy = window.api.media.writeClipboardText
    if (systemCopy) {
      const result = await systemCopy(text)
      return 'ok' in result && result.ok === true
    }
    await window.navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
