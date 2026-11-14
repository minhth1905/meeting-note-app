import {WebSocketGateway,WebSocketServer,SubscribeMessage,ConnectedSocket,MessageBody,OnGatewayConnection,OnGatewayDisconnect} from '@nestjs/websockets';
import {Server,Socket} from 'socket.io';
import WebSocket from 'ws';
import {Db} from './db';
import {AuthService} from './auth';
import {MeetingsService} from './meetings';

// OpenAI gpt-live-transcribe does not support server_vad. Commit turns via a
// lightweight energy-based VAD here; the final transcript is still ElevenLabs Batch.
const SAMPLE_RATE=24000;
const MIN_TURN_MS=450;
const SILENCE_TO_COMMIT_MS=800;
const MAX_TURN_MS=18000;
const ENERGY_THRESHOLD=0.012;
type Session={
 ws:WebSocket;meetingId:string;started:number;ready:boolean;closing:boolean;
 bufferedMs:number;speechMs:number;silenceMs:number;lastSegmentEnd:number;
 turns:{startMs:number;endMs:number}[];
 pending:Set<string>;
 partials:Map<string,string>;
 completed:Map<string,{content:string;startMs:number;endMs:number}>;
 pendingWrites:Set<Promise<unknown>>;
 onSettled:(()=>void)|null;
};

