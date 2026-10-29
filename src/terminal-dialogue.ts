import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { Problem, Exit, terminalText } from './outcomes.js';
export class Dialogue {
  private reader: Interface | undefined;
  private readonly lines: string[] = [];
  private waiting: ((value: string | null) => void) | undefined;
  private ended = false;
  private interrupted = false;
  private readonly interrupt = () => {
    this.interrupted = true;
    this.reader?.close();
  };
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly tty: boolean,
  ) {
  }
  private initialize(): void {
    if (this.reader) {
      return;
    }
    this.reader = createInterface({ input: this.input, terminal: false, crlfDelay: Infinity });
    this.reader.on('line', line => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    this.reader.on('close', () => {
      this.ended = true;
      this.waiting?.(null);
      this.waiting = undefined;
    });
    this.reader.on('SIGINT', this.interrupt);
    process.on('SIGINT', this.interrupt);
  }
  close(): void {
    this.reader?.close();
    process.off('SIGINT', this.interrupt);
  }
  async line(prompt: string): Promise<string | null> {
    if (!this.tty) {
      throw new Problem('input-required', 'This action needs input from a terminal.', Exit.usage);
    }
    this.initialize();
    this.output.write(terminalText(prompt) + ' ');
    let value: string | null;
    if (this.lines.length) {
      value = this.lines.shift()!;
    } else if (this.ended) {
      value = null;
    } else {
      value = await new Promise<string | null>(resolve => {
        this.waiting = resolve;
      });
    }
    if (this.interrupted) {
      throw new Problem('interrupted', 'The action was interrupted.', Exit.interrupted);
    }
    return value;
  }
  async confirm(prompt: string): Promise<boolean> {
    const value = await this.line(`${prompt} [y/N]`);
    return value !== null && /^(y|yes)$/i.test(value.trim());
  }
  async choose(prompt: string, options: readonly string[], multiple = false): Promise<number[]> {
    options.forEach((option, index) => this.output.write(`${index + 1}. ${terminalText(option)}\n`));
    const value = await this.line(`${prompt} (Enter cancels)`);
    if (!value?.trim()) {
      return [];
    }
    const parts = value.trim().split(',').map(part => part.trim());
    const invalid = parts.some(part => !/^[1-9]\d*$/.test(part) || Number(part) > options.length);
    if ((!multiple && parts.length !== 1) || invalid || new Set(parts).size !== parts.length) {
      throw new Problem('choice', 'Choose valid numbered entries.', Exit.usage);
    }
    return parts.map(part => Number(part) - 1);
  }
}
