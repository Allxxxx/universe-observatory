const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('zh-CN').format(n || 0);
const when = ms => ms ? new Date(ms).toLocaleString('zh-CN',{hour12:false}) : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function get(url) { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
let offset = 0, count = 0;
async function summary() {
  const d = await get('/api/summary');
  $('objects-count').textContent = fmt(d.totalObjects);
  $('messages-count').textContent = fmt(d.metrics.messages);
  $('types-count').textContent = fmt(d.totalTypes);
  $('runs-count').textContent = fmt(d.runs.length);
  $('updated').textContent = d.last ? `最近观测 · ${when(d.last)}` : '等待数据';
  const total = d.categories.reduce((n,x)=>n+x.count,0) || 1;
  $('categories').innerHTML = d.categories.length ? d.categories.map(c=>`<div class="category"><div class="category-head"><span>${esc(c.category)}</span><span>${fmt(c.count)} · ${Math.round(c.count/total*100)}%</span></div><div class="track"><div class="fill" style="width:${c.count/total*100}%"></div></div></div>`).join('') : '<div class="empty">暂无对象分类</div>';
  const run = $('run-filter'), chosen = run.value;
  run.innerHTML = '<option value="">全部观测任务</option>'+d.runs.map(r=>`<option value="${esc(r.test_id)}">${esc(r.test_id)}</option>`).join(''); run.value=chosen;
  const cat = $('category-filter'), old=cat.value;
  cat.innerHTML='<option value="">全部类别</option>'+d.categories.map(c=>`<option value="${esc(c.category)}">${esc(c.category)}</option>`).join('');cat.value=old;
}
async function activity() {
  const rows=await get('/api/activity');
  if (!rows.length) return;
  const byMinute=new Map(rows.map(r=>[r.minute,r.messages]));
  const now=Math.floor(Date.now()/60000), values=Array.from({length:60},(_,i)=>byMinute.get(now-59+i)||0);
  const peak=Math.max(1,...values);
  $('chart').innerHTML=values.map((n,i)=>`<div class="bar" title="${i-59} 分钟: ${n} 条" style="height:${Math.max(n ? 4 : 0,n/peak*100)}%"></div>`).join('');
  $('chart-peak').textContent=`峰值 ${fmt(peak)} / 分钟`;
}
async function objects() {
  const p=new URLSearchParams({offset:String(offset),limit:'30'});
  if ($('search').value) p.set('q',$('search').value);
  if ($('run-filter').value) p.set('test_id',$('run-filter').value);
  if ($('category-filter').value) p.set('category',$('category-filter').value);
  const rows=await get('/api/objects?'+p);
  count=rows.length;
  $('object-rows').innerHTML=rows.length ? rows.map(o=>`<tr><td><span class="object-name">${esc(o.name||o.object_id)}</span><span class="object-id">${esc(o.object_id)}</span></td><td><span class="badge">${esc(o.category)}</span></td><td>${esc(o.type_id||'—')}</td><td>${fmt(o.sequence)}</td><td>${when(o.updated_ms)}</td><td><button class="view-btn" data-id="${esc(o.object_id)}" data-test="${esc(o.test_id)}">查看 →</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">没有匹配的对象</td></tr>';
  $('object-page-label').textContent=`第 ${Math.floor(offset/30)+1} 页 · ${rows.length} 条`;
  $('prev').disabled=offset===0;$('next').disabled=rows.length<30;
}
async function types() {
  const p=$('run-filter').value ? '?test_id='+encodeURIComponent($('run-filter').value) : '';
  const rows=await get('/api/types'+p);
  $('type-list').innerHTML=rows.length ? rows.map(t=>`<div class="type-node"><b>${esc(t.name||t.type_id)}</b><small>${esc(t.type_id)}</small><em>${t.parent_id?'↳ '+esc(t.parent_id):'根节点'} · r${fmt(t.revision)}</em></div>`).join(''):'<div class="empty">尚无类型树更新</div>';
}
async function messages() {
  const rows=await get('/api/messages');
  $('message-list').innerHTML=rows.length?rows.map(m=>`<div class="message"><time>${when(m.received_ms).split(' ').pop()}</time><div><b>${esc(m.kind)}</b> · ${esc(m.test_id)}</div><span>${fmt(m.byte_length)} B · #${m.id}</span></div>`).join(''):'<div class="empty">等待消息…</div>';
}
async function refresh() { try { await Promise.all([summary(),activity(),messages()]); await Promise.all([objects(),types()]); $('health').textContent='数据库已连接'; } catch(e) { $('health').textContent='连接失败'; console.error(e); } }
let timer;
for(const id of ['search','run-filter','category-filter']) $(id).addEventListener(id==='search'?'input':'change',()=>{offset=0;clearTimeout(timer);timer=setTimeout(()=>{objects();types();},200)});
$('prev').onclick=()=>{offset=Math.max(0,offset-30);objects()}; $('next').onclick=()=>{if(count===30){offset+=30;objects()}};
$('object-rows').onclick=async e=>{const b=e.target.closest('[data-id]');if(!b)return;try{const o=await get('/api/object?'+new URLSearchParams({id:b.dataset.id,test_id:b.dataset.test}));$('detail-title').textContent=o.name||o.object_id;$('detail-sub').textContent=`${o.category} · ${o.object_id} · ${o.test_id}`;$('detail-body').textContent=JSON.stringify(o.body,null,2);$('detail').showModal()}catch(e){console.error(e)}};
$('close-detail').onclick=()=>$('detail').close();
refresh();setInterval(refresh,5000);
