import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { resolve,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../apps/api/src/app';
import { startProvider,type Responder } from './provider';
export async function harness(responder?:Responder){mkdirSync(resolve('.tmp'),{recursive:true});const dir=mkdtempSync(resolve('.tmp/app-'));const provider=await startProvider(responder);const s=await createApp({dataDir:dir,gatewayOptions:{globalConcurrency:4,connectionConcurrency:2,timeout:1500,summaryTimeout:1500,retryDelay:2}});const connection=s.repo.saveConnection({name:'测试模型',provider:'custom',protocol:'openai-chat',baseUrl:provider.baseUrl,model:'fixture-model',apiKey:'not-a-real-key',active:true,structuredOutput:false});s.repo.saveSettings(connection.id);
 const command=(method:'POST'|'PUT'|'PATCH',url:string,payload:unknown,key:string=randomUUID())=>s.app.inject({method,url,headers:{'x-panel-client':'local','content-type':'application/json','idempotency-key':key},payload:payload as any});
 return {...s,provider,connection,command,close:async()=>{await s.app.close();await provider.close();if(!dir.startsWith(resolve('.tmp')+sep))throw Error('invalid cleanup path');rmSync(dir,{recursive:true,force:true});}};
}
