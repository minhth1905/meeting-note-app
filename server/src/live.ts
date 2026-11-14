import {WebSocketGateway,WebSocketServer,SubscribeMessage,ConnectedSocket,MessageBody,OnGatewayConnection,OnGatewayDisconnect} from '@nestjs/websockets';
import {Server,Socket} from 'socket.io';
import WebSocket from 'ws';
import {Db} from './db';
import {AuthService} from './auth';
import {MeetingsService} from './meetings';

type Session={ws:WebSocket;meetingId:string;userId:string;started:number;ready:boolean;closing:boolean;lastSegmentStart:number};
@WebSocketGateway({cors:{origin:(process.env.WEB_ORIGIN||'http://localhost:5173').split(','),credentials:true},maxHttpBufferSize:2e6})
export class LiveGateway implements OnGatewayConnection,OnGatewayDisconnect{
 @WebSocketServer() io!:Server;
 private active=new Map<string,Session>();
 constructor(private db:Db,private auth:AuthService,private meetings:MeetingsService){}
 async handleConnection(client:Socket){
  const user=this.auth.getUser(String(client.handshake.auth?.token||''));
  if(!user){client.emit('live:error','Unauthorized');client.disconnect(true);return}
  client.data.userId=user.sub;
 }
 async handleDisconnect(client:Socket){await this.finish(client.id,false)}
 @SubscribeMessage('live:start') async start(@ConnectedSocket()client:Socket,@MessageBody()data:{meetingId:string}){
  try{
   const userId=client.data.userId;
   if(!userId)throw Error('Unauthorized');
   await this.meetings.own(data.meetingId,userId);
   if(this.active.has(client.id))throw Error('Already recording');
   const key=process.env.ELEVENLABS_API_KEY;
   if(!key)throw Error('Chưa cấu hình ELEVENLABS_API_KEY');
   const query=new URLSearchParams({
    model_id:process.env.ELEVENLABS_LIVE_MODEL||'scribe_v3_live',
    audio_format:'pcm_16000',language_code:'vi',commit_strategy:'vad',
    vad_silence_threshold_secs:'0.8'
   });
   // Realtime is plain transcription only. Speaker diarization stays in Scribe Batch.
   const ws=new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?'+query.toString(),{
    headers:{'xi-api-key':key}
   });
   const session:Session={ws,meetingId:data.meetingId,userId,started:Date.now(),ready:false,closing:false,lastSegmentStart:0};
   this.active.set(client.id,session);
   ws.on('open',()=>{ /* Wait for session_started before accepting audio. */ });
   ws.on('message',async raw=>{
    try{
     const msg=JSON.parse(raw.toString());
     if(msg.message_type==='session_started'){
      session.ready=true;
      await this.db.meeting.update({where:{id:session.meetingId},data:{status:'recording',startedAt:new Date()}}).catch(()=>{});
      client.emit('live:ready');
     }else if(msg.message_type==='partial_transcript'){
      client.emit('live:interim',{speakerKey:null,content:String(msg.text||''),startMs:session.lastSegmentStart,endMs:Date.now()-session.started});
     }else if(msg.message_type==='committed_transcript'){
      const content=String(msg.text||'').trim();
      if(!content)return;
      const now=Date.now()-session.started;
      const segment={speakerKey:null,content,startMs:session.lastSegmentStart,endMs:now};
      session.lastSegmentStart=now;
      await this.db.segment.create({data:{meetingId:session.meetingId,...segment}});
      client.emit('live:final',segment);
     }else if(msg.message_type==='error'||msg.message_type==='auth_error'||msg.message_type==='quota_exceeded'||msg.message_type==='input_error'||msg.message_type==='invalid_request'||msg.message_type==='transcriber_error'){
      client.emit('live:error',String(msg.error||msg.message||msg.message_type));
     }
    }catch(e){client.emit('live:error','Transcript processing error')}
   });
   ws.on('error',e=>client.emit('live:error','ElevenLabs connection failed: '+e.message));
   ws.on('close',()=>{session.ready=false;client.emit('live:closed')});
  }catch(e:any){client.emit('live:error',e.message||'Failed to start')}
 }
 @SubscribeMessage('live:audio') audio(@ConnectedSocket()client:Socket,@MessageBody()buf:Buffer|ArrayBuffer|Uint8Array){
  const session=this.active.get(client.id);
  if(!session?.ready||session.closing||session.ws.readyState!==WebSocket.OPEN||!buf)return;
  const pcm=Buffer.from(buf as any);
  if(!pcm.length||pcm.length>128000)return;
  session.ws.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:pcm.toString('base64')}));
 }
 @SubscribeMessage('live:stop') async stop(@ConnectedSocket()client:Socket){
  await this.finish(client.id,true);
  client.emit('live:stopped');
 }
 private async finish(socketId:string,commit:boolean){
  const session=this.active.get(socketId);
  if(!session||session.closing)return;
  session.closing=true;
  if(commit&&session.ws.readyState===WebSocket.OPEN){
   // Commit the trailing utterance and allow its callback to persist before closing.
   session.ws.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:'',commit:true}));
   await new Promise(resolve=>setTimeout(resolve,1800));
  }
  this.active.delete(socketId);
  if(session.ws.readyState===WebSocket.OPEN||session.ws.readyState===WebSocket.CONNECTING)session.ws.close();
  await this.db.meeting.update({where:{id:session.meetingId},data:{status:'processing',finishedAt:new Date()}}).catch(()=>{});
 }
}
