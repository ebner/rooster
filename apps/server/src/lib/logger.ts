import { type DestinationStream, pino } from 'pino';

export type Logger = pino.Logger;
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** JSON logger on stdout; `destination` lets tests capture the output. */
export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'rooster' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
