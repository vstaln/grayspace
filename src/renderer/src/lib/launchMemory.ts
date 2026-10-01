/** Approximate committed memory used by one coding-agent CLI. */
export const AGENT_MEMORY_BYTES = 1024 * 1024 * 1024

const MIN_SYSTEM_RESERVE_BYTES = 2 * 1024 * 1024 * 1024
const SYSTEM_RESERVE_RATIO = 0.15
const NO_PAGEFILE_RESERVE_RATIO = 0.5

export interface AgentLaunchMemory {
  freeBytes: number
  /**
   * What can be allocated without swapping, when the platform reports it
   * separately from `freeBytes` (Linux MemAvailable). Preferred over
   * `freeBytes` whenever it is measured.
   */
  availableBytes?: number
  totalBytes: number
  swapFreeBytes?: number
  swapTotalBytes?: number
  platform?: string
}

export interface AgentLaunchPlan {
  /**
   * How many more agents fit, or `null` when memory could not be measured.
   *
   * Agents that are already running are accounted for by the free-memory
   * reading itself, so callers must not subtract them a second time.
   * `null` means "unknown", never "zero": a failed or still-pending stats
   * read must not block a launch.
   */
  availableSlots: number | null
  pagefileDisabled: boolean
}

function measured(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * A reported byte count as a number safe to do arithmetic with.
 *
 * Per-platform OS fields arrive as `undefined` (and, once multiplied by a
 * unit factor, as NaN) on the platforms that do not report them. NaN is
 * false in every comparison, so letting one through here turns a healthy
 * machine into one where nothing may be launched.
 */
function bytesOrZero(value: number | undefined): number {
  return measured(value) ? value : 0
}

function gigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** The reading to budget against: MemAvailable where it exists, else free. */
export function usableBytes(input: AgentLaunchMemory): number {
  return measured(input.availableBytes) ? input.availableBytes : bytesOrZero(input.freeBytes)
}

export function agentLaunchPlan(input: AgentLaunchMemory): AgentLaunchPlan {
  const swapTotal = bytesOrZero(input.swapTotalBytes)
  // Windows only. Linux overcommits by default, so a swapless box there is an
  // ordinary configuration rather than a hard commit ceiling, and reserving
  // half of it would keep a 32 GB machine from starting a single agent.
  const pagefileDisabled = input.platform === 'win32' && swapTotal === 0
  const free = usableBytes(input)
  const total = bytesOrZero(input.totalBytes)
  if (total <= 0 || (!measured(input.availableBytes) && !measured(input.freeBytes))) {
    return { availableSlots: null, pagefileDisabled }
  }

  // With no pagefile, Windows' commit limit is the physical RAM and can be
  // nearly exhausted while several gigabytes still look physically free.
  // Keep half the machine untouched in that configuration; it prevents the
  // allocator aborts seen when os.freemem() alone still reported 7+ GB free.
  const reserveRatio = pagefileDisabled ? NO_PAGEFILE_RESERVE_RATIO : SYSTEM_RESERVE_RATIO
  const reserve = Math.max(MIN_SYSTEM_RESERVE_BYTES, total * reserveRatio)
  // A huge pagefile raises the commit limit but does not make heavily swapped
  // agents usable. Count at most half of physical RAM toward launch capacity.
  const swapFree = Math.min(bytesOrZero(input.swapFreeBytes), total * 0.5)
  const allocatable = Math.max(0, free + swapFree - reserve)
  return { availableSlots: Math.floor(allocatable / AGENT_MEMORY_BYTES), pagefileDisabled }
}

/**
 * How many agents may be started, given a hard cap and what memory allows.
 *
 * Unmeasured memory falls back to the cap alone. Treating "unknown" as zero
 * is what silently disabled every launch when the stats IPC was slow or
 * rejected, with the UI showing nothing but a spinner line.
 */
export function agentLaunchCapacity(input: AgentLaunchMemory, hardCap: number): number {
  const slots = agentLaunchPlan(input).availableSlots
  const cap = Math.max(0, hardCap)
  if (slots === null) return cap
  // The budget may refuse a batch, but never the first agent while a whole
  // agent's worth of memory is actually free: the per-agent figure is an
  // estimate off one CLI, and there is no override anywhere in the UI. The
  // warning still appears, so this is the difference between "you are being
  // told this is risky" and "the feature is gone".
  const floor = usableBytes(input) >= AGENT_MEMORY_BYTES ? 1 : 0
  return Math.min(cap, Math.max(floor, slots))
}

export function launchMemoryWarning(input: AgentLaunchMemory, requested: number): string | null {
  if (requested <= 0) return null
  const plan = agentLaunchPlan(input)
  if (plan.availableSlots === null || requested <= plan.availableSlots) return null

  const capacity = plan.availableSlots > 0
    ? `You can start ${plan.availableSlots} more agent${plan.availableSlots === 1 ? '' : 's'} safely.`
    : 'There is not enough memory to start another agent safely.'
  const pagefile = plan.pagefileDisabled
    ? ' The Windows pagefile is disabled; enabling it also increases the commit limit.'
    : ''
  return `Only ${gigabytes(usableBytes(input))} RAM is free. ${capacity} Close other applications or reduce the agent count.${pagefile}`
}
