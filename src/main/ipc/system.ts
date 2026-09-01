import * as os from 'os'
import { ipcMain } from './shims.ts'
import { getCpuMeta, getCpuUsagePercent } from './cpuSampler.ts'
import { getAgentUsageStats } from '../agentUsage.ts'
import type { IpcDeps } from './types.ts'

export function registerSystemIpc(deps: IpcDeps): void {
  ipcMain.handle('system:stats', async () => {
    try {
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
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
        bus: deps.core.bus.stats(),
        agents
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
