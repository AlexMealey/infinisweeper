// components.js – React UI components (JSX, processed by Babel)
const{useState,useCallback,useMemo,useEffect,useRef,memo}=React;

window.Cell=memo(({x,y,state,go,hl,cr,pulse,sz,onR,onF,onH,onL})=>{
    const st=useMemo(()=>({width:sz,height:sz,fontSize:Math.max(9,sz*.37)}),[sz]);
    let cn='cell ',ct='';
    if(state==='exp'){cn+='cell-exp';ct='💥'}
    else if(state==='mine'){cn+='cell-mine';ct='💣'}
    else if(state==='flag-ok'){cn+='cell-flag-ok';ct='🚩'}
    else if(state==='flag-bad'){cn+='cell-flag-bad';ct=<><span style={{opacity:.7}}>🚩</span><span className="wrong-x" style={{fontSize:sz*.5}}>✕</span></>}
    else if(state==='flag'){cn+='cell-flag';ct='🚩'}
    else if(state==='quest'){cn+='cell-hidden';ct='❓'}
    else if(state&&state[0]==='r'){cn+='cell-rev';if(cr)cn+=' cell-cr';const c=+state[1];if(c)ct=<span className={`n${c}`}>{c}</span>}
    else{cn+='cell-hidden';if(hl)cn+=' cell-hl';else if(pulse)cn+=' cell-pulse'}
    return<div className={cn} style={st} onClick={e=>{e.preventDefault();if(!go)onR(x,y)}} onContextMenu={e=>{e.preventDefault();if(!go)onF(x,y)}} onMouseEnter={()=>onH(x,y)} onMouseLeave={onL}>{ct}</div>;
});

// Checkbox, radio and indented sub-group rows shared by the settings and start menus.
const Chk=({label,checked,onChange,dim})=>(
    <label style={{display:'flex',alignItems:'center',gap:6,color:dim?'#aaa':'#ccc',fontSize:18,padding:'2px 0',cursor:'pointer',userSelect:'none'}}>
        <input type="checkbox" style={{accentColor:'#6366f1',width:12,height:12,flexShrink:0}} checked={checked} onChange={onChange}/>
        {label}
    </label>
);
const Rad=({label,name,checked,onChange,disabled})=>(
    <label style={{display:'flex',alignItems:'center',gap:6,color:'#999',fontSize:12,padding:'1px 0',cursor:disabled?'default':'pointer',userSelect:'none',opacity:disabled?.5:1}}>
        <input type="radio" name={name} style={{accentColor:'#6366f1',width:11,height:11,flexShrink:0}} checked={checked} onChange={onChange} disabled={disabled}/>
        {label}
    </label>
);
const Sub=({children})=>(
    <div style={{marginLeft:18,paddingLeft:8,borderLeft:'2px solid #2a2a4a',marginTop:1,marginBottom:2}}>{children}</div>
);

// Gameplay hints. A new room takes these as its shared hints, so the start menu offers them too.
// A fragment, so the settings panel renders exactly as it did before this was shared.
window.HintOptions=function HintOptions({hints,setHints}){
    return(<>
        <Chk label="Show wrong flags on death" checked={hints.wrongFlags} onChange={e=>setHints(h=>({...h,wrongFlags:e.target.checked}))}/>
        <Chk label="Highlight remaining cells on hover" checked={hints.pulseNeighbors} onChange={e=>setHints(h=>({...h,pulseNeighbors:e.target.checked}))}/>
        <Chk label="Right-click number to auto-flag mines" checked={hints.chordFlag} onChange={e=>setHints(h=>({...h,chordFlag:e.target.checked}))}/>
        <Chk label="Enable undo" checked={hints.undoEnabled} onChange={e=>setHints(h=>({...h,undoEnabled:e.target.checked}))}/>
        {hints.undoEnabled&&<Sub>
            <Rad label="Infinite undo" name="undoMode" checked={hints.undoMode==='infinite'} onChange={()=>setHints(h=>({...h,undoMode:'infinite'}))}/>
            <Rad label="1 free / 1000 cleared" name="undoMode" checked={hints.undoMode==='refill'||(hints.undoMode!=='infinite'&&hints.undoMode!=='stack')} onChange={()=>setHints(h=>({...h,undoMode:'refill'}))}/>
            <Rad label="Stacking +1 / 1000 cleared" name="undoMode" checked={hints.undoMode==='stack'} onChange={()=>setHints(h=>({...h,undoMode:'stack'}))}/>
        </Sub>}
    </>);
};

