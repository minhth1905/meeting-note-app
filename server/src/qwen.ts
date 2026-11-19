import {randomUUID} from 'crypto';
import {setTimeout as sleep} from 'timers/promises';

export const qwenLiveModel=()=>process.env.QWEN_LIVE_MODEL||'qwen-audio-3.1-asr-flash-streaming';
export const qwenBatchModel=()=>process.env.QWEN_BATCH_MODEL||'qwen-audio-3.1-asr-flash-filetrans';
const base=()=> (process.env.QWEN_BASE_URL||'https://ap-southeast-1.maas.qwencloudapi.com').replace(/\/+$/,'');
export const qwenWsUrl=()=>base().replace(/^https:/,'wss:')+'/api-ws/v1/inference';
export function qwenKey(){const key=process.env.DASHSCOPE_API_KEY;if(!key)throw Error('Chưa cấu hình DASHSCOPE_API_KEY');return key}
export function useQwen(kind:'LIVE'|'BATCH'){
 const name=process.env['STT_'+kind+'_PROVIDER']||'openai';
 if(name!=='openai'&&name!=='qwen')throw Error('Invalid STT provider: '+name);
 return name==='qwen';
}
export function qwenHints(){
 const language_hints=(process.env.QWEN_LANGUAGES||'vi,en').split(',').map(x=>x.trim()).filter(Boolean).slice(0,4);
 const vocabulary=Object.fromEntries((process.env.QWEN_STT_KEYWORDS||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,100).map(x=>[x,5]));
 return {language_hints,...(Object.keys(vocabulary).length?{vocabulary}:{})};
}
export function qwenCommand(action:'run-task'|'finish-task',taskId:string,sampleRate=24000){
 return JSON.stringify({header:{action,task_id:taskId,streaming:'duplex'},payload:action==='run-task'?{task_group:'audio',task:'asr',function:'recognition',model:qwenLiveModel(),parameters:{format:'pcm',sample_rate:sampleRate,...qwenHints()},input:{}}:{input:{}}});
}
export function logQwenUsage(kind:string,usage:any){
 if(!usage)return;
 console.info('Qwen '+kind+' usage', {input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,total_tokens:usage.total_tokens,duration:usage.duration});
}
async function json(response:Response,stage:string){
 if(!response.ok)throw Error('Qwen '+stage+' HTTP '+response.status);
 return await response.json() as any;
}
export async function qwenDiarize(audio:Buffer){
 const model=qwenBatchModel(),headers={Authorization:'Bearer '+qwenKey()};
 const policy=await json(await fetch(base()+'/api/v1/uploads?action=getPolicy&model='+encodeURIComponent(model),{headers,signal:AbortSignal.timeout(30000)}),'upload policy');
 const p=policy.data;
 if(!p?.upload_host||!p?.upload_dir)throw Error('Qwen missing upload policy');
 const filename=randomUUID()+'.mp3',key=p.upload_dir+'/'+filename;
 const form=new FormData();
 for(const [k,v] of Object.entries({OSSAccessKeyId:p.oss_access_key_id,Signature:p.signature,policy:p.policy,'x-oss-object-acl':p.x_oss_object_acl,'x-oss-forbid-overwrite':p.x_oss_forbid_overwrite,key,success_action_status:'200'})){
  if(typeof v!=='string')throw Error('Qwen invalid upload policy');
  form.append(k,v);
 }
 form.append('file',new Blob([new Uint8Array(audio)],{type:'audio/mpeg'}),filename);
 const uploaded=await fetch(p.upload_host,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
 if(!uploaded.ok)throw Error('Qwen audio upload HTTP '+uploaded.status);
 const task=await json(await fetch(base()+'/api/v1/services/audio/asr/transcription',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-DashScope-Async':'enable','X-DashScope-OssResourceResolve':'enable'},body:JSON.stringify({model,input:{file_urls:['oss://'+key]},parameters:{channel_id:[0],diarization_enabled:true,...qwenHints()}}),signal:AbortSignal.timeout(30000)}),'submit');
 const id=task.output?.task_id;
 if(!id)throw Error('Qwen missing task ID');
 const deadline=Date.now()+8*60_000;
 while(Date.now()<deadline){
  await sleep(3000);
  const result=await json(await fetch(base()+'/api/v1/tasks/'+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(30000)}),'poll');
  const output=result.output;
  if(output?.task_status==='PENDING'||output?.task_status==='RUNNING')continue;
  if(output?.task_status!=='SUCCEEDED')throw Error('Qwen transcription failed: '+String(output?.task_status||'unknown'));
  const item=output.results?.[0];
  if(item?.subtask_status!=='SUCCEEDED'||!item.transcription_url)throw Error('Qwen transcription subtask failed');
  logQwenUsage('batch',result.usage);
  const transcript=await json(await fetch(item.transcription_url,{signal:AbortSignal.timeout(60000)}),'result');
  if(!Array.isArray(transcript.transcripts))throw Error('Qwen missing transcripts');
  // Adapt Qwen milliseconds to the existing OpenAI-shaped normalization.
  return {segments:transcript.transcripts.flatMap((t:any)=>{
   if(!Array.isArray(t.sentences))throw Error('Qwen missing sentences');
   return t.sentences.map((s:any)=>({text:s.text,start:s.begin_time==null?NaN:s.begin_time/1000,end:s.end_time==null?NaN:s.end_time/1000,speaker:s.speaker_id==null?'':String(s.speaker_id)}));
  })};
 }
 throw Error('Qwen transcription timed out');
}
