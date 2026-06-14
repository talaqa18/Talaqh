/* Smoke test: render every screen (×2 ui variants) and fail on any thrown error.
 * Catches the most common breakage after an edit (undefined var, bad call, etc.).
 */
const path = require('path');
const { boot } = require('./_setup.cjs');
const INDEX = path.join(__dirname, '..', 'index.html');

const X = boot(INDEX);
const SCREENS = X.SCREENS, app = X.app;
console.log('boot ok. screens:', Object.keys(SCREENS).length);

// representative ui to exercise revealed/done/init/step branches
function richUI(){
  return { sel:0, revealed:true, pron:'done', score:80, pronTries:1, weak:true,
    tr0:true, tr1:true, tr:{0:true,1:true}, mode:'words', playId:null, autoSpoke:true,
    convoInit:true, turn:1, used:{Hello:true}, timeLeft:120,
    messages:[{who:'maya',en:'Hi',ar:'مرحبا'},{who:'me',en:'Hello'}], hint:'حاول',
    recing:false, mtyping:false, tourStep:2, tourTr:true, tourScore:92, gStep:2 };
}

// seed progression so home/journey/hub render advanced states
app.state.authed=true; app.state.user={name:'سارة',email:'a@a.co',age:'25',goal:'travel',nativeLang:'ar'};
app.state.level='A1'; app.state.isBeginner=true; app.state.xp=170; app.state.streak=3; app.state.wordsLearned=5;
app.state.unitDone=false;

let fails=0, ok=0;
for(const k of Object.keys(SCREENS)){
  for(const ui of [ {}, richUI() ]){
    app.state.screen=k; app.state.params={i:0}; app.state.ui=ui;
    try{ const node=SCREENS[k](app.state); if(!node) throw new Error('returned '+node); ok++; }
    catch(e){ fails++; console.error(`FAIL ${k} [ui=${Object.keys(ui).length?'rich':'empty'}]:`, e.message); }
  }
}
console.log(`\nrendered ${ok} screen-states ok, ${fails} failures`);
process.exit(fails?1:0);
