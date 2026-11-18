import { describe, it, expect } from 'vitest';
import { CreateDiscussionSchema, ConnectionSummarySchema, ParticipantSchema } from '../packages/contracts/src/index';
import { assertTransition, callBudget } from '../packages/domain/src/index';
describe('契约与生命周期', () => {
  it('rejects skipped completion and restarting completed discussion', () => {
    expect(() => assertTransition('running','completed')).toThrow();
    expect(() => assertTransition('completed','running')).toThrow();
    expect(() => assertTransition('running','summarizing')).not.toThrow();
  });
  it('limits expert counts and topic', () => {
    expect(CreateDiscussionSchema.safeParse({topic:'城市公共交通应如何发展'}).success).toBe(true);
    expect(CreateDiscussionSchema.safeParse({topic:'城市公共交通应如何发展',expertCount:7}).success).toBe(false);
    expect(CreateDiscussionSchema.safeParse({topic:'短'}).success).toBe(false);
  });
  it('rejects private fields in public connection and participant', () => {
    const data = {id:'c', name:'模型',provider:'deepseek',protocol:'openai-chat',baseUrl:'https://example.com/v1',model:'model',structuredOutput:false,active:true,version:1,hasApiKey:true,testedAt:null,testStatus:'untested',createdAt:'2026-11-18'};
    expect(ConnectionSummarySchema.safeParse(data).success).toBe(true);
    expect(ConnectionSummarySchema.safeParse({...data,apiKey:'secret'}).success).toBe(false);
    expect(ParticipantSchema.safeParse({id:'p',discussionId:'d',role:'expert',name:'专家',occupation:'职业',title:'头衔',stance:'立场',specialty:[],colorKey:1,status:'idle',publicFocus:null,reasoning:'hidden'}).success).toBe(false);
  });
  it('scales budget for six experts', () => { expect(callBudget(4)).toBe(120); expect(callBudget(6)).toBe(144); });
});
