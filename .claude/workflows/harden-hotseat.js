export const meta = {
  name: 'harden-hotseat',
  description: 'Play the pond-rush hot-seat page in a real browser, then fix what breaks',
  phases: [
    { title: 'Plan', detail: 'read the UI layers, enumerate play scenarios' },
    { title: 'Play', detail: 'drive Chrome through each scenario, one at a time' },
    { title: 'Fix', detail: 'apply fixes for confirmed defects' },
    { title: 'Re-test', detail: 'replay the failing scenarios in the browser' },
  ],
}

const APP = 'http://127.0.0.1:8000/'
const REPO = '/home/ghollisjr/myprogs/pond-rush'

const SCENARIO_SCHEMA = {
  type: 'object',
  required: ['scenarios'],
  properties: {
    scenarios: {
      type: 'array',
      minItems: 4,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'goal', 'steps', 'expected'],
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          setup: { type: 'string', description: 'variant + seed to enter on the page' },
          steps: { type: 'array', items: { type: 'string' } },
          expected: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const DEFECT_SCHEMA = {
  type: 'object',
  required: ['scenarioId', 'completed', 'defects'],
  properties: {
    scenarioId: { type: 'string' },
    completed: { type: 'boolean', description: 'did the scenario run to the end' },
    notes: { type: 'string' },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'repro', 'observed', 'expected', 'severity'],
        properties: {
          title: { type: 'string' },
          repro: { type: 'string', description: 'exact clicks/values from a fresh page load' },
          observed: { type: 'string' },
          expected: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'cosmetic'] },
          consoleErrors: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['fixed', 'skipped', 'testsPass'],
  properties: {
    fixed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'change'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          change: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'why'],
        properties: { title: { type: 'string' }, why: { type: 'string' } },
      },
    },
    testsPass: { type: 'boolean' },
    testOutput: { type: 'string' },
  },
}

const CONTEXT = `
Project: ${REPO} — a theme-agnostic board game. Read ${REPO}/CLAUDE.md first; its
invariants are binding.

The hot-seat page is served at ${APP} by an esbuild dev server already running in
watch mode. Any edit under src/ rebuilds automatically; a page reload picks it up.

The browser layers:
  src/renderer.ts  layout()  pure: BoardView + Theme -> display list (pixels)
  src/renderer.ts  paint()   the only DOM code; syncs a container to a scene
  src/ui/hotseat.ts          what a click means. Pure, no DOM
  src/ui/main.ts             holds GameState + Selection, wires the buttons
  web/index.html             the page shell

How play works, so you can tell a bug from the rules:
  - Press Roll. The die face decides what you may do this turn.
  - "Move"/"Leap" faces: your movable pieces get a DASHED yellow ring. Click one
    (it goes to a SOLID ring), then click one of the lit destination cells.
  - Leap faces can chain: each landing may offer more landings. A "Stop here (n)"
    button appears while the chain can continue; a dead end commits immediately.
  - "Hazard" faces: no piece selection — every legal cell lights up at once.
  - Pass and Undo are legal at essentially all times; that is correct, not a bug.
  - Everything renders as flat colour blocks. The bundled pack has a manifest but
    no art files, so the palette fallback is doing the work. That is by design.
`

phase('Plan')

const plan = await agent(
  `${CONTEXT}

You are planning a browser test pass for this page. Read src/ui/main.ts,
src/ui/hotseat.ts, src/renderer.ts and web/index.html — and test/*.test.ts, so you
do NOT re-test what is already covered headlessly. The value here is the DOM and
wiring: things only a real browser can show.

Produce 4-6 concrete scenarios that a tester will run one at a time in Chrome.
Prioritise, in this order:
  1. A full turn on the default page (standard-4p, seed 1) — this is the path the
     user hit; it must be flawless.
  2. A leap CHAIN: build a multi-hop chain, confirm "Stop here" appears and works.
  3. The hazard face: cells light up with nothing selected; placing one removes a
     piece and the score/HUD updates.
  4. Undo, across a turn boundary, and the variant picker + seed box restarting a
     game cleanly.
  5. A game played to completion on a small variant (standard-2p) — the HUD must
     announce a winner and the board must stop accepting moves.
  6. Theme fallback: the picker with no pack chosen, and the page at a different
     tile size if you can reach one.

Each scenario needs steps precise enough to replay from a fresh load: which
variant, which seed, which cells to click (give grid coordinates AND roughly where
they sit on screen). Note the expected observable outcome of each step.`,
  { schema: SCENARIO_SCHEMA, label: 'plan:scenarios', phase: 'Plan' }
)

log(`${plan.scenarios.length} scenarios to play`)

