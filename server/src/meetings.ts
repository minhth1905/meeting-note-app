import {Controller,Get,Post,Patch,Delete,Param,Body,UseGuards,Req,NotFoundException,BadRequestException,UploadedFile,UseInterceptors,Res,Injectable} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {IsString,IsOptional,IsBoolean,MaxLength} from 'class-validator';
import {Request,Response} from 'express';
import {Db} from './db';import {JwtGuard} from './auth';
import {mkdir,writeFile,readFile,rm} from 'fs/promises';import path from 'path';
class CreateMeetingDto{@IsString() @MaxLength(180) title!:string;@IsOptional() @IsString() @MaxLength(2000) description?:string}
class SpeakerDto{@IsString() speakerKey!:string;@IsString() displayName!:string}
class ActionDto{@IsBoolean() completed!:boolean}
// ElevenLabs batch returns word-level tokens. Vietnamese words need spaces,
// but punctuation and tokens with their own whitespace should be preserved.
export function appendTranscriptWord(previous:string,token:string):string{
 if(!previous)return token;
 if(!token)return previous;
 if(/\s$/.test(previous)||/^\s/.test(token))return previous+token;
 if(/^[,.;:!?%\)\]\}…]/u.test(token))return previous+token;
 if(/[\(\[\{]$/.test(previous))return previous+token;
 return previous+' '+token;
}
@Injectable() export class MeetingsService{
 constructor(public db:Db){}
 async own(id:string,userId:string){const m=await this.db.meeting.findFirst({where:{id,userId}});if(!m)throw new NotFoundException('Meeting không tồn tại');return m;}
 async detail(id:string,userId:string){await this.own(id,userId);return this.db.meeting.findUniqueOrThrow({where:{id},include:{segments:{orderBy:{startMs:'asc'}},speakers:true,actions:true}})}
 async transcribeAudio(id:string,userId:string){
  const meeting=await this.own(id,userId);
  if(!meeting.audioPath)throw new BadRequestException('Chưa có audio');
  const key=process.env.ELEVENLABS_API_KEY;
  if(!key)throw new BadRequestException('Chưa cấu hình ELEVENLABS_API_KEY');
  const audio=await readFile(meeting.audioPath);
  const form=new FormData();
  form.append('file',new Blob([new Uint8Array(audio)],{type:'audio/webm'}),'meeting.webm');
  form.append('model_id',process.env.ELEVENLABS_BATCH_MODEL||'scribe_v3');
  form.append('language_code','vi');
  form.append('diarize','true');
  form.append('tag_audio_events','false');
  const response=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{
    method:'POST',headers:{'xi-api-key':key},body:form
  });
  if(!response.ok)throw new BadRequestException('ElevenLabs batch error: '+(await response.text()).slice(0,300));
  const payload:any=await response.json();
  const words=Array.isArray(payload.words)?payload.words.filter((w:any)=>w.type==='word'&&typeof w.text==='string'):[];
  if(!words.length)throw new BadRequestException('ElevenLabs không trả về từ nào; transcript realtime được giữ nguyên');
  const segments:{speakerKey:string|null;content:string;startMs:number;endMs:number}[]=[];
  let current:{speakerKey:string|null;content:string;startMs:number;endMs:number}|null=null;
  for(const word of words){
   const speakerKey=word.speaker_id===null||word.speaker_id===undefined?null:'Speaker '+(Number(String(word.speaker_id).split('_').pop())+1);
   const startMs=Math.max(0,Math.round(Number(word.start||0)*1000));
   const endMs=Math.max(startMs,Math.round(Number(word.end||word.start||0)*1000));
   if(!current||current.speakerKey!==speakerKey||startMs-current.endMs>1500){
    if(current?.content.trim())segments.push({...current,content:current.content.trim()});
    current={speakerKey,content:word.text,startMs,endMs};
   }else{current.content=appendTranscriptWord(current.content,word.text);current.endMs=endMs}
  }
  if(current?.content.trim())segments.push({...current,content:current.content.trim()});
  await this.db.$transaction(async tx=>{
   await tx.segment.deleteMany({where:{meetingId:id}});
   for(const segment of segments)await tx.segment.create({data:{meetingId:id,...segment}});
   await tx.meeting.update({where:{id},data:{status:'processing'}});
  });
  return {segments:segments.length,speakers:[...new Set(segments.map(s=>s.speakerKey).filter(Boolean))]};
 }
 async generateNotes(id:string,userId:string){await this.own(id,userId);const segments=await this.db.segment.findMany({where:{meetingId:id},orderBy:{startMs:'asc'}});if(!segments.length)throw new BadRequestException('Chưa có transcript');if(!process.env.OPENCODE_API_KEY)throw new BadRequestException('Chưa cấu hình OPENCODE_API_KEY');
 const transcript=segments.map(s=>`[${Math.floor(s.startMs/1000)}s] ${s.speakerKey||'Unknown'}: ${s.content}`).join('\n').slice(0,110000);
 const baseUrl=(process.env.OPENCODE_BASE_URL||'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/,'');
 const result=await fetch(`${baseUrl}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENCODE_API_KEY}`,'Content-Type':'application/json','User-Agent':'meeting-notes-app/1.0','x-opencode-session':`ses_${id}`},body:JSON.stringify({model:process.env.OPENCODE_MODEL||'glm-5.3-flash',temperature:0.2,response_format:{type:'json_object'},messages:[{role:'system',content:'You create truthful Vietnamese meeting notes. Respond ONLY valid JSON with keys summary (Vietnamese string), decisions (string array), actions (array of objects with title,assignee,dueDate). Do not invent names, deadlines or decisions. Use null for absent information.'},{role:'user',content:transcript}]})});if(!result.ok)throw new BadRequestException('AI summary API error: '+(await result.text()).slice(0,300));
 const body:any=await result.json();let parsed:any;try{parsed=JSON.parse(body.choices?.[0]?.message?.content||'{}')}catch{throw new BadRequestException('AI response invalid JSON')}
 const summary=typeof parsed.summary==='string'?parsed.summary:'';const decisions=Array.isArray(parsed.decisions)?parsed.decisions.filter((x:any)=>typeof x==='string'):[];const actions=Array.isArray(parsed.actions)?parsed.actions:[];
 await this.db.$transaction(async tx=>{await tx.actionItem.deleteMany({where:{meetingId:id}});await tx.meeting.update({where:{id},data:{summary,decisions,status:'completed'}});for(const a of actions.slice(0,30)){if(typeof a.title==='string'&&a.title.trim())await tx.actionItem.create({data:{meetingId:id,title:a.title.slice(0,500),assignee:typeof a.assignee==='string'?a.assignee:null,dueDate:typeof a.dueDate==='string'?a.dueDate:null}})}});return this.detail(id,userId);
 }
}
@Controller('meetings')@UseGuards(JwtGuard)export class MeetingsController{
 constructor(private svc:MeetingsService,private db:Db){}
 @Get()list(@Req() r:Request&{userId:string}){return this.db.meeting.findMany({where:{userId:r.userId},orderBy:{createdAt:'desc'},select:{id:true,title:true,description:true,status:true,createdAt:true,startedAt:true,finishedAt:true,_count:{select:{segments:true,actions:true}}}})}
 @Post()create(@Req() r:Request&{userId:string},@Body() b:CreateMeetingDto){return this.db.meeting.create({data:{title:b.title.trim(),description:b.description||'',userId:r.userId}})}
 @Get(':id')detail(@Req() r:Request&{userId:string},@Param('id') id:string){return this.svc.detail(id,r.userId)}
 @Delete(':id')async remove(@Req() r:Request&{userId:string},@Param('id')id:string){const m=await this.svc.own(id,r.userId);await this.db.meeting.delete({where:{id}});if(m.audioPath)await rm(m.audioPath,{force:true}).catch(()=>{});return {ok:true}}
 @Patch(':id/speakers')async speaker(@Req() r:Request&{userId:string},@Param('id')id:string,@Body() b:SpeakerDto){await this.svc.own(id,r.userId);return this.db.speaker.upsert({where:{meetingId_speakerKey:{meetingId:id,speakerKey:b.speakerKey}},update:{displayName:b.displayName},create:{meetingId:id,speakerKey:b.speakerKey,displayName:b.displayName}})}
 @Patch(':id/actions/:actionId')async action(@Req() r:Request&{userId:string},@Param('id')id:string,@Param('actionId')actionId:string,@Body()b:ActionDto){await this.svc.own(id,r.userId);const found=await this.db.actionItem.findFirst({where:{id:actionId,meetingId:id}});if(!found)throw new NotFoundException();return this.db.actionItem.update({where:{id:actionId},data:{completed:b.completed}})}
 @Post(':id/transcribe')transcribe(@Req() r:Request&{userId:string},@Param('id')id:string){return this.svc.transcribeAudio(id,r.userId)}
 @Post(':id/notes')notes(@Req() r:Request&{userId:string},@Param('id')id:string){return this.svc.generateNotes(id,r.userId)}
 @Post(':id/audio')@UseInterceptors(FileInterceptor('audio',{limits:{fileSize:250*1024*1024}}))async audio(@Req() r:Request&{userId:string},@Param('id')id:string,@UploadedFile()file:Express.Multer.File){await this.svc.own(id,r.userId);if(!file)throw new BadRequestException('Missing audio');const dir=path.resolve(process.cwd(),'uploads');await mkdir(dir,{recursive:true});const filePath=path.join(dir,id+'.webm');await writeFile(filePath,file.buffer);await this.db.meeting.update({where:{id},data:{audioPath:filePath}});return {ok:true}}
 @Get(':id/audio')async getAudio(@Req() r:Request&{userId:string},@Param('id')id:string,@Res()res:Response){const m=await this.svc.own(id,r.userId);if(!m.audioPath)throw new NotFoundException('No audio');try{const data=await readFile(m.audioPath);res.type('audio/webm').send(data)}catch{throw new NotFoundException('Audio missing')}}
}