window.SettingsModal=function SettingsModal({hints,setHints,uiSettings,setUiSettings,viewMode,changeView,cellSize,setCellSize,onClose}){
    useEffect(()=>{
        const h=e=>{if(e.key==='Escape')onClose()};
        document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h);
    },[onClose]);
    const Sec=({children})=>(
        <div style={{marginTop:10,marginBottom:4}}>
            <div style={{color:'#8b8ba8',fontSize:12,fontWeight:700,letterSpacing:'0.09em',textTransform:'uppercase',marginBottom:4}}>{children}</div>
            <div style={{height:1,background:'#2a2a4a'}}/>
        </div>
    );
    const Sm=({onClick,ch})=>(
        <button className="hb" style={{padding:'0 5px',fontSize:12,lineHeight:'18px',minWidth:20}} onClick={onClick}>{ch}</button>
    );
    const StepRow=({label,value,onDec,onInc,reset})=>(
        <div style={{display:'flex',alignItems:'center',gap:5,padding:'2px 0'}}>
            <span style={{color:'#aaa',fontSize:12,minWidth:82}}>{label}</span>
            <Sm onClick={onDec} ch="−"/>
            <span style={{color:'#9ca3af',fontSize:11,width:30,textAlign:'center'}}>{value}</span>
            <Sm onClick={onInc} ch="+"/>
            {reset&&<Sm onClick={reset} ch="↺"/>}
        </div>
    );
    const zoomPct=Math.round(cellSize/ZDEF*100);
    const defPct=Math.round(uiSettings.defaultCellSize/ZDEF*100);
    return(
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-panel" style={{minWidth:360,maxWidth:580,padding:'12px 16px',overflowY:'auto',maxHeight:'85vh',gap:0}} onClick={e=>e.stopPropagation()}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                    <h2 style={{margin:0,fontSize:16}}>⚙ Settings</h2>
                    <button style={{background:'transparent',border:0,color:'#666',fontSize:22,lineHeight:2,cursor:'pointer',padding:'0 3px'}} onClick={onClose}>×</button>
                </div>

                <Sec>Display</Sec>
                <Chk label="Pan arrows" checked={uiSettings.showArrows} onChange={e=>setUiSettings(u=>({...u,showArrows:e.target.checked}))}/>
                <Chk label="Scores (flags / moves / cleared)" checked={uiSettings.showScores} onChange={e=>setUiSettings(u=>({...u,showScores:e.target.checked}))}/>
                <Chk label="Leaderboard" checked={uiSettings.showLeaderboard} onChange={e=>setUiSettings(u=>({...u,showLeaderboard:e.target.checked}))}/>
                <Chk label="Undo counter" checked={uiSettings.showUndo} onChange={e=>setUiSettings(u=>({...u,showUndo:e.target.checked}))}/>
                <Chk label="Zoom controls" checked={uiSettings.showZoom} onChange={e=>setUiSettings(u=>({...u,showZoom:e.target.checked}))}/>
                <Chk label="Coordinates" checked={uiSettings.showCoords} onChange={e=>setUiSettings(u=>({...u,showCoords:e.target.checked}))}/>
                <Chk label="Seed" checked={uiSettings.showSeed} onChange={e=>setUiSettings(u=>({...u,showSeed:e.target.checked}))}/>
                {uiSettings.showSeed&&<Sub>
                    <Chk label="Seed input" dim checked={uiSettings.showSeedBox} onChange={e=>setUiSettings(u=>({...u,showSeedBox:e.target.checked}))}/>
                    <Chk label="Lock button" dim checked={uiSettings.showLockBtn} onChange={e=>setUiSettings(u=>({...u,showLockBtn:e.target.checked}))}/>
                </Sub>}

                <Sec>Hints</Sec>
                <HintOptions hints={hints} setHints={setHints}/>

                <Sec>Defaults</Sec>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Screen size</span>
                    <select className="hs" value={viewMode} onChange={e=>changeView(e.target.value)}>
                        <option>Small</option><option>Medium</option><option>Large</option><option>Fullscreen</option>
                    </select>
                </div>
                <StepRow label="Zoom" value={`${zoomPct}%`} onDec={()=>setCellSize(s=>Math.max(ZMIN,s-ZSTEP))} onInc={()=>setCellSize(s=>Math.min(ZMAX,s+ZSTEP))} reset={()=>setCellSize(uiSettings.defaultCellSize)}/>
                <StepRow label="Default zoom" value={`${defPct}%`} onDec={()=>setUiSettings(u=>({...u,defaultCellSize:Math.max(ZMIN,u.defaultCellSize-ZSTEP)}))} onInc={()=>setUiSettings(u=>({...u,defaultCellSize:Math.min(ZMAX,u.defaultCellSize+ZSTEP)}))}/>

                <Sec>Export</Sec>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Image size</span>
                    <select className="hs" value={uiSettings.exportRes||'auto'} onChange={e=>setUiSettings(u=>({...u,exportRes:e.target.value}))}>
                        <option value="auto">Auto (under 8 MB)</option><option value="32">Full (32 px/cell)</option><option value="16">Half (16 px/cell)</option><option value="8">Quarter (8 px/cell)</option>
                    </select>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Timelapse speed</span>
                    <select className="hs" value={String(uiSettings.tlMovesPerFrame||1)} onChange={e=>setUiSettings(u=>({...u,tlMovesPerFrame:+e.target.value}))}>
                        {[1,2,4,8,16].map(n=><option key={n} value={n}>{n===1?'1 move':`${n} moves`} per frame</option>)}
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
    const[open,setOpen]=useState(false);
    const ref=useRef(null);
    useEffect(()=>{if(!open)return;const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};
        document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h)},[open]);
    useEffect(()=>{if(!open)return;const h=e=>{if(e.key==='Escape')setOpen(false)};
        document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[open]);
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
        {entries.map((e,i)=>{
            const d=new Date(e.date);
            const dateStr=isNaN(d.getTime())?'':d.toLocaleString();
            const tip=[dateStr,e.seed?`seed: ${e.seed}`:''].filter(Boolean).join(' · ');
            return(
                <div key={e.runId||e.date} className={`lb-row${i%2?' lb-alt':''}${e.date===highlight?' lb-mine':''}`} title={tip}>
                    <span className="lb-rank">#{i+1}</span>
                    <span>{e.cleared}</span>
                    <span>{e.moves}</span>
                    <span>{e.flags}</span>
                </div>
            );
        })}
    </div>);
};

