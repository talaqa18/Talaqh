/* Talaqa test harness — shared setup.
 * Loads the inline <script> from index.html into a minimal DOM shim so the
 * screen render functions can run under Node (no browser, no deps).
 * Used by tools/check.cjs, tools/smoke.cjs, tools/structure.cjs.
 */
const fs = require('fs');
const vm = require('vm');

function El(tag){
  return {
    tagName:(tag||'div').toUpperCase(), id:'', className:'', value:'', checked:false, disabled:false,
    _html:'', style:(()=>{const o={_v:{}}; o.setProperty=(k,v)=>{o._v[k]=v;}; o.getPropertyValue=(k)=>o._v[k]||''; o.removeProperty=(k)=>{delete o._v[k];}; o.cssText=''; return new Proxy(o,{get:(t,p)=> p in t?t[p]:(t._v[p]||''), set:(t,p,v)=>{t[p]=v;return true;}});})(),
    children:[], firstChild:null, parentNode:null, scrollTop:0, scrollHeight:0,
    selectionStart:0, selectionEnd:0,
    set innerHTML(v){this._html=v;}, get innerHTML(){return this._html;},
    setAttribute(){}, getAttribute(){return null;}, removeAttribute(){},
    addEventListener(){}, removeEventListener(){},
    appendChild(c){this.children.push(c); if(!this.firstChild)this.firstChild=c; if(c)c.parentNode=this; return c;},
    append(...cs){cs.forEach(c=>this.appendChild(c));},
    replaceChildren(...cs){this.children=[]; this.firstChild=null; cs.forEach(c=>this.appendChild(c));},
    insertBefore(c){return this.appendChild(c);},
    remove(){}, focus(){}, blur(){}, setSelectionRange(){}, click(){},
    classList:{ _s:new Set(), add(...a){a.forEach(x=>this._s.add(x));}, remove(...a){a.forEach(x=>this._s.delete(x));}, contains(x){return this._s.has(x);}, toggle(){} },
    querySelector(){return null;}, querySelectorAll(){return [];},
    getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};},
    closest(){return null;}, matches(){return false;}, getContext(){return {};},
  };
}

function installDom(){
  const docBody = El('body');
  const rootEl = El('div'); rootEl.id='root';
  const appEl = El('div'); appEl.id='app';
  const store = {};
  global.document = {
    createElement:(t)=>El(t), createElementNS:(ns,t)=>El(t),
    getElementById:(id)=> id==='root'?rootEl : id==='app'?appEl : null,
    querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){}, removeEventListener(){},
    body:docBody, documentElement:El('html'), activeElement:null, hidden:false,
    createTextNode:(t)=>({nodeType:3,textContent:t}),
  };
  global.window = { addEventListener(){}, removeEventListener(){}, matchMedia:()=>({matches:false,addListener(){},addEventListener(){}}), __deferredPrompt:null, location:{protocol:'https:',href:'https://x/'}, devicePixelRatio:2, scrollTo(){} };
  global.navigator = { vibrate(){return true;}, userAgent:'node', language:'ar', serviceWorker:{register:()=>Promise.resolve()}, onLine:true };
  global.localStorage = { getItem:(k)=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v);}, removeItem:(k)=>{delete store[k];} };
  global.requestAnimationFrame = (cb)=>setTimeout(cb,0);
  global.cancelAnimationFrame = ()=>{};
  global.speechSynthesis = { speak(u){ if(u&&u.onend) setTimeout(u.onend,0); }, cancel(){}, getVoices(){return [];}, addEventListener(){} };
  global.SpeechSynthesisUtterance = function(t){ this.text=t; this.lang=''; this.onend=null; this.onerror=null; };
  global.matchMedia = global.window.matchMedia;
  global.location = global.window.location;
  global.alert=()=>{}; global.confirm=()=>true; global.prompt=()=>'';
}

function extractAppJS(indexPath){
  const html = fs.readFileSync(indexPath,'utf-8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, parts=[];
  while((m=re.exec(html))) parts.push(m[1]);
  if(!parts.length) throw new Error('No inline <script> found in '+indexPath);
  return parts.join('\n;\n');
}

const EXPORT_NAMES = ['SCREENS','app','frame','statusBar','SECTION_ORDER','sectionMeta',
  'completeSection','go','launchSection','PLANS','SUMMARIES','SUB_FEATURES','Store','SAVE_KEY',
  'WORDS','FULL_QUIZ','LISTENING','READING','CONVO','GRAMMAR','TOUR','PRON_PASS'];

function boot(indexPath){
  installDom();
  let js = extractAppJS(indexPath);
  const exp = EXPORT_NAMES.map(n=>`${n}:(typeof ${n}!=="undefined"?${n}:undefined)`).join(', ');
  js += `\n;global.__EXPORTS={${exp}};`;
  (0,eval)(js);
  if(!global.__EXPORTS || !global.__EXPORTS.SCREENS) throw new Error('Boot did not expose SCREENS');
  return global.__EXPORTS;
}

function syntaxCheck(indexPath){
  const code = extractAppJS(indexPath);
  new vm.Script(code, {filename:'index.html#inline-script'});
  return true;
}

module.exports = { El, installDom, extractAppJS, boot, syntaxCheck, EXPORT_NAMES };
