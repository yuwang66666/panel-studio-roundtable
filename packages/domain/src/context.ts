import type { DiscussionSnapshot } from '@panel/contracts';
export function buildContext(s:DiscussionSnapshot,participantId:string,throughMessageSeq:number,targetMessageId:string|null=null){
 const participant=s.participants.find(p=>p.id===participantId);if(!participant)throw Error('参与者不属于当前讨论');
 const eligible=s.messages.filter(m=>m.messageSeq<=throughMessageSeq&&m.kind!=='summary');
 const target=targetMessageId?eligible.find(m=>m.id===targetMessageId):undefined;if(targetMessageId&&!target)throw Error('回应目标不属于当前讨论快照');
 const messages=eligible.slice(-12);const evidence=new Set(s.insights.flatMap(i=>i.evidence.map(e=>e.messageId)));if(target)evidence.add(target.id);
 for(const m of eligible)if(evidence.has(m.id)&&!messages.some(x=>x.id===m.id))messages.push(m);
 messages.sort((a,b)=>a.messageSeq-b.messageSeq);
 return {topic:s.discussion.topic,participant,participants:s.participants,throughMessageSeq,targetMessageId,messages,insights:s.insights.filter(i=>i.throughMessageSeq<=throughMessageSeq),remainingCalls:Math.max(0,s.discussion.maxCalls-s.discussion.callCount)};
}
export function validShortUtterance(sentences:string[]){
 if(sentences.length<1||sentences.length>2||sentences.join('').length>400)return false;
 const segmenter=new Intl.Segmenter('zh',{granularity:'sentence'});
 return sentences.every(text=>{const normalized=text.trim().replace(/\b(?:e\.g\.|i\.e\.|Dr\.|Mr\.|Ms\.|U\.S\.)/g,m=>m.replaceAll('.','·'));return normalized.length>0&&normalized.length<=250&&[...segmenter.segment(normalized)].filter(s=>s.segment.trim()).length===1;});
}
