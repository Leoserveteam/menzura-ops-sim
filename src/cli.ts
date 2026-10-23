import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, parsePolicies, type HouseConfig, type Policies } from './config.ts';
import { Sim, type RunOutcome } from './engine/sim.ts';
import { OfflineRunner } from './agents/runner.ts';
import { OfflinePeople, HaikuPeople } from './people/llm.ts';
import { buildReport, summarise, type RunSummary } from './report/report.ts';
import { installNetworkGuard, anthropicHosts } from './guard/network.ts';
import { assertCleanEnv } from './guard/env.ts';
import { appendFileSync } from 'node:fs';

const HELP = `menzura-ops-sim: a closed simulation of the Menzura operation

  npm run sim -- --offline                 full year, scripted stand-ins, $0
  npm run sim -- --smoke                   one-month smoke test with real agents (--budget 10)
  npm run sim -- --budget 100              full year with real agents
  npm run sim -- --compare --budget 100    baseline + each policy flipped, same seed

Options
  --offline            no model calls: scripted stand-ins for agents and people
  --smoke              January 2027 only (with the December prologue), budget defaults to $10
  --budget <usd>       stop the run when API spend reaches this (per run)
  --seed <n>           RNG seed (default from config)
  --policy <spec>      e.g. recovery=B,applicant_following=B,exceptions=B
  --compare            run the baseline and each policy variant with the same seed
  --interactive        you make every human call at the terminal
  --end <YYYY-MM-DD>   stop the simulated year early
  --config <path>      config file (default config/house.yaml)
  --out <dir>          runs directory (default runs/)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      offline: { type: 'boolean', default: false },
      smoke: { type: 'boolean', default: false },
      budget: { type: 'string' },
      seed: { type: 'string' },
      policy: { type: 'string' },
      compare: { type: 'boolean', default: false },
      interactive: { type: 'boolean', default: false },
      end: { type: 'string' },
      config: { type: 'string', default: 'config/house.yaml' },
      out: { type: 'string', default: 'runs' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  assertCleanEnv();
  const cfg = loadConfig(values.config);
  const mode: 'offline' | 'live' = values.offline ? 'offline' : 'live';
  if (mode === 'live' && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('Live runs need ANTHROPIC_API_KEY in the environment (see README). Use --offline to test the engine for free.');
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${mode}${values.smoke ? '-smoke' : ''}`;
  const root = join(values.out!, runId);
  mkdirSync(root, { recursive: true });

  // Fail closed: only the Anthropic API may be reached, and only in live mode.
  installNetworkGuard(mode === 'live' ? anthropicHosts() : [], (e) => appendFileSync(join(root, 'network.jsonl'), JSON.stringify(e) + '\n'));

  const budget = Number(values.budget ?? (values.smoke ? 10 : mode === 'offline' ? 0 : 100));
  const seed = Number(values.seed ?? cfg.sim.seed);
  const end = values.end ?? (values.smoke ? '2027-01-31' : undefined);
  const base = parsePolicies(cfg, values.policy);

  const variants: { label: string; policies: Policies }[] = [{ label: 'baseline', policies: base }];
  if (values.compare) {
    for (const k of ['recovery', 'applicant_following', 'exceptions'] as const) {
      variants.push({ label: `${k}=${base[k] === 'A' ? 'B' : 'A'}`, policies: { ...base, [k]: base[k] === 'A' ? 'B' : 'A' } });
    }
  }

  const summaries: RunSummary[] = [];
  let first: { sim: Sim; outcome: RunOutcome } | null = null;
  for (const v of variants) {
    const dir = values.compare ? join(root, v.label) : root;
    mkdirSync(dir, { recursive: true });
    process.stderr.write(`\n▶ ${v.label} (${mode}, seed ${seed}, budget $${budget})\n`);
    const { sim, outcome } = await runOne(cfg, { dir, seed, policies: v.policies, budget, mode, interactive: values.interactive!, end });
    writeFileSync(join(dir, 'report.md'), buildReport(sim, outcome));
    summaries.push(summarise(sim, outcome, v.label));
    first ??= { sim, outcome };
    process.stderr.write(`  ${outcome.completed ? 'completed' : `stopped: ${outcome.stoppedReason}`} · spend $${sim.ctx.budget.spent.toFixed(2)} · report ${join(dir, 'report.md')}\n`);
    if (!outcome.completed && outcome.stoppedReason?.startsWith('Budget')) break;
  }
  if (values.compare && first) {
    writeFileSync(join(root, 'report.md'), buildReport(first.sim, first.outcome, summaries));
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(summaries, null, 2));
    process.stderr.write(`\nComparison report: ${join(root, 'report.md')}\n`);
  }
}

async function runOne(
  cfg: HouseConfig,
  o: { dir: string; seed: number; policies: Policies; budget: number; mode: 'offline' | 'live'; interactive: boolean; end?: string },
): Promise<{ sim: Sim; outcome: RunOutcome }> {
  const cacheDir = 'cache';
  const sim = new Sim({
    cfg,
    runDir: o.dir,
    seed: o.seed,
    policies: o.policies,
    budgetUsd: o.budget,
    mode: o.mode,
    interactive: o.interactive,
    end: o.end,
    runnerFactory: (s) => (o.mode === 'offline' ? new OfflineRunner(s) : liveRunner(s, cacheDir)),
    llmFactory: (s) => (o.mode === 'offline' ? new OfflinePeople() : new HaikuPeople(s, cacheDir)),
  });
  const outcome = await sim.run();
  return { sim, outcome };
}

let liveRunner: (s: Sim, cacheDir: string) => import('./agents/runner.ts').AgentRunner = () => {
  throw new Error('live runner not loaded');
};

const { SdkRunner } = await import('./agents/sdk.ts');
liveRunner = (s, cacheDir) => new SdkRunner(s, cacheDir);

main().catch((e) => {
  const msg = e instanceof Error ? (process.env.SIM_DEBUG ? e.stack ?? e.message : e.message) : String(e);
  process.stderr.write(`\n${msg}\n`);
  process.exit(1);
});
