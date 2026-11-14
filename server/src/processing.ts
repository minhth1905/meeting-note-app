import {Injectable,OnModuleInit,OnModuleDestroy,Logger} from '@nestjs/common';
import {Db} from './db';
import {MeetingsService} from './meetings';

// Persistent Postgres-backed single-instance worker; no HTTP request waits for AI providers.
// A database lease allows another instance or restarted process to reclaim abandoned jobs.
@Injectable()
export class MeetingProcessingWorker implements OnModuleInit,OnModuleDestroy{
 private readonly log=new Logger(MeetingProcessingWorker.name);
 private timer:ReturnType<typeof setInterval>|null=null;
 private working=false;
 private destroyed=false;
 constructor(private db:Db,private meetings:MeetingsService){}
 onModuleInit(){
  this.timer=setInterval(()=>{void this.tick()},3000);
  void this.tick();
 }
 onModuleDestroy(){this.destroyed=true;if(this.timer)clearInterval(this.timer)}
 private async tick(){
  if(this.working||this.destroyed)return;
  this.working=true;
  try{
   const now=new Date();
   const candidate=await this.db.meeting.findFirst({
    where:{processingStage:{in:['queued','transcribing','generating_notes']},OR:[{processingLeaseUntil:null},{processingLeaseUntil:{lt:now}}]},
    orderBy:{processingRequestedAt:'asc'},
    select:{id:true,userId:true,processingStage:true}
   });
   if(!candidate)return;
   const claimed=await this.db.meeting.updateMany({
    where:{id:candidate.id,processingStage:{in:['queued','transcribing','generating_notes']},OR:[{processingLeaseUntil:null},{processingLeaseUntil:{lt:now}}]},
    data:{processingLeaseUntil:new Date(Date.now()+30*60_000),processingAttempts:{increment:1}}
   });
   if(!claimed.count)return;
   try{
    // Restart-safe: stage changes only after the preceding stage commits.
    if(candidate.processingStage!=='generating_notes'){
     await this.db.meeting.update({where:{id:candidate.id},data:{status:'processing',processingStage:'transcribing'}});
     await this.meetings.transcribeAudio(candidate.id,candidate.userId);
     await this.db.meeting.update({where:{id:candidate.id},data:{processingStage:'generating_notes'}});
    }
    await this.meetings.generateNotes(candidate.id,candidate.userId);
    await this.db.meeting.update({where:{id:candidate.id},data:{status:'completed',processingStage:'completed',processingError:null,processingLeaseUntil:null}});
    this.log.log('Meeting processing completed: '+candidate.id);
   }catch(error:any){
    const reason=String(error?.message||'Processing failed').slice(0,1000);
    this.log.error('Meeting processing failed: '+candidate.id+' '+reason);
    await this.db.meeting.updateMany({where:{id:candidate.id},data:{status:'failed',processingStage:'failed',processingError:reason,processingLeaseUntil:null}});
   }
  }catch(error:any){this.log.error('Worker polling error: '+String(error?.message||error))}
  finally{this.working=false}
 }
}
