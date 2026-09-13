/* Two hours of synthetic silence exercise decoding/memory/timeline, not ASR accuracy. */
const { chromium }=require(process.env.VOX_PLAYWRIGHT_PATH||'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const fixture=path.join(require('node:os').tmpdir(),'voxscribe-two-hours-'+process.pid+'.wav');
(async()=>{
  const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const p=await browser.newPage({serviceWorkers:'block'}),errors=[];p.on('pageerror',e=>errors.push(e.message));
    const origin='http://127.0.0.1:'+server.address().port;await p.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
    await p.goto(origin);const b=Buffer.alloc(44+7200*8000,128);
    b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(8000,28);b.writeUInt16LE(1,32);b.writeUInt16LE(8,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
    fs.writeFileSync(fixture,b);
    const start=Date.now();await p.locator('#fileInput').setInputFiles(fixture);
    await p.locator('#transcribePanel').waitFor({state:'visible',timeout:120000});
    assert.equal(await p.locator('#totTime').textContent(),'120:00');console.log('Two-hour file decoded in',Math.round((Date.now()-start)/1000),'seconds');
    await p.click('#transcribeBtn');await p.waitForFunction(()=>!document.querySelector('#transcribeBtn').disabled,{},{timeout:120000});
    const c=await p.evaluate(()=>JSON.parse(localStorage.getItem(VoxASR.CHECKPOINT)));
    assert.equal(c.next,7200);assert.equal(c.duration,7200);assert.deepEqual(c.segments,[]);assert.deepEqual(errors,[]);
    console.log('PASS actual browser decoding and 120 bounded batches for two hours of silence. Total seconds:',Math.round((Date.now()-start)/1000));
  }finally{await browser.close();server.close();if(fs.existsSync(fixture))fs.unlinkSync(fixture);}
})().catch(e=>{console.error(e);process.exitCode=1;});
