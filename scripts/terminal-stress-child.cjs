// Isolated workload used by terminalStress.test.ts; never launches an agent.
console.log(`ORC_STRESS_PID=${process.pid}`)
const mode = process.argv[2]
if (mode === 'quiet') {
  setInterval(() => {}, 1000)
} else {
  const payload = 'я🌍世界'.repeat(2048) + '\r\n'
  let count = 0
  const pump = () => {
    if (mode === 'unicode' && count++ >= 100) {
      console.log('ORC_STRESS_DONE')
      return
    }
    if (process.stdout.write(payload)) setTimeout(pump, 5)
    else process.stdout.once('drain', () => setTimeout(pump, 5))
  }
  pump()
}
