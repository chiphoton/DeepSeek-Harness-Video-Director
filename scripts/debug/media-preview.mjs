// Isolated browser/performance fixture. Never reads the user's data directory.
// Run: node scripts/debug/media-preview.mjs
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { ProjectStore } from '../../src/project-store.js'

const root = await mkdtemp(join(tmpdir(), 'vd-media-smoke-'))
const store = new ProjectStore(join(root, 'store'), 20 * 1024 * 1024)
await store.init()
const project = await store.createProject({ name: 'Synthetic playback test', sessionId: 'synthetic' })
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(root, 'video.mp4')])
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '8', join(root, 'audio.wav')])
const assets = []
for (const [kind, extension, mimeType] of [['video', 'mp4', 'video/mp4'], ['audio', 'wav', 'audio/wav']]) {
  assets.push(await store.putAsset({ projectId: project.id, kind, name: `Synthetic ${kind}.${extension}`, mimeType,
    dataBase64: (await readFile(join(root, `${kind}.${extension}`))).toString('base64') }))
}
const metrics = { requests: [] }
// Optional committed client baseline for repeatable before/after measurements.
const baseline = process.env.VD_SMOKE_BASELINE
const plugins = baseline ? [{ name: 'committed-client', setup(build) {
  build.onLoad({ filter: /\/src\/client\/.*\.(?:tsx?|css|js)$/ }, args => ({
    contents: execFileSync('git', ['show', `${baseline}:${relative(resolve('.'), args.path)}`], { encoding: 'utf8' }),
    loader: extname(args.path) === '.css' ? 'text' : extname(args.path).slice(1), resolveDir: dirname(args.path),
  }))
} }] : []
const bundle = await build({ stdin: { resolveDir: resolve('src/client'), loader: 'tsx', contents: `
  import React, { Profiler } from 'react';
  import { createRoot } from 'react-dom/client';
  import { DirectorOverlay } from './App';
  import { DirectorController } from './controller';
  import { groupJobHistory, pageJobHistory } from '../job-history.js';
  import { setLanguage } from './i18n';
  const { project, assets } = await (await fetch('/fixture')).json();
  const count = Number(new URL(location.href).searchParams.get('count') ?? 80);
  const now = new Date().toISOString();
  const nodes = Array.from({length: count}, (_, i) => ({id: 'preview-' + i, type: 'director', position: {x: i % 8 * 400, y: Math.floor(i / 8) * 300}, data: {kind: 'preview', frozen: true, title: 'Synthetic ' + i, mediaKind: assets[i % 2].kind, assets: [{...assets[i % 2], url: assets[i % 2].url + '?copy=' + i}], status: 'completed'}}));
  nodes.push({id:'generating', type:'director',position:{x:0,y:-350},data:{kind:'video-generation',title:'Simulated running job',status:'running'}});
  project.graph = {nodes, edges: [], viewport: {x:50,y:400,zoom:.75}};
  project.status = 'running';
  const jobs = Array.from({length:count}, (_, i) => ({id:'job-' + i,projectId:project.id,nodeId:'preview-' + i,operation:'video',status:'completed',progress:1,createdAt:now,updatedAt:now,startedAt:now,completedAt:now,result:{kind:'assets',assets:nodes[i].data.assets}}));
  jobs.push({id:'active', workflowRunId:'run', projectId:project.id,nodeId:'generating',operation:'video',status:'running',progress:.5,createdAt:now,updatedAt:now,startedAt:now});
  project.jobs = jobs;
  const runs = [{id:'run',projectId:project.id,status:'running',scheduler:'host',startedAt:now,executionStartedAt:now,totalJobs:1,completedJobs:0,mode:'all'}];
  const projects = [{...project,graph:undefined,jobs:undefined,nodeCount:nodes.length}];
  window.metrics = {notifications:0,commits:0,renderMs:0,rpcs:0,longTasks:[]};
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => window.metrics.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});
  let tick = 0;
  const director = new DirectorController({sessions:{list:{getSnapshot:()=>({current:'synthetic',byId:{synthetic:{}},ids:['synthetic']})}},connection:{rpc:{call:async (_, endpoint, input) => {
    window.metrics.rpcs++;
    if(endpoint==='jobs/list' && runs[0].status==='running') { jobs.at(-1).updatedAt = new Date().toISOString(); jobs.at(-1).progress = (++tick % 100) / 100; }
    if(endpoint==='vd-runs/cancel') { runs[0].status='cancelled'; runs[0].completedAt=new Date().toISOString(); jobs.at(-1).status='cancelled'; jobs.at(-1).completedAt=runs[0].completedAt; projects[0].status='ready'; }
    if (endpoint === 'jobs/history') {
      const page = pageJobHistory(groupJobHistory(runs, jobs).filter(group => !input.projectId || group.projectId === input.projectId), input);
      (window.metrics.historyPages ??= []).push({before:input.before,returned:page.groups.length});
      return {ok:true,value:structuredClone(page)};
    }
    const value = endpoint==='vd-runs/list'?{runs}:endpoint==='vd-runs/get'?{run:runs[0]}:endpoint==='jobs/list'?{jobs}:endpoint==='projects/list'?{projects}:endpoint==='vd-runs/jobs'?{jobs:jobs.slice(-1)}:{};
    return {ok:true,value:structuredClone(value)};
  }}}});
  director.snapshot = {...director.getSnapshot(),phase:'ready',open:true,...structuredClone({project,projects,jobs,workflowRuns:runs})};
  director.subscribe(()=>window.metrics.notifications++);
  const chatState = {sessionId:'synthetic',messages:[],running:false,sending:false,error:null,models:{groups:[],current:null,status:'ready',error:null}};
  const emptyAttachments = [];
  const registry = {subscribe:()=>()=>{},getSnapshot:()=>emptyAttachments,load:async()=>{}};
  const chat = {subscribe:()=>()=>{},getSnapshot:()=>chatState,attachments:()=>registry};
  setLanguage('en');
  createRoot(document.getElementById('root')).render(<Profiler id="studio" onRender={(_,phase,duration)=>{window.metrics.commits++;window.metrics.renderMs+=duration}}><DirectorOverlay director={director} chat={chat} /></Profiler>);
  window.director = director;
  window.fixture = {project,assets};
  void director.observeHostRuns(['run']).catch(error => { window.metrics.runOutcome = error.message; });
` }, plugins, bundle: true, format: 'esm', platform: 'browser', write: false, jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"' } })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/fixture') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ project, assets })); return }
    if (url.pathname === '/metrics') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(metrics)); return }
    if (url.pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return }
    const match = /^\/api\/video-director\/assets\/([^/]+)(\/properties)?$/.exec(url.pathname)
    if (!match) { res.writeHead(404).end(); return }
    const abort = new AbortController()
    res.on('close', () => { if (!res.writableEnded) abort.abort() })
    const request = new Request(url, { method: req.method, headers: req.headers, signal: abort.signal })
    const response = (match[2] || url.search.endsWith('/properties')) ? Response.json({ ok: true, value: await store.videoProperties(match[1], request.signal) }) : await store.assetResponse(match[1], request)
    metrics.requests.push({ path: req.url, range: req.headers.range, status: response.status, bytes: response.headers.get('Content-Length') })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res)
    else res.end()
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, fixtureRoot: root })))
process.on('SIGINT', () => server.close(async () => { await rm(root, { recursive: true, force: true }); process.exit() }))
