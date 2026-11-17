#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { setupTools } from './installer/core.mjs';
try {
  await setupTools({ root: fileURLToPath(new URL('..', import.meta.url)) });
  console.log('Isolated Python 3.13, spotDL 4.6.0 and yt-dlp 2026.10.26 are ready in .tools.');
} catch (error) {
  console.error(
    `Tool setup failed: ${error.message}\nReview https://docs.astral.sh/uv/getting-started/installation/ or rerun bash ./install.sh / .\\install.ps1.`,
  );
  process.exitCode = 1;
}
