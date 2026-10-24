import assert from 'node:assert/strict';
import test from 'node:test';
import { accountingClient, currentToken } from '../src/accounting-client.mjs';
const args={method:'PUT',url:'/open-apis/sheets/v2/spreadsheets/workbook/values',data:{}};
function fixture(responses){
  let requests=0,refreshes=0,tokens=0,reloads=0;
  const client=accountingClient({sheets:{},request:async()=>({read:true})},'synthetic-app',{
    currentToken:async()=>{tokens++;return 'synthetic-only';},
    runUatCheck:async()=>{refreshes++;},
    reloadAuth:async()=>{reloads++;},
    request:async()=>{const response=responses[requests++];if(response instanceof Error)throw response;return response;},
  });
  return {client,counts:()=>({requests,refreshes,tokens}),reloadCount:()=>reloads};
}
for(const first of [{status:401,data:{}},{status:200,data:{code:99991668}}])test('existing auth retries once after known expiry '+first.status,async()=>{
  const f=fixture([first,{status:200,data:{code:0}}]);assert.equal((await f.client.request(args)).code,0);
  assert.deepEqual(f.counts(),{requests:2,refreshes:1,tokens:2});
  assert.equal(f.reloadCount(),1);
});
test('missing permission never triggers credential refresh',async()=>{
  const f=fixture([{status:403,data:{code:99991679}}]);
  await assert.rejects(f.client.request(args),/HTTP 403/u);assert.equal(f.counts().refreshes,0);
  assert.equal(f.reloadCount(),0);
  const g=fixture([{status:200,data:{code:99991679}}]);assert.equal((await g.client.request(args)).code,99991679);
  assert.equal(g.counts().refreshes,0);
});
test('transport errors and disallowed endpoints contain no request dump',async()=>{
  const error=Object.assign(new Error('Authorization: Bearer synthetic-secret'),{config:{headers:{Authorization:'synthetic-secret'}}});
  const f=fixture([error]);await assert.rejects(f.client.request(args),e=>e.code==='ACCOUNTING_TRANSPORT_FAILED'&&!String(e).includes('synthetic-secret')&&!e.cause);
  await assert.rejects(f.client.request({...args,url:'/open-apis/drive/v1/permissions'}),/allowlisted/u);
  assert.equal(f.counts().requests,1);
});

for (const unit of ['seconds','milliseconds']) test(`a resident provider refreshes expired authorization and reloads the existing cache: ${unit}`,async()=>{
  const now=Date.parse('2026-10-11T10:53:00Z');let token='synthetic-expired',refreshes=0,reloads=0;
  const expiry=(time)=>unit==='seconds'?time/1000:time;
  const store={getLocalAccessToken:async()=>token,
    getToken:async(value)=>({expiresAt:expiry(value==='synthetic-expired'?now-1000:now+7200000)}),
    loadFromStorage:async()=>{reloads++;token='synthetic-refreshed';}};
  const dependencies={store,now:()=>now,runUatCheck:async()=>{refreshes++;}};
  assert.equal(await currentToken('synthetic-app',dependencies),'synthetic-refreshed');
  assert.equal(await currentToken('synthetic-app',dependencies),'synthetic-refreshed');
  assert.equal(refreshes,1);assert.equal(reloads,1);
});
test('an unconfirmed refresh never sends a write with the expired authorization',async()=>{
  const now=Date.parse('2026-10-11T10:53:00Z');let requests=0;
  const store={getLocalAccessToken:async()=> 'synthetic-expired',getToken:async()=>({expiresAt:(now-1000)/1000}),loadFromStorage:async()=>{}};
  const client=accountingClient({sheets:{},request:async()=>{}},'synthetic-app',{
    currentToken:appId=>currentToken(appId,{store,now:()=>now,runUatCheck:async()=>{}}),
    request:async()=>{requests++;return {status:200,data:{code:0}};},
  });
  await assert.rejects(client.request(args),/refresh could not be confirmed/u);
  assert.equal(requests,0);
});
