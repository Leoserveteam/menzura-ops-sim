import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolCallRecord {
  time: string;      // sim time
  wall: string;      // real time
  agent: string;     // agent or person acting
  tool: string;
  action: string;
  arguments: unknown;
  outcome: 'allowed' | 'blocked';
  reason?: string;
  via?: 'agent' | 'approval' | 'human' | 'replay';
}

/** Append-only JSONL logs for one run. */
export class RunLog {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
  }
  private append(file: string, obj: unknown): void {
    appendFileSync(join(this.dir, file), JSON.stringify(obj) + '\n');
  }
  toolCall(rec: ToolCallRecord): void {
    this.append('tool_calls.jsonl', rec);
  }
  network(obj: unknown): void {
    this.append('network.jsonl', obj);
  }
  event(obj: unknown): void {
    this.append('events.jsonl', obj);
  }
  transcript(name: string, text: string): string {
    const path = join('transcripts', `${name}.md`);
    writeFileSync(join(this.dir, path), text);
    return path;
  }
  file(name: string, text: string): void {
    writeFileSync(join(this.dir, name), text);
  }
}
