/* Structure & flow assertions: section order, unlock chain, summary XP,
 * subscription plans, save migration. Run after any change to app logic.
 */
const path = require('path');
const { boot } = require('./_setup.cjs');
const INDEX = path.join(__dirname, '..', 'index.html');

const X = boot(INDEX);
const { SCREENS, app, SECTION_ORDER, sectionMeta, completeSection, launchSection,
        PLANS, SUMMARIES, Store, SAVE_KEY, WORDS } = X;
console.log('boot ok. screens:', Object.keys(SCREENS).length);

let bad=0; const chk=(c,m)=>{ if(!c){bad++;console.error('  ✗',m);} else console.log('  ✓',m); };

console.log('--- section structure ---');
chk(JSON.stringify(SECTION_ORDER)===JSON.stringify(['words','listening','reading','conversation','grammar']),'5 sections in order');
chk(JSON.stringify(sectionMeta().map(x=>x.id))===JSON.stringify(SECTION_ORDER),'sectionMeta matches order');

console.log('--- 3 examples per word ---');
chk(WORDS.every(w=>Array.isArray(w.examples) && w.examples.length===3),'every word has exactly 3 examples');
chk(WORDS.every(w=>w.examples.every(e=>e.en && e.ar)),'every example has en+ar');

console.log('--- unlock chain ---');
app.reset();
const expect=(id,st,m)=>chk(app.state.sections[id]===st,m);
completeSection('words',false);        expect('listening','current','words → unlock listening');
completeSection('listening',false);    expect('reading','current','listening → unlock reading');
completeSection('reading',false);      expect('conversation','current','reading → unlock conversation');
completeSection('conversation',false); expect('grammar','current','conversation → unlock grammar');

console.log('--- last section → unit complete ---');
app.reset(); app.state.unitDone=false; completeSection('grammar'); chk(app.state.screen==='unit_complete','grammar (first time) → unit_complete');
app.reset(); app.state.unitDone=true;  completeSection('grammar'); chk(app.state.screen==='unit_hub','grammar (review) → unit_hub');
app.reset(); completeSection('reading'); chk(app.state.screen==='unit_hub','reading complete → unit_hub');

console.log('--- summaries configured ---');
chk(SUMMARIES.words.xp===50,'words summary xp = 50');
chk(SUMMARIES.listening.xp===40 && SUMMARIES.reading.xp===40 && SUMMARIES.grammar.xp===40,'other summaries xp = 40');

console.log('--- launchSection routing ---');
app.reset(); launchSection('reading'); chk(app.state.screen==='reading','launch القراءة → reading');
app.reset(); launchSection('grammar'); chk(app.state.screen==='grammar_lesson','launch القواعد → grammar_lesson');

console.log('--- grammar split: examples page exists ---');
chk(typeof SCREENS.grammar_examples==='function','SCREENS.grammar_examples exists');
chk(typeof SCREENS.grammar_lesson==='function','SCREENS.grammar_lesson exists');

console.log('--- subscription plans (incl. yearly) ---');
chk(PLANS.monthly.price===99 && PLANS.monthly.per==='شهر','monthly = 99/شهر');
chk(PLANS.weekly.price===29 && PLANS.weekly.per==='أسبوع','weekly = 29/أسبوع');
chk(PLANS.yearly && PLANS.yearly.price===999 && PLANS.yearly.per==='سنة','yearly = 999/سنة');
chk(typeof SCREENS.sub_success==='function','SCREENS.sub_success exists');
app.reset(); chk(app.state.subscribed===false && app.state.plan===null,'starts unsubscribed');
app.set({subscribed:true, plan:'yearly'}); chk(app.state.subscribed===true && app.state.plan==='yearly','subscribe sets state');

console.log('--- interactive tour ---');
chk(Array.isArray(X.TOUR) && X.TOUR.length>=5,'TOUR has steps');
chk(typeof SCREENS.tour==='function','SCREENS.tour exists');
app.reset(); chk(app.state.seenTour===false,'seenTour defaults false');

console.log('--- migration (old save lacking new keys) ---');
const oldSave={ authed:true, xp:120, user:{name:'خالد'}, sections:{words:'done',listening:'done',reading:'current',conversation:'locked',grammar:'locked'} };
Store.set(SAVE_KEY, JSON.stringify(oldSave));
const au=app.load();
chk(au===true,'old save loads');
chk(app.state.subscribed===false,'migration: subscribed defaulted');
chk(app.state.seenTour===false,'migration: seenTour defaulted');
chk(app.state.user.photo==='','migration: user.photo defaulted');
chk(Array.isArray(app.state.words)&&app.state.words.length===5,'migration: words normalized to 5');
chk(app.state.sections.reading==='current','migration: kept reading=current');

console.log(bad===0?'\nALL STRUCTURE/FLOW TESTS PASSED ✅':`\n${bad} FAILED ❌`);
process.exit(bad?1:0);
