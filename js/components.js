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

window.SettingsModal=function SettingsModal({hints,setHints,uiSettings,setUiSettings,viewMode,changeView,cellSize,setCellSize,onClose}){
    useEffect(()=>{
        const h=e=>{if(e.key==='Escape')onClose()};
        document.addEventListener('keydown',h);return()=>document.removeEventListener('keydown',h);
    },[onClose]);
    const Chk=({label,checked,onChange,dim})=>(
        <label style={{display:'flex',alignItems:'center',gap:6,color:dim?'#aaa':'#ccc',fontSize:18,padding:'2px 0',cursor:'pointer',userSelect:'none'}}>
            <input type="checkbox" style={{accentColor:'#6366f1',width:12,height:12,flexShrink:0}} checked={checked} onChange={onChange}/>
            {label}
        </label>
    );
    const Rad=({label,name,checked,onChange})=>(
        <label style={{display:'flex',alignItems:'center',gap:6,color:'#999',fontSize:12,padding:'1px 0',cursor:'pointer',userSelect:'none'}}>
            <input type="radio" name={name} style={{accentColor:'#6366f1',width:11,height:11,flexShrink:0}} checked={checked} onChange={onChange}/>
            {label}
        </label>
    );
    const Sec=({children})=>(
        <div style={{marginTop:10,marginBottom:4}}>
            <div style={{color:'#8b8ba8',fontSize:12,fontWeight:700,letterSpacing:'0.09em',textTransform:'uppercase',marginBottom:4}}>{children}</div>
            <div style={{height:1,background:'#2a2a4a'}}/>
        </div>
    );
    const Sub=({children})=>(
        <div style={{marginLeft:18,paddingLeft:8,borderLeft:'2px solid #2a2a4a',marginTop:1,marginBottom:2}}>{children}</div>
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
                <Chk label="Show wrong flags on death" checked={hints.wrongFlags} onChange={e=>setHints(h=>({...h,wrongFlags:e.target.checked}))}/>
                <Chk label="Highlight remaining cells on hover" checked={hints.pulseNeighbors} onChange={e=>setHints(h=>({...h,pulseNeighbors:e.target.checked}))}/>
                <Chk label="Right-click number to auto-flag mines" checked={hints.chordFlag} onChange={e=>setHints(h=>({...h,chordFlag:e.target.checked}))}/>
                <Chk label="Enable undo" checked={hints.undoEnabled} onChange={e=>setHints(h=>({...h,undoEnabled:e.target.checked}))}/>
                {hints.undoEnabled&&<Sub>
                    <Rad label="Infinite undo" name="undoMode" checked={hints.undoMode==='infinite'} onChange={()=>setHints(h=>({...h,undoMode:'infinite'}))}/>
                    <Rad label="1 free / 1000 cleared" name="undoMode" checked={hints.undoMode==='refill'||(hints.undoMode!=='infinite'&&hints.undoMode!=='stack')} onChange={()=>setHints(h=>({...h,undoMode:'refill'}))}/>
                    <Rad label="Stacking +1 / 1000 cleared" name="undoMode" checked={hints.undoMode==='stack'} onChange={()=>setHints(h=>({...h,undoMode:'stack'}))}/>
                </Sub>}

                <Sec>Defaults</Sec>
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'2px 0'}}>
                    <span style={{color:'#aaa',fontSize:12,minWidth:82}}>Screen size</span>
                    <select className="hs" value={viewMode} onChange={e=>changeView(e.target.value)}>
                        <option>Small</option><option>Medium</option><option>Large</option><option>Fullscreen</option>
                    </select>
                </div>
                <StepRow label="Zoom" value={`${zoomPct}%`} onDec={()=>setCellSize(s=>Math.max(ZMIN,s-ZSTEP))} onInc={()=>setCellSize(s=>Math.min(ZMAX,s+ZSTEP))} reset={()=>setCellSize(uiSettings.defaultCellSize)}/>
                <StepRow label="Default zoom" value={`${defPct}%`} onDec={()=>setUiSettings(u=>({...u,defaultCellSize:Math.max(ZMIN,u.defaultCellSize-ZSTEP)}))} onInc={()=>setUiSettings(u=>({...u,defaultCellSize:Math.min(ZMAX,u.defaultCellSize+ZSTEP)}))}/>

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

window.GameOverModal=function GameOverModal({undoAvailable,undoInfinite,undoStack,undoStackCount,onUndo,onRestart,onNewSeed,onExportImage,onExportVideo,onClose,videoExporting,leaderboard,lastEntryDate,killerName,killerIsSelf,inRoom}){
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
            <button onClick={onRestart} disabled={inRoom}>{inRoom?'🔄 Restart (host only — TBD)':'🔄 Restart (same seed)'}</button>
            <button onClick={onNewSeed} disabled={inRoom}>{inRoom?'🎲 New Seed (leave room first)':'🎲 New Seed'}</button>
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

// Dropdown listing all players in the room. Clicking a name jumps your viewport
// so you're centered on the same coordinates the other player is centered on
// (uses player.view, not player.cursor — the goal is "see what they see").
window.PlayerListDropdown=function PlayerListDropdown({players,selfId,onGoTo}){
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
                            <span style={{color:isMe?'#a78bfa':'#eee',fontSize:12,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name||'Player'}{isMe&&' (you)'}</span>
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
    const copy=()=>{onCopyInvite();setCopied(true);setTimeout(()=>setCopied(false),1400)};
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

