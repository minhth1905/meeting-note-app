import React,{useState,useEffect,useRef,useCallback} from 'react';
import {Routes,Route,Navigate,useNavigate,useParams,Link,useLocation} from 'react-router-dom';
import {io,Socket} from 'socket.io-client';
import {AudioLines,Home,CalendarDays,FileText,Users,Settings,BarChart3,Plus,Search,Clock,Mic,Square,Pause,Play,LogOut,ChevronDown,Check,Trash2,ArrowLeft,Download,Copy,CheckCircle2,Tag,FolderOpen,MoreHorizontal,ClipboardList,RefreshCw,Radio,Menu,Volume2,X,Send,Eye,EyeOff,Lock,Mail,NotebookPen,Headphones} from 'lucide-react';
const API='/api';
type Segment={id?:string;speakerKey:string|null;content:string;startMs:number;endMs:number};
type Action={id:string;title:string;assignee:string|null;dueDate:string|null;completed:boolean};
type MeetingMinutes={meetingType?:string|null;attendees?:string[];topics?:{title:string;points:string[]}[]};
type Meeting={id:string;title:string;description:string;status:string;processingStage?:string;processingError?:string|null;createdAt:string;startedAt?:string|null;finishedAt?:string|null;audioPath?:string|null;summary?:string|null;minutes?:MeetingMinutes|null;decisions?:string[]|null;segments?:Segment[];speakers?:{id:string;speakerKey:string;displayName:string}[];actions?:Action[]};
type User={id:string;email:string;name:string};
const statusLabel=(status:string,stage?:string|null):string=>{
 const labels:Record<string,string>={
  created:'Mới tạo',recording:'Đang ghi âm',processing:'Đang xử lý',
  queued:'Đang chờ xử lý',transcribing:'Đang phiên âm',
  generating_notes:'Đang tạo ghi chú AI',completed:'Hoàn tất',
  failed:'Xử lý thất bại',idle:'Chưa xử lý'
 };
 return labels[stage||'']||labels[status]||status;
};
const speakerLabel=(key:string|null|undefined):string=>{
 if(!key)return 'Không rõ người nói';
 const match=/^Speaker\s*(\d+)$/i.exec(key);
 return match?'Người nói '+match[1]:key;
};
const fmt=(d?:string|null)=>d?new Date(d).toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const clock=(ms:number)=>`${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
function getToken(){return localStorage.getItem('meeting_token')||''}
async function api<T=any>(route:string,options:RequestInit={}):Promise<T>{const response=await fetch(API+route,{...options,headers:{...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),Authorization:`Bearer ${getToken()}`,...options.headers}});if(!response.ok){let msg=`HTTP ${response.status}`;try{const data=await response.json();msg=Array.isArray(data.message)?data.message.join(', '):data.message||msg}catch{}throw new Error(msg)}return response.json()}
function Button({children,onClick,variant='primary',disabled=false,loading=false,className=''}:{children:React.ReactNode;onClick?:()=>void;variant?:'primary'|'subtle'|'danger'|'outline';disabled?:boolean;loading?:boolean;className?:string}){return <button type="button" onClick={onClick} disabled={disabled||loading} aria-busy={loading} className={`btn ${variant} ${className}`}>{loading&&<span className="btn-spinner" aria-hidden="true"/>}{children}</button>}
type PopupKind='delete'|'speaker';
function MeetingPopup({kind,speaker,value,onValueChange,loading,error,onClose,onConfirm}:{kind:PopupKind;speaker?:string;value:string;onValueChange:(value:string)=>void;loading:boolean;error:string;onClose:()=>void;onConfirm:()=>void}){
 const isDelete=kind==='delete';
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!loading)onClose()};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[loading,onClose]);
 return <div className="overlay modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!loading)onClose()}}>
  <div className="meeting-popup" role="dialog" aria-modal="true" aria-labelledby="popup-heading">
   <div className={`popup-symbol ${isDelete?'destructive':'neutral'}`}>{isDelete?<Trash2 size={24}/>:<Users size={24}/>}</div>
   <button type="button" className="popup-close" onClick={onClose} disabled={loading} aria-label="Đóng"><X size={19}/></button>
   <h2 id="popup-heading">{isDelete?'Xóa cuộc họp?':'Gán tên người nói'}</h2>
   <p className="popup-description">{isDelete?'Bạn có chắc muốn xóa cuộc họp này? Bản ghi âm, phiên âm, tóm tắt và nhiệm vụ liên quan sẽ bị xóa vĩnh viễn.':`Nhập tên thật cho ${speakerLabel(speaker)} để hiển thị trên toàn bộ bản phiên âm.`}</p>
   {!isDelete&&<label className="popup-field">Tên người nói<input autoFocus maxLength={100} value={value} placeholder="Ví dụ: Nguyễn Văn Minh" disabled={loading} onChange={e=>onValueChange(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&value.trim()&&!loading)onConfirm()}}/></label>}
   {error&&<p className="popup-error" role="alert">{error}</p>}
   <div className="popup-actions"><Button variant="outline" disabled={loading} onClick={onClose}>Hủy</Button><Button variant={isDelete?'danger':'primary'} loading={loading} disabled={!isDelete&&!value.trim()} onClick={onConfirm}>{loading?(isDelete?'Đang xóa...':'Đang lưu...'):(isDelete?'Xóa cuộc họp':'Lưu tên')}</Button></div>
  </div>
 </div>;
}
function App(){const [user,setUser]=useState<User|null>(null);const [ready,setReady]=useState(false);const navigate=useNavigate();const loc=useLocation();useEffect(()=>{if(!getToken()){setReady(true);return}api<User>('/auth/me').then(setUser).catch(()=>{localStorage.removeItem('meeting_token');setUser(null)}).finally(()=>setReady(true))},[]);const logout=()=>{localStorage.removeItem('meeting_token');setUser(null);navigate('/login')};if(!ready)return <div className="loading">Đang tải...</div>;return <Routes><Route path="/login" element={user?<Navigate to="/"/>:<Login onLogin={setUser}/>}/><Route path="/*" element={!user?<Navigate to="/login"/>:<Shell user={user} logout={logout} key={loc.pathname.startsWith('/login')?'login':'app'}/>}/></Routes>}
function Login({onLogin}:{onLogin:(u:User)=>void}){const [email,setEmail]=useState('admin@example.com'),[password,setPassword]=useState(''),[show,setShow]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);const navigate=useNavigate();const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{const r=await api<{accessToken:string;user:User}>('/auth/login',{method:'POST',body:JSON.stringify({email,password})});localStorage.setItem('meeting_token',r.accessToken);onLogin(r.user);navigate('/')}catch(ex:any){setError(ex.message)}finally{setBusy(false)}};return <div className="login-page"><div className="login-hero"><div className="login-brand"><AudioLines size={34}/> Meeting Notes</div><div className="login-copy"><h1>Ghi âm, phiên âm và tóm tắt cuộc họp bằng AI</h1><p>Biến mọi cuộc họp thành thông tin có cấu trúc, dễ tra cứu và hành động ngay.</p><div className="feature"><Mic/> <span><b>Phiên âm trực tiếp</b><small>Phiên âm trực tiếp, hỗ trợ tiếng Việt.</small></span></div><div className="feature"><FileText/><span><b>Tóm tắt và nhiệm vụ</b><small>Tự động tóm tắt, trích xuất quyết định và nhiệm vụ.</small></span></div><div className="feature"><FolderOpen/><span><b>Quản lý cuộc họp tập trung</b><small>Lưu trữ và xem lại tất cả cuộc họp.</small></span></div></div><div className="login-art"><AudioLines size={100} strokeWidth={1}/></div></div><div className="login-form-area"><form className="login-card" onSubmit={submit}><h2>Đăng nhập vào Meeting Notes</h2><p>Tiếp tục để ghi âm, phiên âm và quản lý các cuộc họp của bạn.</p><label>Email</label><div className="input-icon"><Mail size={19}/><input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="Nhập email"/></div><label>Mật khẩu</label><div className="input-icon"><Lock size={19}/><input type={show?'text':'password'} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="Nhập mật khẩu"/><button type="button" className="icon-only" onClick={()=>setShow(!show)}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button></div>{error&&<p className="error">{error}</p>}<button className="btn primary full" type="submit" disabled={busy} aria-busy={busy}>{busy&&<span className="btn-spinner" aria-hidden="true"/>}{busy?'Đang đăng nhập...':'Đăng nhập'}</button><p className="hint">Tài khoản được cấu hình bằng DEMO_EMAIL / DEMO_PASSWORD trên server.</p></form></div></div>}
function Shell({user,logout}:{user:User;logout:()=>void}){const [menu,setMenu]=useState(false);const loc=useLocation();return <div className="app"><header className="topbar"><div className="logo"><AudioLines size={25}/> <strong>Meeting Notes</strong></div><span className="workspace">▦ &nbsp; Không gian làm việc: Cá nhân <ChevronDown size={14}/></span><div className="top-right"><span className="avatar">{user.name.slice(0,1).toUpperCase()}</span><span className="profile">{user.name}<small>Quản trị viên</small></span><button className="transparent" onClick={()=>setMenu(!menu)}><ChevronDown size={16}/></button>{menu&&<div className="profile-menu"><span>{user.email}</span><button onClick={logout}><LogOut size={16}/> Đăng xuất</button></div>}</div></header><nav className="rail"><Link className={!loc.pathname.includes('/meetings/')?'active':''} to="/" title="Trang chủ"><Home/></Link><Link to="/" title="Meetings"><CalendarDays/></Link><Link to="/" title="Biên bản"><FileText/></Link><Link to="/" title="Người dùng"><Users/></Link><div className="rail-spacer"/><button title="Cài đặt"><Settings/></button></nav><main className="main"><Routes><Route path="/" element={<Dashboard/>}/><Route path="/meetings/:id" element={<Detail/>}/><Route path="/meetings/:id/live" element={<Live/>}/><Route path="*" element={<Navigate to="/"/>}/></Routes></main></div>}
function Dashboard(){const[meetings,setMeetings]=useState<Meeting[]>([]),[selected,setSelected]=useState<string|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[modal,setModal]=useState(false),[title,setTitle]=useState(''),[description,setDescription]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const navigate=useNavigate();const load=useCallback(()=>api<Meeting[]>('/meetings').then(setMeetings).catch(e=>setError(e.message)),[]);useEffect(()=>{load()},[load]);useEffect(()=>{if(!meetings.some(m=>m.status==='processing'))return;const timer=setInterval(load,3000);return()=>clearInterval(timer)},[meetings,load]);const current=meetings.find(m=>m.id===selected)||meetings[0];const shown=meetings.filter(m=>m.title.toLowerCase().includes(query.toLowerCase())&&(filter==='all'||(filter==='completed'?m.status==='completed':m.status!=='completed')));const create=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);try{const m=await api<Meeting>('/meetings',{method:'POST',body:JSON.stringify({title,description})});setModal(false);setTitle('');setDescription('');navigate(`/meetings/${m.id}/live`)}catch(ex:any){setError(ex.message)}finally{setBusy(false)}};return <div className="dashboard"><section className="meeting-list"><div className="list-heading"><h2>Danh sách cuộc họp</h2><Button onClick={()=>setModal(true)}><Plus size={17}/> Tạo cuộc họp</Button></div><div className="search"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Tìm cuộc họp..."/></div><div className="filters">{[['all','Tất cả'],['processing','Đang xử lý'],['completed','Hoàn tất']].map(([k,v])=><button className={`pill ${filter===k?'chosen':''}`} key={k} onClick={()=>setFilter(k)}>{v}</button>)}</div><div className="list-section">CUỘC HỌP CỦA BẠN <span>{shown.length}</span></div><div className="list-scroll">{shown.map(m=><button key={m.id} className={`meeting-row ${current?.id===m.id?'selected':''}`} onClick={()=>setSelected(m.id)} onDoubleClick={()=>navigate(`/meetings/${m.id}`)}><div className="meeting-icon"><CalendarDays size={19}/></div><div className="meeting-row-text"><strong>{m.title}</strong><small><Clock size={12}/> {fmt(m.createdAt)}</small><span className={'status '+m.status}>{m.status==='completed'?'✓ Hoàn tất':m.status==='failed'?'⚠ Xử lý thất bại':m.status==='recording'?'● Đang ghi âm':m.status==='processing'?'◷ Đang xử lý':'◷ Mới tạo'}</span></div></button>)}{!shown.length&&<div className="empty-list">Chưa có cuộc họp nào. Hãy tạo cuộc họp đầu tiên.</div>}</div></section><section className="overview">{current?<><div className="overview-head"><div><h1><CalendarDays/> {current.title}</h1><p><Clock size={15}/> {fmt(current.createdAt)} <span>·</span> {current.status==='completed'?'Hoàn tất':current.status==='failed'?'Xử lý thất bại':current.status==='processing'?'Đang xử lý':current.status==='recording'?'Đang ghi âm':'Mới tạo'}</p></div><div className="head-buttons"><Button variant="outline" onClick={()=>navigate(`/meetings/${current.id}`)}>Xem chi tiết</Button><Button onClick={()=>navigate(`/meetings/${current.id}/live`)}><AudioLines size={17}/> Bắt đầu ghi âm trực tiếp</Button></div></div><div className="tabs"><span className="tab active">☰ Tổng quan</span><span className="tab">Biên bản đầy đủ</span><span className="tab">Nhiệm vụ</span></div><div className="overview-content"><div className="panel"><div className="panel-title"><AudioLines size={19}/> Bản phiên âm <button onClick={()=>navigate(`/meetings/${current.id}`)}>Xem toàn bộ →</button></div><TranscriptPreview key={`${current.id}-${current.status}`} meetingId={current.id}/></div><div className="panel"><div className="panel-title"><FileText size={19}/> Tóm tắt</div><div className="summary-box">{current.summary||(current.status==='processing'?'Đang xử lý bản ghi âm và tạo tóm tắt...':current.status==='failed'?'Xử lý thất bại. Mở chi tiết để thử lại.':'Chưa có bản tóm tắt. Hãy ghi âm và kết thúc cuộc họp để AI tạo ghi chú.')}</div></div><div className="panel"><div className="panel-title"><CheckCircle2 size={19}/> Nhiệm vụ <button onClick={()=>navigate(`/meetings/${current.id}`)}>Xem tất cả →</button></div><ActionPreview key={`${current.id}-${current.status}`} meetingId={current.id}/></div></div></>:<div className="empty"><AudioLines size={54}/><h2>Chào mừng đến Meeting Notes</h2><p>Tạo một cuộc họp để bắt đầu ghi âm và phiên âm tiếng Việt.</p><Button onClick={()=>setModal(true)}><Plus size={16}/> Tạo cuộc họp đầu tiên</Button></div>}</section>{modal&&<div className="overlay" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(false)}}><form className="dialog" onSubmit={create}><div className="dialog-title"><h3>Tạo cuộc họp</h3><button type="button" onClick={()=>setModal(false)}><X/></button></div><label>Tên cuộc họp *</label><input autoFocus required maxLength={180} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Ví dụ: Weekly Product Sync"/><label>Mô tả</label><textarea rows={4} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Nội dung cuộc họp..."/><div className="dialog-actions"><Button variant="outline" onClick={()=>setModal(false)}>Hủy</Button><button className="btn primary" type="submit" disabled={busy} aria-busy={busy}>{busy&&<span className="btn-spinner" aria-hidden="true"/>}{busy?'Đang tạo...':'Tạo & ghi âm'}</button></div></form></div>}{error&&<div className="toast" onClick={()=>setError('')}>{error} ✕</div>}</div>}
function TranscriptPreview({meetingId}:{meetingId:string}){const[data,setData]=useState<Meeting|null>(null);useEffect(()=>{api<Meeting>(`/meetings/${meetingId}`).then(setData).catch(()=>{})},[meetingId]);return <div className="preview-transcript">{data?.segments?.length?data.segments.slice(0,4).map((s,i)=><TranscriptLine key={i} segment={s} display={data.speakers?.find(x=>x.speakerKey===s.speakerKey)?.displayName||speakerLabel(s.speakerKey)}/>):<div className="placeholder">Bản phiên âm sẽ xuất hiện sau khi bạn bắt đầu ghi âm.</div>}</div>}
function ActionPreview({meetingId}:{meetingId:string}){const[data,setData]=useState<Meeting|null>(null);useEffect(()=>{api<Meeting>(`/meetings/${meetingId}`).then(setData).catch(()=>{})},[meetingId]);return <div className="action-list">{data?.actions?.length?data.actions.slice(0,4).map(a=><div className="action-row" key={a.id}><input type="checkbox" checked={a.completed} readOnly/><span>{a.title}</span><small>{a.assignee||'—'}</small></div>):<div className="placeholder">Chưa có nhiệm vụ nào.</div>}</div>}
function TranscriptLine({segment,display,interim=false}:{segment:Segment;display:string;interim?:boolean}){const key=segment.speakerKey||'unknown';const colorIndex=Array.from(key).reduce((hash,char)=>((hash*31+char.charCodeAt(0))>>>0),0)%5;return <div className={`transcript-line ${interim?'interim':''}`}><div className={`speaker-avatar speaker-color-${colorIndex}`}>{display.slice(0,2).toUpperCase()}</div><div><div className="speaker-meta"><b>{display}</b><small>{clock(segment.startMs)}</small>{interim&&<span className="live-dot">Đang nói...</span>}</div><p>{segment.content}</p></div></div>}
function MeetingMinutesReport({meeting,onToggle}:{meeting:Meeting;onToggle:(action:Action)=>void}){
 const minutes=meeting.minutes;
 const duration=meeting.startedAt&&meeting.finishedAt?Math.max(0,Math.round((new Date(meeting.finishedAt).getTime()-new Date(meeting.startedAt).getTime())/60000)):null;
 const hasDetails=Boolean(meeting.summary||minutes?.topics?.length||meeting.decisions?.length||meeting.actions?.length);
 return <article className="minutes-report">
  <section className="minutes-section">
   <h3><CalendarDays size={18}/> Thông tin chung</h3>
   <dl className="minutes-facts">
    <div><dt>Ngày họp</dt><dd>{meeting.startedAt?fmt(meeting.startedAt):fmt(meeting.createdAt)}</dd></div>
    <div><dt>Hình thức</dt><dd>{minutes?.meetingType||'Chưa xác định'}</dd></div>
    <div><dt>Thời lượng</dt><dd>{duration!==null?`${duration} phút`:'Chưa xác định'}</dd></div>
    <div><dt>Thành phần tham dự</dt><dd>{minutes?.attendees?.length?minutes.attendees.join(', '):'Chưa xác định'}</dd></div>
   </dl>
  </section>
  <section className="minutes-section">
   <h3><FileText size={18}/> Tóm tắt</h3>
   <p className="minutes-summary">{meeting.summary||'Chưa có bản tóm tắt.'}</p>
  </section>
  <section className="minutes-section">
   <h3><ClipboardList size={18}/> Nội dung chính</h3>
   {minutes?.topics?.length?minutes.topics.map((topic,i)=><div className="minutes-topic" key={i}>
    <h4>{topic.title}</h4>
    <ul>{topic.points.map((point,j)=><li key={j}>{point}</li>)}</ul>
   </div>):<p className="muted">Chưa có nội dung theo chủ đề. Có thể tạo lại bản tóm tắt để phân tích chi tiết.</p>}
  </section>
  <section className="minutes-section">
   <h3><CheckCircle2 size={18}/> Quyết định</h3>
   {meeting.decisions?.length?<ul className="minutes-list">{meeting.decisions.map((decision,i)=><li key={i}>{decision}</li>)}</ul>:<p className="muted">Không ghi nhận quyết định được thống nhất.</p>}
  </section>
  <section className="minutes-section">
   <h3><Check size={18}/> Việc cần làm</h3>
   {meeting.actions?.length?<div className="minutes-tasks">{meeting.actions.map(action=><label className="minutes-task" key={action.id}>
    <input type="checkbox" checked={action.completed} onChange={()=>onToggle(action)}/>
    <div><div className={action.completed?'minutes-task-done':''}>{action.title}</div>
     <div className="minutes-task-meta"><span><Users size={13}/>{action.assignee||'Chưa phân công'}</span><span><CalendarDays size={13}/>{action.dueDate||'Chưa có hạn'}</span></div>
    </div>
   </label>)}</div>:<p className="muted">Không phát hiện việc cần làm trong cuộc họp.</p>}
  </section>
  {!hasDetails&&<p className="muted">Hãy kết thúc cuộc họp để AI tạo biên bản.</p>}
 </article>;
}
function Detail(){const{id}=useParams();const navigate=useNavigate();const[m,setM]=useState<Meeting|null>(null),[tab,setTab]=useState('transcript'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[playing,setPlaying]=useState(false);const [audioSrc,setAudioSrc]=useState('');const [popup,setPopup]=useState<{kind:PopupKind;speaker?:string}|null>(null),[popupValue,setPopupValue]=useState(''),[popupBusy,setPopupBusy]=useState(false),[popupError,setPopupError]=useState('');const audio=useRef<HTMLAudioElement>(null);const processingSeen=useRef(false);
const load=useCallback(()=>{if(id)api<Meeting>(`/meetings/${id}`).then(next=>{
 if(['queued','transcribing','generating_notes'].includes(next.processingStage||''))processingSeen.current=true;
 if(next.processingStage==='completed'&&processingSeen.current){setTab('summary');processingSeen.current=false}
 setM(next);
 }).catch(e=>setError(e.message))},[id]);
useEffect(()=>{load()},[load]);
useEffect(()=>{
 if(!['queued','transcribing','generating_notes'].includes(m?.processingStage||''))return;
 const interval=setInterval(load,2500);return()=>clearInterval(interval);
},[m?.processingStage,load]);useEffect(()=>{if(!id||!m?.audioPath)return;let url='';fetch(`/api/meetings/${id}/audio`,{headers:{Authorization:`Bearer ${getToken()}`}}).then(r=>r.blob()).then(blob=>{url=URL.createObjectURL(blob);setAudioSrc(url)}).catch(()=>{});return()=>{if(url)URL.revokeObjectURL(url)}},[id,m?.audioPath]);const remove=()=>{setPopupError('');setPopup({kind:'delete'})};
 const notes=async()=>{if(busy)return;setBusy(true);setError('');try{await api(`/meetings/${id}/notes`,{method:'POST'});load()}catch(ex:any){setError(ex.message)}finally{setBusy(false)}};
 const renameSpeaker=(key:string)=>{setPopupError('');setPopupValue(m?.speakers?.find(x=>x.speakerKey===key)?.displayName||'');setPopup({kind:'speaker',speaker:key})};
 const submitPopup=async()=>{if(!popup||popupBusy||!id)return;if(popup.kind==='speaker'&&!popupValue.trim())return;setPopupBusy(true);setPopupError('');try{
  if(popup.kind==='delete'){await api(`/meetings/${id}`,{method:'DELETE'});setPopup(null);navigate('/')}
  else {await api(`/meetings/${id}/speakers`,{method:'PATCH',body:JSON.stringify({speakerKey:popup.speaker,displayName:popupValue.trim()})});setPopup(null);load()}
 }catch(ex:any){setPopupError(ex.message)}finally{setPopupBusy(false)}};
 const toggle=async(a:Action)=>{await api(`/meetings/${id}/actions/${a.id}`,{method:'PATCH',body:JSON.stringify({completed:!a.completed})});load()};if(!m)return <div className="loading">{error||'Đang tải cuộc họp...'}</div>;const speakerName=(s:Segment)=>m.speakers?.find(x=>x.speakerKey===s.speakerKey)?.displayName||speakerLabel(s.speakerKey);return <div className="detail-page"><div className="detail-head"><div><h1><button className="back" onClick={()=>navigate('/')}><ArrowLeft/></button> {m.title}<span className={'status '+m.status}>{m.processingStage==='transcribing'?'Đang phiên âm':m.processingStage==='generating_notes'?'Đang tạo Ghi chú AI':m.processingStage==='queued'?'Đang chờ xử lý':m.processingStage==='failed'?'Thất bại':m.status==='completed'?'✓ Hoàn tất':m.status}</span></h1><p><CalendarDays size={15}/> {fmt(m.createdAt)} <span>·</span> <Clock size={15}/> {m.startedAt&&m.finishedAt?`${Math.round((new Date(m.finishedAt).getTime()-new Date(m.startedAt).getTime())/60000)} phút`:'Chưa kết thúc'}</p></div><div className="head-buttons"><Button variant="danger" onClick={remove}><Trash2 size={16}/> Xóa</Button><Button onClick={()=>navigate(`/meetings/${id}/live`)}><Mic size={16}/> Ghi âm</Button></div></div><div className="detail-grid"><aside className="detail-left"><div className="panel"><div className="panel-title">Thông tin cuộc họp</div><label>Tiêu đề</label><strong>{m.title}</strong><label>Mô tả</label><p>{m.description||'—'}</p><label>Trạng thái</label><span className={'status '+m.status}>{statusLabel(m.status,m.processingStage)}</span><label>Ngày tạo</label><p>{fmt(m.createdAt)}</p></div><div className="panel"><div className="panel-title">Người nói</div><p className="muted small">Nhấn để gán tên cho từng người nói.</p>{[...new Set(m.segments?.map(s=>s.speakerKey).filter(Boolean)||[])].map(key=><button className="speaker-map" key={key} onClick={()=>renameSpeaker(key!)}><Users size={15}/>{speakerLabel(key)} <span>→ {m.speakers?.find(s=>s.speakerKey===key)?.displayName||'Gán tên'}</span></button>)}</div></aside><section className="detail-center"><div className="tabs">{[['transcript','Biên bản đầy đủ'],['summary','Biên bản'],['actions','Nhiệm vụ']].map(([k,v])=><button className={`tab ${tab===k?'active':''}`} onClick={()=>setTab(k)} key={k}>{v}</button>)}</div>{tab==='transcript'&&<div className="panel scroll-panel"><div className="panel-title"><AudioLines size={19}/> Bản phiên âm ({m.segments?.length||0} đoạn)</div>{m.segments?.length?m.segments.map(s=><TranscriptLine key={s.id} segment={s} display={speakerName(s)}/>):<div className="placeholder">Chưa có bản phiên âm. Chọn Ghi âm để bắt đầu.</div>}</div>}{tab==='summary'&&<div className="panel minutes-container">
 <div className="panel-title"><FileText size={19}/> Biên bản cuộc họp
 <Button variant="outline" disabled={busy} onClick={notes}><RefreshCw size={15}/>{busy?'Đang tạo...':'Tạo lại biên bản'}</Button></div>
 {m.summary||m.minutes||m.decisions?.length||m.actions?.length?
 <MeetingMinutesReport meeting={m} onToggle={toggle}/>:
 <div className="placeholder">{m.processingStage==='failed'?'Không thể tạo biên bản. Hãy thử xử lý lại.':m.processingStage==='completed'?'Chưa có nội dung biên bản.':'Biên bản sẽ tự xuất hiện sau khi xử lý hoàn tất.'}</div>}
 </div>}{tab==='actions'&&<div className="panel"><div className="panel-title"><CheckCircle2 size={19}/> Nhiệm vụ</div>{m.actions?.length?m.actions.map(a=><div className="action-row" key={a.id}><input type="checkbox" checked={a.completed} onChange={()=>toggle(a)}/><span style={{textDecoration:a.completed?'line-through':'none'}}>{a.title}</span><small>{a.assignee||'Chưa rõ'}</small><small>{a.dueDate||'—'}</small></div>):<div className="placeholder">{m.processingStage==='completed'?'Không phát hiện nhiệm vụ nào':m.processingStage==='failed'?'Chưa tạo được nhiệm vụ. Bạn có thể thử xử lý lại.': 'Nhiệm vụ sẽ tự xuất hiện sau khi AI hoàn tất xử lý.'}</div>}</div>}{error&&<p className="error">{error}</p>}{['queued','transcribing','generating_notes'].includes(m.processingStage||'')&&
 <div className="panel note-panel" role="status" aria-live="polite">
  <div className="panel-title"><RefreshCw size={18}/> Đang xử lý cuộc họp</div>
  <p>{m.processingStage==='queued'?'Đang chờ xử lý...':m.processingStage==='transcribing'?'Đang phiên âm bản ghi âm...':'Đang tạo bản tóm tắt, quyết định và nhiệm vụ...'}</p>
  <p className="muted small">Bạn có thể rời trang. Quá trình xử lý tiếp tục trên server và trang này tự cập nhật.</p>
 </div>}
 {m.processingStage==='failed'&&<div className="panel note-panel" role="alert">
  <div className="panel-title">Xử lý cuộc họp thất bại</div>
  <p className="error">{m.processingError||'Không thể xử lý cuộc họp.'}</p>
  <Button loading={busy} onClick={async()=>{setBusy(true);setError('');try{await api(`/meetings/${id}/process`,{method:'POST'});load()}catch(ex:any){setError(ex.message)}finally{setBusy(false)}}}>Thử xử lý lại</Button>
 </div>}
 </section><aside className="detail-right"><div className="panel"><div className="panel-title"><Headphones size={18}/> Âm thanh cuộc họp</div>{audioSrc?<><audio ref={audio} src={audioSrc} controls className="audio"/><a download={`${m.title}.webm`} href={audioSrc} className="download"><Download size={16}/> Tải bản ghi âm</a></>:<p className="muted">Chưa có bản ghi âm.</p>}</div><div className="panel"><div className="panel-title"><Users size={18}/> Người nói</div>{m.speakers?.length?m.speakers.map(s=><div key={s.id} className="small speaker-item">{speakerLabel(s.speakerKey)} → <b>{s.displayName}</b></div>):<p className="muted">Chưa có Người nói được gán tên.</p>}</div><div className="panel"><div className="panel-title"><FileText size={18}/> Tóm tắt</div><p className="small muted">{m.summary?.slice(0,200)||'Chưa có bản tóm tắt.'}</p></div></aside></div>{popup&&<MeetingPopup kind={popup.kind} speaker={popup.speaker} value={popupValue} onValueChange={setPopupValue} loading={popupBusy} error={popupError} onClose={()=>setPopup(null)} onConfirm={submitPopup}/>}</div>}
function Live(){const{id}=useParams();const navigate=useNavigate();const[m,setM]=useState<Meeting|null>(null),[segments,setSegments]=useState<Segment[]>([]),[interim,setInterim]=useState<Segment|null>(null),[status,setStatus]=useState('idle'),[error,setError]=useState(''),[seconds,setSeconds]=useState(0),[paused,setPaused]=useState(false),[busy,setBusy]=useState(false);const socket=useRef<Socket|null>(null),media=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),chunks=useRef<Blob[]>([]),tick=useRef<ReturnType<typeof setInterval>|null>(null),bottom=useRef<HTMLDivElement>(null);const audioContext=useRef<AudioContext|null>(null),processor=useRef<ScriptProcessorNode|null>(null),audioSource=useRef<MediaStreamAudioSourceNode|null>(null);useEffect(()=>{api<Meeting>(`/meetings/${id}`).then(x=>{setM(x);setSegments(x.segments||[])}).catch(e=>setError(e.message));return()=>{if(tick.current)clearInterval(tick.current);media.current?.state!=='inactive'&&media.current?.stop();stream.current?.getTracks().forEach(t=>t.stop());processor.current?.disconnect();audioSource.current?.disconnect();void audioContext.current?.close();socket.current?.disconnect()}},[id]);useEffect(()=>{bottom.current?.scrollIntoView({behavior:'smooth'})},[segments,interim]);const start=async()=>{setError('');try{
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('Cần HTTPS hoặc localhost để truy cập microphone');
 const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1}});
 stream.current=mic;
 // Initialize audio engine while handling the user-initiated recording action.
 const context=new AudioContext();audioContext.current=context;
 await context.resume();
 const s=io({auth:{token:getToken()},transports:['websocket']});socket.current=s;
 s.on('live:error',(msg:string)=>{setError(msg);setStatus('error')});
 s.on('live:final',(seg:Segment)=>{setSegments(old=>[...old,seg]);setInterim(null)});
 s.on('live:interim',(seg:Segment)=>setInterim(seg.content?seg:null));
 s.on('live:ready',()=>{
  try{
   // Keep original compressed recording for Scribe batch diarization.
   const mime=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
   const recorder=new MediaRecorder(mic,{mimeType:mime});chunks.current=[];
   recorder.ondataavailable=ev=>{if(ev.data.size)chunks.current.push(ev.data)};
   recorder.start(1000);media.current=recorder;
   // OpenAI gpt-live-transcribe requires PCM16 mono at 24 kHz.
   const context=audioContext.current!;
   const source=context.createMediaStreamSource(mic);audioSource.current=source;
   const node=context.createScriptProcessor(4096,1,1);processor.current=node;
   node.onaudioprocess=event=>{
    if(media.current?.state!=='recording'||!s.connected)return;
    const samples=event.inputBuffer.getChannelData(0);
    const ratio=context.sampleRate/24000;
    const length=Math.floor(samples.length/ratio);
    const pcm=new Int16Array(length);
    for(let i=0;i<length;i++){
     const sample=Math.max(-1,Math.min(1,samples[Math.floor(i*ratio)]));
     pcm[i]=sample<0?Math.round(sample*32768):Math.round(sample*32767);
    }
    s.emit('live:audio',pcm.buffer);
   };
   source.connect(node);node.connect(context.destination);
   setStatus('recording');tick.current=setInterval(()=>setSeconds(x=>x+1),1000);
  }catch(e:any){setError(e.message);setStatus('error')}
 });
 s.on('connect',()=>s.emit('live:start',{meetingId:id}));
 setStatus('connecting');
 }catch(e:any){setError(e.message);stream.current?.getTracks().forEach(t=>t.stop())}};
const pause=()=>{if(!media.current)return;if(media.current.state==='recording'){media.current.pause();setPaused(true)}else if(media.current.state==='paused'){media.current.resume();setPaused(false)}};const stop=async(generate:boolean)=>{setBusy(true);setError('');try{
 if(tick.current)clearInterval(tick.current);
 processor.current?.disconnect();audioSource.current?.disconnect();await audioContext.current?.close();
 processor.current=null;audioSource.current=null;audioContext.current=null;
 const recorder=media.current;
 if(recorder&&recorder.state!=='inactive'){
  await new Promise<void>(resolve=>{recorder.addEventListener('stop',()=>resolve(),{once:true});recorder.stop()});
 }
 stream.current?.getTracks().forEach(t=>t.stop());
 // Give OpenAI a chance to commit the trailing speech turn before disconnecting.
 await new Promise<void>(resolve=>{
  const live=socket.current;
  if(!live?.connected){resolve();return}
  const timeout=setTimeout(()=>{live.off('live:stopped',onStopped);resolve()},7500);
  const onStopped=()=>{clearTimeout(timeout);resolve()};
  live.once('live:stopped',onStopped);
  live.emit('live:stop');
 });
 socket.current?.disconnect();
 setStatus('processing');
 const blob=new Blob(chunks.current,{type:'audio/webm'});
 if(!blob.size)throw new Error('Không có audio để xử lý');
 const form=new FormData();form.append('audio',blob,'recording.webm');
 await api(`/meetings/${id}/audio`,{method:'POST',body:form});
 if(generate)await api(`/meetings/${id}/process`,{method:'POST'});
 navigate(`/meetings/${id}`);
 }catch(ex:any){setError(ex.message);setStatus('error')}finally{setBusy(false)}};
const running=status==='recording';return <div className="live-page"><aside className="live-left"><div className="live-title"><h2>{m?.title||'Cuộc họp trực tiếp'}</h2><span className="record-badge">● {running?'Đang ghi âm':status==='connecting'?'Đang kết nối':status==='processing'?'Đang xử lý':'Sẵn sàng'}</span></div>{m?.description&&<p className="muted">{m.description}</p>}<div className="record-timer"><span className="rec-dot">●</span> {clock(seconds*1000)} <AudioLines size={35}/></div><div className="record-controls">{status==='idle'||status==='error'?<Button onClick={start}><Mic size={18}/> Bắt đầu ghi âm</Button>:<><Button variant="outline" disabled={!running} onClick={pause}>{paused?<Play size={17}/>:<Pause size={17}/>} {paused?'Tiếp tục':'Tạm dừng'}</Button><Button variant="outline" loading={busy} disabled={status==='connecting'} onClick={()=>stop(false)}><Square size={16}/> Dừng</Button><Button loading={busy} disabled={status==='connecting'} onClick={()=>stop(true)}><CheckCircle2 size={17}/> Kết thúc và tạo tóm tắt</Button></>}</div><div className="panel"><div className="panel-title"><Mic size={19}/> Micrô</div><p className="small">{running?(paused?'Đang tạm dừng':'Đang ghi âm trên thiết bị này'):'Chưa ghi âm'}</p><div className={`wave ${running&&!paused?'animate':''}`}>{Array.from({length:30},(_,i)=><i key={i} style={{height:10+(i*17%33)}}/>)}</div></div><div className="panel"><div className="panel-title"><Clock size={18}/> Trạng thái</div><p className="small">Thời gian: {clock(seconds*1000)}</p><p className="small">Số đoạn phiên âm: {segments.length}</p><p className="small">Ngôn ngữ: Tiếng Việt (vi)</p></div><Button variant="outline" onClick={()=>navigate(`/meetings/${id}`)}><ArrowLeft size={15}/> Trở về chi tiết</Button>{error&&<p className="error">{error}</p>}</aside><section className="live-middle"><div className="live-header"><h2><AudioLines/> Phiên âm trực tiếp</h2><span className="status recording">{running?'● Đang chạy':'○ '+status}</span></div><div className="live-messages">{segments.map((seg,i)=><div className="live-plain-line" key={seg.id||i}><small>{clock(seg.startMs)}</small><p>{seg.content}</p></div>)}{interim&&<div className="live-plain-line live-plain-interim"><small>{clock(interim.startMs)} · Đang nhận diện</small><p>{interim.content}</p></div>}{!segments.length&&!interim&&<div className="empty"><Mic size={54}/><h3>Sẵn sàng phiên âm</h3><p>Nhấn Bắt đầu ghi âm để chuyển tiếng nói thành văn bản.</p></div>}<div ref={bottom}/></div><div className="live-footer"><span>● {running?'Đang phiên âm trực tiếp...':'Chưa phát trực tiếp'}</span></div></section><aside className="live-right"><h2>✦ Tóm tắt AI</h2><div className="info-banner">Bản tóm tắt cuối cùng được tạo từ bản phiên âm khi cuộc họp kết thúc.</div><div className="panel"><div className="panel-title"><FileText size={18}/> Điểm chính</div><p className="muted small">Nội dung sẽ được AI tổng hợp sau cuộc họp để tránh suy đoán từ transcript chưa hoàn chỉnh.</p></div><div className="panel"><div className="panel-title"><CheckCircle2 size={18}/> Quyết định</div><p className="muted small">AI sẽ trích xuất các quyết định đã được thống nhất.</p></div><div className="panel"><div className="panel-title"><ClipboardList size={18}/> Nhiệm vụ</div><p className="muted small">Nhiệm vụ, người phụ trách và deadline được lấy từ nội dung thực tế.</p></div></aside></div>}
export default App;
