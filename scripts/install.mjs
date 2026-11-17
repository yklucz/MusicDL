#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './installer/core.mjs';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'MusicDL installer: [--check | --dry-run] [--no-system]\n--check/--dry-run verify installed prerequisites and doctor without installing or editing PATH. Missing prerequisites exit nonzero.\n--no-system forbids system package-manager changes; isolated project tools may still be acquired.\nMUSICDL_BIN_DIR overrides the launcher directory. Reopen your terminal after bash installation.',
  );
} else if (args.some((arg) => !['--check', '--dry-run', '--no-system'].includes(arg))) {
  console.error('Unknown installer option. Use --help.');
  process.exitCode = 2;
} else {
  try {
    await install({
      root: fileURLToPath(new URL('..', import.meta.url)),
      mode: args.includes('--check') || args.includes('--dry-run') ? 'check' : 'install',
      noSystem: args.includes('--no-system'),
    });
  } catch (error) {
    console.error(
      `MusicDL installation failed: ${error.message}\nNo success has been recorded. Fix the reported prerequisite and rerun the same command.\nHelp: ${path.join(fileURLToPath(new URL('..', import.meta.url)), 'README.md')}\nExisting settings, library, audio and history are retained.`,
    );
    process.exitCode = 1;
  }
}
