import { randomUUID } from 'node:crypto';
import { CastOutputSchema, type Discussion, type Participant } from '@panel/contracts';
import type { Repository } from './repository';
import type { ModelGateway } from './gateway';
import { AppError,safeError } from './errors';
import { DiscussionEngine } from './engine';
import { InsightsService } from './insights';
export class DiscussionService{
  private active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stopping=false;
  readonly insights:InsightsService;readonly engine:DiscussionEngine;
  constructor(readonly repo:Repository,readonly gateway:ModelGateway){this.insights=new InsightsService(repo,gateway);this.engine=new DiscussionEngine(repo,gateway,this.insights);}
  run(id:string){this.launch(id,'discussion',signal=>this.engine.run(id,signal));}
  summarize(id:string){this.launch(id,'summary',signal=>this.insights.finish(id,this.repo.discussion(id).generation,signal));}
  cast(id:string){this.launch(id,'cast',async(signal)=>{
    const d=this.repo.discussion(id),connection=this.repo.hostConnection(id);
    const cast=await this.gateway.generate({connection,purpose:'cast',discussionId:id,generation:d.generation,input:{topic:d.topic,expertCount:d.expertCount},schema:CastOutputSchema,signal,validate:(cast)=>{
      const all=[cast.moderator,...cast.experts];if(cast.experts.length!==d.expertCount||new Set(all.map(p=>p.name)).size!==all.length||new Set(cast.experts.map(p=>p.occupation+'|'+p.title)).size!==d.expertCount||new Set(cast.experts.map(p=>p.stance)).size!==d.expertCount)throw new AppError('INVALID_OUTPUT','阵容人数或差异性不符合要求',502);
    }});
    const participants:Participant[]=[cast.moderator,...cast.experts].map((p,i)=>({...p,id:randomUUID(),discussionId:id,role:i===0?'moderator':'expert',colorKey:i,status:'idle',publicFocus:null}));
    this.repo.saveCast(id,d.generation,participants);
  });}
  protected launch(id:string,stage:Discussion['failureStage'],work:(signal:AbortSignal)=>Promise<void>){
    if(this.active.has(id))return;
    const controller=new AbortController();const generation=this.repo.discussion(id).generation;
    const promise=Promise.resolve().then(()=>work(controller.signal)).catch(error=>{
      controller.abort();const d=this.repo.discussion(id);if(d.generation!==generation||!['casting','running','summarizing'].includes(d.status))return;
      const e=safeError(error);this.repo.transition(id,this.stopping&&d.status!=='casting'?'interrupted':'failed',{generation,bumpGeneration:this.stopping,failureStage:e.code==='INSIGHTS_FAILED'?'insights':d.status==='summarizing'?'summary':stage,error:this.stopping?'服务已停止，已有讨论内容已保存':e.message});this.repo.clearStates(id);
    }).finally(()=>{if(this.active.get(id)?.controller===controller)this.active.delete(id);});
    this.active.set(id,{controller,promise});
  }
  hasActive(id:string){return this.active.has(id);}
  async idle(id:string){await this.active.get(id)?.promise;}
  async close(){this.stopping=true;for(const job of this.active.values())job.controller.abort();await Promise.allSettled([...this.active.values()].map(j=>j.promise));await this.insights.close();}
}
