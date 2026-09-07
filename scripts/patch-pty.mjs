// Patches node-pty on Windows to prevent 5-second hang when killing terminals.
// Usable two ways: `node scripts/patch-pty.mjs` directly (postinstall), or
// imported by native/build.mjs so every native build applies the same patch.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultPackageDir = path.join(root, 'node_modules/@homebridge/node-pty-prebuilt-multiarch')

/** Idempotent: guarded by content markers, safe to run on every build. */
export function patchWindowsPtyAgents(packageDir = defaultPackageDir) {
  if (process.platform !== 'win32') return
  const agentPath = path.join(packageDir, 'lib/conpty_console_list_agent.js')
  const ptyAgentPath = path.join(packageDir, 'lib/windowsPtyAgent.js')

  if (fs.existsSync(agentPath)) {
    let content = fs.readFileSync(agentPath, 'utf8')
    // Guard on the patched marker itself: the file already contains a generic
    // `try {` (the require fallback), so gating on that string skipped the
    // patch forever.
    if (!content.includes('consoleProcessList = [shellPid]') && content.includes('var consoleProcessList = getConsoleProcessList(shellPid);')) {
      content = content.replace(
        'var consoleProcessList = getConsoleProcessList(shellPid);',
        'var consoleProcessList; try { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) { consoleProcessList = [shellPid]; }'
      )
      fs.writeFileSync(agentPath, content, 'utf8')
      console.log('[ok] Patched conpty_console_list_agent.js')
    }
  }

  if (fs.existsSync(ptyAgentPath)) {
    let content = fs.readFileSync(ptyAgentPath, 'utf8')
    if (!content.includes("agent.on('exit'")) {
      content = content.replace(
        "agent.on('message', function (message) {",
        "agent.on('exit', function () { clearTimeout(timeout); resolve([_this._innerPid]); });\n            agent.on('error', function () { clearTimeout(timeout); resolve([_this._innerPid]); });\n            agent.on('message', function (message) {"
      )
      fs.writeFileSync(ptyAgentPath, content, 'utf8')
      console.log('[ok] Patched windowsPtyAgent.js')
    }
  }
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (invokedDirectly) patchWindowsPtyAgents()
