// components.js – React UI components (JSX, compiled by Babel in the browser)
const{useState,useCallback,useMemo,useEffect,useRef,memo}=React;

// chordTarget: a hidden cell a chord on the hovered number would open. chordReady: that number itself.
window.Cell=memo(({x,y,state,gameOver,chordTarget,chordReady,pulse,size,onReveal,onFlag,onHover,onLeave})=>{
    const style=useMemo(()=>({width:size,height:size,fontSize:Math.max(9,size*.37)}),[size]);
    let className='cell ',content='';
    if(state==='exp'){className+='cell-exp';content='💥'}
    else if(state==='mine'){className+='cell-mine';content='💣'}
    else if(state==='flag-ok'){className+='cell-flag-ok';content='🚩'}
    else if(state==='flag-bad'){className+='cell-flag-bad';content=<><span style={{opacity:.7}}>🚩</span><span className="wrong-x" style={{fontSize:size*.5}}>✕</span></>}
    else if(state==='flag'){className+='cell-flag';content='🚩'}
    else if(state==='quest'){className+='cell-hidden';content='❓'}
    else if(state&&state[0]==='r'){className+='cell-rev';if(chordReady)className+=' cell-cr';const count=+state[1];if(count)content=<span className={`n${count}`}>{count}</span>}
    else{className+='cell-hidden';if(chordTarget)className+=' cell-hl';else if(pulse)className+=' cell-pulse'}
    return<div className={className} style={style} onClick={e=>{e.preventDefault();if(!gameOver)onReveal(x,y)}} onContextMenu={e=>{e.preventDefault();if(!gameOver)onFlag(x,y)}} onMouseEnter={()=>onHover(x,y)} onMouseLeave={onLeave}>{content}</div>;
});

function useEscapeKey(onEscape){
    const handler=useRef(onEscape);handler.current=onEscape;
    useEffect(()=>{
        const onKeyDown=e=>{if(e.key==='Escape'&&handler.current)handler.current()};
        document.addEventListener('keydown',onKeyDown);return()=>document.removeEventListener('keydown',onKeyDown);
    },[]);
}
// Open state for a header dropdown, which closes on Escape or a click outside ref.
function useDropdown(){
    const[open,setOpen]=useState(false);
    const ref=useRef(null);
    useEffect(()=>{
        if(!open)return;
        const onMouseDown=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};
        const onKeyDown=e=>{if(e.key==='Escape')setOpen(false)};
        document.addEventListener('mousedown',onMouseDown);document.addEventListener('keydown',onKeyDown);
        return()=>{document.removeEventListener('mousedown',onMouseDown);document.removeEventListener('keydown',onKeyDown)};
    },[open]);
    return[open,setOpen,ref];
}

// Rows shared by the settings and start menus.
const Checkbox=({label,checked,onChange,dim})=>(
    <label style={{display:'flex',alignItems:'center',gap:6,color:dim?'#aaa':'#ccc',fontSize:18,padding:'2px 0',cursor:'pointer',userSelect:'none'}}>
        <input type="checkbox" style={{accentColor:'#6366f1',width:12,height:12,flexShrink:0}} checked={checked} onChange={onChange}/>
        {label}
    </label>
);
const Radio=({label,name,checked,onChange,disabled})=>(
    <label style={{display:'flex',alignItems:'center',gap:6,color:'#999',fontSize:12,padding:'1px 0',cursor:disabled?'default':'pointer',userSelect:'none',opacity:disabled?.5:1}}>
        <input type="radio" name={name} style={{accentColor:'#6366f1',width:11,height:11,flexShrink:0}} checked={checked} onChange={onChange} disabled={disabled}/>
        {label}
    </label>
);
const SubOptions=({children})=>(
    <div style={{marginLeft:18,paddingLeft:8,borderLeft:'2px solid #2a2a4a',marginTop:1,marginBottom:2}}>{children}</div>
);

// Gameplay hints. The start menu offers them too, since a new room takes them as its shared hints.
window.HintOptions=function HintOptions({hints,setHints}){
    return(<>
        <Checkbox label="Show wrong flags on death" checked={hints.wrongFlags} onChange={e=>setHints(h=>({...h,wrongFlags:e.target.checked}))}/>
        <Checkbox label="Highlight remaining cells on hover" checked={hints.pulseNeighbors} onChange={e=>setHints(h=>({...h,pulseNeighbors:e.target.checked}))}/>
        <Checkbox label="Right-click number to auto-flag mines" checked={hints.chordFlag} onChange={e=>setHints(h=>({...h,chordFlag:e.target.checked}))}/>
        <Checkbox label="Enable undo" checked={hints.undoEnabled} onChange={e=>setHints(h=>({...h,undoEnabled:e.target.checked}))}/>
        {hints.undoEnabled&&<SubOptions>
            <Radio label="Infinite undo" name="undoMode" checked={hints.undoMode==='infinite'} onChange={()=>setHints(h=>({...h,undoMode:'infinite'}))}/>
            <Radio label="1 free / 1000 cleared" name="undoMode" checked={hints.undoMode==='refill'||(hints.undoMode!=='infinite'&&hints.undoMode!=='stack')} onChange={()=>setHints(h=>({...h,undoMode:'refill'}))}/>
            <Radio label="Stacking +1 / 1000 cleared" name="undoMode" checked={hints.undoMode==='stack'} onChange={()=>setHints(h=>({...h,undoMode:'stack'}))}/>
        </SubOptions>}
    </>);
};

