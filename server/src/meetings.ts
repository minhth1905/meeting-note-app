import {Controller,Get,Post,Patch,Delete,Param,Body,UseGuards,Req,NotFoundException,BadRequestException,UploadedFile,UseInterceptors,Res,Injectable} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {IsString,IsOptional,IsBoolean,MaxLength} from 'class-validator';
import {Request,Response} from 'express';
import {Db} from './db';import {JwtGuard} from './auth';
import {mkdir,writeFile,readFile,rm,stat,readdir,mkdtemp} from 'fs/promises';import path from 'path';
import os from 'os';
import {spawn} from 'child_process';
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

const MAX_OPENAI_AUDIO_BYTES=24*1024*1024; // Leave room below the 25 MB API limit.
type TranscribedSegment={speakerKey:string|null;content:string;startMs:number;endMs:number};
async function runAudioTool(command:string,args:string[]):Promise<string>{
 return await new Promise<string>((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',(part:Buffer)=>{if(stdout.length<120000)stdout+=part.toString()});
  child.stderr.on('data',(part:Buffer)=>{if(stderr.length<12000)stderr+=part.toString()});
  child.on('error',reject);
  child.on('close',code=>code===0?resolve(stdout):reject(new Error(command+' thất bại: '+stderr.slice(-600))));
 });
}
async function getDurationSeconds(file:string){
 const stdout=await runAudioTool('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);
 const seconds=Number(stdout.trim());
 if(!Number.isFinite(seconds)||seconds<=0)throw new Error('Không đọc được thời lượng audio');
 return seconds;
}
async function openAiDiarize(audio:Buffer,filename:string,key:string):Promise<any>{
 if(audio.length>MAX_OPENAI_AUDIO_BYTES)throw new Error('Audio vượt giới hạn 24 MB an toàn cho OpenAI');
 const form=new FormData();
 form.append('file',new Blob([new Uint8Array(audio)],{type:filename.endsWith('.mp3')?'audio/mpeg':'audio/webm'}),filename);
 form.append('model',process.env.OPENAI_BATCH_MODEL||'gpt-4o-transcribe-diarize');
 form.append('response_format','diarized_json');
 form.append('chunking_strategy','auto');
 const response=await fetch('https://api.openai.com/v1/audio/transcriptions',{
  method:'POST',headers:{Authorization:`Bearer ${key}`},body:form,signal:AbortSignal.timeout(8*60*1000)
 });
 if(!response.ok)throw new Error('OpenAI Batch error: '+(await response.text()).slice(0,350));
 const payload:any=await response.json();
 if(!Array.isArray(payload.segments))throw new Error('OpenAI không trả về segments có người nói');
 return payload;
}
// OpenAI speaker IDs are only reliable within an individual transcription request.
// Use distinct display keys for every independently transcribed chunk rather than
// incorrectly claiming that Speaker A across separate chunks is the same person.
function normalizeDiarizedSegments(payload:any,offsetMs:number,speakerLabels:Map<string,string>,speakerCounter:{value:number}):TranscribedSegment[]{
 const output:TranscribedSegment[]=[];
 for(const segment of payload.segments){
  const content=typeof segment?.text==='string'?segment.text.trim():'';
  const start=Number(segment?.start),end=Number(segment?.end);
  if(!content||!Number.isFinite(start)||!Number.isFinite(end))continue;
  const rawSpeaker=typeof segment?.speaker==='string'?segment.speaker.trim():'';
  let speakerKey:string|null=null;
  if(rawSpeaker){
   if(!speakerLabels.has(rawSpeaker))speakerLabels.set(rawSpeaker,'Speaker '+(++speakerCounter.value));
   speakerKey=speakerLabels.get(rawSpeaker)!;
  }
  const startMs=offsetMs+Math.max(0,Math.round(start*1000));
  const endMs=offsetMs+Math.max(Math.round(start*1000),Math.round(end*1000));
  output.push({speakerKey,content,startMs,endMs});
 }
 return output;
}

@Injectable() export class MeetingsService{
 constructor(public db:Db){}
 async own(id:string,userId:string){const m=await this.db.meeting.findFirst({where:{id,userId}});if(!m)throw new NotFoundException('Meeting không tồn tại');return m;}
 async detail(id:string,userId:string){await this.own(id,userId);return this.db.meeting.findUniqueOrThrow({where:{id},include:{segments:{orderBy:{startMs:'asc'}},speakers:true,actions:true}})}
 async enqueueProcessing(id:string,userId:string){
  const meeting=await this.own(id,userId);
  if(!meeting.audioPath)throw new BadRequestException('Cần upload audio trước khi xử lý');
  // Repeated clicks return current state instead of duplicating a paid STT/LLM job.
  await this.db.meeting.updateMany({
   where:{id,processingStage:{in:['idle','completed','failed']}},
   data:{status:'processing',processingStage:'queued',processingError:null,processingLeaseUntil:null,processingRequestedAt:new Date()}
  });
  const updated=await this.db.meeting.findUniqueOrThrow({where:{id},select:{id:true,status:true,processingStage:true,processingError:true}});
  return updated;
 }
 async transcribeAudio(id:string,userId:string){
  const meeting=await this.own(id,userId);
  if(!meeting.audioPath)throw new BadRequestException('Chưa có audio');
  const key=process.env.OPENAI_API_KEY;
  if(!key)throw new BadRequestException('Chưa cấu hình OPENAI_API_KEY');
  const speakerCounter={value:0};
  const segments:TranscribedSegment[]=[];
  let tempDir:string|null=null;
  try{
   const inputSize=(await stat(meeting.audioPath)).size;
   if(inputSize<=MAX_OPENAI_AUDIO_BYTES){
    const payload=await openAiDiarize(await readFile(meeting.audioPath),'meeting.webm',key);
    segments.push(...normalizeDiarizedSegments(payload,0,new Map(),speakerCounter));
   }else{
    // A four-hour WebM recording can exceed OpenAI's 25 MB upload limit.
    // Split with FFmpeg into independently decodable 10-minute MP3 parts.
    tempDir=await mkdtemp(path.join(os.tmpdir(),'meeting-diarize-'));
    const partTemplate=path.join(tempDir,'part-%04d.mp3');
    await runAudioTool('ffmpeg',[
     '-hide_banner','-loglevel','error','-y','-i',meeting.audioPath,
     '-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','libmp3lame',
     '-b:a','32k','-f','segment','-segment_time','600',
     '-reset_timestamps','1',partTemplate
    ]);
    const parts=(await readdir(tempDir)).filter(name=>/^part-\d{4}\.mp3$/.test(name)).sort();
    if(!parts.length)throw new Error('FFmpeg không tạo được đoạn audio');
    let offsetMs=0;
    for(const part of parts){
     const file=path.join(tempDir,part);
     const size=(await stat(file)).size;
     if(size>MAX_OPENAI_AUDIO_BYTES)throw new Error('Audio chunk vẫn vượt 24 MB');
     const payload=await openAiDiarize(await readFile(file),part,key);
     segments.push(...normalizeDiarizedSegments(payload,offsetMs,new Map(),speakerCounter));
     offsetMs+=Math.round((await getDurationSeconds(file))*1000);
    }
   }
  }catch(error:any){
   // Never destroy realtime transcript when OpenAI batch fails.
   throw new BadRequestException(error?.message||'Không thể phiên âm batch bằng OpenAI');
  }finally{
   if(tempDir)await rm(tempDir,{recursive:true,force:true}).catch(()=>{});
  }
  if(!segments.length)throw new BadRequestException('OpenAI không trả về đoạn phiên âm nào; giữ nguyên transcript realtime');
  // Replace provisional live captions only after every batch request succeeds.
  await this.db.$transaction(async tx=>{
   await tx.segment.deleteMany({where:{meetingId:id}});
   await tx.segment.createMany({data:segments.map(segment=>({meetingId:id,...segment}))});
   await tx.meeting.update({where:{id},data:{status:'processing'}});
  });
  return {segments:segments.length,speakers:[...new Set(segments.map(s=>s.speakerKey).filter(Boolean))]};
 }
 async generateNotes(id:string,userId:string){
  const meeting=await this.own(id,userId);
  const segments=await this.db.segment.findMany({where:{meetingId:id},orderBy:{startMs:'asc'}});
  if(!segments.length)throw new BadRequestException('Chưa có bản phiên âm');
  if(!process.env.OPENCODE_API_KEY)throw new BadRequestException('Chưa cấu hình OPENCODE_API_KEY');
  const transcript=segments.map(s=>`[${Math.floor(s.startMs/1000)}s] ${s.speakerKey||'Không rõ'}: ${s.content}`).join('\n').slice(0,110000);
  const baseUrl=(process.env.OPENCODE_BASE_URL||'https://opencode.ai/inference/go/openai/v1').replace(/\/+$/,'');
  const systemPrompt=`Bạn là thư ký cuộc họp chuyên nghiệp. Viết BIÊN BẢN CUỘC HỌP có cấu trúc bằng tiếng Việt dựa TRỰC TIẾP vào bản phiên âm được cung cấp.
Trả về DUY NHẤT JSON hợp lệ với các khóa:
{
 "meetingType": string | null,
 "attendees": string[],
 "summary": string,
 "topics": [{"title": string, "points": string[]}],
 "decisions": string[],
 "actions": [{"title": string, "assignee": string | null, "dueDate": string | null}]
}
Quy tắc nghiêm ngặt:
- summary: 2–5 câu văn dễ đọc, nói rõ mục đích và kết quả cuộc họp.
- topics: nhóm các nội dung quan trọng theo chủ đề, đặt tiêu đề ngắn gọn và mỗi nhóm 2–6 gạch đầu dòng. Không chép nguyên transcript. Có thể trả [] nếu không đủ nội dung.
- attendees và meetingType CHỈ lấy nếu được nhắc rõ trong bản phiên âm. Không tự coi Speaker 1, Speaker 2 là tên thật. Không suy đoán người tham dự, hình thức cuộc họp hoặc ngày họp.
- decisions: chỉ những quyết định đã thực sự được thống nhất; không suy diễn.
- actions: chỉ những nhiệm vụ thực sự được giao; người phụ trách và hạn là null nếu không được nói rõ.
- Mọi thông tin không có bằng chứng từ transcript phải để null hoặc [].
- Không thêm markdown fence, không viết lời giải thích ngoài JSON.`;
  const response=await fetch(`${baseUrl}/chat/completions`,{
   method:'POST',
   headers:{Authorization:`Bearer ${process.env.OPENCODE_API_KEY}`,'Content-Type':'application/json','User-Agent':'meeting-notes-app/1.0','x-opencode-session':`ses_${id}`},
   signal:AbortSignal.timeout(3*60*1000),
   body:JSON.stringify({model:process.env.OPENCODE_MODEL||'glm-5.3-flash',temperature:0.2,response_format:{type:'json_object'},messages:[{role:'system',content:systemPrompt},{role:'user',content:`Tên cuộc họp trong ứng dụng: ${meeting.title}\n\nBản phiên âm:\n${transcript}`}]})
  });
  if(!response.ok)throw new BadRequestException('AI summary API error: '+(await response.text()).slice(0,300));
  const body:any=await response.json();
  let parsed:any;
  try{parsed=JSON.parse(body.choices?.[0]?.message?.content||'{}')}catch{throw new BadRequestException('AI response invalid JSON')}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new BadRequestException('AI response invalid structure');
  const clean=(value:any,max=1200)=>typeof value==='string'?value.trim().slice(0,max):'';
  const summary=clean(parsed.summary,6000);
  if(!summary)throw new BadRequestException('AI response missing summary');
  const attendees=Array.isArray(parsed.attendees)?parsed.attendees.map((v:any)=>clean(v,100)).filter(Boolean).slice(0,40):[];
  const topics=Array.isArray(parsed.topics)?parsed.topics.slice(0,18).map((t:any)=>({
   title:clean(t?.title,160),points:Array.isArray(t?.points)?t.points.map((p:any)=>clean(p,800)).filter(Boolean).slice(0,8):[]
  })).filter((t:{title:string;points:string[]})=>t.title&&t.points.length):[];
  const decisions=Array.isArray(parsed.decisions)?parsed.decisions.map((v:any)=>clean(v,800)).filter(Boolean).slice(0,30):[];
  const actions=Array.isArray(parsed.actions)?parsed.actions.slice(0,30).map((a:any)=>({
   title:clean(a?.title,500),assignee:clean(a?.assignee,100)||null,dueDate:clean(a?.dueDate,100)||null
  })).filter((a:{title:string})=>a.title):[];
  const minutes={meetingType:clean(parsed.meetingType,120)||null,attendees,topics};
  await this.db.$transaction(async tx=>{
   await tx.actionItem.deleteMany({where:{meetingId:id}});
   await tx.meeting.update({where:{id},data:{summary,minutes,decisions,status:'completed'}});
   if(actions.length)await tx.actionItem.createMany({data:actions.map((a:{title:string;assignee:string|null;dueDate:string|null})=>({meetingId:id,...a}))});
  });
  return this.detail(id,userId);
 }
}
@Controller('meetings')@UseGuards(JwtGuard)export class MeetingsController{
 constructor(private svc:MeetingsService,private db:Db){}
 @Get()list(@Req() r:Request&{userId:string}){return this.db.meeting.findMany({where:{userId:r.userId},orderBy:{createdAt:'desc'},select:{id:true,title:true,description:true,status:true,processingStage:true,summary:true,createdAt:true,startedAt:true,finishedAt:true,_count:{select:{segments:true,actions:true}}}})}
 @Post()create(@Req() r:Request&{userId:string},@Body() b:CreateMeetingDto){return this.db.meeting.create({data:{title:b.title.trim(),description:b.description||'',userId:r.userId}})}
 @Get(':id')detail(@Req() r:Request&{userId:string},@Param('id') id:string){return this.svc.detail(id,r.userId)}
 @Delete(':id')async remove(@Req() r:Request&{userId:string},@Param('id')id:string){const m=await this.svc.own(id,r.userId);await this.db.meeting.delete({where:{id}});if(m.audioPath)await rm(m.audioPath,{force:true}).catch(()=>{});return {ok:true}}
 @Patch(':id/speakers')async speaker(@Req() r:Request&{userId:string},@Param('id')id:string,@Body() b:SpeakerDto){await this.svc.own(id,r.userId);return this.db.speaker.upsert({where:{meetingId_speakerKey:{meetingId:id,speakerKey:b.speakerKey}},update:{displayName:b.displayName},create:{meetingId:id,speakerKey:b.speakerKey,displayName:b.displayName}})}
 @Patch(':id/actions/:actionId')async action(@Req() r:Request&{userId:string},@Param('id')id:string,@Param('actionId')actionId:string,@Body()b:ActionDto){await this.svc.own(id,r.userId);const found=await this.db.actionItem.findFirst({where:{id:actionId,meetingId:id}});if(!found)throw new NotFoundException();return this.db.actionItem.update({where:{id:actionId},data:{completed:b.completed}})}
 @Post(':id/process')process(@Req() r:Request&{userId:string},@Param('id')id:string){return this.svc.enqueueProcessing(id,r.userId)}
 @Post(':id/transcribe')transcribe(@Req() r:Request&{userId:string},@Param('id')id:string){return this.svc.transcribeAudio(id,r.userId)}
 @Post(':id/notes')notes(@Req() r:Request&{userId:string},@Param('id')id:string){return this.svc.generateNotes(id,r.userId)}
 @Post(':id/audio')@UseInterceptors(FileInterceptor('audio',{limits:{fileSize:250*1024*1024}}))async audio(@Req() r:Request&{userId:string},@Param('id')id:string,@UploadedFile()file:Express.Multer.File){await this.svc.own(id,r.userId);if(!file)throw new BadRequestException('Missing audio');const dir=path.resolve(process.cwd(),'uploads');await mkdir(dir,{recursive:true});const filePath=path.join(dir,id+'.webm');await writeFile(filePath,file.buffer);await this.db.meeting.update({where:{id},data:{audioPath:filePath}});return {ok:true}}
 @Get(':id/audio')async getAudio(@Req() r:Request&{userId:string},@Param('id')id:string,@Res()res:Response){const m=await this.svc.own(id,r.userId);if(!m.audioPath)throw new NotFoundException('No audio');try{const data=await readFile(m.audioPath);res.type('audio/webm').send(data)}catch{throw new NotFoundException('Audio missing')}}
}
