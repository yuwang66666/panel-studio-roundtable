import type { DiscussionSnapshot, Participant } from '@panel/contracts';
export const SAMPLE_TOPICS = ['生成式 AI 会取代初级岗位，还是创造新的机会？','城市是否应优先发展公共交通？','远程办公应该成为企业的长期制度吗？','企业如何选择开源模型与商业模型？','自动驾驶大规模落地，还缺少什么？'];
const cases = [
  { focus:'岗位转型', a:'AI 正在压缩重复性任务，但任务减少不等于整个岗位消失。企业需要同步投入培训，让初级员工转向判断与协作。', b:'我同意培训的必要性，但不能把转型成本全部交给员工。招聘入口缩减后，新人可能连积累经验的机会都没有。', c:'可以把培训与真实项目结合，让新人逐步承担审核和客户沟通。成效应同时看生产率与初级员工的留任率。', consensus:'岗位转型需要配套培训及真实实践机会。', divergence:'企业提高效率的收益能否覆盖新人的转型成本，仍存在分歧。', question:'怎样衡量 AI 部署对初级员工长期成长的影响？' },
  { focus:'公共交通优先', a:'在高密度城区，公交和轨道交通更适合承载集中出行。优先投入应与步行接驳一起规划。', b:'我支持改善接驳，但低密度地区不能简单复制轨道模式。服务覆盖与财政负担需要一起评估。', c:'可以先提升公交可靠性，再根据客流决定轨道投资。每个区域都应设定可衡量的可达性目标。', consensus:'公共交通建设应改善接驳和出行可达性。', divergence:'不同密度地区应投入多少轨道资源，判断存在差异。', question:'如何同时衡量财政成本与弱势群体的出行改善？' },
  { focus:'远程办公', a:'远程办公能扩大招聘范围，但协作规则必须明确。团队应以成果和响应约定评估工作。', b:'我同意明确规则，但新人学习常依赖现场观察。远程制度需要专门安排指导和反馈。', c:'可以根据任务选择远程或现场，而不要求全员采用同一种方式。新人指导应有明确负责人和检查点。', consensus:'远程制度需要明确协作规则与指导安排。', divergence:'应统一规定到岗频率还是按任务协商，仍待讨论。', question:'如何检验制度对新人学习和团队信任的影响？' },
  { focus:'模型选择', a:'开源模型便于控制部署和数据流，但运行维护同样有成本。选型应比较完整使用周期。', b:'我同意比较总成本，但高峰负载可能让自建方案变得昂贵。商业接口的弹性也需要计入。', c:'先用同一套真实任务评估质量和延迟，再核算部署成本。关键流程还应测试迁移和故障恢复。', consensus:'选型应结合真实任务评估与完整成本。', divergence:'在何种负载下自建更有优势，需要具体测量。', question:'如何建立可持续更新的模型评测与迁移机制？' },
  { focus:'自动驾驶落地', a:'规模化部署需要验证长尾场景，而不能只看平均接管率。运营边界应明确且可检查。', b:'我同意明确边界，但运营还涉及道路协同和事故处理。技术指标无法独立覆盖这些约束。', c:'可以在清晰限定的区域开展持续评估，并公开故障处理流程。扩张应以可重复的安全证据为基础。', consensus:'部署边界与可重复的安全证据是落地基础。', divergence:'技术验证与运营制度应如何同步推进，仍需具体方案。', question:'哪些指标能够支持从限定区域向更复杂道路扩展？' },
];
export function makeSample(index: number): DiscussionSnapshot {
  const d = `sample-${index + 1}`, c = cases[index], at = '2026-11-18T02:00:00.000Z';
  const roles = [ ['林序','圆桌主持人','主持人','澄清问题，连接观点'], ['陈知远','产业研究员','研究视角','关注长期变化与生产率'], ['许言','公共政策研究者','政策视角','关注分配与可及性'], ['周以宁','企业实践者','实践视角','关注执行成本与可检验结果'], ['沈若衡','社会学研究者','社会视角','关注组织关系与个体经验'] ];
  const participants: Participant[] = roles.map((r,i) => ({id:`${d}-p${i}`,discussionId:d,role:i===0?'moderator':'expert',name:r[0],occupation:r[1],title:r[2],stance:r[3],specialty:[c.focus],colorKey:i,status:'idle',publicFocus:null}));
  const messages = [
    {p:0,kind:'opening' as const,content:`欢迎来到圆桌。本场我们讨论“${SAMPLE_TOPICS[index]}”，请先明确各自判断成立的条件。`,reply:null},
    {p:1,kind:'expert' as const,content:c.a,reply:null},
    {p:2,kind:'expert' as const,content:c.b,reply:`${d}-m2`},
    {p:3,kind:'expert' as const,content:c.c,reply:`${d}-m3`},
    {p:4,kind:'expert' as const,content:`我赞同把“${c.consensus.replace(/。$/,'')}”作为讨论起点。后续应明确谁承担成本、谁参与评估。`,reply:`${d}-m4`},
    {p:0,kind:'summary' as const,content:`本场讨论聚焦${c.focus}。\n\n共识：${c.consensus}这是部分专家明确支持的方向，不能等同于所有人的完整立场。\n\n分歧：${c.divergence}\n\n待验证：${c.question}`,reply:null},
  ].map((m,i) => ({id:`${d}-m${i+1}`,discussionId:d,messageSeq:i+1,turnId:`${d}-t${i+1}`,participantId:participants[m.p].id,kind:m.kind,content:m.content,replyToMessageId:m.reply,createdAt:at}));
  return { discussion:{id:d,topic:SAMPLE_TOPICS[index],expertCount:4,status:'completed',version:4,castVersion:1,generation:1,finishRequested:false,failureStage:null,error:null,maxUtterances:16,maxCalls:120,callCount:0,insightsThrough:5,isSample:true,createdAt:at,updatedAt:at},participants,bindings:[],messages,insights:[
    {id:`${d}-i1`,kind:'consensus',status:'stable',scope:'local',text:c.consensus,revision:1,throughMessageSeq:5,participantIds:[participants[1].id,participants[3].id,participants[4].id],evidence:[{messageId:messages[1].id,relation:'supports'},{messageId:messages[3].id,relation:'supports'},{messageId:messages[4].id,relation:'supports'}]},
    {id:`${d}-i2`,kind:'divergence',status:'emerging',scope:null,text:c.divergence,revision:1,throughMessageSeq:5,participantIds:[participants[1].id,participants[2].id],evidence:[{messageId:messages[1].id,relation:'qualifies'},{messageId:messages[2].id,relation:'opposes'}]},
    {id:`${d}-i3`,kind:'open_question',status:'emerging',scope:null,text:c.question,revision:1,throughMessageSeq:5,participantIds:[participants[3].id],evidence:[{messageId:messages[3].id,relation:'qualifies'}]},
  ],lastEventSeq:0 };
}
