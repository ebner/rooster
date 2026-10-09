import type { Io } from '../io.ts';
import type { Globals } from '../runtime.ts';
import { type ColorLevel, clean, colorLevel, paint, type Style } from './color.ts';
import { styles } from './theme.ts';

/** Where commands print: stdout for results, stderr for notices and errors. */
export class Output {
  readonly level: ColorLevel;
  readonly errLevel: ColorLevel;

  constructor(
    private readonly io: Io,
    private readonly globals: Pick<Globals, 'json' | 'quiet' | 'noColor'>,
  ) {
    const noColor = globals.noColor || globals.json;
    this.level = colorLevel(io.env, io.stdout.isTTY === true, noColor);
    this.errLevel = colorLevel(io.env, io.stderr.isTTY === true, globals.noColor);
  }

  get json(): boolean {
    return this.globals.json;
  }

  get quiet(): boolean {
    return this.globals.quiet;
  }

  /** Terminal width for truncation; null when stdout is not a terminal (never truncate). */
  get columns(): number | null {
    return this.io.stdout.isTTY === true ? (this.io.stdout.columns ?? 80) : null;
  }

  paint(text: string, style: Style): string {
    return paint(text, style, this.level);
  }

  line(text = ''): void {
    this.io.stdout.write(`${text}\n`);
  }

  /** `--json`: pretty JSON on stdout. */
  data(value: unknown): void {
    this.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  /** A human message on stderr (never mixed into piped results), muted by `--quiet`. */
  notice(text: string): void {
    if (this.globals.quiet) return;
    this.io.stderr.write(`${clean(text)}\n`);
  }

  /** A warning on stderr, also with `--quiet`. */
  warn(text: string): void {
    this.io.stderr.write(`${paint('rooster:', styles.warning, this.errLevel)} ${clean(text)}\n`);
  }

  error(text: string): void {
    this.io.stderr.write(`${paint('rooster:', styles.danger, this.errLevel)} ${clean(text)}\n`);
  }
}
