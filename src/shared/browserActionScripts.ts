/**
 * The in-page JavaScript run for every agent browser action (snapshot,
 * click, fill, select, press, scroll), plus the checkout/payment guards
 * those scripts embed. Single source shared by the in-app `<webview>`
 * (BrowserWidget, via `executeJavaScript`) and the real-Chrome backend
 * (realBrowser, via Puppeteer's `page.evaluate`) so both surfaces enforce
 * the exact same safety rules and element-addressing scheme — ref numbers
 * are a snapshot-order index into the same query, not a persisted id.
 */

export const PROTECTED_ORDER_WORDS = String.raw`\b(?:check\s?out|place\s+(?:an?\s+)?order|submit\s+order|complete\s+order|confirm\s+order|finish\s+order|buy\s+now|purchase|pay(?:ment)?\s+now|confirm\s+payment|order\s+now|(?:continue|proceed)\s+to\s+(?:checkout|payment))\b`
export const PROTECTED_CHECKOUT_PATH = String.raw`(?:^|/)(?:checkouts?(?:[-_](?:now|start|review|payment|confirm(?:ation)?|complete|finish))?|check-out|payments?|billing|place[-_]order|order[-_](?:review|confirm(?:ation)?|complete|finish)|complete[-_]order|confirm[-_]order|finish[-_]order|buy[-_]now|purchase)(?:\.[a-z]+)?(?:/|$)`
export const PROTECTED_PAYMENT_FIELDS = String.raw`password|passwd|secret|token|credit.?card|card.?holder|card.?name|card.?number|card.?exp|expir(?:y|ation)|valid.?through|cc[-_ ]?(?:number|name|exp|csc|cvv|cvc)|payment.?method|one-time-code|\botp\b|\bcvv\b|\bcvc\b|security.?code|iban|routing.?number|ssn`
export const PROTECTED_PAYMENT_FORM_FIELDS = String.raw`password|passwd|secret|credit.?card|card.?holder|card.?name|card.?number|card.?exp|expir(?:y|ation)|valid.?through|cc[-_ ]?(?:number|name|exp|csc|cvv|cvc)|payment.?(?:token|method)|one-time-code|\botp\b|\bcvv\b|\bcvc\b|security.?code|iban|routing.?number|ssn`
export const SAFE_CHECKOUT_EXIT = String.raw`\b(?:back|return)\s+to\s+(?:cart|bag)|continue\s+shopping|edit\s+(?:cart|bag)\b`

export function isProtectedCheckoutUrl(value: string): boolean {
  try {
    const candidate = new URL(value)
    const checkoutPath = new RegExp(PROTECTED_CHECKOUT_PATH, 'i')
    const checkoutHost = /(?:^|\.)(?:checkout|payments?|billing|purchase|orders?)(?:\.|$)/i.test(candidate.hostname)
    const checkoutStep = [...candidate.searchParams].some(([key, step]) => /step|stage|flow|action|page/i.test(key) && checkoutPath.test(step))
    return checkoutPath.test(candidate.pathname) || checkoutHost || checkoutStep
  } catch {
    return false
  }
}

const REF_RANGE_ERROR = 'ref must be a number from the latest browser snapshot'

export function assertRefInRange(ref: number): void {
  if (!Number.isInteger(ref) || ref < 1 || ref > 100) throw new Error(REF_RANGE_ERROR)
}

export function snapshotScript(): string {
  return `(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const nodes = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"]')]
      .filter(visible).slice(0, 100)
    const controls = nodes.map((el, i) => {
      const tag = el.tagName.toLowerCase()
      const label = el.getAttribute('aria-label') || el.closest('label')?.innerText || el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
      let href = ''
      if (tag === 'a') {
        try { const u = new URL(el.href); href = u.origin + u.pathname } catch {}
      }
      const choices = tag === 'select' ? [...el.options].slice(0, 30).map((option) => ({ label: option.label, value: option.value })) : undefined
      return {
        ref: String(i + 1), tag,
        type: el.getAttribute('type') || '',
        label: String(label).replace(/\s+/g, ' ').trim().slice(0, 160),
        placeholder: el.getAttribute('placeholder') || '',
        href, choices
      }
    })
    let pageUrl = location.origin + location.pathname
    return { title: document.title, url: pageUrl, text: (document.body?.innerText || '').slice(0, 6000), controls }
  })()`
}

