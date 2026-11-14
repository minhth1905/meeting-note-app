import {WebSocketGateway,WebSocketServer,SubscribeMessage,ConnectedSocket,MessageBody,OnGatewayConnection,OnGatewayDisconnect} from '@nestjs/websockets';
import {Server,Socket} from 'socket.io';import WebSocket from 'ws';
import {Db} from './db';import {AuthService} from './auth';import {MeetingsService} from './meetings';
@WebSocketGateway({cors:{origin:(process.env.WEB_ORIGIN||'http://localhost:5173').split(','),credentials:true},maxHttpBufferSize:2e6})
export class LiveGateway implements OnGatewayConnection,OnGatewayDisconnect{
 @WebSocketServer() io!:Server; private active=new Map<string,{dg:WebSocket;meetingId:string;userId:string;started:number}>();
 constructor(private db:Db,private auth:AuthService,private meetings:MeetingsService){}
 async handleConnection(client:Socket){const token=String(client.handshake.auth?.token||'');const user=this.auth.getUser(token);if(!user){client.emit('live:error','Unauthorized');client.disconnect(true);return;}client.data.userId=user.sub;}
 async handleDisconnect(client:Socket){await this.finish(client.id)}
 @SubscribeMessage('live:start')async start(@ConnectedSocket()client:Socket,@MessageBody() data:{meetingId:string}){
 try{const userId=client.data.userId;if(!userId)throw Error('Unauthorized');await this.meetings.own(data.meetingId,userId);if(this.active.has(client.id))throw Error('Already recording');if(!process.env.DEEPGRAM_API_KEY)throw Error('Chưa cấu hình DEEPGRAM_API_KEY');
 // Browser MediaRecorder WebM/Opus chunks are sent to Deepgram as one continuous stream.
 const url=`wss://api.deepgram.com/v1/listen?model=${encodeURIComponent(process.env.DEEPGRAM_MODEL||'nova-3')}&language=vi&interim_results=true&punctuate=true&smart_format=true&diarize=true&endpointing=500`;
 const dg=new WebSocket(url,{headers:{Authorization:`Token ${process.env.DEEPGRAM_API_KEY}`}});
 this.active.set(client.id,{dg,meetingId:data.meetingId,userId,started:Date.now()});
 dg.on('open',async()=>{await this.db.meeting.update({where:{id:data.meetingId},data:{status:'recording',startedAt:new Date()}}).catch(()=>{});client.emit('live:ready')});
 dg.on('message',async raw=>{try{const msg=JSON.parse(raw.toString());if(msg.type!=='Results')return;const alternative=msg.channel?.alternatives?.[0];const words=alternative?.words||[];const text=alternative?.transcript?.trim();if(!text)return;const speaker=words.find((w:any)=>w.speaker!==undefined)?.speaker;const speakerKey=speaker===undefined?null:`Speaker ${speaker+1}`;const segment={speakerKey,content:text,startMs:Math.round((msg.start||0)*1000),endMs:Math.round(((msg.start||0)+(msg.duration||0))*1000)};if(msg.is_final){await this.db.segment.create({data:{meetingId:data.meetingId,...segment}});client.emit('live:final',segment)}else client.emit('live:interim',segment)}catch(e){client.emit('live:error','Transcript processing error')}});
 dg.on('error',()=>client.emit('live:error','Deepgram connection failed'));dg.on('close',()=>client.emit('live:closed'));
 }catch(e:any){client.emit('live:error',e.message||'Failed to start')}
 }
 @SubscribeMessage('live:audio')audio(@ConnectedSocket()client:Socket,@MessageBody()buf:Buffer){const session=this.active.get(client.id);if(session?.dg.readyState===WebSocket.OPEN&&buf){session.dg.send(buf)}}
 @SubscribeMessage('live:stop')async stop(@ConnectedSocket()client:Socket){await this.finish(client.id);client.emit('live:stopped')}
 private async finish(socketId:string){const session=this.active.get(socketId);if(!session)return;this.active.delete(socketId);if(session.dg.readyState===WebSocket.OPEN){session.dg.send(JSON.stringify({type:'CloseStream'}));setTimeout(()=>session.dg.close(),1500).unref()}else session.dg.close();await this.db.meeting.update({where:{id:session.meetingId},data:{status:'processing',finishedAt:new Date()}}).catch(()=>{})}
}
