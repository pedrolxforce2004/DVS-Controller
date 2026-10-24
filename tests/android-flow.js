const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');
(async()=>{
 const source=path.resolve(__dirname,'../lib/android-manager.js'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'dvs-adb-flow-'));const calls=[];let state='device';
 const context=vm.createContext({require:createRequire(source),module:{exports:{}},__dirname:path.dirname(source),process,console,setTimeout,clearTimeout,execute:async(args)=>{
  calls.push(args);if(args[0]==='devices')return{output:`List of devices attached\n192.0.2.20:5555\t${state}\n`};
  return{output:args.includes('install')?'Success':'OK'};
 }});
 try{
  vm.runInContext(fs.readFileSync(source,'utf8')+'\nrun=execute;',context);const manager=context.module.exports,device={host:'192.0.2.20',port:5555,name:"Sala 1; 'painel'",autoLaunch:true};
  await manager.connect(device);assert.equal(calls[0][0],'start-server');
  await manager.configureReceiver(device,{server:'http://192.0.2.1:3080'});const broadcast=calls.find(a=>a.includes('broadcast'));assert.ok(broadcast[broadcast.indexOf('name')+1].startsWith("'"));
  fs.mkdirSync(path.join(temp,'dist'));fs.writeFileSync(path.join(temp,'dist/DVS-Receiver-0.6.9.apk'),'fixture');await manager.install(device,temp);assert.ok(calls.some(a=>a.includes('install')&&a.includes('-r')));
  await manager.launch(device);await manager.close(device);assert.ok(calls.some(a=>a.includes('force-stop')));
  state='unauthorized';await assert.rejects(()=>manager.connect(device),/Autorize/);
  assert.throws(()=>manager._test.target({serial:'-s attacker'}),/invalido/);
  console.log('Fluxo ADB: daemon, conexao, autorizacao, instalacao -r, configuracao com nome composto, abertura e encerramento: OK (TV simulada)');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
