import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DOM_QUERY_FUNCTION, CLICK_FUNCTION, validateDomQuery, validateClickSpec } from './cdp-proxy.mjs';
import { wrapVisibleFrame, validateFrameSelector } from './cdp-visible-frame.mjs';

class ChildElement {
  constructor(tag, text, opts={}) { Object.assign(this,{tagName:tag,nodeType:1,innerText:text,childNodes:[],parentElement:null,hidden:false,isContentEditable:false,style:{},clicks:0,rect:{x:20,y:20,left:20,top:20,right:140,bottom:50,width:120,height:30}},opts); if(text)this.childNodes=[{nodeType:3,nodeValue:text,parentElement:this}]; }
  getAttribute(k){return this[k]??null;}
  getBoundingClientRect(){return this.rect;}
  scrollIntoView(){}
  contains(n){return n===this;}
  click(){this.clicks++;}
}
function fixture(opts={}) {
  const anchor=new ChildElement('A','neko',{href:'/artist?id=16177'});
  const doc={URL:'https://music.163.com/search/m/?s=neko&type=100',baseURI:'https://music.163.com/search/m/',querySelectorAll:()=>[anchor],elementFromPoint:()=>anchor,createRange:()=>({selectNodeContents(){},getBoundingClientRect:()=>anchor.rect}),createTreeWalker:root=>{let i=0;return{nextNode:()=>root.childNodes[i++]||null};}};
  const style=e=>({display:'block',visibility:'visible',opacity:'1',...e.style});
  const win={Element:ChildElement,Node:{},NodeFilter:{SHOW_TEXT:4},innerWidth:800,innerHeight:600,getComputedStyle:style,location:{origin:'https://music.163.com'}};
  const frame={tagName:'IFRAME',parentElement:null,getAttribute:()=>null,getBoundingClientRect:()=>({left:100,top:100,right:900,bottom:700,width:800,height:600}),contentDocument:doc,contentWindow:win,clientLeft:0,clientTop:0,...opts};
  const topDoc={querySelectorAll:()=>[frame],elementFromPoint:()=>frame};
  const ctx={document:topDoc,URL,location:{origin:'https://music.163.com'},innerWidth:1000,innerHeight:800,getComputedStyle:style};
  return {anchor,doc,frame,topDoc,ctx,query:vm.runInNewContext(`(${wrapVisibleFrame(DOM_QUERY_FUNCTION)})`,ctx),click:vm.runInNewContext(`(${wrapVisibleFrame(CLICK_FUNCTION,true)})`,ctx)};
}
const query=validateDomQuery({kind:'elements',frameSelector:'iframe#g_iframe',selector:'a',fields:['text','href']});
const click=validateClickSpec(JSON.stringify({frameSelector:'iframe#g_iframe',selector:'a',expectedText:'neko'}));
{
  const f=fixture(); const r=f.query(query);
  assert.equal(r.items[0].text,'neko'); assert.equal(r.items[0].href,'https://music.163.com/artist?id=16177');
  const p=f.click(click,true); assert.equal(p.x,180); assert.equal(p.y,135); assert.equal(f.anchor.clicks,1);
}
for(const opts of [{hidden:true},{style:{display:'none'}},{style:{opacity:'0'}},{style:{transform:'scale(2)'}},{style:{zoom:'2'}},{isContentEditable:true},{contentDocument:null}]) {
  const f=fixture(opts); assert.ok(f.query(query).error); assert.ok(f.click(click,true).error); assert.equal(f.anchor.clicks,0);
}
for(const url of ['https://other.example/search','https://music.163.com/login','about:blank']) {
  const f=fixture(); f.doc.URL=url; assert.ok(f.query(query).error); assert.ok(f.click(click,true).error); assert.equal(f.anchor.clicks,0);
}
{
  const f=fixture();f.topDoc.elementFromPoint=()=>({tagName:'DIV'}); assert.ok(f.click(click,true).error); assert.equal(f.anchor.clicks,0);
}
{
  const f=fixture();f.topDoc.querySelectorAll=()=>[f.frame,{...f.frame}];f.topDoc.elementFromPoint=(x,y)=>f.frame;
  // A distinct second frame covered by the first is excluded.
  assert.equal(f.query(query).items.length,1);
}
{
  const f=fixture();f.anchor.isContentEditable=true;assert.equal(f.query(query).returned,0);assert.ok(f.click(click,true).error);assert.equal(f.anchor.clicks,0);
}
{
  const f=fixture();assert.equal(f.click({...click,expectedText:'wrong'},true).error,'text_mismatch');assert.equal(f.anchor.clicks,0);
}
for(const selector of ['iframe[src]','iframe:not(x)','input','iframe#x,iframe#y','iframe#token=secret']) assert.throws(()=>validateFrameSelector(selector));
for(const selector of ['input','textarea','[data-token]']) assert.throws(()=>validateDomQuery({...query,selector}));
assert.throws(()=>validateDomQuery({...query,fields:['value']}));
console.log('visible-frame PASS: scoped public links, child realm, guarded click, hidden/covered/cross-origin/auth/editable rejection, text match, unchanged field restrictions');
