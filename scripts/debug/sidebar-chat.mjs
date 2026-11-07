// Local QA only: fresh temporary Host, synthetic media and a simulated DSH chat transport.
// No existing projects, browser profiles, credentials or generation providers are used.
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { testHost } from '../../test/fixtures/director-host.js'
import { providerConnectionsFixture } from '../../test/fixtures/provider-connections.js'

const root = await mkdtemp(join(tmpdir(), 'vd-sidebar-smoke-'))
const settingsFixture = process.argv.includes('--settings') ? providerConnectionsFixture() : undefined
const host = await testHost(join(root, 'host'), settingsFixture ? { providerOptions: { fetchImpl: settingsFixture.fetchImpl } } : {})
if (settingsFixture) {
  host.providerSettings.base.providers = settingsFixture.providers
  host.providerSettings.refresh()
  host.providers.codexPlan.check = () => {}
}
const project = await host.store.createProject({ name: 'Synthetic sidebar studio', sessionId: 'synthetic-chat' })
await host.rpc('library/command', { projectId: project.id, sessionId: project.sessionId, command: 'create', args: { name: 'storyboard-review', description: 'Check shot order and visual continuity.', content: 'Inspect only requested nodes. Suggest small revisions and inspect each change.' } })
await host.store.cacheDraft(project.id, { name: project.name, settings: project.settings, graph: { nodes: [
  { id: 'script', type: 'director', position: { x: 60, y: 70 }, data: { kind: 'load-text', title: 'Opening scene', text: 'A paper boat crosses a blue pond.', status: 'idle' } },
  { id: 'image', type: 'director', position: { x: 440, y: 70 }, data: { kind: 'load-image', title: 'Storyboard frame', mediaKind: 'image', status: 'idle' } },
], edges: [], viewport: { x: 15, y: 10, zoom: .85 } } })
await mkdir(join(root, 'Shot references', 'Scenes'), { recursive: true })
await writeFile(join(root, 'Shot references', 'Scenes', 'script.txt'), 'Synthetic scene one: a paper boat.')
await writeFile(join(root, 'Shot references', 'README.md'), '# Synthetic folder\nNo private assets.')
for (const [name, args] of [
  ['color.png', ['-f', 'lavfi', '-i', 'color=c=royalblue:size=240x160', '-frames:v', '1']],
  ['tone.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2']],
  ['bars.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
]) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, join(root, name)])
if (process.argv.includes('--asset-picker')) {
  const dataBase64 = (await readFile(join(root, 'color.png'))).toString('base64')
  for (let index = 0; index < 46; index++) await host.store.putAsset({ projectId: project.id, kind: 'image', mimeType: 'image/png',
    name: `scene-${String(index).padStart(2, '0')}.png`, origin: index < 23 ? 'output' : 'input', dataBase64 })
  for (const [kind, name, mimeType] of [['video', 'bars.mp4', 'video/mp4'], ['audio', 'tone.wav', 'audio/wav']]) {
    await host.store.putAsset({ projectId: project.id, kind, name, mimeType, dataBase64: (await readFile(join(root, name))).toString('base64') })
  }
}
const bundle = await build({ stdin: { resolveDir: resolve('src/client'), loader: 'tsx', contents: `
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import { DirectorOverlay } from './App'; import { DirectorController } from './controller';
  import { ProjectChatSource } from './chat-source'; import { setLanguage } from './i18n';
  const observable = value => { const listeners = new Set(); return { getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},publish:next=>{value=next;listeners.forEach(fn=>fn())} } };
  const sessionId = 'synthetic-chat'; const events = observable({entries:[]}); let retire;
  const inbox = observable({'next-turn':[],'next-step':[]});
  const binding = { eventSource:events, session:{...observable({running:false}),projections:{faceOf:()=>inbox},rename:async()=>({ok:true,value:{}}),beginSubmission:input=>{retire=input.onRetire;return{requestId:crypto.randomUUID(),abandon:()=>retire?.({reason:'failed'})}},prompt:async(content, mode,signal,requestId)=>{window.lastSubmission={content,mode,requestId};retire?.({reason:'observed'});return{ok:true,value:{accepted:true}}} } };
  const retain = () => ({binding,ready:Promise.resolve(binding),release:()=>{}});
  const modelState = observable({current:{provider:'fixture',model:'synthetic'},routable:true,groups:[{id:'fixture',name:'Local QA',models:[{id:'synthetic',name:'Simulated transport'}]}],failures:[],status:'ready',error:null,pending:null});
  const settingsState = observable({open:false,activeId:undefined});
  const settingsStore = {...settingsState, actions:{openSection:section=>settingsState.publish({open:true,activeId:section}),close:()=>settingsState.publish({open:false})}};
  const ctx = { connection:{rpc:{call:async(_,method,{endpoint,payload:input})=> (await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,input})})).json()}},
    slots:{entries:name=>name==='sidebar.settings'?[{store:{create:()=>settingsStore}}]:[]},
    sessions:{list:observable({byId:{[sessionId]:{id:sessionId,retainedBy:{}}}}),retain,using:async(id,options,callback)=>{const reference=retain();try{return await callback(reference)}finally{reference.release()}},refresh:async()=>{},create:async()=>sessionId},
    uiWorkspace:{openSession:()=>{}},
    modelDirectories:{directoryFor:()=>({store:modelState,load:async()=>modelState.getSnapshot(),select:async()=>({ok:true,value:{}})})} };
  const director = new DirectorController(ctx); await director.start(); director.open();
  const chat = new ProjectChatSource(ctx,director); setLanguage('en');
  function Fixture() {
    const settings=React.useSyncExternalStore(settingsState.subscribe,settingsState.getSnapshot);
    return <><DirectorOverlay director={director} chat={chat}/>{settings.open && <div role="dialog" aria-label="Synthetic dsh model settings" style={{position:'fixed',inset:100,background:'white',padding:30}}>
      <h2>Synthetic dsh model settings</h2><button onClick={()=>{modelState.publish({...modelState.getSnapshot(),groups:[{id:'fixture',name:'Local QA',models:[{id:'synthetic',name:'Simulated transport'},{id:'new-model',name:'New synthetic model'}]}]});settingsStore.actions.close()}}>Save synthetic model and return</button>
    </div>}</>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
  window.director=director;window.chat=chat;
` }, bundle: true, platform: 'browser', format: 'esm', write: false, jsx: 'automatic', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"development"' } })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (settingsFixture && url.pathname === '/qa/providers') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(settingsFixture.calls)); return }
    if (url.pathname === '/rpc') {
      const buffers = []; for await (const part of req) buffers.push(part)
      const { endpoint, input } = JSON.parse(Buffer.concat(buffers).toString())
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await host.rpc(endpoint, input))); return
    }
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return }
    if (url.pathname === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return }
    const match = /^\/api\/video-director\/assets\/([^/]+)(\/properties)?$/.exec(url.pathname)
    if (match) {
      const response = match[2] ? Response.json(await host.rpc('assets/properties', { assetId: match[1] })) : await host.store.assetResponse(match[1], new Request(url, { method: req.method, headers: req.headers }))
      res.writeHead(response.status, Object.fromEntries(response.headers)); if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end(); return
    }
    res.writeHead(404).end()
  } catch (error) { res.writeHead(500).end(String(error)) }
})
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, fixtureRoot: root, projectId: project.id })))
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, async () => { server.close(); await host.close(); await rm(root, { recursive: true, force: true }); process.exit(0) })
