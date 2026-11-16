#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 12)) {
  console.error('MusicDL requires Node.js 24.12 or newer.');
  process.exitCode = 1;
} else {
  try {
    const { main } = await import('../dist/cli.js');
    await main();
  } catch (error) {
    console.error(
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'MusicDL is not built. Run pnpm install and pnpm build in the project directory.'
        : `MusicDL: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
