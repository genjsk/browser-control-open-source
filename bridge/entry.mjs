import { prepareDataDirectory } from './paths.mjs';
try {
  process.env.BROWSER_CONTROL_DATA_DIR = prepareDataDirectory().dataDir;
  await import('./mcp.mjs');
} catch (error) { console.error(error.message); process.exitCode = 1; }
