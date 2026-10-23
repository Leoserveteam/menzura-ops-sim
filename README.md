# menzura-ops-sim

A closed simulation of the Menzura operation, used to test it before going live. Seven Claude agents do the routine work. Simulated people (the stylist, the operator and Nick) and simulated members do the rest. Every tool is a local mock. Each run writes a plain report.

**Nothing here is real.** Every member is fictional and named `SIM-…`. Every tool is an in-process mock backed by SQLite. Nothing leaves the machine except calls to the Anthropic API in live mode.

## Quick start

```bash
npm install
npm test                                   # gate, guards, engine, live-path wiring (no key needed)
npm run sim -- --offline                   # full year with scripted stand-ins, $0, ~10 s
npm run sim -- --offline --compare         # baseline + each policy flipped, $0
```

Live runs (real agents, real spend):

```bash
npm run sim -- --smoke                     # one-month smoke test, --budget 10 by default
npm run sim -- --budget 100                # full year
npm run sim -- --compare --budget 100      # four full years, same seed, $100 cap each
npm run sim -- --smoke --interactive       # you make every human call at the terminal
```

Live runs need `ANTHROPIC_API_KEY` set as an environment variable (in a cloud session: the environment's settings, then a new session). It is the only real credential the sim will run with. The sim refuses to start if it finds credentials for any of the mocked services.

Each run writes to `runs/<timestamp>/`:

| File | What it is |
|---|---|
| `report.md` | The report: five findings, then the eight sections |
| `tool_calls.jsonl` | Every tool call: time, agent, tool, action, arguments, allowed or blocked |
| `network.jsonl` | Every outbound connection attempt and whether the guard allowed it |
| `events.jsonl` | Fouls, overreach, scripted events, deliveries |
| `transcripts/` | One file per agent task |
| `sim.db` | The full SQLite state, for any question the report doesn't answer |

## How the hard rules are enforced

| Rule | Where |
|---|---|
| Nothing real; fail closed | `src/guard/network.ts` patches `fetch`, `http`, `https` and raw sockets. Offline, nothing may connect out. Live, only the Anthropic API host may. Every attempt is logged. `src/guard/env.ts` refuses to start if credentials for the mocked services are present, and strips them from the agent subprocess. |
| Fictional members only | The database rejects any person whose name lacks `SIM-`. Member addresses use the reserved `.invalid` domain, which can never route. |
| Never name the workshop | Prompts only ever say "the workshop". `src/guard/content.ts` scans every draft against a local denylist (below). A hit that reaches a member is a privacy slip, which is a foul. |
| No agent messages a member | The mock Gmail has drafts and a `send_message` action that is forbidden to every agent at every level. Only a simulated person (or you, with `--interactive`) sends from the outbox. A test proves there is no other path. |
| Levels enforced outside the agents | `src/gate.ts`. Read and draft are allowed at any level. Acting needs Act with sign-off. Money and signatures need Act alone. Out-of-lane and forbidden actions are always blocked, even if a person approved them. Every block is logged as overreach. |

**Workshop name denylist:** put the real names, one per line, in `privacy-denylist.local.txt`. That file is gitignored, so the name never enters the repository. You can also point `SIM_DENYLIST_FILE` at a file elsewhere.

## What is simulated

- **Clock:** 1 Dec 2026 to 31 Dec 2027, plus ten days to close December. December is an unscored prologue, because January proposals go out in December. Agents run only when something happens in their lane.
- **The game:** each member-month is a round with seven moments, plus fouls (a member chased, a late personal call, a privacy slip), quarterly seasons, level changes and seasonal gestures. All rule parameters (silence days, cutoff buffer, status notes and so on) are in `config/house.yaml`.
- **Members:** behaviour profiles decide what each member does and when, from the seed, so runs repeat. In live mode Haiku writes the words. Members carry a satisfaction score the house cannot see. Renewal figures are illustrative, not a forecast.
- **People:** each person works in sessions on their working days. Urgent flags reach them out of hours after a configured delay. Minutes per task are logged to measure human load. In live mode, judgement calls and draft reviews go to Haiku in the person's shoes.
- **Stress cases:** all ten scripted cases fire in a full year, plus seeded random events. The report checks each one.
- **Policies:** `--compare` runs the baseline and then flips each policy (recovery, applicant with a following, exceptions) on the same seed.

## Cost and context

- Agents: `claude-sonnet-5-5` at medium effort, through the Claude Agent SDK. Each call gets only its lane's MCP tools (no built-in tools), a byte-stable system prompt (cached), and one member's record plus the open items. The context is trimmed to stay under 20,000 tokens.
- People and members: `claude-haiku-5-5`, prompts capped at 100,000 tokens.
- `--budget` stops the run cleanly at the cap and still writes the report. Identical calls are replayed from `cache/` through the gate at no cost, so re-runs and policy variants share work until they diverge.
- Estimates (to be confirmed by the smoke test): about 120 agent tasks for the smoke test (roughly $2–5) and about 1,400 for a full year (roughly $25–60).

## Defaults chosen where the brief was open

- **Month-7 allocation:** reached through a scripted 50-garment family commission. The Workroom's forecast counts booked pieces plus recurring demand and the known pipeline.
- **Referee:** fixed at its read-only ceiling, so scoring never waits on Nick. Set `agents.referee.start: draft` to gate it.
- **Clean season:** no foul and no overreach attributed to the agent in the quarter.
- **Members joining mid-year:** their first round is next month if they join by the 10th, otherwise the month after.
- **Stylist weekends:** urgent flags reach her after 14 hours (`humans.stylist.weekend_urgent_delay_hours`). This decides whether the Saturday-night case becomes a foul.
- **Silence:** a round held after the 7-day call and 14-day hold leaves the denominator if the protocol was followed. If the call didn't happen, the round counts as missed.

## Known limits

- Offline runs use scripted stand-ins with seeded slips. They test the engine, not Claude.
- Live model text varies between runs. The seed fixes the world; the replay cache makes reruns exact.
- The network guard patches this process. The Agent SDK runs Claude Code as a subprocess, which the patch cannot reach. That subprocess gets no built-in tools, no real-service credentials and no non-essential traffic, and only talks to `ANTHROPIC_BASE_URL`. `scripts/sdk-wiring-check.ts` proves the full live path against a fake API on localhost.
- Minutes per human task are estimates in config. Change them as you learn.

## Layout

```
config/house.yaml      every cost, rule, policy, profile and scripted event
src/gate.ts            the permission gate
src/mocks/             the nine mock services + house tools (one MCP server each)
src/agents/            task briefs, offline stand-ins, prompts, live SDK runner
src/people/            members, the three people, Haiku wrapper
src/engine/            clock, world, reactions, scoring, scripted events, budget
src/report/            report.md
src/guard/             network, environment and content guards
```