export function clickScript(ref: number): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const nodes = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 100)
    const el = nodes[${ref - 1}]
    if (!el) throw new Error('page element no longer exists; take a new snapshot')
    const label = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('value')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    const form = el.form
    const submitText = form ? [...form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"]')].map((item) => item.innerText || item.value || item.getAttribute('aria-label') || '').join(' ') : ''
    const formFields = form ? [...form.querySelectorAll('input,select,textarea')].map((item) => [item.type, item.name, item.id, item.autocomplete, item.getAttribute('aria-label'), item.getAttribute('placeholder'), [...(item.labels || [])].map((label) => label.innerText).join(' ')].join(' ')).join(' ') : ''
    const protectedWords = new RegExp(${JSON.stringify(PROTECTED_ORDER_WORDS)}, 'i')
    const protectedFields = new RegExp(${JSON.stringify(PROTECTED_PAYMENT_FORM_FIELDS)}, 'i')
    const checkoutPath = new RegExp(${JSON.stringify(PROTECTED_CHECKOUT_PATH)}, 'i')
    const safeExit = new RegExp(${JSON.stringify(SAFE_CHECKOUT_EXIT)}, 'i')
    const isCheckoutUrl = (raw) => {
      const candidate = new URL(raw, location.href)
      const checkoutHost = /(?:^|\.)(?:checkout|payments?|billing|purchase|orders?)(?:\.|$)/i.test(candidate.hostname)
      const checkoutStep = [...candidate.searchParams].some(([key, value]) => /step|stage|flow|action|page/i.test(key) && checkoutPath.test(value))
      return checkoutPath.test(candidate.pathname) || checkoutHost || checkoutStep
    }
    const destination = el instanceof HTMLAnchorElement ? el.href : (el.getAttribute('formaction') || form?.action || location.href)
    const onCheckoutPage = isCheckoutUrl(location.href)
    const checkoutDestination = isCheckoutUrl(destination)
    const leavesCheckoutSafely = safeExit.test(label) && !checkoutDestination && (el instanceof HTMLAnchorElement || !form)
    if (protectedWords.test(label + ' ' + submitText) || protectedFields.test(formFields) || checkoutDestination || (onCheckoutPage && !leavesCheckoutSafely)) throw new Error('checkout and purchase actions are disabled')
    el.click()
    return { clicked: label.slice(0, 160), tag: el.tagName.toLowerCase() }
  })()`
}

export function selectScript(ref: number, value: string): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const nodes = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 100)
    const el = nodes[${ref - 1}]
    if (!el || el.tagName !== 'SELECT') throw new Error('ref is not a select field; take a new snapshot')
    const identity = [el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder'), [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ')
    if (new RegExp(${JSON.stringify(PROTECTED_PAYMENT_FIELDS)}, 'i').test(identity)) throw new Error('password and payment fields are disabled')
    const wanted = ${JSON.stringify(value)}
    const option = [...el.options].find((item) => item.value === wanted) || [...el.options].find((item) => item.label.trim().toLowerCase() === wanted.trim().toLowerCase())
    if (!option) throw new Error('option not found; take a new snapshot and use one of its listed choices')
    el.value = option.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { selected: option.label, value: option.value }
  })()`
}

export function fillScript(ref: number, value: string): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const nodes = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 100)
    const el = nodes[${ref - 1}]
    if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) throw new Error('ref is not a text field; take a new snapshot')
    const identity = [el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.placeholder, [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ')
    if (el.type === 'password' || new RegExp(${JSON.stringify(PROTECTED_PAYMENT_FIELDS)}, 'i').test(identity)) throw new Error('password and payment fields are disabled')
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.focus()
    return { filled: true, ref: '${ref}' }
  })()`
}

export function pressFocusScript(ref: number): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    const nodes = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 100)
    if (!nodes[${ref - 1}]) throw new Error('page element no longer exists; take a new snapshot')
    nodes[${ref - 1}].focus()
  })()`
}

export function pressKeyScript(key: string): string {
  return `(() => {
    const key = ${JSON.stringify(key)}
    const target = document.activeElement || document.body
    const form = target instanceof HTMLInputElement || target instanceof HTMLButtonElement ? target.form : null
    const label = [target.innerText, target.getAttribute?.('aria-label'), target.getAttribute?.('title'), target.value].filter(Boolean).join(' ')
    if (key === 'Enter') {
      const fields = form ? [...form.querySelectorAll('input,select,textarea')].map((el) => [el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder'), [...(el.labels || [])].map((label) => label.innerText).join(' ')].join(' ')).join(' ') : ''
      const buttons = form ? [...form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"]')].map((el) => el.innerText || el.value || el.getAttribute('aria-label') || '').join(' ') : ''
      const protectedWords = new RegExp(${JSON.stringify(PROTECTED_ORDER_WORDS)}, 'i')
      const protectedFields = new RegExp(${JSON.stringify(PROTECTED_PAYMENT_FORM_FIELDS)}, 'i')
      const checkoutPath = new RegExp(${JSON.stringify(PROTECTED_CHECKOUT_PATH)}, 'i')
      const safeExit = new RegExp(${JSON.stringify(SAFE_CHECKOUT_EXIT)}, 'i')
      const isCheckoutUrl = (raw) => {
        const candidate = new URL(raw, location.href)
        const checkoutHost = /(?:^|\.)(?:checkout|payments?|billing|purchase|orders?)(?:\.|$)/i.test(candidate.hostname)
        const checkoutStep = [...candidate.searchParams].some(([key, value]) => /step|stage|flow|action|page/i.test(key) && checkoutPath.test(value))
        return checkoutPath.test(candidate.pathname) || checkoutHost || checkoutStep
      }
      const destination = target instanceof HTMLAnchorElement ? target.href : (target.getAttribute?.('formaction') || form?.action || location.href)
      const onCheckoutPage = isCheckoutUrl(location.href)
      const checkoutDestination = isCheckoutUrl(destination)
      const leavesCheckoutSafely = safeExit.test(label) && !checkoutDestination && (target instanceof HTMLAnchorElement || !form)
      if (protectedWords.test(label + ' ' + buttons) || protectedFields.test(fields) || checkoutDestination || (onCheckoutPage && !leavesCheckoutSafely)) throw new Error('checkout and purchase actions are disabled')
    }
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    if (key === 'Enter' && target instanceof HTMLInputElement && target.form) target.form.requestSubmit()
    else if (key === 'Enter' && target instanceof HTMLButtonElement) target.click()
    return { key }
  })()`
}

export function scrollScript(pixels: number): string {
  return `(() => { window.scrollBy({ top: ${pixels}, behavior: 'instant' }); return { scrolled: ${pixels} } })()`
}

export const SUPPORTED_PRESS_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '] as const
