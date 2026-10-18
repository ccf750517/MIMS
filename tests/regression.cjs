// Run with NODE_PATH pointing at the isolated playwright-core installation; see README.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright-core');
let browser,server,url;
before(async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../index.html'));
 server=http.createServer((req,res)=>{res.writeHead(req.url==='/'?200:404,{'Content-Type':'text/html; charset=utf-8'});res.end(req.url==='/'?html:'');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}/`;
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
async function session(run){
 const context=await browser.newContext({viewport:{width:1920,height:1080},timezoneId:'Asia/Taipei',acceptDownloads:true});
 const page=await context.newPage(),errors=[],dialogs=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());d.accept()});
 try{await page.goto(url);await run(page,context,dialogs);assert.deepEqual(errors,[]);}finally{await context.close();}
}
async function create(page,id,name='回歸測試'){
 await page.locator('nav [data-view="editor"]').click();await page.locator('#fId').fill(id);await page.locator('#fName').fill(name);await page.locator('[onclick="saveAndBack()"]').click();
}
function sample(id='IMPORT'){return {id,name:'測試儀器',calibrationType:'內校',calibrationCycle:'1 年',calibrations:[],tolerances:[],attachments:[],repairs:[],custody:[]};}

test('seven views, settings tabs, CRUD and JSON file roundtrip',()=>session(async(page)=>{
 assert.equal(await page.evaluate(()=>instruments.length),425);
 for(const view of ['editor','list','isoList','annualCalPlan','settings','backup','dashboard']){await page.locator(`nav [data-view="${view}"]`).click();assert(await page.locator('#'+view).isVisible());}
 await page.locator('nav [data-view="settings"]').click();
 for(const tab of ['usage','brand','grade','precision','cycle','location','tol-item','tol-unit']){await page.locator(`[data-settings-tab-button="${tab}"]`).click();assert(await page.locator(`[data-settings-tab-page="${tab}"]`).isVisible());}
 await create(page,'CRUD');await page.reload();assert(await page.evaluate(()=>instruments.some(i=>i.id==='CRUD')));
 await page.evaluate(()=>editInstrument('CRUD'));await page.locator('#fName').fill('更新');await page.locator('[onclick="saveAndBack()"]').click();
 await page.evaluate(()=>copyInstrument('CRUD'));await page.locator('#fId').fill('COPY');await page.locator('[onclick="saveAndBack()"]').click();
 assert.equal(await page.evaluate(()=>instruments.find(i=>i.id==='COPY').name),'更新');
 await page.evaluate(()=>{editInstrument('CRUD');deleteCurrent()});assert(!await page.evaluate(()=>instruments.some(i=>i.id==='CRUD')));
 await page.locator('nav [data-view="backup"]').click();
 const promise=page.waitForEvent('download');await page.locator('#backup [onclick="backupJson()"]').click();const download=await promise;
 assert.equal(await download.failure(),null);const stream=await download.createReadStream();let raw='';for await(const chunk of stream)raw+=chunk;
 const backup=JSON.parse(raw);assert.equal(backup.version,'0.1.115');assert(backup.isoLayout);
 await page.locator('#restoreFile').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(raw)});
 await page.waitForFunction(()=>document.getElementById('restoreFile').value==='');await page.reload();assert(await page.evaluate(()=>instruments.some(i=>i.id==='COPY')));
}));

test('invalid imports never alter stored or in-memory state',()=>session(async(page)=>{
 for(const data of [
  {instruments:[{...sample(),calibrations:'invalid'}]},
  {instruments:[sample(),sample()]},
  {instruments:[{...sample(),name:''}]},
  {instruments:[{...sample(),calibrations:[{errorValues:'invalid'}]}]},
  {instruments:[sample()],brands:[{bad:'object'}]},
  {instruments:[sample()],app:'other'},
  {instruments:[sample()],version:'99.0.0'},
  {instruments:[sample()],annualPlanMonthOverrides:{2026:{IMPORT:[13]}}},
  JSON.parse('{"instruments":[],"__proto__":{"polluted":true}}'),
  {instruments:[sample()],isoLayout:{manual:true,pageCount:26,pages:{}}}
 ]){
  assert(await page.evaluate(raw=>{
   const data=JSON.parse(raw);
   const before=JSON.stringify([...DATA_KEYS].map(k=>localStorage.getItem(k))),memory=JSON.stringify(instruments);
   try{importBackupObject(data);}catch(e){}
   return before===JSON.stringify([...DATA_KEYS].map(k=>localStorage.getItem(k)))&&memory===JSON.stringify(instruments);
  },JSON.stringify(data)),JSON.stringify(data));
 }
 const before=await page.evaluate(()=>localStorage.getItem(STORAGE_KEY));
 await page.locator('#restoreFile').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
 await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>localStorage.getItem(STORAGE_KEY)),before);
}));

test('failed writes roll back every key, keep editor draft and do not report success',()=>session(async(page)=>{
 const data={instruments:[sample()],usageUnits:['新單位']};
 const result=await page.evaluate(data=>{
  const before=JSON.stringify(DATA_KEYS.map(k=>localStorage.getItem(k))),memory=JSON.stringify(instruments);
  const original=Storage.prototype.setItem;let failed=false;
  Storage.prototype.setItem=function(key,value){if(key===STORAGE_KEY&&!failed){failed=true;throw new DOMException('simulated quota','QuotaExceededError');}return original.call(this,key,value);};
  let result;try{result=importBackupObject(data);}finally{Storage.prototype.setItem=original;}
  return {result,unchanged:before===JSON.stringify(DATA_KEYS.map(k=>localStorage.getItem(k))),memoryUnchanged:memory===JSON.stringify(instruments),journal:localStorage.getItem(WRITE_JOURNAL_KEY)};
 },data);
 assert.deepEqual(result,{result:false,unchanged:true,memoryUnchanged:true,journal:null});
 await page.evaluate(()=>showView('editor'));await page.locator('#fId').fill('QUOTA');await page.locator('#fName').fill('未保存草稿');
 await page.evaluate(()=>{window.nativeSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k===STORAGE_KEY)throw new Error('disk unavailable');return window.nativeSetItem.call(this,k,v);};});
 await page.locator('[onclick="saveAndBack()"]').click();
 assert(await page.locator('#editor').isVisible());assert.equal(await page.locator('#fName').inputValue(),'未保存草稿');
 assert(!await page.evaluate(()=>instruments.some(i=>i.id==='QUOTA')));
 await page.evaluate(()=>{Storage.prototype.setItem=window.nativeSetItem});
}));

test('backup snapshot restores prior valid state',()=>session(async(page)=>{
 await create(page,'UNDO');assert(await page.evaluate(()=>instruments.some(i=>i.id==='UNDO')));
 await page.evaluate(()=>recoverPreviousSnapshot());await page.waitForLoadState('load');
 await page.waitForFunction(()=>!instruments.some(i=>i.id==='UNDO'));assert.equal(await page.evaluate(()=>instruments.length),425);
}));

test('corrupt data stays untouched; validated import recovers protection mode',()=>session(async(page)=>{
 await page.evaluate(()=>localStorage.setItem(STORAGE_KEY,'{broken'));await page.reload();
 assert.equal(await page.evaluate(()=>localStorage.getItem(STORAGE_KEY)),'{broken');assert(await page.evaluate(()=>storageBlocked));
 assert.equal(await page.evaluate(data=>importBackupObject({instruments:[data]}),sample('RECOVER')),true);
 await page.reload();assert.equal(await page.evaluate(()=>instruments[0].id),'RECOVER');
}));

test('interrupted transaction rolls back from the durable journal',()=>session(async(page)=>{
 await page.evaluate(()=>{const before=Object.fromEntries(DATA_KEYS.map(k=>[k,localStorage.getItem(k)]));const after={...before,[STORAGE_KEY]:'[]'};localStorage.setItem(WRITE_JOURNAL_KEY,JSON.stringify({before,after}));localStorage.setItem(STORAGE_KEY,'[]');});
 await page.reload();assert.equal(await page.evaluate(()=>instruments.length),425);assert.equal(await page.evaluate(()=>localStorage.getItem(WRITE_JOURNAL_KEY)),null);
}));

test('special character IDs and settings are inert across every generated view',()=>session(async(page)=>{
 const id="x' onmouseover='window.injectionMarker=1' data-extra='";
 await create(page,id);await page.evaluate(id=>{document.getElementById('searchBox').value=id;renderList()},id);
 const button=page.locator('#listBody [data-action="editInstrument"]');assert.equal(await button.getAttribute('onclick'),null);
 await button.hover();assert.equal(await page.evaluate(()=>window.injectionMarker),undefined);
 await button.click();assert.equal(await page.locator('#fId').inputValue(),id);
 for(const view of ['isoList','annualCalPlan']){await page.evaluate(view=>showView(view),view);assert.equal(await page.locator(`#${view} [data-argument]`).first().getAttribute('onchange'),null);}
 await page.evaluate(()=>{document.getElementById('newBrand').value="O'Reilly";addBrand();showView('settings');switchSettingsTab('brand')});
 const del=page.locator('[data-action="deleteBrand"]').filter({hasText:'刪除'});assert(await del.count()>0);
 await page.locator('[data-action="deleteBrand"][data-argument="O\'Reilly"]').click();assert(!await page.evaluate(()=>brands.includes("O'Reilly")));
 assert.equal(await page.evaluate(()=>window.injectionMarker),undefined);
}));

