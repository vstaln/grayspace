import type { Dispatch, OrcTask, Run } from './types.ts'















export function buildPreamble(input: { run: Run; task: OrcTask; dispatchId: string; agent: string }): string {
  const { run, task, dispatchId } = input
  return [
    '--- ORCSPACE DISPATCH ---',
    `You are a worker in OrcSpace run ${run.id}.`,
    `Objective of the run: ${run.objective}`,
    '',
    `Your task: ${task.id}`,
    `Your dispatch: ${dispatchId}`,
    `Worker route: ${input.agent}`,
    '',
    'SPEC:',
    task.spec,
    '',
    'WORK RULES — keep this dispatch bounded:',
    '  • Read the relevant local instructions and inspect the current state before editing.',
    '  • Stay inside the scope and ownership in SPEC; do not rewrite unrelated files or',
    '    create competing dispatches. Preserve edits made by other workers.',
    '  • Meet every acceptance criterion and run the listed verification before reporting.',
    '  • If the spec is missing acceptance or verification details, use the smallest safe',
    '    check and state the gap in your report; do not expand the task silently.',
    '  • Never put credentials, tokens, or private environment values in messages or files.',
    '',
    'CONTRACT — you talk to the coordinator by running shell commands:',
    '',
    '  • Stuck, or the spec is wrong? Ask and wait for the answer:',
    `      orc ask --question "..." --task-id ${task.id} --dispatch-id ${dispatchId} --json`,
    '    It blocks until the coordinator replies, then prints the reply.',
    '',
    '  • Need a human/coordinator decision before you can continue?',
    `      orc escalate --body "..." --task-id ${task.id} --dispatch-id ${dispatchId} --json`,
    '',
    '  • Need explicit safety permission? Ask immediately and wait — do not silently',
    '    continue or forget the request:',
    `      orc ask --type permission --question "..." --task-id ${task.id} --dispatch-id ${dispatchId} --json`,
    '    The request stays visible until the human answers it.',
    '',
    '  • Long job? Say you are alive every few minutes:',
    `      orc heartbeat --task-id ${task.id} --dispatch-id ${dispatchId} --json`,
    '',
    '  • When finished — EXACTLY ONCE, and always, even on failure:',
    `      orc done --outcome succeeded --task-id ${task.id} --dispatch-id ${dispatchId} \\`,
    '          --body "what you changed and anything the coordinator must know" \\',
    '          --files "path/one.ts,path/two.ts" --json',
    '    Use --outcome failed if you could not do it. A coordinator is blocked',
    '    waiting on this message; if you never send it, the run stalls.',
    '    Include changed files and concrete verification evidence in the body.',
    '',
    'You also have the rest of the app: orc canvas, orc plan,',
    'orc plan, orc terminal, orc git. Run `orc --help` for the full surface.',
    '--- END DISPATCH ---',
    '',
    'Begin now.'
  ].join('\n')
}


export function dispatchSummary(dispatch: Dispatch, task: OrcTask): string {
  return `${task.id} → ${dispatch.terminalId} (${dispatch.agent})\n\n${task.spec}`
}
