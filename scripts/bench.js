const base=process.env.BASE_URL||'http://127.0.0.1:8000';
const batches=Number(process.env.BATCHES||500), workers=Number(process.env.WORKERS||8);
let next=0, ok=0, failed=0;
const start=performance.now();
await Promise.all(Array.from({length:workers},async()=>{
  while(next<batches){
    const i=next++;
    const body={kind:'objects',test_id:'local-benchmark',sequence:i,objects:Array.from({length:20},(_,j)=>({id:`b-${i}-${j}`,name:`Benchmark ${i}-${j}`,type_id:j%2?'star':'life',attributes:{mass:i+j,note:'sample payload'}}))};
    try{const r=await fetch(base+'/ingest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(r.ok)ok++;else failed++;}catch{failed++;}
  }
}));
const seconds=(performance.now()-start)/1000;
console.log(JSON.stringify({batches,objects:batches*20,workers,ok,failed,seconds:+seconds.toFixed(3),objects_per_second:Math.round(ok*20/seconds)}));
