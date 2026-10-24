import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DOM_QUERY_FUNCTION, CLICK_FUNCTION, validateDomQuery, validateClickSpec, validateShadowPath, ALLOWED_CDP_METHODS } from './cdp-proxy.mjs';

const results = [];
function test(name, fn) { fn(); results.push(name); }
const rect = () => ({ x:20,y:20,width:120,height:30,top:20,left:20,right:140,bottom:50 });
class Container {
  constructor() { this.childNodes = []; this.parentNode = null; }
  append(...nodes) { for(const n of nodes) { n.parentNode = this; n.parentElement = this instanceof Element ? this : null; this.childNodes.push(n); } return this; }
  getRootNode() { let n=this; while(n.parentNode) n=n.parentNode; return n; }
  querySelectorAll(selector) {
    const out=[]; const walk=root=>{ for(const n of root.childNodes) { if(n instanceof Element){if(n.matches(selector))out.push(n);walk(n);} } }; walk(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Element extends Container {
  constructor(tag, opts={}) { super(); Object.assign(this,{nodeType:1,tagName:tag.toUpperCase(),hidden:false,isContentEditable:false,parentElement:null,shadowRoot:null,assignedSlot:null,style:{},attributes:{},rect:rect(),clicks:0,scrolls:0},opts); }
  matches(selector) { return selector==='*' || (selector[0]==='#' ? this.attributes.id===selector.slice(1) : selector[0]==='.' ? (this.attributes.class||'').split(' ').includes(selector.slice(1)) : this.tagName.toLowerCase()===selector.toLowerCase()); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.rect; }
  get innerText() { return this.childNodes.map(n=>n.nodeType===3?n.nodeValue:n.innerText).join(' '); }
  setText(value) { this.childNodes=[]; this.append(new Text(value)); return this; }
  scrollIntoView() { this.scrolls++; if(this.onScroll)this.onScroll(); }
  click() { this.clicks++; }
  contains(node) { for(let n=node;n;n=n.parentNode)if(n===this)return true;return false; }
  assignedNodes() { return this.assigned || []; }
  attachShadow(mode='open') { const r=new ShadowRoot(this);if(mode==='open')this.shadowRoot=r;return r; }
}
class Text extends Container { constructor(value){super();this.nodeType=3;this.nodeValue=value;this.parentElement=null;} }
class ShadowRoot extends Container { constructor(host){super();this.host=host;this.point=null;} elementFromPoint(){return this.point;} }
class Doc extends Container {
  constructor(){super();this.baseURI='https://www.bilibili.com/video/BV1000000012/';this.point=null;}
  elementFromPoint(){return this.point;}
  createRange(){let n;return{selectNodeContents:node=>{n=node;},getBoundingClientRect:()=>n.rect||n.parentElement?.rect||n.getRootNode()?.host?.rect||rect()};}
  createTreeWalker(root){const text=[];const walk=n=>{for(const c of n.childNodes){if(c.nodeType===3)text.push(c);else walk(c);}};walk(root);let i=0;return{nextNode:()=>text[i++]||null};}
}
function fixture(){
  const doc=new Doc();
  const host=new Element('bili-comments');doc.append(host);const root=host.attachShadow();
  const thread=new Element('test-thread');root.append(thread);const inside=thread.attachShadow();
  const comment=new Element('p').setText('玩家评价');const button=new Element('button').setText('共 12 条回复');inside.append(comment,button);
  doc.point=host;root.point=thread;inside.point=button;
  const context={document:doc,Element,URL,NodeFilter:{SHOW_TEXT:4},innerWidth:1000,innerHeight:800,getComputedStyle:e=>({display:'block',visibility:'visible',opacity:'1',...e.style})};
  return{doc,host,root,thread,inside,comment,button,query:vm.runInNewContext(`(${DOM_QUERY_FUNCTION})`,context),click:vm.runInNewContext(`(${CLICK_FUNCTION})`,context)};
}
const path=[{selector:'bili-comments',index:0},{selector:'test-thread',index:0}];
const elements=(selector='button',extra={})=>({kind:'elements',selector,shadowPath:path,visibility:'rendered',limit:20,fields:['tag','text'],...extra});
const text=(selector='test-thread',extra={})=>({kind:'text',selector,shadowPath:[path[0]],visibility:'rendered',maxChars:16000,...extra});
const locator=(extra={})=>({selector:'button',shadowPath:path,expectedText:'共 12 条回复',...extra});
function rejects(fn,code){assert.throws(fn,e=>e.code===code);}

test('legacy validators retain exact normalized schema',()=>{
  assert.deepEqual(validateDomQuery({kind:'text',selector:'main',maxChars:100}),{kind:'text',selector:'main',visibility:'rendered',maxChars:100});
  assert.equal(validateClickSpec('button'),'button');
});
test('nested path and structured click validate',()=>{
  assert.deepEqual(validateShadowPath([{selector:'bili-comments'}]),[{selector:'bili-comments',index:0}]);
  assert.equal(validateClickSpec(JSON.stringify(locator())).expectedText,'共 12 条回复');
});
test('invalid path types depths indexes and unknown fields reject',()=>{
  for(const v of [null,false,{},Array(9).fill({selector:'x'})]) rejects(()=>validateShadowPath(v),'invalid_shadow_path');
  for(const index of [-1,2000,0.5,'0']) rejects(()=>validateShadowPath([{selector:'x',index}]),'invalid_shadow_index');
  rejects(()=>validateShadowPath([{selector:'x',eval:'1'}]),'unknown_query_field');
  rejects(()=>validateClickSpec('{"selector":"button","shadowPath":null}'),'invalid_shadow_path');
});
test('unsafe selectors and private query fields remain rejected',()=>{
  for(const selector of ['input','[data-token]','a[href="x"]','div:has(a)','\\61']) rejects(()=>validateShadowPath([{selector}]),'unsafe_selector');
  rejects(()=>validateDomQuery({...elements(),fields:['value']}),'invalid_element_fields');
  rejects(()=>validateDomQuery({...elements(),expression:'document.cookie'}),'unknown_query_field');
  rejects(()=>validateClickSpec('{"selector":"button","__proto__":{}}'),'unknown_query_field');
  rejects(()=>validateClickSpec(JSON.stringify({...locator(),expectedText:'\n'})),'invalid_expected_text');
  assert.equal(ALLOWED_CDP_METHODS.has('Runtime.evaluate'),false);
  assert.equal(ALLOWED_CDP_METHODS.has('Network.getAllCookies'),false);
});
test('two nested roots expose only requested public fields',()=>{
  const f=fixture();const r=f.query(elements());assert.equal(r.items[0].text,'共 12 条回复');assert.equal(r.items[0].tag,'BUTTON');assert.deepEqual(Object.keys(r.items[0]),['tag','text','text_truncated']);assert.equal(r.items[0].text_truncated,false);
});
test('composed text includes nested comment and reply control',()=>{
  const r=fixture().query(text());assert.equal(r.text,'玩家评价 共 12 条回复');assert.equal(r.truncated,false);
});
test('empty shadow path preserves light DOM behavior',()=>{
  const f=fixture();assert.equal(f.query({...elements(),shadowPath:[]}).returned,0);
});
test('hidden and editable hosts block nested reads',()=>{
  for(const opts of [{hidden:true},{attributes:{'aria-hidden':'true'}},{style:{display:'none'}},{style:{visibility:'hidden'}},{style:{opacity:'0'}},{isContentEditable:true}]){
    const f=fixture();Object.assign(f.host,opts);assert.equal(f.query(elements()).returned,0);assert.ok(f.click(locator(),true).error);assert.equal(f.button.clicks,0);
  }
});
test('closed roots are not entered',()=>{
  const f=fixture();f.thread.shadowRoot=null;assert.equal(f.query(elements()).reason,'shadow_root_unavailable');assert.ok(f.click(locator(),true).error);assert.equal(f.button.clicks,0);
});
test('hidden sibling and sensitive nested elements are excluded',()=>{
  const f=fixture();const hidden=new Element('p',{hidden:true}).setText('hidden');const input=new Element('input').setText('secret');f.inside.append(hidden,input);assert.equal(f.query(text()).text,'玩家评价 共 12 条回复');
});
test('slot assignments replace fallback text and avoid duplicate text',()=>{
  const f=fixture();const slot=new Element('slot').setText('fallback');const assigned=new Element('span').setText('分配文字');f.thread.append(assigned);assigned.assignedSlot=slot;slot.assigned=[assigned];f.inside.append(slot);const r=f.query(text());assert.equal(r.text,'玩家评价 共 12 条回复 分配文字');
});
test('direct shadow-root text remains readable',()=>{
  const f=fixture();f.inside.append(new Text('根部文字'));assert.equal(f.query(text()).text,'玩家评价 共 12 条回复 根部文字');
});
test('zero-box hosts fail closed with the same numbering as element lists',()=>{
  const f=fixture();f.host.style.display='contents';f.host.rect={...rect(),width:0,height:0};assert.equal(f.query(elements()).returned,0);assert.equal(f.query(elements()).reason,'shadow_host_not_found');
});
test('viewport text mode excludes offscreen text',()=>{
  const f=fixture();f.comment.rect={...rect(),y:1000,top:1000,bottom:1030};assert.equal(f.query(text('test-thread',{visibility:'viewport'})).text,'共 12 条回复');
});
test('nested shadow hit test permits visible button',()=>{
  const f=fixture();assert.equal(f.click(locator(),true).text,'共 12 条回复');assert.equal(f.button.clicks,1);
});
test('locate-only structured click does not activate',()=>{
  const f=fixture();assert.equal(f.click(locator(),false).tag,'BUTTON');assert.equal(f.button.clicks,0);
});
test('inner and outer overlays prevent click',()=>{
  for(const outer of [false,true]){const f=fixture();const overlay=new Element('div');if(outer)f.doc.point=overlay;else f.inside.point=overlay;assert.equal(f.click(locator(),true).error,'occluded');assert.equal(f.button.clicks,0);}
});
test('missing root hit testing fails closed',()=>{
  const f=fixture();f.inside.elementFromPoint=undefined;assert.equal(f.click(locator(),true).error,'occluded');assert.equal(f.button.clicks,0);
});
test('wrong or changed expected text prevents click',()=>{
  const a=fixture();assert.equal(a.click(locator({expectedText:'错误楼层'}),true).error,'text_mismatch');assert.equal(a.button.clicks,0);
  const b=fixture();b.button.onScroll=()=>b.button.setText('已变化');assert.equal(b.click(locator(),true).error,'not_visible_or_changed');assert.equal(b.button.clicks,0);
  const c=fixture();const boundary='字'.repeat(160);c.button.setText(boundary);assert.equal(c.click(locator({expectedText:boundary}),true).tag,'BUTTON');assert.equal(c.button.clicks,1);
});
test('target hidden after scroll prevents click',()=>{
  const f=fixture();f.button.onScroll=()=>{f.button.hidden=true;};assert.equal(f.click(locator(),true).error,'not_visible_or_changed');assert.equal(f.button.clicks,0);
});
test('explicit candidate index chooses only designated visible item',()=>{
  const f=fixture();const other=new Element('button').setText('共 8 条回复');f.inside.append(other);f.inside.point=other;assert.equal(f.click(locator({index:1,expectedText:'共 8 条回复'}),true).text,'共 8 条回复');assert.equal(f.button.clicks,0);assert.equal(other.clicks,1);
});
test('host index isolates repeated comment components',()=>{
  const f=fixture();const other=new Element('test-thread');const r=other.attachShadow();r.append(new Element('p').setText('第二条'));f.root.append(other);
  const empty=new Element('test-thread',{rect:{...rect(),width:0,height:0}});empty.attachShadow();f.root.append(empty);f.root.childNodes=[empty,f.thread,other];
  assert.equal(f.query({...elements('test-thread'),shadowPath:[path[0]]}).returned,2);
  assert.equal(f.query({...elements('p'),shadowPath:[path[0],{selector:'test-thread',index:1}]}).items[0].text,'第二条');
});
test('new-tab public links retain same-page navigation behavior',()=>{
  const f=fixture();const link=new Element('a',{attributes:{target:'_blank',href:'/public/profile'}}).setText('主页');f.inside.append(link);f.inside.point=link;const r=f.click(locator({selector:'a',expectedText:'主页'}),true);assert.equal(r.navigationUrl,'https://www.bilibili.com/public/profile');assert.equal(link.clicks,0);
});
test('unsafe new-tab destinations remain blocked',()=>{
  for(const href of ['javascript:alert(1)','file:///C:/private','https://user:password@example.test/']){const f=fixture();const a=new Element('a',{attributes:{target:'_blank',href}}).setText('主页');f.inside.append(a);f.inside.point=a;assert.equal(f.click(locator({selector:'a',expectedText:'主页'}),true).error,'unsupported_link');assert.equal(a.clicks,0);}
});
test('slotted element inherits anchor navigation through composed ancestry',()=>{
  const f=fixture();const a=new Element('a',{attributes:{target:'_blank',href:'/public'}});const slot=new Element('slot');a.append(slot);f.inside.append(a);const span=new Element('span').setText('主页');f.thread.append(span);span.assignedSlot=slot;slot.assigned=[span];f.inside.point=span;const r=f.click({selector:'span',shadowPath:[],expectedText:'主页'},true);assert.equal(r.error,'not_found');
  // The light span belongs to a host inside another root; reach that host's light DOM through its parent root.
  const r2=f.click({selector:'span',shadowPath:[path[0]],expectedText:'主页'},true);assert.equal(r2.navigationUrl,'https://www.bilibili.com/public');assert.equal(span.clicks,0);
});
test('public URL and attribute sanitizers are unchanged inside open roots',()=>{
  const f=fixture();const a=new Element('a',{attributes:{href:'https://www.bilibili.com/video/BV1x/?token=secret#x',title:'Authorization=Bearer opaque-value'}}).setText('public');f.inside.append(a);const r=f.query(elements('a',{fields:['text','href','title']}));assert.equal(r.items[0].href,'https://www.bilibili.com/video/BV1x/');assert.equal(r.items[0].title,null);
});
test('text-node budget stops at 2500 with explicit truncation',()=>{
  const f=fixture();f.inside.childNodes=[];const p=new Element('p');for(let i=0;i<2501;i++)p.append(new Text('字'));f.inside.append(p);const r=f.query(text());assert.equal(r.scannedTextNodes,2500);assert.equal(r.truncated,true);
});
test('pending and visited node budgets bound large sibling lists',()=>{
  const f=fixture();f.inside.childNodes=[];for(let i=0;i<9000;i++)f.inside.append(new Element('i'));assert.equal(f.query(text()).truncated,true);
});
test('open root count and depth have hard bounds',()=>{
  const f=fixture();f.inside.childNodes=[];for(let i=0;i<140;i++){const h=new Element('x-child');h.attachShadow().append(new Text('字'));f.inside.append(h);}assert.equal(f.query(text()).truncated,true);
  const g=fixture();let r=g.inside;for(let i=0;i<18;i++){const h=new Element('x-child');r.append(h);r=h.attachShadow();}r.append(new Text('太深'));assert.equal(g.query(text()).truncated,true);
});
test('candidate limit includes path lookup and reports truncation',()=>{
  const f=fixture();f.inside.childNodes=[];for(let i=0;i<2001;i++)f.inside.append(new Element('button',{hidden:true}));const r=f.query(elements());assert.equal(r.returned,0);assert.equal(r.truncated,true);
});
test('normal output size and character limits still validate',()=>{
  rejects(()=>validateDomQuery({...elements(),limit:51}),'invalid_element_limit');
  rejects(()=>validateDomQuery({...text(),maxChars:16001}),'invalid_max_chars');
  const f=fixture();assert.equal(f.query(text('test-thread',{maxChars:4})).text.length,4);
});

console.log(JSON.stringify({suite:'open-shadow fixed-query and click',passed:results.length,cases:results},null,2));