window.SettingsModal=function SettingsModal({hints,setHints,uiSettings,setUiSettings,viewMode,changeView,cellSize,setCellSize,onClose}){
    useEscapeKey(onClose);
    const SectionHeading=({children})=>(
        <div style={{marginTop:10,marginBottom:4}}>
            <div style={{color:'#8b8ba8',fontSize:12,fontWeight:700,letterSpacing:'0.09em',textTransform:'uppercase',marginBottom:4}}>{children}</div>
            <div style={{height:1,background:'#2a2a4a'}}/>
        </div>
    );
    const SmallButton=({onClick,label})=>(
        <button className="hb" style={{padding:'0 5px',fontSize:12,lineHeight:'18px',minWidth:20}} onClick={onClick}>{label}</button>
    );
    const Stepper=({label,value,onDec,onInc,onReset})=>(
        <div style={{display:'flex',alignItems:'center',gap:5,padding:'2px 0'}}>
            <span style={{color:'#aaa',fontSize:12,minWidth:82}}>{label}</span>
            <SmallButton onClick={onDec} label="−"/>
            <span style={{color:'#9ca3af',fontSize:11,width:30,textAlign:'center'}}>{value}</span>
            <SmallButton onClick={onInc} label="+"/>
            {onReset&&<SmallButton onClick={onReset} label="↺"/>}
        </div>
    );
    const zoomPct=Math.round(cellSize/CELL_SIZE_DEFAULT*100);
    const defaultZoomPct=Math.round(uiSettings.defaultCellSize/CELL_SIZE_DEFAULT*100);
    return(
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-panel" style={{minWidth:360,maxWidth:580,padding:'12px 16px',overflowY:'auto',maxHeight:'85vh',gap:0}} onClick={e=>e.stopPropagation()}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                    <h2 style={{margin:0,fontSize:16}}>⚙ Settings</h2>
                    <button style={{background:'transparent',border:0,color:'#666',fontSize:22,lineHeight:2,cursor:'pointer',padding:'0 3px'}} onClick={onClose}>×</button>
                </div>

                <SectionHeading>Display</SectionHeading>
                <Checkbox label="Pan arrows" checked={uiSettings.showArrows} onChange={e=>setUiSettings(u=>({...u,showArrows:e.target.checked}))}/>
                <Checkbox label="Scores (flags / moves / cleared)" checked={uiSettings.showScores} onChange={e=>setUiSettings(u=>({...u,showScores:e.target.checked}))}/>
                <Checkbox label="Leaderboard" checked={uiSettings.showLeaderboard} onChange={e=>setUiSettings(u=>({...u,showLeaderboard:e.target.checked}))}/>
                <Checkbox label="Undo counter" checked={uiSettings.showUndo} onChange={e=>setUiSettings(u=>({...u,showUndo:e.target.checked}))}/>
                <Checkbox label="Zoom controls" checked={uiSettings.showZoom} onChange={e=>setUiSettings(u=>({...u,showZoom:e.target.checked}))}/>
                <Checkbox label="Coordinates" checked={uiSettings.showCoords} onChange={e=>setUiSettings(u=>({...u,showCoords:e.target.checked}))}/>
                <Checkbox label="Seed" checked={uiSettings.showSeed} onChange={e=>setUiSettings(u=>({...u,showSeed:e.target.checked}))}/>
                {uiSettings.showSeed&&<SubOptions>
                    <Checkbox label="Seed input" dim checked={uiSettings.showSeedBox} onChange={e=>setUiSettings(u=>({...u,showSeedBox:e.target.checked}))}/>
                    <Checkbox label="Lock button" dim checked={uiSettings.showLockBtn} onChange={e=>setUiSettings(u=>({...u,showLockBtn:e.target.checked}))}/>
                </SubOptions>}

                <SectionHeading>Hints</SectionHeading>
                <HintOptions hints={hints} setHints={setHints}/>

                <SectionHeading>Defaults</SectionHeading>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Screen size</span>
                    <select className="hs" value={viewMode} onChange={e=>changeView(e.target.value)}>
                        <option>Small</option><option>Medium</option><option>Large</option><option>Fullscreen</option>
                    </select>
                </div>
                <Stepper label="Zoom" value={`${zoomPct}%`} onDec={()=>setCellSize(s=>Math.max(CELL_SIZE_MIN,s-CELL_SIZE_STEP))} onInc={()=>setCellSize(s=>Math.min(CELL_SIZE_MAX,s+CELL_SIZE_STEP))} onReset={()=>setCellSize(uiSettings.defaultCellSize)}/>
                <Stepper label="Default zoom" value={`${defaultZoomPct}%`} onDec={()=>setUiSettings(u=>({...u,defaultCellSize:Math.max(CELL_SIZE_MIN,u.defaultCellSize-CELL_SIZE_STEP)}))} onInc={()=>setUiSettings(u=>({...u,defaultCellSize:Math.min(CELL_SIZE_MAX,u.defaultCellSize+CELL_SIZE_STEP)}))}/>

                <SectionHeading>Export</SectionHeading>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Image size</span>
                    <select className="hs" value={uiSettings.exportRes||'auto'} onChange={e=>setUiSettings(u=>({...u,exportRes:e.target.value}))}>
                        <option value="auto">Auto (under 8 MB)</option><option value="32">Full (32 px/cell)</option><option value="16">Half (16 px/cell)</option><option value="8">Quarter (8 px/cell)</option>
                    </select>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Timelapse speed</span>
                    <select className="hs" value={String(uiSettings.tlMovesPerFrame||1)} onChange={e=>setUiSettings(u=>({...u,tlMovesPerFrame:+e.target.value}))}>
                        {[1,2,4,8,16,32].map(n=><option key={n} value={n}>{n===1?'1 move':`${n} moves`} per frame</option>)}
                    </select>
                    <select className="hs" value={String(uiSettings.tlFps||60)} onChange={e=>setUiSettings(u=>({...u,tlFps:+e.target.value}))}>
                        <option value="30">30 fps</option><option value="60">60 fps</option>
                    </select>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Video size</span>
                    <select className="hs" value={uiSettings.tlRes||'auto'} onChange={e=>setUiSettings(u=>({...u,tlRes:e.target.value}))}>
                        <option value="auto">Auto (up to 24 px per cell)</option><option value="720">720p (0.9 MP)</option><option value="1080">1080p (2 MP)</option><option value="1440">1440p (3.7 MP)</option><option value="2160">4K (8.3 MP)</option>
                    </select>
                </div>
                <div style={{color:'#777',fontSize:11,paddingLeft:90}}>The video takes the board's shape, with a border of unopened cells, and stays under 50 MB.{uiSettings.tlRes==='2160'&&(uiSettings.tlFps||60)===60?' At 60 fps, 4K is reduced to about 4 MP to stay within what standard H.264 players support.':''}</div>

                <div style={{display:'flex',justifyContent:'center',marginTop:10}}>
                    <button className="close-btn" style={{color:'#888',fontSize:12}} onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

window.GameDropdown=function GameDropdown({onExport,onImport,onClear,onExportImage,onExportVideo,videoExporting}){
    const[open,setOpen,ref]=useDropdown();
    return(<div ref={ref} style={{position:'relative'}}>
        <button className="hb" onClick={()=>setOpen(o=>!o)}>💾</button>
        {open&&<div className="hints-panel" style={{minWidth:170}}>
            <label onClick={()=>{onExport();setOpen(false)}}>Save Game</label>
            <label>Load Game<input type="file" className="hidden" onChange={e=>{onImport(e);setOpen(false)}} accept=".json"/></label>
            <div style={{height:1,background:'#3a3a5c',margin:'4px 0'}}/>
            <label onClick={()=>{onExportImage(false);setOpen(false)}}>Image Only</label>
            <label onClick={()=>{onExportImage(true);setOpen(false)}}>Image + Stats</label>
            <div style={{height:1,background:'#3a3a5c',margin:'4px 0'}}/>
            <label onClick={()=>{if(!videoExporting){onExportVideo();setOpen(false)}}} style={videoExporting?{opacity:.5,cursor:'default'}:{}}>{videoExporting?'Exporting video…':'Export Timelapse (MP4)'}</label>
            <div style={{height:1,background:'#3a3a5c',margin:'4px 0'}}/>
            <label onClick={()=>{if(confirm('Clear local cache?')){onClear();setOpen(false)}}} style={{color:'#f87171'}}>Clear Cache</label>
        </div>}
    </div>);
};

window.LeaderboardList=function LeaderboardList({entries,highlight}){
    if(!entries||entries.length===0)return <div className="lb-empty">No games finished yet</div>;
    return(<div style={{display:'flex',flexDirection:'column',gap:2}}>
        <div className="lb-row lb-head">
            <span className="lb-rank"></span>
            <span title="Squares Cleared">🟦</span>
            <span title="Moves Made">👆</span>
            <span title="Mines Flagged">🚩</span>
        </div>
        {entries.map((entry,i)=>{
            const date=new Date(entry.date);
            const dateText=isNaN(date.getTime())?'':date.toLocaleString();
            const tooltip=[dateText,entry.seed?`seed: ${entry.seed}`:''].filter(Boolean).join(' · ');
            return(
                <div key={entry.runId||entry.date} className={`lb-row${i%2?' lb-alt':''}${entry.date===highlight?' lb-mine':''}`} title={tooltip}>
                    <span className="lb-rank">#{i+1}</span>
                    <span>{entry.cleared}</span>
                    <span>{entry.moves}</span>
                    <span>{entry.flags}</span>
                </div>
            );
        })}
    </div>);
};

window.LeaderboardDropdown=function LeaderboardDropdown({entries,currentScore}){
    const[open,setOpen,ref]=useDropdown();
    return(<div ref={ref} style={{position:'relative'}}>
        <button className="hb" onClick={()=>setOpen(o=>!o)} title="Leaderboard (top 8 by squares cleared)">📋 {currentScore}</button>
        {open&&<div className="hints-panel" style={{minWidth:200}}>
            <div style={{color:'#fff',fontSize:13,fontWeight:600,textAlign:'center',marginBottom:6}}>🏆 Leaderboard</div>
            <LeaderboardList entries={entries}/>
        </div>}
    </div>);
};

// Progress of an image or timelapse export. Updates come through task.progress (a tiny store) rather than props,
// so a running export doesn't re-render the board.
function useExportProgress(task){
    const[progress,setProgress]=useState(task.progress.get());
    const[,setClockTick]=useState(0);
    const phaseStart=useRef(null);
    useEffect(()=>task.progress.sub(setProgress),[task.progress]);
    useEffect(()=>{const t=setInterval(()=>setClockTick(n=>n+1),500);return()=>clearInterval(t)},[]);
    const video=task.kind==='video';
    const fraction=progress.phase==='estimate'?null:video?(progress.total?Math.min(1,progress.done/progress.total):0):(progress.done||0);
    if(!phaseStart.current||phaseStart.current.phase!==progress.phase)phaseStart.current={phase:progress.phase,time:Date.now(),fraction:fraction||0};
    const start=phaseStart.current,secondsInPhase=(Date.now()-start.time)/1000;
    const eta=fraction!==null&&fraction>start.fraction&&secondsInPhase>2?secondsInPhase/(fraction-start.fraction)*(1-fraction):null;
    const label=!progress.phase?'Starting…'
        :progress.phase==='prepare'?'Replaying moves…'
        :progress.phase==='encode'?(video?'Encoding video…':`Compressing at ${progress.sz} px per cell…`)
        :progress.phase==='estimate'?`Checking the size at ${progress.sz} px per cell…`
        :progress.phase==='retry'?'Re-encoding to stay under 50 MB…'
        :'Finishing the file…';
    const detail=video&&(progress.phase==='encode'||progress.phase==='retry')&&progress.total?`Frame ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
        :video&&progress.phase==='prepare'&&progress.total?`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} moves`:'';
    return{video,fraction,label,detail,elapsed:(Date.now()-task.startedAt)/1000,eta};
}
const formatClock=sec=>{const t=Math.max(0,Math.round(sec)),h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=String(t%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`};
const ProgressBar=({fraction,height})=><div style={{height,background:'#2a2a4a',borderRadius:height/2,overflow:'hidden'}}>
    <div style={{height:'100%',width:fraction===null?'100%':`${Math.round(fraction*100)}%`,background:'#6366f1',opacity:fraction===null?0.35:1,transition:'width .2s'}}/>
</div>;

// The running export as a toast, so the game stays usable meanwhile. Once task.result is set, it shows that instead.
window.ExportProgressToast=function ExportProgressToast({task}){
    const s=useExportProgress(task);
    if(task.result)return(<div className="toast" style={{width:300,borderLeftColor:task.result.ok?'#22c55e':'#f87171'}}>
        <div className="toast-title">{task.result.ok?'✅':'⚠️'} {task.result.title}</div>
        {task.result.text&&<div className="toast-sub">{task.result.text}</div>}
    </div>);
    return(<div className="toast" style={{width:300}}>
        <div className="toast-title">{s.video?'🎬':'🖼'} {task.title}</div>
        <div className="toast-sub">{s.label}</div>
        <div style={{margin:'8px 0 6px'}}><ProgressBar fraction={s.fraction} height={6}/></div>
        <div className="toast-sub" style={{display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:'0 10px',marginTop:0}}>
            <span>{s.detail}{s.detail&&s.fraction!==null?' · ':''}{s.fraction!==null?`${Math.floor(s.fraction*100)}%`:''}</span>
            <span>{formatClock(s.elapsed)}{s.eta!==null?` · ${formatClock(s.eta)} left`:''}</span>
        </div>
        <div className="toast-actions" style={{justifyContent:'flex-end'}}><button onClick={task.cancel}>Cancel</button></div>
    </div>);
};

// A long timelapse's speed picker (task.plan), with the video length for each choice. Without a plan it shows
// the progress, for an older app.js that has no toast.
window.ExportProgressModal=function ExportProgressModal({task}){
    const[speed,setSpeed]=useState(task.plan?task.plan.movesPerFrame:1);
    const panel={minWidth:340,maxWidth:460,padding:'16px 20px',gap:10};
    const plan=task.plan;
    if(plan){
        const speeds=Array.isArray(plan.speeds)?plan.speeds:[1,2,4,8,16];
        const frameCount=n=>Math.ceil(plan.moves/n)+plan.fps,videoLength=n=>formatClock(frameCount(n)/plan.fps);
        // The WebAssembly encoder (plain http://) is slow enough that the export time matters too.
        const exportTime=n=>{const sec=frameCount(n)*plan.msPerFrame/1000;return sec<90?`${Math.max(1,Math.round(sec))} s`:`${Math.round(sec/60)} min`};
        return(<div className="modal-overlay"><div className="modal-panel" style={panel}>
            <h2 style={{fontSize:16,margin:0}}>🎬 Long timelapse</h2>
            <div style={{color:'#9ca3af',fontSize:12,textAlign:'center'}}>{plan.moves.toLocaleString()} moves · {plan.width}×{plan.height} · {plan.fps} fps</div>
            <div style={{color:'#ccc',fontSize:12}}>More moves per frame gives a shorter video that also exports faster.</div>
            {plan.slow&&<div style={{color:'#fbbf24',fontSize:12}}>Browsers switch their video encoder off on plain http:// pages, so a slower built-in one is used here.</div>}
            <div style={{display:'flex',flexDirection:'column',gap:2}}>
                {speeds.map(n=><label key={n} style={{display:'flex',alignItems:'center',gap:8,padding:'3px 6px',borderRadius:5,cursor:'pointer',background:speed===n?'#2a2a55':'transparent',color:'#ddd',fontSize:13}}>
                    <input type="radio" name="tl-speed" checked={speed===n} onChange={()=>setSpeed(n)}/>
                    {n===1?'1 move':`${n} moves`} per frame<span style={{marginLeft:'auto',color:'#9ca3af'}}>{videoLength(n)}{plan.slow?` · about ${exportTime(n)} to export`:''}</span>
                </label>)}
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={task.cancel}>Cancel</button>
                <button className="primary" onClick={()=>task.start(speed)}>Start export</button>
            </div>
        </div></div>);
    }
    return <ExportProgressPanel task={task} panel={panel}/>;
};
function ExportProgressPanel({task,panel}){
    const s=useExportProgress(task);
    return(<div className="modal-overlay"><div className="modal-panel" style={panel}>
        <h2 style={{fontSize:16,margin:0}}>{s.video?'🎬':'🖼'} {task.title}</h2>
        <div style={{color:'#ccc',fontSize:13}}>{s.label}</div>
        <ProgressBar fraction={s.fraction} height={8}/>
        <div style={{display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:'2px 16px',color:'#9ca3af',fontSize:12}}>
            <span>{s.detail}{s.detail&&s.fraction!==null?' · ':''}{s.fraction!==null?`${Math.floor(s.fraction*100)}%`:''}</span>
            <span>{formatClock(s.elapsed)} elapsed{s.eta!==null?` · about ${formatClock(s.eta)} left`:''}</span>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end'}}><button onClick={task.cancel}>Cancel</button></div>
    </div></div>);
}

window.GameOverModal=function GameOverModal({undoAvailable,undoInfinite,undoStack,undoStackCount,onUndo,onRestart,onNewSeed,onExportImage,onExportVideo,onClose,videoExporting,leaderboard,lastEntryDate,killerName,killerIsSelf}){
    const[closeLockSecs,setCloseLockSecs]=useState(5);
    useEffect(()=>{
        if(closeLockSecs<=0)return;
        const t=setInterval(()=>setCloseLockSecs(s=>Math.max(0,s-1)),1000);
        return()=>clearInterval(t);
    },[closeLockSecs>0]);
    const locked=closeLockSecs>0;
    const closeIfUnlocked=()=>{if(!locked)onClose()};
    const undo=()=>{setCloseLockSecs(0);onUndo()};
    useEscapeKey(closeIfUnlocked);
    return(<div className="modal-overlay" onClick={closeIfUnlocked}>
        <div className="modal-panel" onClick={e=>e.stopPropagation()}>
            <h2>💥 Game Over</h2>
            <div className="sub">{killerName&&!killerIsSelf?`${killerName} hit a mine.`:'You hit a mine.'}</div>
            {undoAvailable&&<button className="primary" onClick={undo}>↩ Undo{undoInfinite?' (∞)':undoStack?` (${undoStackCount} banked)`:' (1 left)'}</button>}
            <button onClick={onRestart}>🔄 Restart (same seed)</button>
            <button onClick={onNewSeed}>🎲 New Seed</button>
            <button onClick={onExportImage}>🖼 Export Image</button>
            <button onClick={onExportVideo} disabled={videoExporting}>{videoExporting?'Exporting timelapse…':'🎬 Export Timelapse'}</button>
            <div className="close-row"><button className="close-btn" onClick={closeIfUnlocked} disabled={locked}>{locked?`Wait ${closeLockSecs}s…`:'Close (inspect board)'}</button></div>
        </div>
        <div className="leaderboard-panel" onClick={e=>e.stopPropagation()}>
            <h3>🏆 Leaderboard</h3>
            <LeaderboardList entries={leaderboard} highlight={lastEntryDate}/>
        </div>
    </div>);
};

// A room id from whatever was pasted: a bare code, a full invite link, or "?room=…".
const parseSessionCode=raw=>{
    let s=(raw||'').trim();
    try{const r=new URL(s).searchParams.get('room');if(r)s=r}catch(e){}
    const m=s.match(/room=([^&#\s]+)/i);if(m)s=m[1];
    s=s.toLowerCase();
    return/^[a-f0-9]{16,64}$/.test(s)?s:null;
};

// The start menu, shown on a fresh visit and from the header's Menu button. Its hints are a draft until a game
// starts, so browsing it inside a room never changes the room's hints. currentGame: {moves, seed, shareable} or null.
window.StartModal=function StartModal({initialStep,hints,initialSeed,initialName,currentGame,inRoom,onStartSingle,onCreateSession,onJoinSession,onCopyLink,onCurrent,onClose}){
    const[step,setStep]=useState(initialStep||'choose'); // choose → single, or choose → multi → create → created
    const[draftHints,setDraftHints]=useState(()=>({...hints}));
    const[seed,setSeed]=useState(initialSeed||randomSeed());
    const[name,setName]=useState(initialName||'');
    const[preferCurrent,setPreferCurrent]=useState(!!(currentGame&&currentGame.shareable));
    const[code,setCode]=useState('');
    const[error,setError]=useState('');
    const[busy,setBusy]=useState(false);
    const[roomId,setRoomId]=useState(null);
    const[copied,setCopied]=useState(false);
    useEscapeKey(onClose);
    const goTo=s=>{setError('');setStep(s)};
    const cleanName=name.trim().slice(0,24);
    const startFromCurrent=preferCurrent&&!!currentGame&&currentGame.shareable;
    const createSession=async()=>{
        if(!cleanName||busy)return;
        setBusy(true);setError('');
        try{setRoomId(await onCreateSession(cleanName,startFromCurrent?currentGame.seed:seed.trim(),draftHints,startFromCurrent));setStep('created')}
        catch(e){console.error(e);setError("Couldn't create a session. Is the server running?")}
        finally{setBusy(false)}
    };
    const joinSession=()=>{
        const id=parseSessionCode(code);
        if(id)onJoinSession(id);else setError("That doesn't look like a session code or invite link.");
    };
    const inviteLink=roomId?`${location.origin}${location.pathname}?room=${roomId}`:'';
    const copyInvite=async()=>{if(await onCopyLink(inviteLink)){setCopied(true);setTimeout(()=>setCopied(false),1400)}};
    const seedField=(
        <div className="start-field">
            <label htmlFor="start-seed" className="start-label">Seed</label>
            <div className="start-row">
                <input id="start-seed" className="hi" value={seed} onChange={e=>setSeed(e.target.value)} placeholder="Random"/>
                <button className="start-icon" onClick={()=>setSeed(randomSeed())} title="Random seed" aria-label="Random seed">🎲</button>
            </div>
        </div>
    );
    const hintsField=<div className="start-field"><span className="start-label">Hints</span><div><HintOptions hints={draftHints} setHints={setDraftHints}/></div></div>;
    const backButton=to=><div className="close-row"><button className="close-btn" onClick={()=>goTo(to)}>← Back</button></div>;
    const boardWord=inRoom?'board':'game';
    return(
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-panel start-panel" onClick={e=>e.stopPropagation()}>
                {onClose&&<button className="start-x" onClick={onClose} title="Close" aria-label="Close">×</button>}
                <h2>💣 InfiniSweeper</h2>
                {step==='choose'&&<>
                    <button className="primary start-choice" onClick={()=>goTo('single')}>👤 Singleplayer</button>
                    <button className="start-choice" onClick={()=>goTo('multi')}>👥 Multiplayer</button>
                    {currentGame&&<div className="start-field">
                        <span className="start-label">{inRoom?'This session':'Current game'}</span>
                        <div className="start-row">
                            <button className="start-grow" onClick={()=>onCurrent('restart')}>🔄 Restart {boardWord}</button>
                            <button className="start-grow" onClick={()=>onCurrent('new')}>🎲 New seed</button>
                        </div>
                    </div>}
                </>}
                {step==='single'&&<>
                    {inRoom&&<div className="sub">Leaves this session.</div>}
                    {hintsField}
                    {seedField}
                    <button className="primary" onClick={()=>onStartSingle(seed,draftHints)}>▶ Start game</button>
                    {backButton('choose')}
                </>}
                {step==='multi'&&<>
                    <button className="primary start-choice" onClick={()=>goTo('create')}>➕ Create a session</button>
                    <div className="start-field">
                        <label htmlFor="start-code" className="start-label">Enter session code</label>
                        <div className="start-row">
                            <input id="start-code" className="hi" value={code} onChange={e=>{setCode(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter')joinSession()}} placeholder="Code or invite link"/>
                            <button onClick={joinSession} disabled={!code.trim()}>Join</button>
                        </div>
                    </div>
                    {error&&<div className="start-error">{error}</div>}
                    {backButton('choose')}
                </>}
                {step==='create'&&<>
                    <div className="start-field">
                        <label htmlFor="start-name" className="start-label">Your name</label>
                        <input id="start-name" className="hi" autoFocus maxLength={24} value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')createSession()}} placeholder="So others can see who's who"/>
                    </div>
                    {currentGame&&<div className="start-field">
                        <span className="start-label">Start from</span>
                        <div>
                            <Radio label={`The current ${boardWord} (${currentGame.moves} move${currentGame.moves===1?'':'s'}, seed ${currentGame.seed})`} name="startFrom" checked={startFromCurrent} onChange={()=>setPreferCurrent(true)} disabled={!currentGame.shareable}/>
                            {!currentGame.shareable&&<div className="start-note">Unavailable: sessions only take seeds of letters, numbers, - and _ (up to 32).</div>}
                            <Radio label="A new board" name="startFrom" checked={!startFromCurrent} onChange={()=>setPreferCurrent(false)}/>
                        </div>
                    </div>}
                    {hintsField}
                    {!startFromCurrent&&seedField}
                    <button className="primary" onClick={createSession} disabled={!cleanName||busy}>{busy?'Creating…':'Create session'}</button>
                    {error&&<div className="start-error">{error}</div>}
                    {backButton('multi')}
                </>}
                {step==='created'&&<>
                    <div className="sub">Session ready. Send the link to whoever you're playing with.</div>
                    <input className="hi" readOnly value={inviteLink} onFocus={e=>e.target.select()} aria-label="Invite link"/>
                    <button onClick={copyInvite}>{copied?'✓ Copied':'🔗 Copy link'}</button>
                    <button className="primary" onClick={()=>onJoinSession(roomId)}>▶ Start playing</button>
                </>}
            </div>
        </div>
    );
};

// --- Multiplayer ---

// Asks for a name on entering a room (or after a refresh, if the name wasn't saved).
window.NamePromptModal=function NamePromptModal({initial,onSubmit,onCancel}){
    const[name,setName]=useState(initial||'');
    useEscapeKey(onCancel);
    const submit=()=>{const n=(name||'').trim().slice(0,24);if(n)onSubmit(n)};
    return(
        <div className="modal-overlay">
            <div className="modal-panel" style={{minWidth:280,maxWidth:400}}>
                <h2>Join room</h2>
                <div className="sub">Pick a name so your teammate can see who's who.</div>
                <input className="hi" autoFocus value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')submit()}} placeholder="Your name" style={{width:'100%',padding:'6px 8px',fontSize:14}}/>
                <button className="primary" onClick={submit} disabled={!(name||'').trim()}>Join</button>
                {onCancel&&<div className="close-row"><button className="close-btn" onClick={onCancel}>Cancel</button></div>}
            </div>
        </div>
    );
};

// Other players' cursors, positioned with the same world-to-screen maths as the grid.
window.CursorOverlay=function CursorOverlay({players,selfId,viewX,viewY,cellSize,containerRect}){
    if(!containerRect||!players)return null;
    const cols=Math.floor(containerRect.width/cellSize),rows=Math.floor(containerRect.height/cellSize);
    const padX=(containerRect.width-cols*cellSize)/2,padY=(containerRect.height-rows*cellSize)/2;
    const leftX=viewX-Math.floor(cols/2),topY=viewY-Math.floor(rows/2);
    const cursors=[];
    for(const pid in players){
        if(pid===selfId)continue;
        const p=players[pid];if(!p||!p.cursor)continue;
        const cx=padX+(p.cursor.x-leftX)*cellSize;
        const cy=padY+(p.cursor.y-topY)*cellSize;
        if(cx<-40||cy<-40||cx>containerRect.width+40||cy>containerRect.height+40)continue; // off screen
        cursors.push({pid,p,cx,cy});
    }
    return(
        <div style={{position:'absolute',left:0,top:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:50,overflow:'hidden'}}>
            {cursors.map(({pid,p,cx,cy})=>(
                <div key={pid} style={{position:'absolute',left:cx,top:cy,transform:'translate(-2px,-2px)',transition:'left .12s linear,top .12s linear'}}>
                    <svg width="18" height="20" viewBox="0 0 18 20" style={{filter:'drop-shadow(0 1px 2px rgba(0,0,0,.6))'}}>
                        <path d="M2 2 L2 16 L6 12 L9 18 L11 17 L8 12 L14 12 Z" fill={p.color||'#fff'} stroke="#000" strokeWidth="1"/>
                    </svg>
                    <div style={{position:'absolute',left:16,top:14,background:p.color||'#5b9bd5',color:'#fff',fontSize:11,fontWeight:600,padding:'2px 6px',borderRadius:4,whiteSpace:'nowrap',boxShadow:'0 1px 3px rgba(0,0,0,.4)'}}>{p.name||'Player'}</div>
                </div>
            ))}
        </div>
    );
};

// Top-right notices: the start-over vote, and short-lived ones like "Alex used an undo" so changes others make
// don't come out of nowhere. Sits above modals, since the game-over modal may be open when a vote starts.
window.ToastStack=function ToastStack({toasts,vote,selfId,onVote,children}){
    if(!vote&&!toasts.length&&!children)return null;
    return(
        <div className="toast-stack">
            {children}
            {vote&&<ResetVoteToast key={vote.id} vote={vote} selfId={selfId} onVote={onVote}/>}
            {toasts.map(t=><div key={t.id} className="toast">{t.text}</div>)}
        </div>
    );
};

// The start-over vote, with tallies and countdown from the server. Players who haven't answered get Yes/No.
window.ResetVoteToast=function ResetVoteToast({vote,selfId,onVote}){
    const[answeredLocally,setAnsweredLocally]=useState(false); // hides the buttons before the server echoes our vote
    const request=vote.kind==='new'?'start a new game with a new seed'
        :vote.kind==='load'?`load a save file (${vote.loadMoves} moves)`:'restart this board';
    const open=vote.status==='open';
    const answered=(vote.myVote!==null&&vote.myVote!==undefined)||answeredLocally;
    const answer=yes=>{setAnsweredLocally(true);onVote(vote.id,yes)};
    const outcome={passed:'✓ Vote passed — starting over',failed:'✗ Not enough players agreed',expired:'✗ Vote timed out'}[vote.status];
    return(
        <div className="toast">
            <div className="toast-title">{vote.by===selfId?`You asked to ${request}`:`${vote.byName} wants to ${request}`}</div>
            <div className="toast-sub">{open?`${vote.yes} of ${vote.total} agree · ${vote.needed} needed · ${vote.secondsLeft}s left`:outcome}</div>
            {open&&!answered&&<div className="toast-actions">
                <button className="hb pr" onClick={()=>answer(true)}>Yes, start over</button>
                <button className="hb" onClick={()=>answer(false)}>No, keep playing</button>
            </div>}
            {open&&answered&&<div className="toast-sub">Waiting for the others…</div>}
        </div>
    );
};

// Everyone in the room. Clicking a name centres your view on theirs.
window.PlayerListDropdown=function PlayerListDropdown({players,selfId,founderId,onGoTo}){
    const[open,setOpen,ref]=useDropdown();
    const list=Object.entries(players||{});
    return(
        <div ref={ref} style={{position:'relative'}}>
            <button className="hb" onClick={()=>setOpen(o=>!o)} title="Players in this room">👤 {list.length}</button>
            {open&&<div className="hints-panel" style={{minWidth:200,right:'auto',left:0}}>
                <div style={{color:'#fff',fontSize:12,fontWeight:600,marginBottom:6}}>In this room</div>
                {list.length===0&&<div className="lb-empty">Nobody here yet</div>}
                {list.map(([pid,p])=>{
                    const isMe=pid===selfId;
                    const canGo=!isMe&&p.view;
                    return(
                        <div key={pid}
                             onClick={canGo?()=>{onGoTo(p.view.x,p.view.y);setOpen(false)}:undefined}
                             title={canGo?`Center on ${p.name}'s view`:undefined}
                             style={{display:'flex',alignItems:'center',gap:8,padding:'4px 4px',borderRadius:4,cursor:canGo?'pointer':'default',transition:'background .1s'}}
                             onMouseEnter={e=>{if(canGo)e.currentTarget.style.background='rgba(99,102,241,0.15)'}}
                             onMouseLeave={e=>{e.currentTarget.style.background='transparent'}}>
                            <span style={{width:10,height:10,borderRadius:'50%',background:p.color||'#5b9bd5',flexShrink:0}}/>
                            <span style={{color:isMe?'#a78bfa':'#eee',fontSize:12,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name||'Player'}{isMe&&' (you)'}{pid===founderId&&<span title="Room founder — can start over without a vote"> 👑</span>}</span>
                            {p.view&&<span style={{color:'#888',fontSize:10}}>{p.view.x},{p.view.y}</span>}
                        </div>
                    );
                })}
            </div>}
        </div>
    );
};

// Header badge with the connection status, a reconnect countdown, and invite and leave buttons.
// status: 'connected' | 'disconnected' | 'connecting' (or {state}); backoff: {retryInMs, errStreak} while retrying.
window.MultiplayerBadge=function MultiplayerBadge({status,backoff,onCopyInvite,onLeave}){
    const[copied,setCopied]=useState(false);
    const state=typeof status==='string'?status:(status&&status.state)||'connecting';
    const dotColor=state==='connected'?'#10b981':state==='disconnected'?'#ef4444':'#f59e0b';
    const copyInvite=async()=>{if(await onCopyInvite()){setCopied(true);setTimeout(()=>setCopied(false),1400)}};
    const[retrySecondsLeft,setRetrySecondsLeft]=useState(0);
    useEffect(()=>{
        if(!backoff||state==='connected'){setRetrySecondsLeft(0);return}
        const retryAt=Date.now()+backoff.retryInMs;
        const update=()=>{setRetrySecondsLeft(Math.max(0,Math.ceil((retryAt-Date.now())/1000)))};
        update();const id=setInterval(update,250);return()=>clearInterval(id);
    },[backoff,state]);
    const showRetry=state!=='connected'&&backoff&&backoff.errStreak>0;
    return(
        <div className="flex items-center gap-1" style={{background:'#1a1a32',border:'1px solid #3a3a5c',borderRadius:5,padding:'2px 6px'}}>
            <span title={`Status: ${state}`} style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:dotColor,flexShrink:0}}/>
            {showRetry&&<span className="text-gray-400" style={{fontSize:10,fontStyle:'italic'}}>reconnecting{retrySecondsLeft?` (${retrySecondsLeft}s)`:'…'}</span>}
            <button className="hb" style={{padding:'1px 6px',fontSize:11}} onClick={copyInvite} title="Copy invite link">{copied?'✓ Copied':'🔗 Invite'}</button>
            <button className="hb" style={{padding:'1px 6px',fontSize:11}} onClick={onLeave} title="Leave room">↩</button>
        </div>
    );
};
