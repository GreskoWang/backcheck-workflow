import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This path and registry are server-owned. No HTTP field can supply a module,
// path, function, selector, revision or source string.
const moduleUrl = new URL('./research-dom-recipes.mjs', import.meta.url);
const registeredRecipes = Object.freeze([
  'weibo-feed', 'bilibili-dynamic', 'bilibili-video',
  'douyin-posts', 'xiaohongshu-notes', 'generic-posts',
]);
const digest = source => createHash('sha256').update(source).digest('hex');

// Dependency injection is used only by local unit tests. Production uses the
// single fixed sibling file, through the default instance below.
export function createFixedRecipeLoader({
  readSource = () => readFile(moduleUrl),
  loadModule = revision => import(`${moduleUrl.href}?revision=${revision}`),
} = {}) {
  let loaded = null;
  let queue = Promise.resolve();
  return function getFixedResearchReadFunction(recipe) {
    if (typeof recipe !== 'string' || !registeredRecipes.includes(recipe)) {
      return Promise.reject(Object.assign(new Error('Unknown fixed recipe'), {code:'invalid_research_recipe'}));
    }
    const operation = queue.then(async () => {
      const revision = digest(await readSource());
      if (loaded?.revision !== revision) {
        const candidate = await loadModule(revision);
        if (digest(await readSource()) !== revision) throw new Error('Recipe file changed during loading');
        if (!Array.isArray(candidate.RESEARCH_DOM_RECIPES)
          || JSON.stringify(candidate.RESEARCH_DOM_RECIPES) !== JSON.stringify(registeredRecipes)
          || typeof candidate.buildResearchReadFunctionDeclaration !== 'function') {
          throw new Error('Fixed recipe module contract changed');
        }
        const declarations = new Map();
        for (const name of registeredRecipes) {
          const declaration = candidate.buildResearchReadFunctionDeclaration(name);
          if (typeof declaration !== 'string' || !declaration.startsWith('function() { return (')) {
            throw new Error('Invalid fixed recipe declaration');
          }
          declarations.set(name, declaration);
        }
        loaded = {revision, declarations};
      }
      return {revision:loaded.revision, declaration:loaded.declarations.get(recipe)};
    });
    // A failed local update rejects this snapshot; it never silently uses the
    // old module, disconnects Edge, changes a lease or prevents a later fix.
    queue = operation.catch(() => {});
    return operation;
  };
}

export const getFixedResearchReadFunction = createFixedRecipeLoader();
