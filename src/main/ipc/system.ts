import * as os from 'os'
import { ipcMain } from './shims.ts'
import { getCpuMeta, getCpuUsagePercent } from './cpuSampler.ts'
import { getAgentUsageStats } from '../agentUsage.ts'
import type { IpcDeps } from './types.ts'

interface MemoryStats {
  totalMem: number
  freeMem: number
  /** The memory pressure signal to budget against; see readMemoryStats. */
  availableMem: number
  swapTotal: number
  swapFree: number
}

/**
 * Kilobytes from getSystemMemoryInfo() as bytes, or 0.
 *
 * Its fields are per-platform: `swapTotal`/`swapFree` exist only on Windows
 * and Linux, `available` only on Linux. On the platforms that do not report
 * one it is absent at runtime even though the type declares it, so an
 * unchecked `* 1024` yields NaN — which then poisons every arithmetic
 * comparison it reaches, including the launch budget's.
 */
function kilobytesToBytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1024 : 0
}

function readMemoryStats(): MemoryStats {
  const systemMemory: Partial<Electron.SystemMemoryInfo> =
    typeof process.getSystemMemoryInfo === 'function' ? process.getSystemMemoryInfo() : {}
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  // On Linux os.freemem() is MemFree, which excludes the page cache and other
  // reclaimable memory: a healthy machine with a warm cache reports a couple
  // of gigabytes free while tens are actually obtainable. MemAvailable is the
  // kernel's own estimate of what can be allocated without swapping, and is
  // what Electron documents as the pressure signal there. Everywhere else
  // free physical memory already means roughly that.
  const available = kilobytesToBytes(systemMemory.available)
  const hasAvailable = typeof systemMemory.available === 'number' &&
    Number.isFinite(systemMemory.available) && systemMemory.available >= 0
  return {
    totalMem,
    freeMem,
    availableMem: os.platform() === 'linux' && hasAvailable ? available : freeMem,
    swapTotal: kilobytesToBytes(systemMemory.swapTotal),
    swapFree: kilobytesToBytes(systemMemory.swapFree)
  }
}

export function registerSystemIpc(deps: IpcDeps): void {
  ipcMain.handle('system:cpu', () => ({ cpuPercent: getCpuUsagePercent() }))

  ipcMain.handle('system:release-locks', () => {
    deps.core.locks.releaseAll()
    return { ok: true }
  })

  ipcMain.handle('system:memory', () => {
    try {
      return { ...readMemoryStats(), platform: os.platform() }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('system:stats', async () => {
    try {
      const { totalMem, freeMem, swapTotal, swapFree } = readMemoryStats()
      const usedMem = Math.max(0, totalMem - freeMem)
      const memUsagePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0
      const cpuPercent = getCpuUsagePercent()
      const cpu = getCpuMeta()
      const activeTerminals = deps.terminals.list().map((t) => ({
        id: t.id,
        title: t.title,
        running: t.alive,
        agentOwned: t.id.startsWith('agent-')
      }))
      const procMem = process.memoryUsage()
      const agents = await getAgentUsageStats(deps)

      return {
        cpuPercent,
        cpuCount: cpu.count,
        cpuModel: cpu.model,
        cores: cpu.cores,
        totalMem,
        freeMem,
        swapTotal,
        swapFree,
        usedMem,
        memUsagePercent,
        processMemory: {
          rss: procMem.rss,
          heapUsed: procMem.heapUsed,
          heapTotal: procMem.heapTotal
        },
        uptime: os.uptime(),
        appUptime: Math.floor(process.uptime()),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        terminalsCount: activeTerminals.length,
        activeTerminals,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        flow: deps.core.flow.stats(),
        agents
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
