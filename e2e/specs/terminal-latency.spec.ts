import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace } from '../helpers/app'
import { frameStats, estimateRefreshMs } from '../../src/renderer/src/lib/frameMetrics'

for (const terminalCount of [1, 3]) test(`keyboard echo stays responsive with ${terminalCount} streaming terminals`, async () => {
  const ctx = await launchOrcSpace()
  try {
    const { page } = ctx
    await ctx.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setPosition(0, 0)
      window.show()
      window.focus()
    })
    await waitForCanvas(page)
    await page.evaluate(() => window.api.workspace.create(`latency-${Date.now()}`))
    await page.getByRole('tab', { name: 'Code', exact: true }).click()
    await page.evaluate(async (count) => {
      const workspace = await window.api.workspace.codeWorkspaces()
      await window.api.code.save({ codeWorkspaceId: workspace.activeId, sessions: Array.from({ length: count }, (_, index) => ({
        id: index === 0 ? 'latency-shell' : `load-shell-${index}`, agentId: 'custom', label: 'Shell', command: '', status: 'active' as const
      })) })
    }, terminalCount)
    const terminal = page.getByTestId('terminal-xterm').first()
    await expect(terminal).toContainText('>')
    for (let index = 1; index < terminalCount; index++) {
      await expect(page.getByTestId('terminal-xterm').nth(index)).toContainText('>')
      await page.evaluate((id) => window.api.terminal.write(id,
        `node -e "setInterval(()=>process.stdout.write('load '.repeat(100)+'\\r\\n'),16)"\r`
      ), `load-shell-${index}`)
    }
    await page.evaluate(() => window.api.terminal.write('latency-shell',
      `node -e "process.stdin.setRawMode(true);process.stdin.on('data',b=>{for(const c of b)process.stdout.write('KEY:'+c+'\\r\\n')});setInterval(()=>process.stdout.write('load '.repeat(100)+'\\r\\n'),33);console.log('BENCH_READY')"\r`
    ))
    await expect(terminal.locator('.xterm-rows')).toContainText('BENCH_READY')
    await terminal.locator('textarea').focus()
    await ctx.app.evaluate(({ app }) => { app.getAppMetrics() })
    await page.evaluate(() => {
      const samples: number[] = []
      const frames: number[] = []
      const pending = new Map<string, number>()
      const rows = document.querySelector('.xterm-rows')!
      document.addEventListener('keydown', (event) => {
        if (/^[a-z]$/.test(event.key)) pending.set(`KEY:${event.key.charCodeAt(0)}`, performance.now())
      }, true)
      const observer = new MutationObserver(() => {
        const text = rows.textContent ?? ''
        for (const [marker, started] of pending) {
          if (text.includes(marker)) {
            samples.push(performance.now() - started)
            pending.delete(marker)
          }
        }
      })
      observer.observe(rows, { childList: true, characterData: true, subtree: true })
      const state = { samples, frames, done: false }
      ;(window as typeof window & { terminalBench?: typeof state }).terminalBench = state
      const frame = (at: number) => {
        frames.push(at)
        if (at - frames[0] < 4000 || samples.length < 26) requestAnimationFrame(frame)
        else { state.done = true; observer.disconnect() }
      }
      requestAnimationFrame(frame)
    })
    await page.keyboard.type('abcdefghijklmnopqrstuvwxyz', { delay: 40 })
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { terminalBench?: { done: boolean } }).terminalBench?.done
    )).toBe(true)
    const metrics = await page.evaluate(() =>
      (window as typeof window & { terminalBench: { samples: number[]; frames: number[] } }).terminalBench
    )
    expect(metrics.samples).toHaveLength(26)
    const ordered = metrics.samples.slice().sort((a, b) => a - b)
    const stats = frameStats(metrics.frames, estimateRefreshMs(metrics.frames) ?? undefined)
    console.log(JSON.stringify({ terminalCount, keyboardToPaintP50: ordered[12], keyboardToPaintP95: ordered[24], ...stats }))
    console.log(JSON.stringify({ terminalCount, processes: await ctx.app.evaluate(({ app }) =>
      app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpuPercent: cpu.percentCPUUsage, ...memory }))
    ) }))
    expect(ordered[24]).toBeLessThan(100)
    expect(stats.p95Ms).toBeLessThan(35)
  } finally {
    await closeOrcSpace(ctx)
  }
})
