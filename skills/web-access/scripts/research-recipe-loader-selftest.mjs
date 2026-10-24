import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createFixedRecipeLoader, getFixedResearchReadFunction} from './research-recipe-loader.mjs';

const names = ['weibo-feed','bilibili-dynamic','bilibili-video','douyin-posts','xiaohongshu-notes','generic-posts'];
const moduleFor = version => ({RESEARCH_DOM_RECIPES:names,
  buildResearchReadFunctionDeclaration:name=>`function() { return (${JSON.stringify({version,name})}); }`});
let source = 'v1';
let loads = 0;
let mode = 'normal';
const loader = createFixedRecipeLoader({readSource:async()=>source,loadModule:async()=>{
  loads++;
  if(mode==='syntax-error') throw new SyntaxError('broken source');
  if(mode==='racing-write') source='changed-mid-load';
  if(mode==='bad-registry') return {...moduleFor(source),RESEARCH_DOM_RECIPES:[...names,'caller-code']};
  return moduleFor(source);
}});
for (const bad of ['document.cookie','article','__proto__','toString',{},null]) {
  await assert.rejects(loader(bad),{code:'invalid_research_recipe'});
}
assert.equal(loads,0);
const first = await Promise.all([loader('bilibili-dynamic'),loader('weibo-feed')]);
assert.equal(loads,1);
assert.equal(first[0].revision,createHash('sha256').update('v1').digest('hex'));
source='v2';
assert.ok((await loader('bilibili-dynamic')).declaration.includes('v2'));
assert.equal(loads,2);
source='broken'; mode='syntax-error';
await assert.rejects(loader('bilibili-dynamic'),SyntaxError);
source='v3'; mode='normal';
assert.ok((await loader('bilibili-dynamic')).declaration.includes('v3'));
source='v4'; mode='racing-write';
await assert.rejects(loader('bilibili-dynamic'),/changed during loading/);
source='v5'; mode='bad-registry';
await assert.rejects(loader('bilibili-dynamic'),/contract changed/);
source='v6'; mode='normal';
assert.ok((await loader('bilibili-dynamic')).declaration.includes('v6'));
const real = await getFixedResearchReadFunction('bilibili-dynamic');
assert.match(real.revision,/^[a-f0-9]{64}$/);
assert.ok(real.declaration.includes('.bili-dyn-content__orig.reference'));
console.log('PASS fixed-path loading, cache/concurrency, updated revision, syntax/race/registry rejection, recovery and real module; no browser or network used');
