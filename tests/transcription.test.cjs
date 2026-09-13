const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const A = require('../transcription.js');
const createModelCache = require('../model-cache.js');

test('large model cache round-trips chunks and rejects incomplete weights', async () => {
  const data = new Map();
  const cache = {match:async key=>data.get(key)?.clone(),put:async(key,response)=>{data.set(key,response.clone());},delete:async key=>data.delete(key)};
  const custom = createModelCache({open:async()=>cache},'https://example.test/voxscribe/worker.js',32);
  const key='https://huggingface.co/model/weights.onnx';
  const bytes=Uint8Array.from({length:111},(_,i)=>i);
  await custom.put(key,new Response(bytes,{headers:{'content-encoding':'gzip'}}));
  assert.deepEqual(new Uint8Array(await(await custom.match(key)).arrayBuffer()),bytes);
  const info=await(await cache.match(key)).json();assert.equal(info.count,4);
  data.delete('https://example.test/voxscribe/__model_cache__/'+info.id+'/2');
  assert.equal(await custom.match(key),undefined);
});

test('failed model cache writes do not publish a manifest or retain partial chunks', async () => {
  const data=new Map();let writes=0;
  const cache={match:async key=>data.get(key)?.clone(),put:async(key,r)=>{if(++writes===2)throw Error('quota');data.set(key,r.clone());},delete:async key=>data.delete(key)};
  const custom=createModelCache({open:async()=>cache},'https://example.test/voxscribe/worker.js',32);
  await assert.rejects(custom.put('https://huggingface.co/model/weights.onnx',new Response(new Uint8Array(111))),/quota/);
  assert.equal(data.size,0);
});

test('two hours use bounded context windows with no timeline gaps', () => {
  let next = 0, count = 0;
  while (next < 7200) {
    const w = A.windowAt(next, 7200);
    assert.equal(w.start, next);
    assert.ok(w.to - w.from <= 70);
    assert.ok(w.from >= 0 && w.to <= 7200 && w.end > next);
    next = w.end; count++;
  }
  assert.equal(next, 7200); assert.equal(count, 120);
  assert.equal(A.windowAt(7200, 7200.25).end, 7200.25);
});

test('near-digital silence is skipped but low-level speech is retained', () => {
  assert.equal(A.isSilent(new Float32Array(16000)), true);
  assert.equal(A.isSilent(new Float32Array(16000).fill(0.001)), false);
});

test('timestamps use absolute positions, clip context and handle missing endpoints', () => {
  const w = A.windowAt(3600, 7200);
  const s = A.segmentsForWindow([
    {timestamp:[0,4],text:'old'}, {timestamp:[4,10],text:'boundary'},
    {timestamp:[10,null],text:'tail'}, {timestamp:[68,70],text:'future'}
  ], w);
  assert.deepEqual(s, [{start:3600,end:3605,text:'boundary',overlap:true},{start:3605,end:3660,text:'tail',overlap:false}]);
});

test('overlap is deduplicated while legitimate repeated phrases remain', () => {
  const existing = [{start:0,end:60,text:'The first law of motion.'}];
  assert.deepEqual(A.appendSegments(existing,[{start:60,end:65,text:'law of motion. It describes inertia.',overlap:true}]),
    [{start:60,end:65,text:'It describes inertia.'}]);
  assert.equal(A.appendSegments(existing,[{start:63,end:68,text:'The first law of motion.'}])[0].text,'The first law of motion.');
  assert.equal(A.appendSegments(existing,[{start:60,end:65,text:'The first law of motion.'}])[0].text,'The first law of motion.');
  assert.equal(A.appendSegments([], [{start:0,end:5,text:'very very very important'}])[0].text,'very very very important');
});

test('checkpoint schema rejects corruption and accepts a partial two-hour job', () => {
  const saved = {version:A.VERSION,key:'sha256',duration:7200,next:3600,model:A.MODELS[0].id,language:'italian',segments:[{start:3590,end:3600,text:'Lezione'}]};
  const storage = {getItem:()=>JSON.stringify(saved)};
  assert.equal(A.readCheckpoint(storage).next,3600);
  saved.next = -1; assert.equal(A.readCheckpoint(storage),null);
  saved.next = 3600; saved.segments[0].end = 4000; assert.equal(A.readCheckpoint(storage),null);
  assert.equal(A.readCheckpoint({getItem:()=>'{broken'}),null);
});

test('fingerprints cover the entire file, not just its name or sampled bytes', async () => {
  const data = new Uint8Array(4 * 1024 * 1024 + 100);
  const a = await A.fingerprint(new Blob([data]));
  data[data.length-1] = 1;
  assert.notEqual(await A.fingerprint(new Blob([data])),a);
  assert.equal(await A.fingerprint(new Blob([new Uint8Array(data.length)])),a);
});

test('engine persists, serializes jobs and ignores late cancelled responses', async () => {
  const workers = [];
  const engine = new A.Engine(()=>{const w={postMessage(m){this.message=m;},terminate(){this.dead=true;}};workers.push(w);return w;});
  const first = engine.request({type:'preload'});
  await assert.rejects(engine.request({type:'preload'}),/occupato/);
  workers[0].onmessage({data:{id:workers[0].message.id,type:'result'}}); await first;
  const second = engine.request({type:'transcribe'});
  const rejected = assert.rejects(second,/Interrotto/); engine.cancel(); await rejected;
  const third = engine.request({type:'preload'});
  workers[0].onmessage({data:{id:workers[0].message.id,type:'result',chunks:['stale']}});
  assert.ok(engine.pending);
  workers[1].onmessage({data:{id:workers[1].message.id,type:'result'}}); await third;
  assert.equal(workers.length,2);
});

test('service worker preserves model caches and other applications', async () => {
  const listeners = {}, deleted=[];
  const context = vm.createContext({self:{addEventListener:(n,f)=>listeners[n]=f,clients:{claim(){}}},
    caches:{keys:async()=>['voxscribe-v6','voxscribe-lectures-1','transformers-cache','transformers-voxscribe-chunks-v1','bytelens-v3'],delete:async n=>deleted.push(n)}});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8'),context);
  let pending; listeners.activate({waitUntil:p=>pending=p}); await pending;
  assert.deepEqual(deleted,['voxscribe-v6']);
});
