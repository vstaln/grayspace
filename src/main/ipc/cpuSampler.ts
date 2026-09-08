import * as os from 'os'

interface CpuCoreTimes {
  idle: number
  total: number
}

let prevCpuTimes: CpuCoreTimes[] = []
let currentCpuPercent = 0
let currentCorePercents: number[] = []
let lastCpuSampleAt = 0
let lastStatsRequestAt = 0
let cpuSamplerTimer: ReturnType<typeof setInterval> | null = null
let cachedCpuMeta: { count: number; model: string } | null = null

export function sampleCpuUsage(): void {
  const now = Date.now()

  if (now - lastCpuSampleAt < 400 && prevCpuTimes.length > 0) return
  lastCpuSampleAt = now
  try {
    const cpus = os.cpus()
    if (!cpus || cpus.length === 0) return
    if (!cachedCpuMeta) cachedCpuMeta = { count: cpus.length, model: cpus[0]?.model || 'Generic CPU' }

    if (prevCpuTimes.length !== cpus.length) {
      prevCpuTimes = cpus.map((cpu) => {
        let total = 0
        for (const type in cpu.times) {
          total += cpu.times[type as keyof typeof cpu.times]
        }
        return { idle: cpu.times.idle, total }
      })
      return
    }

    let totalIdleDiff = 0
    let totalTimeDiff = 0
    const perCore: number[] = []

    for (let i = 0; i < cpus.length; i++) {
      const cpu = cpus[i]
      let coreTotal = 0
      for (const type in cpu.times) {
        coreTotal += cpu.times[type as keyof typeof cpu.times]
      }
      const prev = prevCpuTimes[i]
      const coreIdleDiff = cpu.times.idle - prev.idle
      const coreTotalDiff = coreTotal - prev.total

      prevCpuTimes[i] = { idle: cpu.times.idle, total: coreTotal }

      if (coreTotalDiff > 0) {
        const coreUsage = Math.max(0, Math.min(100, Math.round((1 - coreIdleDiff / coreTotalDiff) * 100)))
        perCore.push(coreUsage)
        totalIdleDiff += coreIdleDiff
        totalTimeDiff += coreTotalDiff
      } else {
        perCore.push(0)
      }
    }

    if (totalTimeDiff > 0) {
      currentCpuPercent = Math.max(0, Math.min(100, Math.round((1 - totalIdleDiff / totalTimeDiff) * 100)))
    }
    currentCorePercents = perCore
  } catch {

  }
}

function ensureCpuSampler(): void {
  lastStatsRequestAt = Date.now()
  if (cpuSamplerTimer) return
  sampleCpuUsage()
  cpuSamplerTimer = setInterval(() => {
    if (Date.now() - lastStatsRequestAt > 8_000) {
      if (cpuSamplerTimer) clearInterval(cpuSamplerTimer)
      cpuSamplerTimer = null
      return
    }
    sampleCpuUsage()
  }, 1000)
  cpuSamplerTimer.unref?.()
}

export function getCpuUsagePercent(): number {
  ensureCpuSampler()
  sampleCpuUsage()
  return currentCpuPercent
}

export function getCpuMeta(): { count: number; model: string; cores: number[] } {
  return {
    count: cachedCpuMeta?.count || currentCorePercents.length || (os.cpus() || []).length,
    model: cachedCpuMeta?.model || 'Generic CPU',
    cores: currentCorePercents.length > 0 ? currentCorePercents : []
  }
}
