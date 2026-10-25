import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'observatory.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
PRAGMA cache_size=-32768; PRAGMA journal_size_limit=67108864;
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, received_ms INTEGER NOT NULL,
 test_id TEXT NOT NULL, kind TEXT NOT NULL, byte_length INTEGER NOT NULL, body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_time ON messages(received_ms DESC);
CREATE TABLE IF NOT EXISTS objects (
 test_id TEXT NOT NULL, object_id TEXT NOT NULL, name TEXT, type_id TEXT, category TEXT,
 sequence INTEGER NOT NULL, updated_ms INTEGER NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(test_id,object_id)
);
CREATE INDEX IF NOT EXISTS objects_recent ON objects(updated_ms DESC);
CREATE INDEX IF NOT EXISTS objects_type ON objects(type_id);
CREATE INDEX IF NOT EXISTS objects_category ON objects(category);
CREATE TABLE IF NOT EXISTS type_nodes (
 test_id TEXT NOT NULL, type_id TEXT NOT NULL, parent_id TEXT, name TEXT,
 revision INTEGER NOT NULL, PRIMARY KEY(test_id,type_id)
);
CREATE TABLE IF NOT EXISTS metrics (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO metrics(key,value) VALUES ('messages',0),('duplicates',0),('objects_seen',0),('trees_seen',0),('rejected',0);
`);
const sql = {
  insertMessage: db.prepare('INSERT OR IGNORE INTO messages(digest,received_ms,test_id,kind,byte_length,body) VALUES (?,?,?,?,?,?)'),
  object: db.prepare(`INSERT INTO objects(test_id,object_id,name,type_id,category,sequence,updated_ms,body)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(test_id,object_id) DO UPDATE SET
    name=excluded.name,type_id=excluded.type_id,category=excluded.category,
    sequence=excluded.sequence,updated_ms=excluded.updated_ms,body=excluded.body
    WHERE excluded.sequence >= objects.sequence`),
  type: db.prepare(`INSERT INTO type_nodes(test_id,type_id,parent_id,name,revision) VALUES (?,?,?,?,?)
    ON CONFLICT(test_id,type_id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,revision=excluded.revision
    WHERE excluded.revision >= type_nodes.revision`),
  metric: db.prepare('UPDATE metrics SET value=value+? WHERE key=?'),
};
const isRecord = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const first = (...xs) => xs.find(x => x !== undefined && x !== null && x !== '');
const str = x => x == null ? null : String(x);
function candidates(value, depth = 0, out = []) {
  if (depth > 5 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const x of value) candidates(x, depth + 1, out); return out; }
  const id = first(value.object_id, value.entity_id, value.id);
  const hasShape = id != null && (value.type_id != null || value.attributes != null || value.body != null || value.position != null || value.name != null || value.category != null);
  if (hasShape) { out.push(value); return out; }
  for (const [key, child] of Object.entries(value)) {
    if (['tree','type_tree','taxonomy','nodes','types'].includes(key)) continue;
    if (child && typeof child === 'object') candidates(child, depth + 1, out);
  }
  return out;
}
function treeNodes(payload) {
  const tree = first(payload.tree, payload.type_tree, payload.taxonomy);
  const nodes = first(tree?.nodes, payload.nodes, Array.isArray(payload.types) ? payload.types : undefined);
  return Array.isArray(nodes) ? nodes : [];
}
function classify(o) {
  const raw = first(o.category, o.family, o.kind, o.body_kind, o.type_name, o.type?.name, o.type_id);
  return String(raw ?? 'unknown').split(/[/.]/)[0].slice(0, 80);
}
function project(payload, received) {
  const testId = String(first(payload.test_id, payload.run_id, 'unassigned')).slice(0, 160);
  const seq = Number(first(payload.sequence, payload.first_sequence, payload.batch_sequence, 0));
  let objectCount = 0, treeCount = 0;
  for (const o of candidates(payload)) {
    const id = str(first(o.object_id, o.entity_id, o.id));
    if (!id) continue;
    const version = Number(first(o.sequence, o.version, o.revision, seq));
    sql.object.run(testId, id, str(first(o.name, o.label, o.designation, id))?.slice(0, 240),
      str(first(o.type_id, o.type?.id)), classify(o), Number.isFinite(version) ? version : 0,
      received, JSON.stringify(o));
    objectCount++;
  }
  const tree = first(payload.tree, payload.type_tree, payload.taxonomy);
  const revision = Number(first(tree?.revision, payload.revision, 0));
  for (const n of treeNodes(payload)) {
    if (!isRecord(n)) continue;
    const id = str(first(n.type_id, n.id, n.node));
    if (!id) continue;
    sql.type.run(testId, id, str(first(n.parent_id, n.parent)),
      str(first(n.name, n.label, id)), Number.isFinite(revision) ? revision : 0);
    treeCount++;
  }
  if (objectCount) sql.metric.run(objectCount, 'objects_seen');
  if (treeCount) sql.metric.run(treeCount, 'trees_seen');
  return { testId, objectCount, treeCount };
}
function ingest(body) {
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { sql.metric.run(1, 'rejected'); return { code: 400, result: { error: 'invalid JSON' } }; }
  if (!isRecord(payload)) { sql.metric.run(1, 'rejected'); return { code: 422, result: { error: 'expected JSON object' } }; }
  const received = Date.now();
  const testId = String(first(payload.test_id, payload.run_id, 'unassigned')).slice(0, 160);
  const kind = String(first(payload.kind, payload.workload, payload.type, 'unknown')).slice(0, 80);
  const inserted = sql.insertMessage.run(digest, received, testId, kind, body.length, body).changes;
  let projection = { objectCount: 0, treeCount: 0 };
  if (inserted) { projection = project(payload, received); sql.metric.run(1, 'messages'); }
  else sql.metric.run(1, 'duplicates');
  return { code: 200, result: { stored: Boolean(inserted), ...projection } };
}
function json(res, code, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
const bounded = (x, fallback, max) => Math.min(max, Math.max(1, Number(x) || fallback));
function api(url, res) {
  const testId = url.searchParams.get('test_id');
  if (url.pathname === '/health') return json(res, 200, { status: 'ok', database: 'ready' });
  if (url.pathname === '/api/summary') {
    const metrics = Object.fromEntries(db.prepare('SELECT key,value FROM metrics').all().map(r=>[r.key,r.value]));
    const categories = db.prepare('SELECT category,COUNT(*) count FROM objects GROUP BY category ORDER BY count DESC LIMIT 12').all();
    const kinds = db.prepare('SELECT kind,COUNT(*) count FROM messages GROUP BY kind ORDER BY count DESC').all();
    const runs = db.prepare('SELECT test_id,COUNT(*) messages,MAX(received_ms) last_ms FROM messages GROUP BY test_id ORDER BY last_ms DESC LIMIT 20').all();
    const totalObjects = db.prepare('SELECT COUNT(*) n FROM objects').get().n;
    const totalTypes = db.prepare('SELECT COUNT(*) n FROM type_nodes').get().n;
    const last = db.prepare('SELECT MAX(received_ms) ms FROM messages').get().ms;
    return json(res, 200, { metrics, categories, kinds, runs, totalObjects, totalTypes, last });
  }
  if (url.pathname === '/api/activity') {
    const since = Date.now() - bounded(url.searchParams.get('minutes'), 60, 1440) * 60000;
    const rows = db.prepare('SELECT (received_ms / 60000) minute, COUNT(*) messages, SUM(byte_length) bytes FROM messages WHERE received_ms >= ? GROUP BY minute ORDER BY minute').all(since);
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/objects') {
    const limit = bounded(url.searchParams.get('limit'), 30, 100);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const q = (url.searchParams.get('q') || '').slice(0, 100);
    const category = (url.searchParams.get('category') || '').slice(0, 80);
    const clauses = [], args = [];
    if (testId) { clauses.push('test_id=?'); args.push(testId); }
    if (category) { clauses.push('category=?'); args.push(category); }
    if (q) { clauses.push('(object_id LIKE ? OR name LIKE ? OR type_id LIKE ?)'); args.push(...Array(3).fill('%'+q+'%')); }
    const where = clauses.length ? 'WHERE '+clauses.join(' AND ') : '';
    const rows = db.prepare(`SELECT test_id,object_id,name,type_id,category,sequence,updated_ms FROM objects ${where} ORDER BY updated_ms DESC LIMIT ? OFFSET ?`).all(...args,limit,offset);
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/object') {
    const id = url.searchParams.get('id');
    if (!id || !testId) return json(res, 400, { error: 'id and test_id required' });
    const row = db.prepare('SELECT * FROM objects WHERE test_id=? AND object_id=?').get(testId,id);
    return json(res, row ? 200 : 404, row ? { ...row, body: JSON.parse(row.body) } : { error: 'not found' });
  }
  if (url.pathname === '/api/types') {
    const rows = testId ? db.prepare('SELECT * FROM type_nodes WHERE test_id=? ORDER BY revision DESC LIMIT 500').all(testId)
      : db.prepare('SELECT * FROM type_nodes ORDER BY revision DESC LIMIT 500').all();
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/messages') {
    const rows = db.prepare('SELECT id,received_ms,test_id,kind,byte_length FROM messages ORDER BY id DESC LIMIT 30').all();
    return json(res, 200, rows);
  }
  if (url.pathname === '/api/message') {
    const id = Number(url.searchParams.get('id'));
    const row = db.prepare('SELECT id,received_ms,test_id,kind,byte_length,body FROM messages WHERE id=?').get(id);
    return json(res, row ? 200 : 404, row ? { ...row, body: JSON.parse(row.body.toString('utf8')) } : { error: 'not found' });
  }
  return json(res, 404, { error: 'not found' });
}
const staticFiles = new Map([['/','index.html'],['/app.js','app.js'],['/style.css','style.css']]);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8' };
let pending = [], flushTimer = null;
function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = pending; pending = [];
  if (!batch.length) return;
  try {
    db.exec('BEGIN IMMEDIATE');
    const outcomes = batch.map(({body})=>ingest(body));
    db.exec('COMMIT');
    for (let i=0;i<batch.length;i++) json(batch[i].res,outcomes[i].code,outcomes[i].result);
  } catch(e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error('ingest failed',e);
    for (const item of batch) json(item.res,503,{error:'durable write failed'});
  }
}
const server = http.createServer((req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/ingest') {
    const dbPath=path.join(dataDir,'observatory.db');
    const used=['','-wal','-shm'].reduce((n,suffix)=>{try{return n+fs.statSync(dbPath+suffix).size}catch{return n}},0);
    if (used > 18*1024**3) return json(res,507,{error:'storage budget reached'});
    const chunks = []; let size = 0, oversized = false;
    req.on('data', chunk => { size += chunk.length; if (size > 8*1024*1024) { oversized=true; chunks.length=0; } else if (!oversized) chunks.push(chunk); });
    req.on('end', () => { if (oversized) return json(res,413,{error:'message exceeds 8 MiB'});
      pending.push({body:Buffer.concat(chunks),res});
      if (pending.length >= 64) flush(); else if (!flushTimer) flushTimer=setTimeout(flush,5); });
    return;
  }
  if (req.method !== 'GET') return json(res,405,{error:'method not allowed'});
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    try { return api(url,res); } catch(e) { console.error('api failed',e); return json(res,500,{error:'query failed'}); }
  }
  const file = staticFiles.get(url.pathname);
  if (!file) return json(res,404,{error:'not found'});
  const body = fs.readFileSync(path.join(root,'public',file));
  res.writeHead(200,{'content-type':mime[path.extname(file)],'content-length':body.length,'cache-control':'no-cache'}); res.end(body);
});
const port = Number(process.env.PORT || 8000);
server.listen(port, '0.0.0.0', () => console.log(`Observatory listening on :${port}`));
process.on('SIGTERM',()=>server.close(()=>{ db.close(); process.exit(0); }));
