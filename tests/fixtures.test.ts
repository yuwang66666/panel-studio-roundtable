import { describe,it,expect } from 'vitest';
import { SnapshotSchema, CastOutputSchema, IntentSchema, UtteranceOutputSchema, ProseOutputSchema, InsightOutputSchema } from '../packages/contracts/src/index';
import { makeSample } from '../packages/domain/src/samples';
import { defaultResponse,startProvider } from './fixtures/provider';
describe('可重复的模型与数据测试基线',()=>{
  it('five labelled snapshots are valid and references stay inside the discussion',()=>{
    for(let i=0;i<5;i++){const s=SnapshotSchema.parse(makeSample(i));expect(s.discussion.isSample).toBe(true);expect(s.participants).toHaveLength(5);for(const insight of s.insights)for(const evidence of insight.evidence)expect(s.messages.some(m=>m.id===evidence.messageId&&m.discussionId===s.discussion.id)).toBe(true);}
  });
  it('model fixtures conform to business output schemas',()=>{
    const s=makeSample(0),input={context:{...s,participant:s.participants[1]}};
    CastOutputSchema.parse(defaultResponse({purpose:'cast',input:{expertCount:4}}));
    IntentSchema.parse(defaultResponse({purpose:'intent',input}));
    UtteranceOutputSchema.parse(defaultResponse({purpose:'utterance',input}));
    ProseOutputSchema.parse(defaultResponse({purpose:'summary',input}));
    InsightOutputSchema.parse(defaultResponse({purpose:'insights',input}));
  });
  it('HTTP fixture can reproduce rate limiting and a subsequent successful response',async()=>{
    const provider=await startProvider();try{provider.fail(429);const call=()=>fetch(provider.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({messages:[{role:'user',content:JSON.stringify({purpose:'test',input:{}})}]})});expect((await call()).status).toBe(429);expect((await call()).status).toBe(200);expect(provider.calls).toHaveLength(2);}finally{await provider.close();}
  });
});