window.LeaderboardDropdown=function LeaderboardDropdown({entries,currentScore}){
    const[open,setOpen]=useState(false);
    const ref=useRef(null);
    useEffect(()=>{if(!open)return;const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};
        document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h)},[open]);
    useEffect(()=>{if(!open)return;const h=e=>{if(e.key==='Escape')setOpen(false)};
        document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[open]);
    return(<div ref={ref} style={{position:'relative'}}>
        <button className="hb" onClick={()=>setOpen(o=>!o)} title="Leaderboard (top 8 by squares cleared)">📋 {currentScore}</button>
        {open&&<div className="hints-panel" style={{minWidth:200}}>
            <div style={{color:'#fff',fontSize:13,fontWeight:600,textAlign:'center',marginBottom:6}}>🏆 Leaderboard</div>
            <LeaderboardList entries={entries}/>
        </div>}
    </div>);
};

// Progress for image and timelapse exports. Updates arrive through task.progress (a tiny store) instead of
// props, so an export ticking away doesn't re-render the whole board. A long timelapse first shows task.plan:
// a speed picker with the video length for each choice.
window.ExportProgressModal=function ExportProgressModal({task}){
    const[p,setP]=useState(task.progress.get());
    const[speed,setSpeed]=useState(task.plan?task.plan.movesPerFrame:1);
    const[,setTick]=useState(0);
    const phaseStart=useRef(null);
    useEffect(()=>task.progress.sub(setP),[task.progress]);
    useEffect(()=>{const t=setInterval(()=>setTick(n=>n+1),500);return()=>clearInterval(t)},[]);
    const fmt=sec=>{const t=Math.max(0,Math.round(sec)),h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=String(t%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`};
    const panel={minWidth:340,maxWidth:460,padding:'16px 20px',gap:10};
    const plan=task.plan;
    if(plan){
        const len=n=>fmt((Math.ceil(plan.moves/n)+plan.fps)/plan.fps);
        return(<div className="modal-overlay"><div className="modal-panel" style={panel}>
            <h2 style={{fontSize:16,margin:0}}>🎬 Long timelapse</h2>
            <div style={{color:'#9ca3af',fontSize:12,textAlign:'center'}}>{plan.moves.toLocaleString()} moves · {plan.width}×{plan.height} · {plan.fps} fps</div>
            <div style={{color:'#ccc',fontSize:12}}>More moves per frame gives a shorter video that also exports faster.</div>
            <div style={{display:'flex',flexDirection:'column',gap:2}}>
                {[1,2,4,8,16].map(n=><label key={n} style={{display:'flex',alignItems:'center',gap:8,padding:'3px 6px',borderRadius:5,cursor:'pointer',background:speed===n?'#2a2a55':'transparent',color:'#ddd',fontSize:13}}>
                    <input type="radio" name="tl-speed" checked={speed===n} onChange={()=>setSpeed(n)}/>
                    {n===1?'1 move':`${n} moves`} per frame<span style={{marginLeft:'auto',color:'#9ca3af'}}>{len(n)}</span>
                </label>)}
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
                <button onClick={task.cancel}>Cancel</button>
                <button className="primary" onClick={()=>task.start(speed)}>Start export</button>
            </div>
        </div></div>);
    }
    const video=task.kind==='video';
    const frac=p.phase==='estimate'?null:video?(p.total?Math.min(1,p.done/p.total):0):(p.done||0);
    if(!phaseStart.current||phaseStart.current.phase!==p.phase)phaseStart.current={phase:p.phase,t:Date.now(),frac:frac||0};
    const ps=phaseStart.current,inPhase=(Date.now()-ps.t)/1000;
    const eta=frac!==null&&frac>ps.frac&&inPhase>2?inPhase/(frac-ps.frac)*(1-frac):null;
    const label=!p.phase?'Starting…'
        :p.phase==='prepare'?'Replaying moves…'
        :p.phase==='encode'?(video?'Encoding video…':`Compressing at ${p.sz} px per cell…`)
        :p.phase==='estimate'?`Checking the size at ${p.sz} px per cell…`
        :p.phase==='retry'?'Re-encoding to stay under 50 MB…'
        :'Finishing the file…';
    const detail=video&&(p.phase==='encode'||p.phase==='retry')&&p.total?`Frame ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`:video&&p.phase==='prepare'&&p.total?`${p.done.toLocaleString()} of ${p.total.toLocaleString()} moves`:'';
    return(<div className="modal-overlay"><div className="modal-panel" style={panel}>
        <h2 style={{fontSize:16,margin:0}}>{video?'🎬':'🖼'} {task.title}</h2>
        <div style={{color:'#ccc',fontSize:13}}>{label}</div>
        <div style={{height:8,background:'#2a2a4a',borderRadius:4,overflow:'hidden'}}>
            <div style={{height:'100%',width:frac===null?'100%':`${Math.round(frac*100)}%`,background:'#6366f1',opacity:frac===null?0.35:1,transition:'width .2s'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',flexWrap:'wrap',gap:'2px 16px',color:'#9ca3af',fontSize:12}}>
            <span>{detail}{detail&&frac!==null?' · ':''}{frac!==null?`${Math.floor(frac*100)}%`:''}</span>
            <span>{fmt((Date.now()-task.startedAt)/1000)} elapsed{eta!==null?` · about ${fmt(eta)} left`:''}</span>
        </div>
        <div style={{display:'flex',justifyContent:'flex-end'}}><button onClick={task.cancel}>Cancel</button></div>
    </div></div>);
};

window.GameOverModal=function GameOverModal({undoAvailable,undoInfinite,undoStack,undoStackCount,onUndo,onRestart,onNewSeed,onExportImage,onExportVideo,onClose,videoExporting,leaderboard,lastEntryDate,killerName,killerIsSelf}){
    const[closeLockSecs,setCloseLockSecs]=useState(5);
    useEffect(()=>{
        if(closeLockSecs<=0)return;
        const t=setInterval(()=>setCloseLockSecs(s=>Math.max(0,s-1)),1000);
        return()=>clearInterval(t);
    },[closeLockSecs>0]);
    const locked=closeLockSecs>0;
    const guardedClose=()=>{if(!locked)onClose()};
    const guardedUndo=()=>{setCloseLockSecs(0);onUndo()};
    useEffect(()=>{const h=e=>{if(e.key==='Escape')guardedClose()};document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[locked,onClose]);
    return(<div className="modal-overlay" onClick={guardedClose}>
        <div className="modal-panel" onClick={e=>e.stopPropagation()}>
            <h2>💥 Game Over</h2>
            <div className="sub">{killerName&&!killerIsSelf?`${killerName} hit a mine.`:'You hit a mine.'}</div>
            {undoAvailable&&<button className="primary" onClick={guardedUndo}>↩ Undo{undoInfinite?' (∞)':undoStack?` (${undoStackCount} banked)`:' (1 left)'}</button>}
            <button onClick={onRestart}>🔄 Restart (same seed)</button>
            <button onClick={onNewSeed}>🎲 New Seed</button>
            <button onClick={onExportImage}>🖼 Export Image</button>
            <button onClick={onExportVideo} disabled={videoExporting}>{videoExporting?'Exporting timelapse…':'🎬 Export Timelapse'}</button>
            <div className="close-row"><button className="close-btn" onClick={guardedClose} disabled={locked}>{locked?`Wait ${closeLockSecs}s…`:'Close (inspect board)'}</button></div>
        </div>
        <div className="leaderboard-panel" onClick={e=>e.stopPropagation()}>
            <h3>🏆 Leaderboard</h3>
            <LeaderboardList entries={leaderboard} highlight={lastEntryDate}/>
        </div>
    </div>);
};

// Pulls a room id out of whatever was pasted: a bare code, a full invite link, or "?room=…".
const parseSessionCode=raw=>{
    let s=(raw||'').trim();
    try{const r=new URL(s).searchParams.get('room');if(r)s=r}catch(e){}
    const m=s.match(/room=([^&#\s]+)/i);if(m)s=m[1];
    s=s.toLowerCase();
    return/^[a-f0-9]{16,64}$/.test(s)?s:null;
};

// The start menu: shown on a fresh visit (no saved game to restore), and from the header's Menu
// button. Singleplayer starts a board; Multiplayer creates a session (optionally from the game
// already on screen, then hands out its invite link) or joins one by code or link. Hints are a
// draft until a game starts, so browsing the menu inside a room never changes the room's hints.
// currentGame: {moves, seed, shareable} when a board is underway, else null.
window.StartModal=function StartModal({initialStep,hints,initialSeed,initialName,currentGame,inRoom,onStartSingle,onCreateSession,onJoinSession,onCopyLink,onCurrent,onClose}){
    const[step,setStep]=useState(initialStep||'choose'); // choose → single, or choose → multi → create → created
    const[draftHints,setDraftHints]=useState(()=>({...hints}));
    const[seed,setSeed]=useState(initialSeed||rndSeed());
    const[name,setName]=useState(initialName||'');
    const[fromCurrent,setFromCurrent]=useState(!!(currentGame&&currentGame.shareable));
    const[code,setCode]=useState('');
    const[error,setError]=useState('');
    const[busy,setBusy]=useState(false);
    const[roomId,setRoomId]=useState(null);
    const[copied,setCopied]=useState(false);
    useEffect(()=>{
        if(!onClose)return;
        const h=e=>{if(e.key==='Escape')onClose()};
        document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h);
    },[onClose]);
    const go=s=>{setError('');setStep(s)};
    const cleanName=name.trim().slice(0,24);
    const useCurrent=fromCurrent&&!!currentGame&&currentGame.shareable;
    const create=async()=>{
        if(!cleanName||busy)return;
        setBusy(true);setError('');
        try{setRoomId(await onCreateSession(cleanName,useCurrent?currentGame.seed:seed.trim(),draftHints,useCurrent));setStep('created')}
        catch(e){console.error(e);setError("Couldn't create a session. Is the server running?")}
        finally{setBusy(false)}
    };
    const join=()=>{
        const id=parseSessionCode(code);
        if(id)onJoinSession(id);else setError("That doesn't look like a session code or invite link.");
    };
    const link=roomId?`${location.origin}${location.pathname}?room=${roomId}`:'';
    const copy=async()=>{if(await onCopyLink(link)){setCopied(true);setTimeout(()=>setCopied(false),1400)}};
    const seedRow=(
        <div className="start-field">
            <label htmlFor="start-seed" className="start-label">Seed</label>
            <div className="start-row">
                <input id="start-seed" className="hi" value={seed} onChange={e=>setSeed(e.target.value)} placeholder="Random"/>
                <button className="start-icon" onClick={()=>setSeed(rndSeed())} title="Random seed" aria-label="Random seed">🎲</button>
            </div>
        </div>
    );
    const hintsBlock=<div className="start-field"><span className="start-label">Hints</span><div><HintOptions hints={draftHints} setHints={setDraftHints}/></div></div>;
    const back=to=><div className="close-row"><button className="close-btn" onClick={()=>go(to)}>← Back</button></div>;
    const boardWord=inRoom?'board':'game';
    return(
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-panel start-panel" onClick={e=>e.stopPropagation()}>
                {onClose&&<button className="start-x" onClick={onClose} title="Close" aria-label="Close">×</button>}
                <h2>💣 InfiniSweeper</h2>
                {step==='choose'&&<>
                    <button className="primary start-choice" onClick={()=>go('single')}>👤 Singleplayer</button>
                    <button className="start-choice" onClick={()=>go('multi')}>👥 Multiplayer</button>
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
                    {hintsBlock}
                    {seedRow}
                    <button className="primary" onClick={()=>onStartSingle(seed,draftHints)}>▶ Start game</button>
                    {back('choose')}
                </>}
                {step==='multi'&&<>
                    <button className="primary start-choice" onClick={()=>go('create')}>➕ Create a session</button>
                    <div className="start-field">
                        <label htmlFor="start-code" className="start-label">Enter session code</label>
                        <div className="start-row">
                            <input id="start-code" className="hi" value={code} onChange={e=>{setCode(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter')join()}} placeholder="Code or invite link"/>
                            <button onClick={join} disabled={!code.trim()}>Join</button>
                        </div>
                    </div>
                    {error&&<div className="start-error">{error}</div>}
                    {back('choose')}
                </>}
                {step==='create'&&<>
                    <div className="start-field">
                        <label htmlFor="start-name" className="start-label">Your name</label>
                        <input id="start-name" className="hi" autoFocus maxLength={24} value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')create()}} placeholder="So others can see who's who"/>
                    </div>
                    {currentGame&&<div className="start-field">
                        <span className="start-label">Start from</span>
                        <div>
                            <Rad label={`The current ${boardWord} (${currentGame.moves} move${currentGame.moves===1?'':'s'}, seed ${currentGame.seed})`} name="startFrom" checked={useCurrent} onChange={()=>setFromCurrent(true)} disabled={!currentGame.shareable}/>
                            {!currentGame.shareable&&<div className="start-note">Unavailable: sessions only take seeds of letters, numbers, - and _ (up to 32).</div>}
                            <Rad label="A new board" name="startFrom" checked={!useCurrent} onChange={()=>setFromCurrent(false)}/>
                        </div>
                    </div>}
                    {hintsBlock}
                    {!useCurrent&&seedRow}
                    <button className="primary" onClick={create} disabled={!cleanName||busy}>{busy?'Creating…':'Create session'}</button>
                    {error&&<div className="start-error">{error}</div>}
                    {back('multi')}
                </>}
                {step==='created'&&<>
                    <div className="sub">Session ready. Send the link to whoever you're playing with.</div>
                    <input className="hi" readOnly value={link} onFocus={e=>e.target.select()} aria-label="Invite link"/>
                    <button onClick={copy}>{copied?'✓ Copied':'🔗 Copy link'}</button>
                    <button className="primary" onClick={()=>onJoinSession(roomId)}>▶ Start playing</button>
                </>}
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Multiplayer components — phase 1 MVP
// ---------------------------------------------------------------------------

// Prompts on first entry to a room (or on refresh if the name wasn't saved).
// Trivial modal; no async persistence — the caller writes to localStorage.
window.NamePromptModal=function NamePromptModal({initial,onSubmit,onCancel}){
    const[name,setName]=useState(initial||'');
    useEffect(()=>{const h=e=>{if(e.key==='Escape'&&onCancel)onCancel()};document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[onCancel]);
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

// Draws remote players' cursors as an absolutely-positioned overlay inside the
// game container. Positions are converted from world coords to viewport pixels
// using the same math the grid uses. Only re-renders when cursor data or
// viewport changes — the grid itself has its own memoized render.
window.CursorOverlay=function CursorOverlay({players,selfId,viewX,viewY,cellSize,containerRect}){
    if(!containerRect||!players)return null;
    const cols=Math.floor(containerRect.width/cellSize),rows=Math.floor(containerRect.height/cellSize);
    const padX=(containerRect.width-cols*cellSize)/2,padY=(containerRect.height-rows*cellSize)/2;
    const sX=viewX-Math.floor(cols/2),sY=viewY-Math.floor(rows/2);
    const list=[];
    for(const pid in players){
        if(pid===selfId)continue;
        const p=players[pid];if(!p||!p.cursor)continue;
        const cx=padX+(p.cursor.x-sX)*cellSize;
        const cy=padY+(p.cursor.y-sY)*cellSize;
        // Skip cursors well outside the visible area to avoid drawing them off-screen.
        if(cx<-40||cy<-40||cx>containerRect.width+40||cy>containerRect.height+40)continue;
        list.push({pid,p,cx,cy});
    }
    return(
        <div style={{position:'absolute',left:0,top:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:50,overflow:'hidden'}}>
            {list.map(({pid,p,cx,cy})=>(
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

// Top-right stack of room notifications: the start-over vote (while open or just resolved) and
// short-lived notices like "Alex used an undo", so board changes made by others don't come out of
// nowhere. Sits above modals, since the game-over modal may be open for everyone when a vote starts.
window.ToastStack=function ToastStack({toasts,vote,selfId,onVote}){
    if(!vote&&!toasts.length)return null;
    return(
        <div className="toast-stack">
            {vote&&<ResetVoteToast key={vote.id} vote={vote} selfId={selfId} onVote={onVote}/>}
            {toasts.map(t=><div key={t.id} className="toast">{t.text}</div>)}
        </div>
    );
};

// The start-over vote. Everyone sees it; players who haven't answered get Yes/No.
// Tallies and the countdown come from the server on every sync.
window.ResetVoteToast=function ResetVoteToast({vote,selfId,onVote}){
    // Set once we've answered, so the buttons hide before the server echoes our vote back.
    const[answeredLocally,setAnsweredLocally]=useState(false);
    const what=vote.kind==='new'?'start a new game with a new seed'
        :vote.kind==='load'?`load a save file (${vote.loadMoves} moves)`:'restart this board';
    const open=vote.status==='open';
    const answered=(vote.myVote!==null&&vote.myVote!==undefined)||answeredLocally;
    const answer=yes=>{setAnsweredLocally(true);onVote(vote.id,yes)};
    const result={passed:'✓ Vote passed — starting over',failed:'✗ Not enough players agreed',expired:'✗ Vote timed out'}[vote.status];
    return(
        <div className="toast">
            <div className="toast-title">{vote.by===selfId?`You asked to ${what}`:`${vote.byName} wants to ${what}`}</div>
            <div className="toast-sub">{open?`${vote.yes} of ${vote.total} agree · ${vote.needed} needed · ${vote.secondsLeft}s left`:result}</div>
            {open&&!answered&&<div className="toast-actions">
                <button className="hb pr" onClick={()=>answer(true)}>Yes, start over</button>
                <button className="hb" onClick={()=>answer(false)}>No, keep playing</button>
            </div>}
            {open&&answered&&<div className="toast-sub">Waiting for the others…</div>}
        </div>
    );
};

// Dropdown listing all players in the room. Clicking a name jumps your viewport
// so you're centered on the same coordinates the other player is centered on
// (uses player.view, not player.cursor — the goal is "see what they see").
window.PlayerListDropdown=function PlayerListDropdown({players,selfId,founderId,onGoTo}){
    const[open,setOpen]=useState(false);
    const ref=useRef(null);
    useEffect(()=>{if(!open)return;const h=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false)};document.addEventListener('mousedown',h);return()=>document.removeEventListener('mousedown',h)},[open]);
    useEffect(()=>{if(!open)return;const h=e=>{if(e.key==='Escape')setOpen(false)};document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h)},[open]);
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

// Small header badge: shows connection status and a "copy invite" button.
// Status can be a plain string ('connected'|'disconnected'|'connecting') or an
// object {state, retryInMs, errStreak} pushed by Net during backoff — the object
// form lets us surface reconnect timing without a separate callback.
window.MultiplayerBadge=function MultiplayerBadge({status,backoff,onCopyInvite,onLeave}){
    const[copied,setCopied]=useState(false);
    const state=typeof status==='string'?status:(status&&status.state)||'connecting';
    const dot=state==='connected'?'#10b981':state==='disconnected'?'#ef4444':'#f59e0b';
    const copy=async()=>{if(await onCopyInvite()){setCopied(true);setTimeout(()=>setCopied(false),1400)}};
    // Countdown ticker so the reconnect message doesn't just say "reconnecting…" forever.
    const[secLeft,setSecLeft]=useState(0);
    useEffect(()=>{
        if(!backoff||state==='connected'){setSecLeft(0);return}
        const targetAt=Date.now()+backoff.retryInMs;
        const tick=()=>{setSecLeft(Math.max(0,Math.ceil((targetAt-Date.now())/1000)))};
        tick();const id=setInterval(tick,250);return()=>clearInterval(id);
    },[backoff,state]);
    const showBackoff=state!=='connected'&&backoff&&backoff.errStreak>0;
    return(
        <div className="flex items-center gap-1" style={{background:'#1a1a32',border:'1px solid #3a3a5c',borderRadius:5,padding:'2px 6px'}}>
            <span title={`Status: ${state}`} style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:dot,flexShrink:0}}/>
            {showBackoff&&<span className="text-gray-400" style={{fontSize:10,fontStyle:'italic'}}>reconnecting{secLeft?` (${secLeft}s)`:'…'}</span>}
            <button className="hb" style={{padding:'1px 6px',fontSize:11}} onClick={copy} title="Copy invite link">{copied?'✓ Copied':'🔗 Invite'}</button>
            <button className="hb" style={{padding:'1px 6px',fontSize:11}} onClick={onLeave} title="Leave room">↩</button>
        </div>
    );
};