// Browser work is strictly serial: these agents share one Chrome, and two of
// them clicking at once would corrupt each other's runs.
phase('Play')

const reports = []
for (const sc of plan.scenarios) {
  const r = await agent(
    `${CONTEXT}

Use the claude-in-chrome tools to ACTUALLY DRIVE the browser. Load the skill first
(Skill tool, "claude-in-chrome"), then find the browser tools with ToolSearch.
Do not guess at behaviour and do not reason about it from the source: click, look,
and report what you SAW. Take screenshots and read the console.

Scenario "${sc.id}": ${sc.goal}
Setup: ${sc.setup ?? 'default page state'}
Steps:
${sc.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
Expected:
${sc.expected.map((s) => `  - ${s}`).join('\n')}

Start from a fresh load of ${APP} every time. Check the browser console for errors
at the start and after each interaction.

Report defects only for things you observed going wrong. Re-read the "How play
works" notes above before calling something a bug — correct game rules that merely
feel odd are NOT defects. For each defect give a repro precise enough that someone
else can reproduce it from a fresh page load in under a minute.

If the page is unreachable or Chrome tools are unavailable, say so plainly with
completed=false rather than inventing results.`,
    { schema: DEFECT_SCHEMA, label: `play:${sc.id}`, phase: 'Play' }
  )
  if (r) {
    reports.push(r)
    const n = r.defects?.length ?? 0
    log(`${sc.id}: ${r.completed ? 'ran' : 'DID NOT COMPLETE'}, ${n} defect(s)`)
  }
}

const defects = reports.flatMap((r) => (r.defects ?? []).map((d) => ({ ...d, from: r.scenarioId })))
const blocked = reports.filter((r) => !r.completed).map((r) => r.scenarioId)

if (!defects.length) {
  log('no defects found in the browser')
  return {
    verdict: blocked.length ? 'incomplete' : 'clean',
    scenariosRun: reports.length,
    blocked,
    defects: [],
    fix: null,
  }
}

const RANK = { blocker: 0, major: 1, minor: 2, cosmetic: 3 }
defects.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
log(`${defects.length} defect(s) to fix`)

phase('Fix')

const fix = await agent(
  `${CONTEXT}

A browser test pass found these defects, worst first. Fix them in the working tree.

${defects
  .map(
    (d, i) => `${i + 1}. [${d.severity}] ${d.title}   (from scenario ${d.from})
   repro:    ${d.repro}
   observed: ${d.observed}
   expected: ${d.expected}
   console:  ${(d.consoleErrors ?? []).join(' | ') || 'none reported'}`
  )
  .join('\n\n')}

Rules for the fix:
  - Respect every invariant in CLAUDE.md. In particular: no theme vocabulary in the
    engine, the engine stays pure, positions are grid coordinates and only the
    renderer multiplies by tileSize.
  - Fix at the right layer. A wrong destination is a hotseat.ts bug; a
    wrongly-drawn one is a renderer bug; a stale HUD is main.ts. Do not paper over
    a logic bug in the DOM layer.
  - Add or extend a test in test/ for each defect whose cause sits in a pure layer
    (layout, hotseat, paint-via-shim). Match the existing style: node:test plus the
    local expect shim, zero dependencies.
  - Verify: run "npm test" and "npx tsc --noEmit" in ${REPO}. Both must be clean.
  - If a reported defect turns out to be correct behaviour, do NOT change the code
    — put it in "skipped" with the reasoning.

Report the test output verbatim in testOutput.`,
  { schema: FIX_SCHEMA, label: 'fix:defects', phase: 'Fix' }
)

phase('Re-test')

const failedScenarios = [...new Set(defects.map((d) => d.from))]
const recheck = await agent(
  `${CONTEXT}

Fixes have just landed for these defects:
${(fix?.fixed ?? []).map((f) => `  - ${f.title}  (${f.file}: ${f.change})`).join('\n') || '  (none applied)'}

Replay the scenarios that failed — ${failedScenarios.join(', ')} — in Chrome against
a freshly reloaded ${APP}. The dev server rebuilds on save, so a hard reload is
enough; confirm you are on the new bundle before judging anything.

For each previously reported defect, state whether it is now GONE or STILL PRESENT.
Also watch for regressions the fixes may have introduced elsewhere on the page.

Original defects:
${defects.map((d, i) => `  ${i + 1}. [${d.severity}] ${d.title} — repro: ${d.repro}`).join('\n')}`,
  { schema: DEFECT_SCHEMA, label: 're-test', phase: 'Re-test' }
)

return {
  verdict: (recheck?.defects?.length ?? 0) === 0 ? 'fixed' : 'defects remain',
  scenariosRun: reports.length,
  blocked,
  defectsFound: defects,
  fix,
  recheck,
}
