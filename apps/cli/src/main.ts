#!/usr/bin/env node
/** The `rooster` command line (docs/spec/07-cli.md). */
import { nodeIo } from './io.ts';
import { runCli } from './run.ts';

const code = await runCli(process.argv.slice(2), nodeIo());
process.exitCode = code;
