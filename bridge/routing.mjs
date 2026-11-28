import { readFile } from 'node:fs/promises';
import { writeJson } from './config.mjs';

export function validBrowserId(id) {
  return typeof id === 'string' && /^[a-z0-9._-]{1,100}$/i.test(id);
}

export async function openRouting(file) {
  let saved;
  if (file) {
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let browsers = new Map((saved?.browsers || []).filter(item => validBrowserId(item?.id)).map(item => [item.id, item]));
  let assignments = new Map(Object.entries(saved?.assignments || {}).filter(([, id]) => browsers.has(id)));
  const revisions = new Map();
  let lock = Promise.resolve();
  function update(operation) {
    const task = lock.then(operation);
    lock = task.catch(() => {});
    return task;
  }
  async function save(nextBrowsers, nextAssignments) {
    if (file) await writeJson(file, { browsers: [...nextBrowsers.values()], assignments: Object.fromEntries(nextAssignments) });
    browsers = nextBrowsers;
    assignments = nextAssignments;
  }
  return {
    list: () => [...browsers.values()],
    assigned: id => assignments.get(id) ?? null,
    effective: id => assignments.get(id) ?? (browsers.size === 1 ? browsers.keys().next().value : null),
    revision: id => revisions.get(id) ?? 0,
    remember: (id, name) => update(async () => {
      const cleaned = typeof name === 'string' ? name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) : '';
      if (browsers.has(id) && (!cleaned || browsers.get(id).name === cleaned)) return;
      const next = new Map(browsers).set(id, { id, name: cleaned || '浏览器' });
      await save(next, assignments);
    }),
    assign: (id, browserId) => update(async () => {
      if (browserId !== null && !browsers.has(browserId)) {
        throw Object.assign(new Error('找不到该浏览器，请用配对码连接后再选择。'), { code: 'BROWSER_UNKNOWN', status: 404 });
      }
      if ((assignments.get(id) ?? null) === browserId) return;
      const next = new Map(assignments);
      if (browserId === null) next.delete(id);
      else next.set(id, browserId);
      await save(browsers, next);
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
    })
  };
}