test('month-end/leap-year rules and use qualification are independent from expiry',()=>session(async(page)=>{
 const results=await page.evaluate(()=>({
  dates:[fmtDate(addCalendarMonths(new Date(2025,0,31),1)),fmtDate(addCalendarMonths(new Date(2024,0,31),1)),fmtDate(addCalendarMonths(new Date(2024,1,29),12))],
  failed:usageInfo({calibrationType:'內校',calibrationCycle:'1 年',calibrations:[{date:fmtDate(new Date()),result:'不合格',action:'待複驗'}]}).code,
  stopped:usageInfo({calibrationType:'免校',currentStatus:'停用'}).code,
  noResult:usageInfo({calibrationType:'內校',calibrationCycle:'1 年',calibrations:[{date:fmtDate(new Date())}]}).code,
  good:usageInfo({calibrationType:'內校',calibrationCycle:'1 年',calibrations:[{date:fmtDate(new Date()),result:'合格'}]}).code,
  deadline:dueInfo({calibrationType:'內校',calibrationCycle:'1 月',calibrations:[{date:'2025.01.31'}]}).due
 }));
 assert.deepEqual(results,{dates:['2025-02-28','2024-02-29','2025-02-28'],failed:'blocked',stopped:'blocked',noResult:'review',good:'allowed',deadline:'2025-02-28'});
}));

