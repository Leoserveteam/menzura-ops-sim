import { existsSync, readFileSync } from 'node:fs';

/**
 * Content guard: scans anything an agent writes before it can leave the house.
 * - Real names on the local denylist (the workshop must only ever be "the workshop").
 * - Another member's name in a message addressed to a member (privacy slip).
 * - An address outside the sim's reserved domain.
 */
export interface ContentIssue {
  kind: 'denylisted_name' | 'other_member_named' | 'real_address' | 'missing_sim_prefix';
  detail: string;
}

export class ContentGuard {
  private denylist: string[];

  constructor(denylistFile?: string, private memberDomain = 'example.invalid') {
    const path = process.env.SIM_DENYLIST_FILE || denylistFile;
    this.denylist =
      path && existsSync(path)
        ? readFileSync(path, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
        : [];
  }

  get denylistSize(): number {
    return this.denylist.length;
  }

  addDenylisted(name: string): void {
    this.denylist.push(name);
  }

  scan(text: string, opts: { toMemberId?: string; members?: { id: string; name: string }[]; addresses?: string[] } = {}): ContentIssue[] {
    const issues: ContentIssue[] = [];
    const lower = text.toLowerCase();
    for (const name of this.denylist) {
      if (lower.includes(name.toLowerCase())) issues.push({ kind: 'denylisted_name', detail: 'a denylisted real name appears' });
    }
    if (opts.toMemberId && opts.members) {
      for (const m of opts.members) {
        if (m.id === opts.toMemberId) continue;
        const bare = m.name.replace(/^SIM-/, '');
        const surname = bare.split(' ').slice(-1)[0];
        if (text.includes(m.name) || text.includes(bare) || (surname.length > 3 && new RegExp(`\\b${escapeRe(surname)}\\b`).test(text) && text.includes(bare.split(' ')[0]))) {
          issues.push({ kind: 'other_member_named', detail: `names another member (${m.id})` });
        }
      }
    }
    for (const a of opts.addresses ?? []) {
      if (!a.toLowerCase().endsWith(`@${this.memberDomain}`) && !a.toLowerCase().endsWith('@house.invalid')) {
        issues.push({ kind: 'real_address', detail: `address outside the sim domains: ${a}` });
      }
    }
    return issues;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
