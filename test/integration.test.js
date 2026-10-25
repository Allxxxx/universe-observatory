import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('durable ingest, duplicate suppression, version ordering and exploration APIs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'observatory-test-'));
  const port = 18000 + Math.floor(Math.random()*20000);
  const child = spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,DATA_DIR:dir,PORT:String(port)},stdio:'pipe'});
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    for(let i=0;i<100;i++) { try { const r=await fetch(base+'/health'); if(r.ok){ready=true;break} } catch{} await new Promise(r=>setTimeout(r,50)); }
    assert.equal(ready,true);
    const send=(x)=>fetch(base+'/ingest',{method:'POST',headers:{'content-type':'application/json'},body:typeof x==='string'?x:JSON.stringify(x)});
    const batch={kind:'objects',test_id:'test-1',sequence:10,objects:[{id:'obj-1',name:'Aster',type_id:'star',attributes:{mass:12}},{id:'obj-2',name:'Lumen',type_id:'life',attributes:{home:'obj-1'}}]};
    assert.equal((await send(batch)).status,200);
    const dup=await send(batch); assert.equal((await dup.json()).stored,false);
    assert.equal((await send({kind:'objects',test_id:'test-1',sequence:9,objects:[{id:'obj-1',name:'Stale',type_id:'star',attributes:{mass:1}}]})).status,200);
    assert.equal((await send({kind:'tree',test_id:'test-1',revision:3,tree:{nodes:[{id:'star',name:'Stellar'},{id:'life',name:'Life',parent_id:'star'}]}})).status,200);
    assert.equal((await send('{bad')).status,400);
    const summary=await (await fetch(base+'/api/summary')).json();
    assert.equal(summary.totalObjects,2);assert.equal(summary.metrics.messages,3);assert.equal(summary.metrics.duplicates,1);assert.equal(summary.metrics.trees_seen,2);
    const object=await (await fetch(base+'/api/object?test_id=test-1&id=obj-1')).json();
    assert.equal(object.name,'Aster'); assert.equal(object.body.attributes.mass,12);
    assert.equal((await (await fetch(base+'/api/types')).json()).length,2);
    assert.equal((await (await fetch(base+'/api/messages')).json()).length,3);
  } finally { child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r)); fs.rmSync(dir,{recursive:true,force:true}); }
});