test('live master is used in history and all overflow data reaches continuation/PDF',()=>session(async(page)=>{
 await page.evaluate(()=>{editInstrument('1D-001');document.getElementById('fName').value='最新主檔名稱';document.getElementById('fCycle').value='6 月';saveInstrument();viewHistory('1D-001');});
 assert((await page.locator('#historyContent').innerText()).includes('最新主檔名稱'));
 assert((await page.locator('#historyContent .iso-top').innerText()).includes('6 月'));
 const data=sample('OVERFLOW');data.tolerances=Array.from({length:6},(_,i)=>({item:'項目'+i,value:'TOL'+i}));
 data.calibrations=Array.from({length:34},(_,i)=>({date:'2025.01.01',reportNo:'REPORT'+i,errorValues:Array.from({length:6},(_,j)=>({item:'項目'+j,value:`ERROR-${i}-${j}`}))}));
 data.attachments=Array.from({length:7},(_,i)=>({name:'ATT'+i}));data.repairs=Array.from({length:14},(_,i)=>({content:'REP'+i}));data.custody=Array.from({length:14},(_,i)=>({receiver:'CUS'+i}));
 await page.evaluate(data=>{importBackupObject({instruments:[data]});viewHistory('OVERFLOW')},data);
 const text=await page.locator('#historyContent').innerText();for(const marker of ['REPORT33','ERROR-33-5','ATT6','REP13','CUS13','TOL5'])assert(text.includes(marker),marker);
 assert(await page.locator('.iso-overflow-note').isVisible());
 await page.evaluate(()=>document.body.classList.add('print-history'));
 const pdf=await page.pdf({preferCSSPageSize:true,printBackground:true});assert(pdf.length>10000);
 const dir=process.env.MIMS_TEST_ARTIFACTS||'/tmp/mims-regression';fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'overflow-history.pdf'),pdf);
}));

test('stale tabs cannot overwrite data and rejected saves stay in editor',()=>session(async(page,context)=>{
 const second=await context.newPage();second.on('dialog',d=>d.accept());await second.goto(url);
 await create(page,'TAB-A');await second.locator('nav [data-view="editor"]').click();await second.locator('#fId').fill('TAB-B');await second.locator('#fName').fill('本頁草稿');await second.locator('[onclick="saveAndBack()"]').click();
 assert(await second.locator('#editor').isVisible());assert.equal(await second.locator('#fName').inputValue(),'本頁草稿');
 assert.deepEqual(await second.evaluate(()=>{const a=JSON.parse(localStorage.getItem(STORAGE_KEY));return [a.some(i=>i.id==='TAB-A'),a.some(i=>i.id==='TAB-B')]}),[true,false]);
 await page.evaluate(()=>editInstrument('2D-600'));await page.locator('#fId').fill('1D-001');await page.locator('[onclick="saveAndBack()"]').click();assert(await page.locator('#editor').isVisible());
}));

