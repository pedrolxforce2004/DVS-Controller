const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-auto-login-'));let browser,child,cookieLeak=false;
 const fixture=http.createServer((req,res)=>{
  if((req.headers.cookie||'').includes('dvs_'))cookieLeak=true;
  const authed=(req.headers.cookie||'').includes('site_session=fixture');
  if(req.url==='/api/session'&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{const value=JSON.parse(body);if(value.username!=='viewer'||value.password!=='fixture-only'){res.writeHead(401);res.end();return;}res.setHeader('set-cookie','site_session=fixture; HttpOnly; SameSite=Strict; Path=/');res.end('{}');});return;}
  if(req.url==='/api/data'){res.setHeader('content-type','application/json');res.writeHead(authed?200:401);res.end(JSON.stringify({message:'API autenticada'}));return;}
  res.setHeader('content-type','text/html');
  if(req.url==='/'||req.url==='/screen'&&!authed){res.writeHead(302,{location:authed?'/screen':'/login'});res.end();return;}
  if(req.url==='/login'){res.end(`<html><head></head><body><form><input name="username"><input name="password" type="password"><button>Entrar</button></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});if(r.ok)location.href='/screen';};</script></body></html>`);return;}
  res.end('<html><head></head><body><h1>Aplicacao na TV</h1><p id="data"></p><p id="socket"></p><script>fetch("/api/data").then(r=>r.json()).then(d=>document.getElementById("data").textContent=d.message);const ws=new WebSocket(`ws://${location.host}/ws`);ws.onmessage=e=>document.getElementById("socket").textContent=e.data;</script></body></html>');
 });
 fixture.on('upgrade',(req,socket)=>{if(!(req.headers.cookie||'').includes('site_session=fixture')){socket.destroy();return;}const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+key+'\r\n\r\n');const text=Buffer.from('WebSocket autenticado');socket.write(Buffer.concat([Buffer.from([129,text.length]),text]));socket.on('error',()=>{});});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));const port=42000+Math.floor(Math.random()*500),base=`http://127.0.0.1:${port}`,site=`http://127.0.0.1:${fixture.address().port}`;
 async function api(url,body){const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result;}
 try{
  child=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DVS_DATA_DIR:data,DVS_ENABLE_ADMIN_AUTH:'0'},stdio:'ignore'});
  for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const panel=(await api('/api/panels',{name:'Automatico',url:site,mode:'direct',auth:{enabled:true,username:'viewer',password:'fixture-only'}})).panel;
  browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.addCookies([{name:'dvs_sentinel',value:'private',url:base}]);const page=await context.newPage();
  await page.goto(base+'/tv-app?name=Automatico');await page.waitForFunction(()=>JSON.parse(localStorage.getItem('dvs.receiver')||'{}').id);const id=await page.evaluate(()=>JSON.parse(localStorage.getItem('dvs.receiver')).id);
  await api(`/api/tvs/${id}/command`,{type:'setPanel',panelId:panel.id});
  await page.frameLocator('#frame').locator('#data',{hasText:'API autenticada'}).waitFor({timeout:60000});await page.frameLocator('#frame').locator('#socket',{hasText:'WebSocket autenticado'}).waitFor();
  const frame=page.frames().find(f=>f.url().includes('/direct-app/'));assert.ok(frame);
  assert.equal(await frame.evaluate(()=>{try{return Boolean(parent.document);}catch{return false;}}),false);
  assert.equal(await frame.evaluate(()=>{try{return document.cookie;}catch{return 'isolated';}}),'isolated');assert.equal(cookieLeak,false);
  const stale=frame.url();await page.reload();await page.frameLocator('#frame').locator('#data',{hasText:'API autenticada'}).waitFor({timeout:30000});
  await api('/api/panels',{id:panel.id,url:site,auth:{enabled:false}});assert.equal((await fetch(stale)).status,401);
  const admin=await context.newPage();await admin.goto(base+'/admin');await admin.locator('[data-view="mediaView"]').click();
  const form=admin.locator('#panelForm');assert.equal(await form.locator('[data-video-loop]').isVisible(),false);
  await form.locator('.auth-config summary').first().click();await form.locator('[name=authEnabled]').check();
  assert.equal(await form.locator('[name=authUsername]').isVisible(),true);assert.equal(await form.locator('[name=authPassword]').isVisible(),true);
  assert.equal(await form.locator('[name=usernameSelector]').isVisible(),false);assert.equal(await form.locator('[name=loginUrl]').isVisible(),false);
  fs.mkdirSync(path.join(root,'artifacts/evidence'),{recursive:true});await form.screenshot({path:path.join(root,'artifacts/evidence/login-simplificado.png')});
  console.log('Login direto automatico: formulario JavaScript/JSON, cookies, API, WebSocket, reinicio do receiver, revogacao, isolamento e cadastro sem campos redundantes: OK');
 }finally{if(browser)await browser.close();if(child)child.kill();fixture.closeAllConnections();fixture.close();await new Promise(r=>setTimeout(r,700));fs.rmSync(data,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
