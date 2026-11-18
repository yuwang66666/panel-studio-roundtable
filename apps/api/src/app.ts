import Fastify from 'fastify';
import { z } from 'zod';
import { ConnectionInputSchema,ConnectionPatchSchema,SettingsSchema } from '@panel/contracts';
import { Repository } from './repository';
import { ModelGateway } from './gateway';
import { config } from './config';
import { AppError,safeError } from './errors';
export async function createApp(options:{dataDir?:string;logger?:boolean;recover?:boolean;gatewayOptions?:ConstructorParameters<typeof ModelGateway>[1]}={}){
 const repo=new Repository(options.dataDir||config.dataDir);if(options.recover!==false)repo.recover();
 const gateway=new ModelGateway(repo,options.gatewayOptions||{...config,retryDelay:400});
 const app=Fastify({logger:options.logger??false,disableRequestLogging:true,bodyLimit:65536});
 app.addHook('onRequest',async(req)=>{
   const hostname=req.hostname;if(!['localhost','127.0.0.1'].includes(hostname))throw new AppError('HOST_REJECTED','仅允许本地访问',403);
   if(['GET','HEAD','OPTIONS'].includes(req.method))return;
   const origin=req.headers.origin;if(origin?!config.origins.includes(origin):req.headers['x-panel-client']!=='local')throw new AppError('ORIGIN_REJECTED','请求来源不允许',403);
   if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError('CONTENT_TYPE','请使用 JSON 请求',415);
 });
 app.setErrorHandler((error,req,reply)=>{let e=error instanceof z.ZodError?new AppError('VALIDATION',error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；')):safeError(error);if((error as any).statusCode===400&&!(error instanceof AppError))e=new AppError('VALIDATION','请求格式错误');req.log.warn({code:e.code,requestId:req.id},'Request rejected');reply.code(e.status).send({error:{code:e.code,message:e.message}});});
 app.get('/api/health',async()=>({ok:true}));
 app.get('/api/model-connections',async()=>repo.listConnections());
 app.post('/api/model-connections',async(req,reply)=>{const body=ConnectionInputSchema.parse(req.body);const key=req.headers['idempotency-key'];const result=typeof key==='string'?repo.command('connection:create',key,body,()=>repo.saveConnection(body)).result:repo.saveConnection(body);return reply.code(201).send(result);});
 app.patch<{Params:{id:string}}>('/api/model-connections/:id',async(req)=>{const body=ConnectionPatchSchema.parse(req.body);const key=req.headers['idempotency-key'];return typeof key==='string'?repo.command('connection:'+req.params.id,key,body,()=>repo.patchConnection(req.params.id,body)).result:repo.patchConnection(req.params.id,body);});
 app.post<{Params:{id:string}}>('/api/model-connections/:id/test',async(req)=>{const c=repo.connection(req.params.id);if(!c.active)throw new AppError('DISABLED','请先启用连接',409);try{await gateway.generate({connection:c,purpose:'test',input:{},schema:z.object({ok:z.literal(true)}).strict()});repo.markTest(c.id,c.version,true);return {ok:true,message:'连接验证通过，可用于圆桌讨论。'};}catch(e){repo.markTest(c.id,c.version,false);throw e;}});
 app.get('/api/settings',async()=>repo.settings());
 app.patch('/api/settings',async(req)=>repo.saveSettings(SettingsSchema.parse(req.body).defaultModeratorConnectionId));
 app.addHook('onClose',async()=>{repo.close();});
 return {app,repo,gateway};
}
