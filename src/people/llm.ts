import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sim } from '../engine/sim.ts';

/** Words and judgements for simulated members and people. */
export interface PeopleLlm {
  write(who: string, system: string, prompt: string, fallback: string): Promise<string>;
  judge<T extends object>(who: string, system: string, prompt: string, fallback: T): Promise<T>;
}

/** Offline: no model, the fallback text is used. */
export class OfflinePeople implements PeopleLlm {
  async write(_who: string, _s: string, _p: string, fallback: string): Promise<string> {
    return fallback;
  }
  async judge<T extends object>(_who: string, _s: string, _p: string, fallback: T): Promise<T> {
    return fallback;
  }
}

const estTokens = (s: string) => Math.ceil(s.length / 3.5);

/**
 * Live: Claude Haiku via the Anthropic SDK. Every call is checked against the
 * budget first, kept under the prompt cap, cached on disk by prompt hash (so a
 * re-run or a policy variant replays identical calls for free), and costed.
 */
export class HaikuPeople implements PeopleLlm {
  private client = new Anthropic();
  private dir: string;

  constructor(private sim: Sim, cacheDir: string) {
    this.dir = join(cacheDir, 'people');
    mkdirSync(this.dir, { recursive: true });
  }

  private async complete(who: string, system: string, prompt: string, maxTokens: number): Promise<string | null> {
    const { cfg, budget } = this.sim.ctx;
    const model = cfg.models.people;
    const cap = cfg.limits.people_prompt_max_tokens;
    let user = prompt;
    if (estTokens(system) + estTokens(user) > cap) user = user.slice(0, Math.max(0, (cap - estTokens(system)) * 3.5 - 100));
    const key = createHash('sha256').update(JSON.stringify([model, system, user, maxTokens])).digest('hex');
    const file = join(this.dir, `${key}.json`);
    if (existsSync(file)) {
      budget.record(model, 0, `people:${who}`, {}, true);
      return JSON.parse(readFileSync(file, 'utf8')).text;
    }
    budget.ensure(0.001);
    try {
      const res = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { effort: cfg.models.people_effort },
      } as any);
      const text = (res.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const u = res.usage as any;
      const price = cfg.models.pricing_usd_per_mtok[model];
      const usd =
        ((u.input_tokens ?? 0) * price.input +
          (u.output_tokens ?? 0) * price.output +
          (u.cache_read_input_tokens ?? 0) * price.cache_read +
          (u.cache_creation_input_tokens ?? 0) * price.cache_write) / 1e6;
      budget.record(model, usd, `people:${who}`, { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens });
      writeFileSync(file, JSON.stringify({ text }));
      return text;
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        this.sim.logEvent('people_llm_error', { status: e.status, message: e.message.slice(0, 200) });
        return null;
      }
      throw e;
    }
  }

  async write(who: string, system: string, prompt: string, fallback: string): Promise<string> {
    const t = await this.complete(who, system, prompt, this.sim.ctx.cfg.limits.people_max_output_tokens);
    return t || fallback;
  }

  async judge<T extends object>(who: string, system: string, prompt: string, fallback: T): Promise<T> {
    const t = await this.complete(who, system, `${prompt}\nReply with the JSON object only.`, 200);
    if (!t) return fallback;
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    try {
      return { ...fallback, ...JSON.parse(m[0]) };
    } catch {
      return fallback;
    }
  }
}