test('manual layout persists, rejects overflow, survives backup and tracks renamed IDs',()=>session(async(page)=>{
 await page.evaluate(()=>{startIsoManualPaging();isoSelectedIds=new Set(instruments.slice(0,24).map(i=>i.id));assignIsoSelectionToPage(1);isoSelectedIds=new Set([instruments[24].id]);assignIsoSelectionToPage(1);});
 assert.equal(await page.evaluate(()=>isoPageAssignments[1].size),24);await page.reload();assert(await page.evaluate(()=>isoManualPaging));assert.equal(await page.evaluate(()=>isoPageAssignments[1].size),24);
 await page.evaluate(()=>{editInstrument('1D-001');document.getElementById('fId').value='RENAMED';saveInstrument();});await page.reload();assert(await page.evaluate(()=>isoPageAssignments[1].has('RENAMED')&&!isoPageAssignments[1].has('1D-001')));
 const state=await page.evaluate(()=>captureState());await page.evaluate(state=>importBackupObject({...state,app:'量測儀器管理系統'}),state);await page.reload();assert(await page.evaluate(()=>isoPageAssignments[1].has('RENAMED')));
}));

test('keyboard modal trap, Escape focus return, tabs and sorting',()=>session(async(page)=>{
 await page.locator('nav [data-view="list"]').click();const trigger=page.locator('#listBody [data-action="viewHistory"]').first();await trigger.click();await page.waitForTimeout(50);
 const modal=page.locator('#historyModal');assert.equal(await modal.getAttribute('role'),'dialog');
 await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'關閉');
 await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'列印履歷');
 await page.evaluate(()=>document.getElementById('historyModal').classList.add('open'));await page.waitForTimeout(20);
 await page.keyboard.press('Escape');assert(!await modal.isVisible());assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 await page.locator('nav [data-view="settings"]').click();await page.locator('[data-settings-tab-button="usage"]').focus();await page.keyboard.press('ArrowRight');assert(await page.locator('[data-settings-tab-page="brand"]').isVisible());
 await page.locator('nav [data-view="list"]').click();await page.locator('th[data-sort-key="id"]').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>listSort.dir),'desc');
}));

test('responsive toolbar stays non-overlapping at twelve widths',()=>session(async(page)=>{
 await page.locator('nav [data-view="list"]').click();
 for(const width of [375,768,1199,1200,1366,1536,1600,1920,2399,2400,2560,3840]){
  await page.setViewportSize({width,height:1080});
  const overlap=await page.evaluate(()=>{const r=[...document.querySelectorAll('#list .toolbar input,#list .toolbar select,#list .toolbar button')].map(e=>e.getBoundingClientRect());return r.some((a,i)=>r.slice(i+1).some(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1));});
  assert.equal(overlap,false,'width '+width);
 }
}));

test('editing retains historical errors that no longer match tolerance items',()=>session(async(page)=>{
 const data=sample('HISTORICAL');data.tolerances=[{item:'現行項目',value:'1'}];
 data.calibrations=[{date:'2025.01.01',errorValues:[{item:'現行項目',value:'KEEP0'},...Array.from({length:5},(_,i)=>({item:'既有項目'+i,value:'KEEP'+(i+1)}))]}];
 await page.evaluate(data=>{importBackupObject({instruments:[data]});editInstrument(data.id);saveInstrument()},data);
 const values=await page.evaluate(()=>instruments[0].calibrations[0].errorValues.map(e=>e.value));assert.deepEqual(values,['KEEP0','KEEP1','KEEP2','KEEP3','KEEP4','KEEP5']);
 await page.evaluate(()=>viewHistory('HISTORICAL'));assert((await page.locator('.history-continuation').innerText()).includes('KEEP5'));
}));

test('a recent journal from another tab is never rolled back or overwritten',()=>session(async(page)=>{
 const original=await page.evaluate(()=>localStorage.getItem(STORAGE_KEY));
 await page.evaluate(()=>{const before=Object.fromEntries(DATA_KEYS.map(k=>[k,localStorage.getItem(k)]));localStorage.setItem(WRITE_JOURNAL_KEY,JSON.stringify({before,after:before,owner:'other-active-tab',startedAt:Date.now()}));});
 await page.reload();assert(await page.evaluate(()=>storageBlocked));assert.equal(await page.evaluate(()=>localStorage.getItem(STORAGE_KEY)),original);assert(await page.evaluate(()=>Boolean(localStorage.getItem(WRITE_JOURNAL_KEY))));
}));
