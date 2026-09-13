/* Set VOX_PLAYWRIGHT_PATH to a Playwright installation; no dependency shipped to users. */
const { chromium } = require(process.env.VOX_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const root = path.resolve(__dirname,'..');
let workerLoads = 0;
const fake = `self.onmessage=e=>{const m=e.data;self.postMessage({id:m.id,type:'ready',device:'wasm'});setTimeout(()=>self.postMessage({id:m.id,type:'result',device:'wasm',chunks:[{timestamp:[5,15],text:'Questa è una lezione universitaria.'}]}),250);};`;
function wav(seconds) {
  const b=Buffer.alloc(44+seconds*16000*2); b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=44;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/20)*8000),i);return b;
}
(async()=>{
  const server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).slice(1)||'index.html';
    if(name==='whisper.worker.js'){workerLoads++;res.setHeader('Content-Type','text/javascript');res.end(fake);return;}
    const target=path.resolve(root,name);if(!target.startsWith(root+path.sep)||!fs.existsSync(target)||!fs.statSync(target).isFile()){res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(target));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({channel:process.env.VOX_BROWSER || 'msedge',headless:true});
  try {
    const page=await browser.newPage({serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const origin='http://127.0.0.1:'+server.address().port;
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(origin);
    const file={name:'lecture.wav',mimeType:'audio/wav',buffer:wav(130)};
    await page.locator('#fileInput').setInputFiles(file);await page.locator('#transcribePanel').waitFor({state:'visible'});
    await page.click('#transcribeBtn');await page.click('#pauseBtn');await page.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled);
    let checkpoint=await page.evaluate(()=>JSON.parse(localStorage.getItem(VoxASR.CHECKPOINT)));assert.equal(checkpoint.next,60);
    assert.ok(await page.locator('.seg').count());assert.equal(workerLoads,1);
    await page.click('#transcribeBtn');await page.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled);
    checkpoint=await page.evaluate(()=>JSON.parse(localStorage.getItem(VoxASR.CHECKPOINT)));assert.equal(checkpoint.next,130);assert.equal(workerLoads,1);
    await page.locator('#fileInput').setInputFiles(file);await page.locator('#transcribePanel').waitFor({state:'visible'});
    await page.click('#transcribeBtn');await page.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled);
    assert.equal(workerLoads,1,'model worker must also survive loading the next file');
    await page.reload();await page.locator('#fileInput').setInputFiles(file);await page.locator('#restoreBtn').waitFor({state:'visible'});await page.click('#restoreBtn');
    assert.ok(await page.locator('.seg').count());
    await page.click('#transcribeBtn');await page.click('#stopBtn');await page.waitForTimeout(400);
    assert.equal(await page.locator('#transcribeBtn').isEnabled(),true);
    await page.click('#forgetBtn');assert.equal(await page.evaluate(()=>localStorage.getItem(VoxASR.CHECKPOINT)),null);
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    if(process.env.VOX_SCREENSHOT) await page.screenshot({path:process.env.VOX_SCREENSHOT,fullPage:true});
    assert.deepEqual(errors,[]);console.log('PASS browser: loading, pause/resume, persistent worker, reload recovery, immediate stop, local deletion, mobile layout. Inference mocked.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