@WebSocketGateway({cors:{origin:(process.env.WEB_ORIGIN||'http://localhost:5173').split(','),credentials:true},maxHttpBufferSize:2e6})
export class LiveGateway implements OnGatewayConnection,OnGatewayDisconnect{
 @WebSocketServer() io!:Server;
 private active=new Map<string,Session>();
 constructor(private db:Db,private auth:AuthService,private meetings:MeetingsService){}
 async handleConnection(client:Socket){
  const user=this.auth.getUser(String(client.handshake.auth?.token||''));
  if(!user){client.emit('live:error','Không có quyền truy cập');client.disconnect(true);return}
  client.data.userId=user.sub;
 }
 async handleDisconnect(client:Socket){await this.finish(client.id,false)}
 @SubscribeMessage('live:start') async start(@ConnectedSocket()client:Socket,@MessageBody()data:{meetingId:string}){
  try{
   const userId=client.data.userId;
   if(!userId)throw Error('Không có quyền truy cập');
   if(!data?.meetingId)throw Error('Thiếu thông tin cuộc họp');
   await this.meetings.own(data.meetingId,userId);
   if(this.active.has(client.id))throw Error('Đang có phiên ghi âm');
   const key=process.env.OPENAI_API_KEY;
   if(!key)throw Error('Chưa cấu hình OPENAI_API_KEY cho phiên âm trực tiếp');
   const ws=new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription',{
    headers:{Authorization:`Bearer ${key}`}
   });
   const session:Session={
    ws,meetingId:data.meetingId,started:Date.now(),ready:false,closing:false,
    bufferedMs:0,speechMs:0,silenceMs:0,lastSegmentEnd:0,turns:[],pending:new Set(),
    partials:new Map(),completed:new Map(),pendingWrites:new Set(),onSettled:null
   };
   this.active.set(client.id,session);
   ws.on('open',()=>{
    const keywords=(process.env.OPENAI_STT_KEYWORDS||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,30);
    const transcription:Record<string,unknown>={
     model:process.env.OPENAI_LIVE_MODEL||'gpt-live-transcribe',
     languages:['vi'],delay:'low',
     prompt:'Phiên âm cuộc họp bằng tiếng Việt, giữ nguyên tên riêng và thuật ngữ chuyên ngành.'
    };
    if(keywords.length)transcription.keywords=keywords;
    ws.send(JSON.stringify({
     type:'session.update',
     session:{type:'transcription',audio:{input:{
      format:{type:'audio/pcm',rate:SAMPLE_RATE},
      transcription,
      turn_detection:null
     }}}
    }));
   });
   ws.on('message',raw=>{void this.onOpenAIMessage(client,session,raw.toString())});
   ws.on('error',err=>client.emit('live:error','Kết nối OpenAI thất bại: '+err.message));
   ws.on('close',()=>{
    session.ready=false;
    if(!session.closing)client.emit('live:error','Kết nối phiên âm bị ngắt. Hãy kiểm tra mạng rồi thử lại.');
    client.emit('live:closed');
   });
  }catch(e:any){client.emit('live:error',e?.message||'Không thể bắt đầu phiên âm')}
 }
 private async onOpenAIMessage(client:Socket,s:Session,raw:string){
  try{
   const event=JSON.parse(raw);
   switch(event.type){
    case 'session.updated':
     if(!s.ready){
      s.ready=true;
      await this.db.meeting.update({where:{id:s.meetingId},data:{status:'recording',startedAt:new Date()}}).catch(()=>{});
      client.emit('live:ready');
     }
     break;
    case 'input_audio_buffer.committed': {
     const itemId=String(event.item_id||'');
     if(itemId)s.pending.add(itemId);
     break;
    }
    case 'conversation.item.input_audio_transcription.delta': {
     const id=String(event.item_id||'');
     if(!id)return;
     const prior=s.partials.get(id)||'';
     const text=prior+String(event.delta||'');
     s.partials.set(id,text);
     const bounds=s.completed.get(id);
     client.emit('live:interim',{speakerKey:null,content:text,startMs:bounds?.startMs??s.lastSegmentEnd,endMs:Date.now()-s.started});
     break;
    }
    case 'conversation.item.input_audio_transcription.completed': {
     const id=String(event.item_id||'');
     if(!id||s.completed.has(id))return;
     const content=String(event.transcript||'').trim();
     const bounds=s.turns.shift()||{startMs:s.lastSegmentEnd,endMs:Date.now()-s.started};
     s.completed.set(id,{content,...bounds});
     s.pending.delete(id);
     s.partials.delete(id);
     s.lastSegmentEnd=Math.max(s.lastSegmentEnd,bounds.endMs);
     client.emit('live:interim',{speakerKey:null,content:'',startMs:bounds.endMs,endMs:bounds.endMs});
     if(content){
      const segment={speakerKey:null,content,startMs:bounds.startMs,endMs:bounds.endMs};
      const task=this.db.segment.create({data:{meetingId:s.meetingId,...segment}}).then(
       ()=>{client.emit('live:final',segment)},
       ()=>{client.emit('live:error','Không lưu được bản phiên âm tạm thời')}
      );
      s.pendingWrites.add(task);void task.finally(()=>{s.pendingWrites.delete(task);s.onSettled?.()});
     }
     s.onSettled?.();
     break;
    }
    case 'conversation.item.input_audio_transcription.failed':{
     const id=String(event.item_id||'');
     s.pending.delete(id);s.partials.delete(id);s.turns.shift();
     client.emit('live:error',String(event.error?.message||'Không thể phiên âm đoạn âm thanh'));
     s.onSettled?.();break;
    }
    case 'error':
     client.emit('live:error',String(event.error?.message||'OpenAI từ chối xử lý âm thanh'));
     break;
   }
  }catch{client.emit('live:error','Không đọc được kết quả phiên âm')}
 }
 private commit(s:Session){
  if(s.ws.readyState!==WebSocket.OPEN||s.bufferedMs<MIN_TURN_MS)return;
  const endMs=Date.now()-s.started;
  s.turns.push({startMs:Math.max(0,endMs-s.bufferedMs),endMs});
  s.ws.send(JSON.stringify({type:'input_audio_buffer.commit'}));
  s.bufferedMs=0;s.speechMs=0;s.silenceMs=0;
 }
 @SubscribeMessage('live:audio') audio(@ConnectedSocket()client:Socket,@MessageBody()buf:Buffer|ArrayBuffer|Uint8Array){
  const s=this.active.get(client.id);
  if(!s?.ready||s.closing||s.ws.readyState!==WebSocket.OPEN||!buf)return;
  const pcm=Buffer.from(buf as any);
  if(!pcm.length||pcm.length%2||pcm.length>128000)return;
  if(s.ws.bufferedAmount>2_000_000){client.emit('live:error','Mạng chậm, không thể gửi kịp âm thanh');return}
  const samples=pcm.length/2;
  const durationMs=samples/SAMPLE_RATE*1000;
  let energy=0;
  for(let i=0;i<pcm.length;i+=2){const sample=pcm.readInt16LE(i)/32768;energy+=sample*sample}
  const hasVoice=Math.sqrt(energy/samples)>ENERGY_THRESHOLD;
  s.bufferedMs+=durationMs;
  if(hasVoice){s.speechMs+=durationMs;s.silenceMs=0}
  else if(s.speechMs>0)s.silenceMs+=durationMs;
  // Only send to OpenAI when we have detected speech, or during a short tail.
  // The first 450 ms are pre-roll, retained as silence locally.
  s.ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:pcm.toString('base64')}));
  if((s.speechMs>=MIN_TURN_MS&&s.silenceMs>=SILENCE_TO_COMMIT_MS)||s.bufferedMs>=MAX_TURN_MS){
   if(s.speechMs>=MIN_TURN_MS)this.commit(s);
   else{s.ws.send(JSON.stringify({type:'input_audio_buffer.clear'}));s.bufferedMs=0;s.silenceMs=0}
  }
 }
 @SubscribeMessage('live:stop') async stop(@ConnectedSocket()client:Socket){
  await this.finish(client.id,true);
  client.emit('live:stopped');
 }
 private async finish(socketId:string,commit:boolean){
  const s=this.active.get(socketId);
  if(!s||s.closing)return;
  s.closing=true;
  if(commit&&s.ws.readyState===WebSocket.OPEN&&s.bufferedMs>=MIN_TURN_MS&&s.speechMs>=MIN_TURN_MS)this.commit(s);
  if(commit&&s.ws.readyState===WebSocket.OPEN){
   await Promise.race([
    new Promise<void>(resolve=>{
     const timeout=setTimeout(()=>{s.onSettled=null;resolve()},6500);
     s.onSettled=()=>{if(s.pending.size===0&&s.turns.length===0&&s.pendingWrites.size===0){clearTimeout(timeout);s.onSettled=null;resolve()}};
     s.onSettled();
    }),
    new Promise<void>(resolve=>setTimeout(resolve,6700))
   ]);
  }
  await Promise.allSettled([...s.pendingWrites]);
  this.active.delete(socketId);
  if(s.ws.readyState===WebSocket.OPEN||s.ws.readyState===WebSocket.CONNECTING)s.ws.close();
  await this.db.meeting.update({where:{id:s.meetingId},data:{status:'processing',finishedAt:new Date()}}).catch(()=>{});
 }
}
