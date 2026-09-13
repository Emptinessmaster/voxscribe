/* Optional real inference smoke test. Fixtures stay local and are never uploaded. */
const { chromium } = require(process.env.VOX_PLAYWRIGHT_PATH || 'playwright');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async()=>{
  const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';
    const file=path.resolve(root,name);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const b=await chromium.launch({channel:'msedge',headless:true});
  try {
    const p=await b.newPage();const errors=[],outgoing=[];
    p.on('pageerror',e=>errors.push(e.message));
    p.on('console',m=>{if(m.type()==='warning')console.log('Browser warning:',m.text());});
    p.on('requestfailed',r=>console.log('Failed request:',r.url().split('?')[0],r.failure()?.errorText));
    p.on('request',r=>{if(r.method()!=='GET' && r.method()!=='HEAD')outgoing.push({method:r.method(),url:r.url()});});
    await p.goto('http://127.0.0.1:'+server.address().port);
    await p.evaluate(()=>navigator.serviceWorker.ready);
    await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const model=process.env.VOX_REAL_MODEL||'onnx-community/whisper-base';
    const device=process.env.VOX_REAL_DEVICE||'wasm';
    console.log('Test settings:',model,device);
    for(const [fixture,language] of [['speech-test.wav','italian'],['speech-en.wav','english']]) {
      await p.locator('#fileInput').setInputFiles(path.join(root,fixture));
      await p.locator('#transcribePanel').waitFor({state:'visible'});
      await p.selectOption('#modelSelect',model);await p.selectOption('#engineSel',device);await p.selectOption('#langSel',language);
      const start=Date.now();await p.click('#transcribeBtn');
      const timer=setInterval(async()=>{try{console.log(language,await p.locator('#mpText').textContent())}catch{}},15000);
      try {await p.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled,{},{timeout:600000});}finally{clearInterval(timer);}
      const status=await p.locator('#mpText').textContent(),text=await p.locator('#transcript').innerText();
      assert.match(status,/completata/);assert.ok(text.length>20);
      console.log(language,'seconds:',Math.round((Date.now()-start)/1000),'engine:',await p.locator('#engineStatus').textContent(),'transcript:',text);
    }
    console.log('Storage:',await p.evaluate(()=>navigator.storage.estimate()));
    console.log('Cached models:',await p.evaluate(async()=>{const c=await caches.open('transformers-cache');return (await c.keys()).map(r=>r.url).filter(u=>u.includes('onnx'));}));
    await p.context().setOffline(true);await p.reload();
    await p.locator('#fileInput').setInputFiles(path.join(root,'speech-en.wav'));
    await p.locator('#transcribePanel').waitFor({state:'visible'});
    await p.selectOption('#modelSelect',model);await p.selectOption('#engineSel',device);await p.selectOption('#langSel','english');
    await p.click('#transcribeBtn');await p.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled,{},{timeout:180000});
    assert.match(await p.locator('#mpText').textContent(),/completata/);
    assert.ok((await p.locator('#transcript').innerText()).length>20);
    assert.deepEqual(errors,[]);assert.deepEqual(outgoing,[]);
    console.log('PASS real IT/EN transcription, offline reload + inference; no POST or other upload requests.');
  }finally{await b.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
