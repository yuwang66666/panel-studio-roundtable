import type { Intent,Message } from '@panel/contracts';
const priority={pass:0,raise:1,interrupt:2,supplement:3,rebut:4};
export function validIntents(intents:Intent[],messages:Message[],through:number){const byId=new Map(messages.filter(m=>m.messageSeq<=through&&m.kind!=='summary').map(m=>[m.id,m]));return intents.filter(i=>i.action!=='pass'&&i.basedOnMessageSeq===through&&(!i.targetMessageId||byId.has(i.targetMessageId))&&(!['supplement','rebut'].includes(i.action)||(i.targetMessageId&&byId.get(i.targetMessageId)?.participantId!==i.participantId)));}
export function selectNextSpeaker(intents:Intent[],messages:Message[],through:number,waits:Record<string,number>,previousFocus:string|null=null){
 let candidates=validIntents(intents,messages,through);const history=messages.filter(m=>m.kind==='expert'),last=history.at(-1),previous=history.at(-2);
 if(last&&last.participantId===previous?.participantId&&candidates.some(i=>i.participantId!==last.participantId))candidates=candidates.filter(i=>i.participantId!==last.participantId);
 candidates.sort((a,b)=>{const aw=waits[a.participantId]||0,bw=waits[b.participantId]||0;if((aw>=3)!==(bw>=3))return aw>=3?-1:1;if(aw>=3&&bw>=3&&aw!==bw)return bw-aw;const as=priority[a.action]-(a.proposedFocus===previousFocus?1:0),bs=priority[b.action]-(b.proposedFocus===previousFocus?1:0);return bs-as||bw-aw||a.participantId.localeCompare(b.participantId);});
 return candidates[0]||null;
}
