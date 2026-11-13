import { prepareDataDirectory } from '../bridge/paths.mjs';
try {
  const at = process.argv.indexOf('--select');
  if (at >= 0 && !process.argv[at + 1]) throw new Error('请提供数据目录。');
  console.log(JSON.stringify(prepareDataDirectory(at >= 0 ? { selected: process.argv[at + 1] } : {})));
} catch (error) { console.error(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1; }
