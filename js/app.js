// app.js – App component and ReactDOM render (JSX, compiled by Babel in the browser)
const{useState,useCallback,useMemo,useEffect,useRef}=React;

const DEFAULT_UI_SETTINGS={showArrows:true,showScores:true,showLeaderboard:true,showUndo:true,showZoom:true,showCoords:true,showSeed:true,showSeedBox:true,showLockBtn:true,defaultCellSize:CELL_SIZE_DEFAULT,exportRes:'auto',tlMovesPerFrame:1,tlFps:60,tlRes:'auto',myColor:'',cursorSee:'off',cursorSend:'normal',pingQuality:'full',boardFx:'full'};
const CLEARED_PER_UNDO=1000;
const MAX_VIDEO_BYTES=50e6; // timelapse.js has the same limit
const PING_SHOW_MS=4000,MAX_PINGS_SHOWN=10,PING_COOLDOWN_MS=400; // middle-click pings in a room
// Others' cursors by rate setting: how long each move glides, and how often Infrequent redraws them.
const CURSOR_GLIDE_MS={infrequent:0,normal:120,frequent:100},CURSOR_INFREQUENT_MS=1000;
const NO_HIGHLIGHTS={chordTargets:new Set(),chordCell:null,pulseTargets:new Set()}; // shared, so the grid's memo holds
const POP_MAX_CELLS=400; // an update revealing more cells than this skips their pop-in animation

// The world position (in fractional cells) under a screen point, for a view centred on viewX, viewY.
function screenToWorld(rect,clientX,clientY,cellSize,viewX,viewY){
    const cols=Math.floor(rect.width/cellSize),rows=Math.floor(rect.height/cellSize);
    const padX=(rect.width-cols*cellSize)/2,padY=(rect.height-rows*cellSize)/2;
    return[viewX-Math.floor(cols/2)+(clientX-rect.left-padX)/cellSize,viewY-Math.floor(rows/2)+(clientY-rect.top-padY)/cellSize];
}
const formatSize=bytes=>{const kb=bytes/1e3;return kb<1000?Math.ceil(kb)+' KB':(kb/1e3).toFixed(1)+' MB'};
const formatDuration=sec=>{const t=Math.round(sec);return`${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`};
const exportFileDate=()=>new Date().toISOString().replace(/[:.]/g,'-').slice(0,19); // UTC
const downloadBlob=(blob,fileName,revokeAfterMs)=>{
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=fileName;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),revokeAfterMs);
};

function App(){
    const initialSeed=getSeedFromURL()||randomSeed();
    const[seedInput,setSeedInput]=useState(initialSeed);
    const[activeSeed,setActiveSeed]=useState(initialSeed);
    const[seedLocked,setSeedLocked]=useState(!!getSeedFromURL());
    // A per-browser preference, kept apart from game saves so rooms and empty boards remember it too.
    const[viewMode,setViewMode]=useState(()=>{
        const isValid=v=>v==='Fullscreen'||VIEW_SIZES.hasOwnProperty(v);
        try{
            const v=localStorage.getItem('minesweeper_view');if(isValid(v))return v;
            const save=JSON.parse(localStorage.getItem('minesweeper_save')||'null');if(save&&isValid(save.viewMode))return save.viewMode; // older builds
        }catch(e){console.error('Failed to read saved view mode',e)}
        return'Large'});
    const[cellSize,setCellSize]=useState(CELL_SIZE_DEFAULT);
    const[viewX,setViewX]=useState(0);
    const[viewY,setViewY]=useState(0);
    // The board (cells, counters, minefield) is changed in place, so a move costs only what it changes; boardVersion
    // re-renders after each change.
    const boardRef=useRef(null);
    if(!boardRef.current)boardRef.current=createBoard(initialSeed,false);
    const[boardVersion,setBoardVersion]=useState(0);
    // revealed: how many cells the change revealed; a rebuilt board passes Infinity.
    const bumpBoard=useCallback((revealed=0)=>{if(window.setCellPop)setCellPop(revealed<=POP_MAX_CELLS);setBoardVersion(v=>v+1)},[]);
    useEffect(()=>{if(window.setCellPop)setCellPop(true)},[boardVersion]);
    const{cells,gameOver,moves,flags,cleared:clearedCount,clearedAtLastUndo,undoUsedCount}=boardRef.current;
    const[hoveredCell,setHoveredCell]=useState(null);
    const[gridDims,setGridDims]=useState({cols:20,rows:15});
    const[containerSize,setContainerSize]=useState({w:800,h:600});
    const[hints,setHints]=useState(()=>{try{const s=localStorage.getItem('minesweeper_hints');if(s)return migrateHints(JSON.parse(s))}catch(e){console.error('Failed to read saved hints',e)}return migrateHints(null)});
    const[uiSettings,setUiSettings]=useState(()=>{try{const s=localStorage.getItem('minesweeper_ui');if(s){
        const saved=JSON.parse(s);
        // Older builds had on/off switches where the cursor rate dropdowns are now.
        if(saved.cursorSee===undefined&&saved.showCursors!==undefined)saved.cursorSee=saved.showCursors?'normal':'off';
        if(saved.cursorSend===undefined&&saved.shareCursor!==undefined)saved.cursorSend=saved.shareCursor===false?'off':'normal';
        delete saved.showCursors;delete saved.shareCursor;
        return{...DEFAULT_UI_SETTINGS,...saved}}}catch(e){console.error('Failed to read saved UI settings',e)}return DEFAULT_UI_SETTINGS});
    const uiSettingsRef=useRef(uiSettings); // for the sync loop, which starts once per room
    uiSettingsRef.current=uiSettings;
    const[showSettings,setShowSettings]=useState(false);
    const[status,setStatus]=useState('');
    const[videoExporting,setVideoExporting]=useState(false);
    const[showGameOverModal,setShowGameOverModal]=useState(false);
    const[leaderboard,setLeaderboard]=useState(()=>{
        try{const s=localStorage.getItem('minesweeper_leaderboard');const arr=s?JSON.parse(s):[];return Array.isArray(arr)?arr:[]}catch(e){console.error('Failed to read saved leaderboard',e);return[]}
    });
    const[lastEntryDate,setLastEntryDate]=useState(null);
    const leaderboardRecordedRef=useRef(false);
    const runIdRef=useRef(newRunId());
    const v1FramesRef=useRef(null); // a version 1 save's recorded frames; null when the move log has the history
    const moveLogRef=useRef([]);
    const flagMapRef=useRef({});
    const containerRef=useRef(null);
    const viewBeforeFullscreenRef=useRef('Medium');

    // --- Multiplayer state (inert outside a room) ---
    const mpRoomId=useMemo(()=>new URLSearchParams(window.location.search).get('room'),[]);
    const[mpPlayerId,setMpPlayerId]=useState(null); // state, so the sync effect starts once it's assigned
    const mpOwnerTag=useMemo(()=>mpPlayerId?mpPlayerId.slice(0,8):null,[mpPlayerId]); // how the server credits our moves
    const[mpName,setMpName]=useState(()=>localStorage.getItem('minesweeper_name')||'');
    const[mpNamePromptOpen,setMpNamePromptOpen]=useState(!!mpRoomId&&!localStorage.getItem('minesweeper_name'));
    // Start menu: {step, closable}, or null. Opens by itself on a fresh visit: no room, saved game or queued start.
    const[startMenu,setStartMenu]=useState(()=>{
        if(mpRoomId||localStorage.getItem('minesweeper_pending_start'))return null;
        try{
            const save=JSON.parse(localStorage.getItem('minesweeper_save')||'null');
            if(save&&(save.version===1?save.cells&&Object.keys(save.cells).length:save.moveLog&&save.moveLog.length))return null;
        }catch(e){console.error('Failed to read saved game',e)}
        return{step:'choose',closable:false}});
    const[mpPlayers,setMpPlayers]=useState({});
    const mpPlayersShownRef=useRef({meta:'',cursors:'',cursorsAt:0}); // what mpPlayers last showed, so polls with no change skip a redraw
    const[mpStatus,setMpStatus]=useState('connecting');
    const mpServerLogRef=useRef([]); // the room's move log, in server order
    const mpServerOwnersRef=useRef([]); // owner tag of each entry, for game-over attribution
    const mpSyncingRef=useRef(false);
    const[mpLoserTag,setMpLoserTag]=useState(null); // owner tag of whoever hit the mine
    const mpLastSyncedHintsRef=useRef(null);
    const[mpBackoff,setMpBackoff]=useState(null); // set while syncs are failing
    const[mpFounderId,setMpFounderId]=useState(null); // the room's creator, who can start over without a vote
    const[mpResetVote,setMpResetVote]=useState(null);
    const mpRoundRef=useRef(null); // a change means the room started over
    const[mpToasts,setMpToasts]=useState([]);
    const mpToastIdRef=useRef(0);
    const mpLastEventSeqRef=useRef(null);
    // key: a new toast replaces any showing with the same key (one ping toast per player).
    const pushToast=useCallback((text,onClick,key)=>{
        const id=++mpToastIdRef.current;
        setMpToasts(ts=>[...ts.filter(t=>!key||t.key!==key).slice(-3),{id,text,onClick,key}]);
        setTimeout(()=>setMpToasts(ts=>ts.filter(t=>t.id!==id)),5000);
    },[]);
    // Middle-click pings on the board, ours and other players': {id, x, y, color, name}.
    const[mpPings,setMpPings]=useState([]);
    const mpPingIdRef=useRef(0);
    const addPing=useCallback(ping=>{
        const id=++mpPingIdRef.current;
        setMpPings(ps=>[...ps.slice(-(MAX_PINGS_SHOWN-1)),{...ping,id}]);
        setTimeout(()=>setMpPings(ps=>ps.filter(p=>p.id!==id)),PING_SHOW_MS);
    },[]);

    const savedSignatureRef=useRef('');
    const saveSignature=save=>{
        const logLength=typeof save.moveLog==='string'?save.moveLog.length:(Array.isArray(save.moveLog)?save.moveLog.length:0);
        return logLength+'|'+save.activeSeed+'|'+save.locked+'|'+save.viewMode+'|'+save.cellSize+'|'+save.viewX+'|'+save.viewY+'|'+JSON.stringify(save.hints);
    };

    useEffect(()=>{try{localStorage.setItem('minesweeper_hints',JSON.stringify(hints))}catch(e){console.error('Failed to save hints',e)}},[hints]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_ui',JSON.stringify(uiSettings))}catch(e){console.error('Failed to save UI settings',e)}},[uiSettings]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_view',viewMode)}catch(e){console.error('Failed to save view mode',e)}},[viewMode]);
    useEffect(()=>{document.title=activeSeed?`${activeSeed} - InfiniSweeper`:'InfiniSweeper'},[activeSeed]);

    // Fullscreen hides the status line, so the latest status also shows as a toast, updated in place.
    const[statusToast,setStatusToast]=useState(null);
    const statusToastTimerRef=useRef(null);
    const showStatus=useCallback(msg=>{
        setStatus(msg);
        clearTimeout(statusToastTimerRef.current);
        if(!msg){setStatusToast(null);return}
        setStatusToast({id:'status',text:msg});
        statusToastTimerRef.current=setTimeout(()=>setStatusToast(null),Math.max(5000,String(msg).length*70));
    },[]);

    const buildSave=useCallback(()=>({
        version:3,activeSeed,locked:seedLocked,viewMode,cellSize,viewX,viewY,hints,moveLog:encodeMoveLog(moveLogRef.current),timestamp:Date.now(),runId:runIdRef.current
    }),[activeSeed,seedLocked,viewMode,cellSize,viewX,viewY,hints,boardVersion]);

    // A save's viewMode is ignored: the minesweeper_view preference wins.
    const loadSave=useCallback(data=>{
        if(!data)return false;
        if(data.version===3||data.version===2){
            const log=data.version===3
                ?decodeMoveLog(typeof data.moveLog==='string'?data.moveLog:'')
                :(Array.isArray(data.moveLog)?data.moveLog.slice():[]);
            setActiveSeed(data.activeSeed);setSeedInput(data.activeSeed);setSeedLocked(data.locked);
            setCellSize(data.cellSize);setViewX(data.viewX);setViewY(data.viewY);
            setHints(migrateHints(data.hints));
            runIdRef.current=data.runId||newRunId();
            moveLogRef.current=log;
            v1FramesRef.current=null;
            flagMapRef.current={};
            boardRef.current=boardFromLog(data.activeSeed,log,!!(data.hints&&data.hints.wrongFlags));
            bumpBoard(Infinity);
            setShowGameOverModal(boardRef.current.gameOver);
            return true;
        }
        if(data.version===1){
            setActiveSeed(data.activeSeed);setSeedInput(data.activeSeed);setSeedLocked(data.locked);
            setCellSize(data.cellSize);setViewX(data.viewX);setViewY(data.viewY);
            setHints(migrateHints(data.hints));
            boardRef.current=createBoard(data.activeSeed,!!(data.hints&&data.hints.wrongFlags),
                {cells:data.cells||{},firstClick:data.firstClick||null,moves:data.moves||0,flags:data.flags||0,gameOver:!!data.gameOver});
            bumpBoard(Infinity);
            runIdRef.current=data.runId||newRunId();
            const hasCells=!!(data.cells&&Object.keys(data.cells).length>0);
            moveLogRef.current=[];
            const flagMap=extractFlags(data.cells||{});
            flagMapRef.current=flagMap;
            v1FramesRef.current=hasCells?[{diff:Object.entries(data.cells),flags:flagMap}]:null;
            setShowGameOverModal(!!data.gameOver);
            return true;
        }
        return false;
    },[bumpBoard]);

    const downloadSave=()=>{
        const save=buildSave();
        downloadBlob(new Blob([JSON.stringify(save,null,2)],{type:'application/json'}),`${exportFileDate()}-minesweeper-save.json`,0);
        savedSignatureRef.current=saveSignature(save);
        showStatus('Save file downloaded')};

    const importSaveFile=e=>{
        const file=e.target.files[0];if(!file)return;
        const reader=new FileReader();
        reader.onload=ev=>{
            try{const data=JSON.parse(ev.target.result);
                if(mpRoomId){importIntoRoom(data);return}
                if(data.version===1||data.version===2||data.version===3){
                    if(moves>0&&!confirm('Overwrite current progress?'))return;
                    if(loadSave(data)){
                        savedSignatureRef.current=saveSignature(data);
                        showStatus('Save file loaded successfully');
                    }else showStatus('Invalid save file')}
                else showStatus('Incompatible save version')}
            catch(err){console.error('Failed to import save file',err);showStatus('Invalid save file')}};
        reader.onerror=()=>{console.error('Failed to read save file',reader.error);showStatus('Could not read file')};
        reader.readAsText(file);e.target.value=''};

    const clearSave=()=>{localStorage.removeItem('minesweeper_save');savedSignatureRef.current='';showStatus('Cache cleared')};

    // The original full-canvas image export, for when mapimage.js didn't load, CompressionStream is missing, or the
    // streamed export fails.
    const exportImageViaCanvas=(withStats,cellPx)=>{
        const cells=boardRef.current.cells,keys=Object.keys(cells);
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        keys.forEach(k=>{const[x,y]=k.split(',').map(Number);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)});
        const border=2;
        minX-=border;maxX+=border;minY-=border;maxY+=border;
        const cols=maxX-minX+1,rows=maxY-minY+1;
        const boardH=rows*cellPx,footerH=withStats?Math.round(boardH*0.04/0.96):0;
        const canvasW=cols*cellPx,canvasH=boardH+footerH;
        if(canvasW*canvasH>16000000){if(!confirm('The exported image will be very large. Continue?'))return}
        const canvas=document.createElement('canvas');canvas.width=canvasW;canvas.height=canvasH;
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,canvasW,canvasH);
        for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
                drawCellToCanvas(ctx,cells[`${x},${y}`],(x-minX)*cellPx,(y-minY)*cellPx,cellPx);}}
        if(withStats&&footerH>0){
            ctx.fillStyle='#111128';ctx.fillRect(0,canvasH-footerH,canvasW,footerH);
            ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(footerH/48));ctx.strokeRect(0,canvasH-footerH,canvasW,footerH);
            const fontSize=Math.round(footerH*0.3),iconSize=Math.round(footerH*0.35),midY=canvasH-footerH/2;
            ctx.font=`bold ${fontSize}px sans-serif`;ctx.textAlign='left';ctx.textBaseline='middle';
            let penX=footerH*0.4;
            const drawStat=(label,icon,value)=>{
                ctx.fillStyle='#aaa';ctx.font=`bold ${fontSize}px sans-serif`;ctx.fillText(label,penX,midY);penX+=ctx.measureText(label).width+footerH*0.1;
                ctx.font=`${iconSize}px serif`;ctx.fillText(icon,penX,midY);penX+=footerH*0.45;
                ctx.fillStyle='#fff';ctx.font=`bold ${fontSize}px sans-serif`;ctx.fillText(value,penX,midY);
                penX+=ctx.measureText(value).width+footerH*0.6};
            drawStat('Mines Flagged:','🚩',flags);
            drawStat('Moves Made:','👆',moves);
            drawStat('Squares Cleared:','🟦',`${clearedCount}`);
        }
        const link=document.createElement('a');link.download=`${exportFileDate()}-minesweeper-seed-${activeSeed}-run.png`;
        link.href=canvas.toDataURL('image/png');link.click();showStatus('Progress image exported')};
    const[exportTask,setExportTask]=useState(null);
    const exportResultTimerRef=useRef(null);
    // Starts an export's progress UI and returns the hooks the exporter reports through. The toast leaves the game
    // usable; progress goes through a tiny store it subscribes to, so ticks don't re-render the board.
    const beginExportTask=(kind,title)=>{
        let progress={},resolvePlan=null,showTimer=null,shown=false;const listeners=new Set(),abort=new AbortController();
        const task={kind,title,startedAt:Date.now(),plan:null,
            progress:{get:()=>progress,set:update=>{progress={...progress,...update};listeners.forEach(f=>f(progress))},sub:f=>{listeners.add(f);return()=>{listeners.delete(f)}}},
            cancel:()=>{if(resolvePlan){resolvePlan(false);resolvePlan=null}abort.abort()},
            start:movesPerFrame=>{if(resolvePlan){resolvePlan({movesPerFrame});resolvePlan=null}setExportTask(t=>t&&{...t,plan:null})}};
        clearTimeout(exportResultTimerRef.current);
        const hasUI=!!(window.ExportProgressToast||window.ExportProgressModal);
        if(hasUI)showTimer=setTimeout(()=>{shown=true;setExportTask(task)},300); // so quick exports don't flash it
        return{signal:abort.signal,onProgress:update=>task.progress.set(update),hasModal:!!window.ExportProgressModal,
            // Shows a long timelapse's speed picker. Resolves to false, or {movesPerFrame}.
            askPlan:plan=>new Promise(resolve=>{resolvePlan=resolve;clearTimeout(showTimer);shown=true;setExportTask({...task,plan})}),
            // Shows result {ok, title, text} in the toast for a few seconds. Returns false if there was no toast to show it in.
            end:result=>{
                clearTimeout(showTimer);
                if(!(result&&shown&&window.ExportProgressToast)){setExportTask(null);return false}
                setExportTask({...task,plan:null,result});
                exportResultTimerRef.current=setTimeout(()=>setExportTask(t=>t&&t.result===result?null:t),Math.max(5000,(result.title+(result.text||'')).length*70));
                return true}};
    };
    // Reports how an export ended: in its toast if it had one, otherwise as a status message.
    const finishExport=(job,result)=>{
        const message=result?(result.text?`${result.title} (${result.text})`:result.title):'';
        if(job.end(result))setStatus(message);else if(message)showStatus(message);
    };
    const imageExportingRef=useRef(false);
    const exportImage=async(withStats=true)=>{
        if(imageExportingRef.current)return;
        if(Object.keys(cells).length===0){showStatus('No progress to export');return}
        const res=uiSettings.exportRes||'auto';
        const exportViaCanvas=()=>{try{exportImageViaCanvas(withStats,res==='auto'?32:Math.max(1,Math.min(32,parseInt(res,10)||32)))}
            catch(err){console.error('Canvas image export failed',err);showStatus('Image export failed: '+(err&&err.message?err.message:'unknown error'))}};
        if(!window.MapImage||!window.CompressionStream){exportViaCanvas();return}
        imageExportingRef.current=true;setStatus('Exporting image…');
        const job=beginExportTask('image','Exporting image');
        let result=null,fallBack=false;
        try{
            const stats=withStats?{flags,moves,cleared:clearedCount}:null;
            const out=await MapImage.render(cells,stats,res,bytes=>confirm(`The exported image will be about ${Math.ceil(bytes/1e6)} MB. Continue?`),undefined,{signal:job.signal,onProgress:job.onProgress});
            if(!out)result={ok:false,title:'Image export cancelled'};
            else{
                downloadBlob(out.blob,`${exportFileDate()}-minesweeper-seed-${activeSeed}-run.png`,10000);
                result={ok:true,title:'Progress image exported',text:`${formatSize(out.blob.size)}, ${out.sz}px per cell`};
            }
        }catch(err){
            if(err&&err.name==='AbortError')result={ok:false,title:'Image export cancelled'};
            else{console.error('Image export failed, falling back to canvas export',err);fallBack=true}}
        finally{imageExportingRef.current=false;finishExport(job,result)}
        if(fallBack)exportViaCanvas()};

    // The board-changing moves as [{diff, flagged}], for the in-memory exporter.
    const inMemoryVideoSteps=()=>{
        const steps=[];
        if(Array.isArray(v1FramesRef.current)&&v1FramesRef.current.length){
            // Each recorded frame has a full flag snapshot; turn those into flag changes.
            let prevFlags={};
            for(const frame of v1FramesRef.current){
                const diff=frame.diff.slice(),inDiff=new Set(diff.map(d=>d[0])),frameFlags=frame.flags||{};
                for(const k of new Set([...Object.keys(prevFlags),...Object.keys(frameFlags)]))if(!inDiff.has(k)&&frameFlags[k]!==prevFlags[k])diff.push([k,frameFlags[k]]);
                let flagged=0;for(const k in frameFlags)if(frameFlags[k]!=='quest')flagged++;
                prevFlags=frameFlags;steps.push({diff,flagged});
            }
            return steps;
        }
        // Mirrors applyLogEntry in game.js.
        const log=moveLogRef.current,first=log[0],firstMove=first&&first[0]==='r'?[first[1],first[2]]:null;
        const minefield=createMinefield(hashSeed(activeSeed),firstMove),board={};let flagged=0;
        for(const entry of log){
            if(!entry||entry.length<3)continue;const[type,x,y]=entry;
            if(type==='r'){const{diff,gameOver}=applyReveal(board,x,y,minefield,hints.wrongFlags,true);if(diff.length)steps.push({diff,flagged});if(gameOver)break}
            else if(type==='f'){const{diff,flagsDelta,changed}=applyFlag(board,x,y,true);if(changed){flagged+=flagsDelta;steps.push({diff,flagged})}}
        }
        return steps};
    // Why WebCodecs video export can't run here, or null. Browsers only offer VideoEncoder on https:// or localhost.
    const webCodecsMissingReason=()=>{
        if(typeof window.VideoEncoder!=='undefined'&&typeof window.VideoFrame!=='undefined'&&typeof window.Mp4Muxer!=='undefined')return null;
        if(window.isSecureContext===false)return`Video export on ${location.protocol}//${location.host} needs timelapse.js, which didn't load. Reload the page, or open it at localhost.`;
        if(typeof window.Mp4Muxer==='undefined')return'The video export library failed to load. Reload the page and try again.';
        return'Video export needs a browser with WebCodecs (try Chrome or Edge)';
    };
    // The original timelapse exporter, which draws on a canvas and holds the whole file in memory. Used when
    // timelapse.js didn't load, or its streamed export fails.
    const exportVideoInMemory=async steps=>{
        if(!steps.length){showStatus('No progress to export');return}
        const missing=webCodecsMissingReason();if(missing){showStatus(missing);return}
        const fps=+uiSettings.tlFps===30?30:60,movesPerFrame=[1,2,4,8,16,32].includes(+uiSettings.tlMovesPerFrame)?+uiSettings.tlMovesPerFrame:1;
        const holdFrames=fps,totalFrames=Math.ceil(steps.length/movesPerFrame)+holdFrames; // hold the final board for a second
        if(totalFrames>4000&&!confirm(`This timelapse is ${formatDuration(totalFrames/fps)} long (${steps.length} moves) and may take a while to encode. Continue?`))return;

        setVideoExporting(true);setStatus('Exporting timelapse…');
        const job=beginExportTask('video','Exporting timelapse');let result=null,lastReport=0;
        try{
            let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
            for(const step of steps)for(const[k]of step.diff){const c=k.indexOf(','),x=+k.slice(0,c),y=+k.slice(c+1);if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y}
            const border=2;minX-=border;maxX+=border;minY-=border;maxY+=border;
            const cols=maxX-minX+1,rows=maxY-minY+1;

            // Cells shrink (down to 1px) to keep the frame within maxSide.
            const maxSide=1920;
            const cellPx=Math.max(1,Math.min(24,Math.floor(maxSide/Math.max(cols,rows))));
            const footerH=Math.max(48,Math.round(rows*cellPx*0.04/0.96));
            let canvasW=Math.max(480,cols*cellPx),canvasH=Math.max(480,rows*cellPx+footerH);
            if(canvasW%2)canvasW++;
            if(canvasH%2)canvasH++;

            // The smallest H.264 level (up to 5.1) that fits this frame size and rate.
            const macroblocks=Math.ceil(canvasW/16)*Math.ceil(canvasH/16);
            const level=([[30,1620,40500],[31,3600,108000],[32,5120,216000],[40,8192,245760],[42,8704,522240],[50,22080,589824],[51,36864,983040]].find(([,maxPerFrame,maxPerSecond])=>macroblocks<=maxPerFrame&&macroblocks*fps<=maxPerSecond)||[51])[0].toString(16);
            const codecCandidates=['4d00','42e0','6400'].map(profile=>({type:'avc',codec:`avc1.${profile}${level}`}));
            let codec=null;
            for(const candidate of codecCandidates){
                try{const support=await VideoEncoder.isConfigSupported({codec:candidate.codec,width:canvasW,height:canvasH,framerate:fps});
                    if(support&&support.supported){codec=candidate;break}}catch(e){console.error('Codec support check failed for',candidate.codec,e)}}
            if(!codec){result={ok:false,title:'This device cannot encode H.264 video'};return}

            const canvas=document.createElement('canvas');canvas.width=canvasW;canvas.height=canvasH;
            const ctx=canvas.getContext('2d');
            const frameDurationUs=Math.round(1e6/fps);
            const encodeAt=async bitrate=>{
                ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,canvasW,canvasH);
                for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)drawCellToCanvas(ctx,null,(x-minX)*cellPx,(y-minY)*cellPx,cellPx);
                const chunks=[]; // muxed once encoding is done
                let encoderError=null;
                const videoEncoder=new VideoEncoder({
                    output:(chunk,meta)=>{const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);chunks.push({data,type:chunk.type,pts:chunk.timestamp,meta})},
                    error:e=>{encoderError=encoderError||e;console.error('Timelapse encode error',e)}
                });
                videoEncoder.configure({codec:codec.codec,width:canvasW,height:canvasH,bitrate,framerate:fps});
                let frame=0,movesDone=0,cleared=0,flagged=0;
                const emitFrame=async()=>{
                    drawVideoFooter(ctx,canvasW,canvasH,footerH,movesDone,steps.length,cleared,flagged);
                    const videoFrame=new VideoFrame(canvas,{timestamp:frame*frameDurationUs,duration:frameDurationUs});
                    videoEncoder.encode(videoFrame,{keyFrame:frame%(fps*10)===0}); // a keyframe every 10s: seekable, and half the size of every 2s
                    videoFrame.close();frame++;
                    if(videoEncoder.encodeQueueSize>4)await new Promise(r=>setTimeout(r,0));
                    if(frame%25===0||frame===totalFrames)await new Promise(r=>setTimeout(r,0));
                    const now=performance.now();if(now-lastReport>100||frame===totalFrames){lastReport=now;job.onProgress({phase:'encode',done:frame,total:totalFrames})}
                    if(encoderError)throw encoderError;
                    if(job.signal.aborted)throw new DOMException('Export cancelled','AbortError');
                };
                for(const step of steps){
                    for(const[k,v]of step.diff){if(v&&v[0]==='r')cleared++;const c=k.indexOf(',');drawCellToCanvas(ctx,v,(+k.slice(0,c)-minX)*cellPx,(+k.slice(c+1)-minY)*cellPx,cellPx)}
                    flagged=step.flagged;movesDone++;
                    if(movesDone%movesPerFrame===0||movesDone===steps.length)await emitFrame();
                }
                for(let j=0;j<holdFrames;j++)await emitFrame();
                await videoEncoder.flush();videoEncoder.close();
                if(encoderError)throw encoderError;
                const muxer=new Mp4Muxer.Muxer({
                    target:new Mp4Muxer.ArrayBufferTarget(),
                    video:{codec:codec.type,width:canvasW,height:canvasH},
                    fastStart:'in-memory',firstTimestampBehavior:'offset'
                });
                // Some encoders (Firefox's) reorder frames and shift their timestamps. Chunks come in decode order,
                // so the n-th decodes at the n-th presentation time, moved earlier by the deepest reordering.
                const presentationTimes=chunks.map(c=>c.pts).sort((a,b)=>a-b);let reorderLead=0;
                chunks.forEach((c,n)=>{reorderLead=Math.max(reorderLead,presentationTimes[n]-c.pts)});
                chunks.forEach((c,n)=>{
                    let meta=c.meta;
                    if(meta&&meta.decoderConfig&&meta.decoderConfig.description&&window.repairAvcDecoderConfig)
                        meta={...meta,decoderConfig:{...meta.decoderConfig,description:window.repairAvcDecoderConfig(meta.decoderConfig.description,c.data)}};
                    muxer.addVideoChunkRaw(c.data,c.type,c.pts,frameDurationUs,meta,c.pts-(presentationTimes[n]-reorderLead));
                });
                muxer.finalize();
                return muxer.target.buffer;
            };
            // No more than fits the cap over this video's length; screen content rarely needs even that.
            let bitrate=Math.round(Math.min(20e6,Math.max(3e5,canvasW*canvasH*fps*0.02),MAX_VIDEO_BYTES*8*0.9/(totalFrames/fps)));
            let buffer=await encodeAt(bitrate);
            for(let attempt=1;attempt<3&&buffer.byteLength>MAX_VIDEO_BYTES;attempt++){
                job.onProgress({phase:'retry',done:0,total:totalFrames});
                bitrate=Math.floor(bitrate*MAX_VIDEO_BYTES/buffer.byteLength*0.85);buffer=await encodeAt(bitrate);
            }
            if(buffer.byteLength>MAX_VIDEO_BYTES){result={ok:false,title:'The timelapse would be over 50 MB',text:'pick more moves per frame in Settings'};return}
            const blob=new Blob([buffer],{type:'video/mp4'});
            downloadBlob(blob,`${exportFileDate()}-minesweeper-seed-${activeSeed}-timelapse.mp4`,60000);
            result={ok:true,title:'Timelapse video exported',text:`${formatDuration(totalFrames/fps)}, ${canvasW}×${canvasH}, ${formatSize(blob.size)}`};
        }catch(err){
            if(err&&err.name==='AbortError')result={ok:false,title:'Timelapse export cancelled'};
            else{console.error(err);result={ok:false,title:'Video export failed',text:err&&err.message?err.message:'unknown error'}}
        }finally{
            setVideoExporting(false);finishExport(job,result);
        }
    };
    const exportVideo=async()=>{
        if(videoExporting)return;
        const v1Frames=Array.isArray(v1FramesRef.current)&&v1FramesRef.current.length?v1FramesRef.current:null;
        if(!v1Frames&&!moveLogRef.current.length){showStatus('No progress to export');return}
        // timelapse.js encodes with WebCodecs, or with WebAssembly where the browser hides VideoEncoder (plain http://).
        const hasWebCodecs=!webCodecsMissingReason();
        const canStream=!!(window.Timelapse&&window.Mp4Muxer&&Mp4Muxer.StreamTarget&&(hasWebCodecs||typeof WebAssembly!=='undefined'));
        if(!canStream){const missing=webCodecsMissingReason();if(missing){showStatus(missing);return}await exportVideoInMemory(inMemoryVideoSteps());return}
        setVideoExporting(true);setStatus('Exporting timelapse…');
        const job=beginExportTask('video','Exporting timelapse');
        let failure=null,wakeLock=null,result=null;
        // Long exports run for minutes; keep the screen from sleeping (and pausing the tab) meanwhile.
        try{if(navigator.wakeLock)wakeLock=await navigator.wakeLock.request('screen')}catch(e){console.error('Screen wake lock unavailable',e)}
        try{
            // In a room, moveLogRef holds the whole room's log, with every player's moves.
            const source=v1Frames?{frames:v1Frames}:{seed:activeSeed,moveLog:moveLogRef.current.slice(),wrongFlags:!!hints.wrongFlags};
            const out=await Timelapse.render(source,{fps:uiSettings.tlFps,movesPerFrame:uiSettings.tlMovesPerFrame,res:uiSettings.tlRes},{
                signal:job.signal,onProgress:job.onProgress,
                // Over 4000 frames, or a minute's work for the slow WebAssembly encoder, offer a faster speed first.
                confirmPlan:plan=>(plan.frames<=4000&&!(plan.slow&&plan.frames*plan.msPerFrame>60000))||(job.hasModal?job.askPlan(plan):confirm(`This timelapse is ${formatDuration(plan.seconds)} long (${plan.moves} moves) and may take a while to encode. Continue?`))});
            if(!out)result={ok:false,title:'Timelapse export cancelled'};
            else if(out.empty)result={ok:false,title:'No progress to export'};
            else if(out.tooBig)result={ok:false,title:`The timelapse would be over ${Math.round(out.limit/1e6)} MB`,text:'pick more moves per frame in Settings'};
            else{
                downloadBlob(out.blob,`${exportFileDate()}-minesweeper-seed-${activeSeed}-timelapse.mp4`,60000);
                result={ok:true,title:'Timelapse video exported',text:`${formatDuration(out.seconds)}, ${out.width}×${out.height}, ${formatSize(out.blob.size)}`};
            }
        }catch(err){failure=err}
        finally{
            setVideoExporting(false);
            if(failure&&!hasWebCodecs)result={ok:false,title:'Video export failed',text:failure&&failure.message?failure.message:'unknown error'};
            // With WebCodecs, a failure goes straight on to the in-memory exporter, which shows its own toast.
            finishExport(job,failure&&hasWebCodecs?null:result);
            if(wakeLock)wakeLock.release().catch(e=>console.error('Screen wake lock release failed',e))}
        if(failure&&hasWebCodecs){console.error('Timelapse export failed, retrying with the in-memory exporter',failure);await exportVideoInMemory(inMemoryVideoSteps())}
        else if(failure)console.error('Timelapse export failed',failure);
    };

    // Restores the saved game, or starts the singleplayer game queued by leaving a room. Rooms load from the server.
    useEffect(()=>{
        if(mpRoomId)return;
        let pendingStart=null;
        try{pendingStart=JSON.parse(localStorage.getItem('minesweeper_pending_start')||'null')}catch(e){console.error('Failed to read pending start',e)}
        if(pendingStart){
            localStorage.removeItem('minesweeper_pending_start');
            if(pendingStart.hints)setHints(migrateHints(pendingStart.hints));
            startNewGame(typeof pendingStart.seed==='string'?pendingStart.seed:'');
            return;
        }
        const saved=localStorage.getItem('minesweeper_save');
        if(saved){try{const data=JSON.parse(saved);if(data&&(data.version===1||data.version===2||data.version===3)){if(loadSave(data)){savedSignatureRef.current=saveSignature(data);showStatus('Progress restored')}}}catch(e){console.error('Failed to restore saved game',e)}}
    },[loadSave,showStatus,mpRoomId]);

    // Auto-save. Not in a room: the server holds that game, and saving would race with its rebuilds.
    useEffect(()=>{
        if(mpRoomId)return;
        const t=setTimeout(()=>{
            const save=buildSave();
            if(!save.moveLog)return;
            const signature=saveSignature(save);
            if(signature===savedSignatureRef.current)return;
            localStorage.setItem('minesweeper_save',JSON.stringify(save));
            savedSignatureRef.current=signature;
            showStatus('Progress auto-saved');
        },1200);
        return()=>clearTimeout(t)},[buildSave,showStatus,mpRoomId]);

    useEffect(()=>{
        if(mpRoomId)return; // the URL holds ?room= instead
        setSeedInURL(activeSeed);
    },[activeSeed,mpRoomId]);

    // --- Multiplayer: a stable playerId for this room ---
    useEffect(()=>{
        if(!mpRoomId){setMpPlayerId(null);return}
        const key='minesweeper_room_'+mpRoomId;
        let pid=localStorage.getItem(key);
        // The server's is_valid_id() rule; older builds stored ids it rejects.
        if(!pid||!/^[a-f0-9]{16,64}$/.test(pid)){
            // getRandomValues rather than randomUUID, which only exists on https:// and localhost.
            pid=Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('');
            localStorage.setItem(key,pid);
        }
        setMpPlayerId(pid);
    },[mpRoomId]);

    // --- Multiplayer: applies the server's moves to the board ---
    // newMoves extends our copy of the log; moveLog replaces it after an undo rewrote past entries. Our clicks the
    // server hasn't taken yet stay on top (it appends them in this order), so they never blink out. ownTag credits a
    // loss to us when the losing reveal is one of those.
    const applyServerMoves=useCallback((seed,data,showWrongFlags,ownTag)=>{
        const{newMoves,moveLog,moveOwners}=data,added=[];
        if(typeof moveLog==='string'){
            mpServerLogRef.current=decodeMoveLog(moveLog);
            const owners=(typeof moveOwners==='string')?moveOwners.replace(/;$/,''):'';
            mpServerOwnersRef.current=owners.length===0?[]:owners.split(';'); // keeps empty slots, so indices line up
        }else if(newMoves&&newMoves.length){
            for(const m of newMoves){
                if(!m||m.length<3)continue;
                const entry=[m[0],m[1],m[2]];
                mpServerLogRef.current.push(entry);
                mpServerOwnersRef.current.push(m[3]||'');
                added.push(entry);
            }
        }
        const before=boardRef.current,clearedBefore=before.cleared;
        const synced=syncBoard(before,moveLogRef.current,mpServerLogRef.current,added,typeof moveLog==='string',seed,!!showWrongFlags,Net.pendingMoves());
        if(!synced)return;
        boardRef.current=synced.board;
        moveLogRef.current=synced.log;
        v1FramesRef.current=null;
        const{gameOver:lost,losingMoveIndex:i}=synced.board,owners=mpServerOwnersRef.current;
        setMpLoserTag(lost?(i<owners.length?owners[i]:ownTag)||'':null);
        bumpBoard(synced.board===before?synced.board.cleared-clearedBefore:Infinity);
    },[bumpBoard]);

    // --- Multiplayer: the sync loop, once we have a room, name and player id ---
    useEffect(()=>{
        if(!mpRoomId||!mpName||!mpPlayerId)return;
        mpSyncingRef.current=true;
        mpRoundRef.current=null;
        mpLastEventSeqRef.current=null;
        mpPlayersShownRef.current={meta:'',cursors:'',cursorsAt:0};
        // Net starts again from move 0, so our copy of the server's log starts over and the board is rebuilt from it.
        mpServerLogRef.current=[];
        mpServerOwnersRef.current=[];
        boardRef.current.dirty=true;
        const batch=ReactDOM.unstable_batchedUpdates||(f=>f()); // one render per sync
        Net.start({
            roomId:mpRoomId,
            playerId:mpPlayerId,
            name:mpName,
            color:uiSettingsRef.current.myColor||'',
            onStatus:s=>{setMpStatus(s);if(s==='connected')setMpBackoff(null)},
            onBackoff:info=>setMpBackoff(info),
            onSync:data=>batch(()=>{
                if(data.players){
                    // Redrawn only for a change: names, colours and views at once, others' cursors at the chosen rate
                    // (Infrequent: once a second) and not at all while they're off.
                    const see=uiSettingsRef.current.cursorSee,now=Date.now(),shown=mpPlayersShownRef.current;
                    let meta='',cursors='';
                    for(const pid in data.players){
                        const p=data.players[pid]||{};
                        meta+=`${pid}:${p.name}|${p.color}|${p.view?p.view.x+','+p.view.y:''};`;
                        if(p.cursor)cursors+=`${pid}:${p.cursor.x},${p.cursor.y};`;
                    }
                    const cursorsDue=see!=='off'&&cursors!==shown.cursors&&(see!=='infrequent'||now-shown.cursorsAt>=CURSOR_INFREQUENT_MS);
                    if(meta!==shown.meta||cursorsDue){
                        setMpPlayers(data.players);
                        mpPlayersShownRef.current={meta,cursors,cursorsAt:cursors!==shown.cursors?now:shown.cursorsAt};
                    }
                }
                setMpFounderId(data.founderId||null);
                setMpResetVote(data.resetVote||null);
                if(typeof data.round==='number'){
                    // Someone started over. The replay below clears the board; this starts a new leaderboard run and recentres.
                    if(mpRoundRef.current!==null&&data.round!==mpRoundRef.current){
                        runIdRef.current=newRunId();
                        setViewX(0);setViewY(0);
                        showStatus('New round started');
                    }
                    mpRoundRef.current=data.round;
                }
                if(Array.isArray(data.events)){
                    // Announces each of the other players' actions once, skipping ones from before we joined.
                    const lastSeen=mpLastEventSeqRef.current;
                    let newest=lastSeen===null?0:lastSeen;
                    for(const ev of data.events){
                        if(ev.seq>newest)newest=ev.seq;
                        if(lastSeen===null||ev.seq<=lastSeen||ev.by===mpPlayerId)continue;
                        if(ev.type==='ping'){
                            if(!Number.isFinite(ev.x)||!Number.isFinite(ev.y)||uiSettingsRef.current.pingQuality==='off')continue;
                            const pinger=data.players&&data.players[ev.by];
                            addPing({x:ev.x,y:ev.y,color:(pinger&&pinger.color)||'#5b9bd5',name:ev.byName});
                            pushToast(`${ev.byName} pinged (${ev.x}, ${ev.y})`,()=>{setViewX(ev.x);setViewY(ev.y)},'ping:'+ev.by);
                            continue;
                        }
                        const msg={undo:'used an undo',restart:'restarted the board',new:'started a new game',load:'loaded a save file'}[ev.type];
                        if(msg)pushToast(`${ev.byName} ${msg}`);
                    }
                    mpLastEventSeqRef.current=newest;
                }
                if(data.seed&&data.seed!==activeSeed){setActiveSeed(data.seed);setSeedInput(data.seed);}
                if(data.hints){
                    // Recorded before setHints, so the hint-sync effect doesn't send the server's own hints back.
                    mpLastSyncedHintsRef.current={...data.hints};
                    setHints(prev=>Object.keys(data.hints).every(k=>prev[k]===data.hints[k])?prev:{...prev,...data.hints});
                }
                applyServerMoves(data.seed||activeSeed,data,data.hints&&data.hints.wrongFlags,mpPlayerId.slice(0,8));
            }),
            onError:e=>{
                console.error('sync error',e);
                // A mistyped session code, or a session that expired (rooms are deleted after a day idle).
                if(e&&e.message==='HTTP 404')showStatus('Session not found. Check the code, or create a new session.');
            },
        });
        return()=>{Net.stop();mpSyncingRef.current=false};
    // Started once per room, name and player id, so activeSeed is left out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    },[mpRoomId,mpName,mpPlayerId,applyServerMoves,pushToast,addPing]);

    // Cursor rates and colour from the settings. net.js may be an older cached copy without them.
    useEffect(()=>{if(typeof Net.setCursorRates==='function')Net.setCursorRates(uiSettings.cursorSend,uiSettings.cursorSee)},[uiSettings.cursorSend,uiSettings.cursorSee]);
    useEffect(()=>{if(Net.isRunning()&&typeof Net.updateColor==='function')Net.updateColor(uiSettings.myColor||'')},[uiSettings.myColor]);

    // --- Multiplayer: our cursor, handed to Net at up to 10 Hz (it sends at the chosen rate) unless it's off ---
    const mpMouseRef=useRef(null); // the mouse's last client position while over the board
    useEffect(()=>{
        if(!mpRoomId||!containerRef.current)return;
        const el=containerRef.current;
        const hideCursor=()=>{if(typeof Net.hideCursor==='function')Net.hideCursor()}; // net.js may be an older cached copy
        if(uiSettings.cursorSend==='off'){mpMouseRef.current=null;hideCursor();return}
        let lastSentAt=0,lastX=null,lastY=null,trailing=null;
        const send=(clientX,clientY)=>{
            const[x,y]=screenToWorld(el.getBoundingClientRect(),clientX,clientY,cellSize,viewX,viewY);
            if(lastX!==null&&Math.abs(x-lastX)<0.1&&Math.abs(y-lastY)<0.1)return;
            lastSentAt=Date.now();lastX=x;lastY=y;
            Net.sendCursor(x,y,cellSize);
        };
        const onMouseMove=e=>{
            mpMouseRef.current={x:e.clientX,y:e.clientY};
            clearTimeout(trailing);
            const wait=lastSentAt+100-Date.now();
            if(wait<=0)send(e.clientX,e.clientY);
            else trailing=setTimeout(()=>{const m=mpMouseRef.current;if(m)send(m.x,m.y)},wait); // so the resting spot is sent
        };
        const onMouseLeave=()=>{mpMouseRef.current=null;clearTimeout(trailing);hideCursor()};
        // A pan or zoom moves the board under a still mouse.
        if(mpMouseRef.current)send(mpMouseRef.current.x,mpMouseRef.current.y);
        el.addEventListener('mousemove',onMouseMove);
        el.addEventListener('mouseleave',onMouseLeave);
        return()=>{el.removeEventListener('mousemove',onMouseMove);el.removeEventListener('mouseleave',onMouseLeave);clearTimeout(trailing)};
    // mpPlayerId: Net starts once it's set, so a "sharing off" hide goes out then.
    },[mpRoomId,mpPlayerId,cellSize,viewX,viewY,uiSettings.cursorSend]);

    // Middle-click pings the cell under the mouse for everyone in the room.
    const lastPingAtRef=useRef(0);
    const handleBoardMouseDown=useCallback(e=>{
        if(e.button!==1||!mpRoomId||!containerRef.current)return;
        e.preventDefault(); // no autoscroll
        if(Date.now()-lastPingAtRef.current<PING_COOLDOWN_MS)return;
        lastPingAtRef.current=Date.now();
        const[wx,wy]=screenToWorld(containerRef.current.getBoundingClientRect(),e.clientX,e.clientY,cellSize,viewX,viewY);
        const x=Math.floor(wx),y=Math.floor(wy);
        const self=mpPlayers[mpPlayerId];
        if(uiSettings.pingQuality!=='off')addPing({x,y,color:uiSettings.myColor||(self&&self.color)||'#5b9bd5',name:mpName||'You'});
        if(typeof Net.sendPing==='function')Net.sendPing(x,y); // sent even with pings off, for the others
    },[mpRoomId,cellSize,viewX,viewY,mpPlayers,mpPlayerId,mpName,addPing,uiSettings.myColor,uiSettings.pingQuality]);

    useEffect(()=>{if(mpName&&Net.isRunning())Net.updateName(mpName)},[mpName]);

    // Our view centre, so other players can jump to what we're looking at.
    useEffect(()=>{
        if(!mpRoomId||!Net.isRunning())return;
        Net.setView(viewX,viewY);
    },[viewX,viewY,mpRoomId]);

    // Shares local hint changes with the room, skipping the ones that just came from the server.
    useEffect(()=>{
        if(!mpRoomId||!mpSyncingRef.current)return;
        const shared={
            wrongFlags:hints.wrongFlags,pulseNeighbors:hints.pulseNeighbors,
            undoEnabled:hints.undoEnabled,undoMode:hints.undoMode,chordFlag:hints.chordFlag,
        };
        const lastSynced=mpLastSyncedHintsRef.current;
        if(lastSynced&&Object.keys(shared).every(k=>shared[k]===lastSynced[k]))return;
        Net.sendHints(shared);
    },[hints,mpRoomId]);

    useEffect(()=>{
        if(!containerRef.current)return;let t;
        const observer=new ResizeObserver(entries=>{clearTimeout(t);t=setTimeout(()=>{
            const{width,height}=entries[0].contentRect;
            if(width>0&&height>0)setContainerSize({w:Math.floor(width),h:Math.floor(height)})},50)});
        observer.observe(containerRef.current);return()=>{observer.disconnect();clearTimeout(t)}},[]);

    useEffect(()=>{const cols=Math.floor(containerSize.w/cellSize),rows=Math.floor(containerSize.h/cellSize);
        if(cols>0&&rows>0)setGridDims({cols,rows})},[containerSize,cellSize]);

    useEffect(()=>{
        const onKeyDown=e=>{
            if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
            const pan={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]};
            if(pan[e.key]){e.preventDefault();const[dx,dy]=pan[e.key];setViewX(v=>v+dx*3);setViewY(v=>v+dy*3);return}
            if(e.key==='Escape'&&viewMode==='Fullscreen'){setViewMode(viewBeforeFullscreenRef.current||'Medium');return}
            if(e.ctrlKey&&(e.key==='='||e.key==='+')){e.preventDefault();setCellSize(s=>Math.min(CELL_SIZE_MAX,s+CELL_SIZE_STEP))}
            if(e.ctrlKey&&e.key==='-'){e.preventDefault();setCellSize(s=>Math.max(CELL_SIZE_MIN,s-CELL_SIZE_STEP))}};
        window.addEventListener('keydown',onKeyDown);return()=>window.removeEventListener('keydown',onKeyDown)},[viewMode]);

    // Zooms around the cursor: the world point under it stays put.
    const handleWheel=useCallback(e=>{
        e.preventDefault();const rect=containerRef.current?.getBoundingClientRect();if(!rect)return;
        const[worldX,worldY]=screenToWorld(rect,e.clientX,e.clientY,cellSize,viewX,viewY);
        const newSize=e.deltaY<0?Math.min(CELL_SIZE_MAX,cellSize+CELL_SIZE_STEP):Math.max(CELL_SIZE_MIN,cellSize-CELL_SIZE_STEP);
        if(newSize===cellSize)return;
        const newCols=Math.floor(rect.width/newSize),newRows=Math.floor(rect.height/newSize);
        const cursorCol=(e.clientX-rect.left-(rect.width-newCols*newSize)/2)/newSize,cursorRow=(e.clientY-rect.top-(rect.height-newRows*newSize)/2)/newSize;
        setCellSize(newSize);setViewX(Math.round(worldX-cursorCol+newCols/2));setViewY(Math.round(worldY-cursorRow+newRows/2))},[cellSize,viewX,viewY]);

    const clearBoard=(seed=activeSeed)=>{runIdRef.current=newRunId();boardRef.current=createBoard(seed,false);bumpBoard();setViewX(0);setViewY(0);setCellSize(uiSettings.defaultCellSize);v1FramesRef.current=null;moveLogRef.current=[];flagMapRef.current={};setShowGameOverModal(false);localStorage.removeItem('minesweeper_save');savedSignatureRef.current=''};
    const startNewGame=seed=>{const s=seed.trim()||randomSeed();setSeedInput(s);setActiveSeed(s);clearBoard(s)};
    const changeView=v=>{if(v==='Fullscreen')viewBeforeFullscreenRef.current=viewMode;setViewMode(v)};

    const undoInfinite=hints.undoEnabled&&hints.undoMode==='infinite';
    const undoStack=hints.undoEnabled&&hints.undoMode==='stack';
    const undoStackCount=Math.max(0,Math.floor(clearedCount/CLEARED_PER_UNDO)+1-undoUsedCount);
    const undoAvailable=hints.undoEnabled&&(
        undoInfinite||
        (undoStack?undoStackCount>0:(clearedAtLastUndo===null||clearedCount-clearedAtLastUndo>=CLEARED_PER_UNDO))
    );
    const clearedUntilNextUndo=undoStack
        ?(CLEARED_PER_UNDO-(clearedCount%CLEARED_PER_UNDO))
        :(clearedAtLastUndo===null?0:Math.max(0,CLEARED_PER_UNDO-(clearedCount-clearedAtLastUndo)));

    const mpIsFounder=!!(mpRoomId&&mpPlayerId&&mpFounderId===mpPlayerId);
    // kind: 'restart' (same seed), 'new' (seed defaults to random), or in a room 'load' (a save's seed and moveLog).
    // Asks first if there's progress to lose. In a room the founder decides alone; anyone else starts a vote.
    const startOver=(kind,seed,loadLog)=>{
        const progressAtStake=moveLogRef.current.length>0&&(!gameOver||undoAvailable);
        const action=kind==='new'?'start a new game with a new seed':kind==='load'?'replace the board with this save file':'restart this board';
        if(!mpRoomId){
            if(progressAtStake&&!confirm(`Are you sure you want to ${action}? Your current progress will be lost.`))return;
            if(kind==='new')startNewGame(seed||randomSeed());else clearBoard();
            return;
        }
        if(!mpSyncingRef.current)return;
        const needsVote=progressAtStake&&!mpIsFounder;
        if(progressAtStake&&!confirm(needsVote
            ?`Start a vote to ${action}? At least 51% of the room must agree.`
            :`Are you sure you want to ${action} for everyone in the room? Current progress will be lost.`))return;
        Net.requestReset(kind,kind==='new'?(seed||randomSeed()):kind==='load'?seed:null,needsVote,loadLog);
        showStatus(needsVote?'Vote started — waiting for the room':'Starting over…');
    };
    // In a room a save file replaces the shared board; loaded locally, the next sync would overwrite it.
    const importIntoRoom=data=>{
        const entries=data&&data.version===3?decodeMoveLog(typeof data.moveLog==='string'?data.moveLog:'')
            :data&&data.version===2&&Array.isArray(data.moveLog)?data.moveLog:null;
        if(!entries){showStatus('This save is too old to load into a room');return}
        // Rooms only take plain seeds; the server would change anything else, and the moves would land on another board.
        const seed=String(data.activeSeed||'');
        if(!/^[A-Za-z0-9_-]{1,32}$/.test(seed)){showStatus("This save's seed can't be used in a room");return}
        const validMoves=entries.filter(m=>Array.isArray(m)&&['r','f','u'].includes(m[0])&&Number.isInteger(m[1])&&Number.isInteger(m[2]));
        startOver('load',seed,encodeMoveLog(validMoves));
    };

    // In a room, someone else's undo can end the game-over, so the modal follows gameOver both ways.
    useEffect(()=>{setShowGameOverModal(!!gameOver)},[gameOver]);

    const addLeaderboardEntry=useCallback(entry=>{
        setLeaderboard(prev=>{
            const others=prev.filter(e=>e.runId!==entry.runId);
            const next=[...others,entry].sort((a,b)=>b.cleared-a.cleared||a.moves-b.moves).slice(0,8);
            try{localStorage.setItem('minesweeper_leaderboard',JSON.stringify(next))}catch(e){console.error('Failed to save leaderboard',e)}
            return next;
        });
    },[]);

    useEffect(()=>{
        if(gameOver){
            if(!leaderboardRecordedRef.current){
                leaderboardRecordedRef.current=true;
                const entry={cleared:clearedCount,flags,moves,seed:activeSeed,date:Date.now(),runId:runIdRef.current};
                setLastEntryDate(entry.date);
                addLeaderboardEntry(entry);
            }
        }else{
            leaderboardRecordedRef.current=false;
        }
    },[gameOver]);

    // Rewrites the reveal that hit the mine as an undone one ('u') and replays.
    const undoLosingMove=useCallback(()=>{
        if(!undoAvailable)return;
        const log=moveLogRef.current,losingIndex=boardRef.current.losingMoveIndex;
        if(losingIndex<0)return;
        const[,x,y]=log[losingIndex];
        // In a room the server rewrites its log too and every client rebuilds; until then applyServerMoves keeps ours.
        if(mpSyncingRef.current)Net.sendMove(['u',x,y]);
        log[losingIndex]=['u',x,y];
        const board=boardFromLog(boardRef.current.seed,log,hints.wrongFlags);
        board.dirty=!!mpRoomId; // an undo can't be taken back off, so the next sync rebuilds from the server's log
        boardRef.current=board;
        flagMapRef.current={};
        v1FramesRef.current=null;
        bumpBoard(Infinity);
        setShowGameOverModal(board.gameOver);
        setMpLoserTag(null);
        showStatus(mpSyncingRef.current?'Undo applied — syncing with room':'Free undo used');
    },[undoAvailable,hints.wrongFlags,showStatus,mpRoomId,bumpBoard]);

    // Hovering a number highlights the cells a chord would open, or with the pulse hint, its hidden neighbours.
    const hoverHighlights=useMemo(()=>{
        const none=NO_HIGHLIGHTS;
        if(!hoveredCell||gameOver)return none;
        const[hx,hy]=hoveredCell,key=`${hx},${hy}`,state=cells[key];
        if(!state||state[0]!=='r')return none;
        const count=+state[1];if(!count)return none;
        let flagged=0;const hidden=[];
        for(const[dx,dy]of NEIGHBOR_OFFSETS){const nkey=`${hx+dx},${hy+dy}`,neighbor=cells[nkey];if(neighbor==='flag')flagged++;else if(!neighbor||neighbor==='quest')hidden.push(nkey)}
        if(flagged===count)return{...none,chordTargets:new Set(hidden),chordCell:key};
        if(hints.pulseNeighbors)return{...none,pulseTargets:new Set(hidden)};
        return none;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    },[hoveredCell,boardVersion,gameOver,hints.pulseNeighbors]); // boardVersion: cells changes in place

    // The first reveal places the minefield (its 3×3 is always safe). In a room a click is journaled, so the next sync
    // can take it back off and put it where the server's order says.
    const revealCell=useCallback((x,y)=>{
        const board=boardRef.current;
        if(!mpRoomId)board.showWrongFlags=!!hints.wrongFlags; // the setting at the click; a room's comes from the server
        const diff=applyMove(board,['r',x,y],!!mpRoomId);
        if(!diff)return;
        moveLogRef.current.push(['r',x,y]);
        if(mpSyncingRef.current)Net.sendMove(['r',x,y]);
        recordV1Frame(v1FramesRef,diff,flagMapRef.current);
        bumpBoard(diff.length);
    },[mpRoomId,hints.wrongFlags,bumpBoard]);

    // Cycles flag, question mark, hidden; or, with the chord-flag hint, flags all of a number's must-be-mine neighbours.
    const flagCell=useCallback((x,y)=>{
        const board=boardRef.current;
        if(!board.length&&!board.firstClick)return; // flags wait for the first reveal, which places the minefield
        const targets=hints.chordFlag?chordFlagTargets(board.cells,x,y):[];
        const entries=targets.length?targets.map(key=>['f',...key.split(',').map(Number)]):[['f',x,y]];
        let changed=false;
        for(const entry of entries){
            const diff=applyMove(board,entry,!!mpRoomId);
            if(!diff)continue;
            changed=true;
            moveLogRef.current.push(entry);
            if(mpSyncingRef.current)Net.sendMove(entry);
            applyDiffToFlags(flagMapRef.current,diff);
        }
        if(changed)bumpBoard();
    },[mpRoomId,hints.chordFlag,bumpBoard]);

    const hoverCell=useCallback((x,y)=>setHoveredCell([x,y]),[]);
    const clearHover=useCallback(()=>setHoveredCell(null),[]);

    const{cols,rows}=gridDims;
    const leftX=viewX-Math.floor(cols/2),topY=viewY-Math.floor(rows/2);
    const gridW=cols*cellSize,gridH=rows*cellSize;
    const zoomPct=Math.round(cellSize/CELL_SIZE_DEFAULT*100);

    const gridCells=useMemo(()=>{
        const out=[];
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
            const x=leftX+col,y=topY+row,key=`${x},${y}`;
            out.push(<Cell key={key} x={x} y={y} state={cells[key]||null} gameOver={gameOver}
                         chordTarget={hoverHighlights.chordTargets.has(key)} chordReady={hoverHighlights.chordCell===key} pulse={hoverHighlights.pulseTargets.has(key)} size={cellSize}
                         onReveal={revealCell} onFlag={flagCell} onHover={hoverCell} onLeave={clearHover}/>)}
        return out;
    // cells changes in place; boardVersion stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    },[leftX,topY,rows,cols,boardVersion,gameOver,cellSize,revealCell,flagCell,hoverCell,clearHover,hoverHighlights]);

    const isFullscreen=viewMode==='Fullscreen';
    // Export progress shows as a toast; a long timelapse's speed picker still needs the modal.
    const showExportToast=!!(exportTask&&!exportTask.plan&&window.ExportProgressToast);
    const containerStyle=isFullscreen?{width:'100vw',height:'calc(100vh - 42px)'}:{width:VIEW_SIZES[viewMode]?.w||800,height:VIEW_SIZES[viewMode]?.h||600,borderRadius:8,border:'1px solid #2a2a4a',boxShadow:'0 4px 30px rgba(0,0,0,.5)'};

    // --- Multiplayer helpers for the header and start menu ---
    // Resolves true only if the link reached the clipboard.
    const copyLink=useCallback(async url=>{
        let copied=false;
        if(navigator.clipboard&&navigator.clipboard.writeText){
            try{await navigator.clipboard.writeText(url);copied=true}catch(e){console.error('Clipboard write failed',e)}
        }
        // navigator.clipboard only exists on https:// and localhost.
        if(!copied){
            const textarea=document.createElement('textarea');
            textarea.value=url;textarea.setAttribute('readonly','');
            textarea.style.cssText='position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(textarea);
            textarea.focus();textarea.select();textarea.setSelectionRange(0,url.length); // setSelectionRange for iOS Safari
            try{copied=document.execCommand('copy')}catch(e){console.error('Legacy copy failed',e)}
            document.body.removeChild(textarea);
        }
        if(copied)showStatus('Invite link copied');
        else window.prompt('Copy this invite link:',url);
        return copied;
    },[showStatus]);
    const handleCopyInvite=useCallback(()=>copyLink(window.location.href),[copyLink]);
    const handleLeaveRoom=useCallback(()=>{window.location.href=window.location.pathname},[]);
    // Creates a room and keeps our founder playerId for it. Resolves to the roomId. An encoded moveLog starts it
    // from an existing board.
    const createRoom=useCallback(async(seed,roomHints,moveLog)=>{
        const res=await fetch('./php/create-room.php',{
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({seed,hints:roomHints,moveLog:moveLog||undefined}),
            cache:'no-store',
        });
        if(!res.ok)throw new Error('HTTP '+res.status);
        const data=await res.json();
        if(!data.roomId)throw new Error('no roomId in response');
        localStorage.setItem('minesweeper_room_'+data.roomId,data.playerId);
        return data.roomId;
    },[]);
    const joinRoom=useCallback(roomId=>{window.location.search='?room='+roomId},[]);

    // --- Start menu actions ---
    const openMenu=step=>setStartMenu({step,closable:true});
    // A new session can start from the board on screen, if its seed survives the server's sanitize_seed() unchanged.
    const menuCurrentGame=moveLogRef.current.length
        ?{moves:moveLogRef.current.length,seed:activeSeed,shareable:/^[A-Za-z0-9_-]{1,32}$/.test(activeSeed)}
        :null;
    const menuStartSingle=(seed,newHints)=>{
        if(mpRoomId){
            // Leaving the room reloads the page, so the new game is queued for after it.
            if(localStorage.getItem('minesweeper_save')&&!confirm('Leave this session and start a new singleplayer game? Your saved singleplayer game will be replaced.'))return;
            localStorage.setItem('minesweeper_pending_start',JSON.stringify({seed,hints:newHints}));
            window.location.href=window.location.pathname;
            return;
        }
        const progressAtStake=moveLogRef.current.length>0&&(!gameOver||undoAvailable);
        if(progressAtStake&&!confirm('Start a new game? Your current progress will be lost.'))return;
        setHints(newHints);
        startNewGame(seed);
        setStartMenu(null);
    };
    const menuCreateSession=(name,seed,roomHints,fromCurrent)=>{
        localStorage.setItem('minesweeper_name',name);setMpName(name);
        return createRoom(seed,roomHints,fromCurrent?encodeMoveLog(moveLogRef.current):null);
    };
    const mpKillerName=useMemo(()=>{
        if(!gameOver||!mpLoserTag)return null;
        for(const pid in mpPlayers){if(pid.startsWith(mpLoserTag))return mpPlayers[pid].name||'Player'}
        return null;
    },[gameOver,mpLoserTag,mpPlayers]);
    const mpKillerIsSelf=!!(mpLoserTag&&mpOwnerTag&&mpLoserTag===mpOwnerTag);
    const handleGoToPlayer=useCallback((x,y)=>{setViewX(Math.round(x));setViewY(Math.round(y))},[]);

    return(
        <div className="flex flex-col items-center" style={{width:'100vw',height:'100vh'}}>
            {startMenu&&<StartModal
                initialStep={startMenu.step}
                hints={hints}
                initialSeed={startMenu.closable?randomSeed():seedInput}
                initialName={mpName}
                currentGame={menuCurrentGame}
                inRoom={!!mpRoomId}
                onStartSingle={menuStartSingle}
                onCreateSession={menuCreateSession}
                onJoinSession={joinRoom}
                onCopyLink={copyLink}
                onCurrent={kind=>{setStartMenu(null);startOver(kind)}}
                onClose={startMenu.closable?()=>setStartMenu(null):undefined}
            />}
            {mpNamePromptOpen&&<NamePromptModal
                initial={mpName}
                onSubmit={n=>{localStorage.setItem('minesweeper_name',n);setMpName(n);setMpNamePromptOpen(false)}}
                onCancel={()=>{setMpNamePromptOpen(false);handleLeaveRoom()}}
            />}
            {showGameOverModal&&<GameOverModal
                undoAvailable={undoAvailable}
                undoInfinite={undoInfinite}
                undoStack={undoStack}
                undoStackCount={undoStackCount}
                videoExporting={videoExporting}
                onUndo={undoLosingMove}
                onRestart={()=>startOver('restart')}
                onNewSeed={()=>startOver('new')}
                onExportImage={()=>exportImage(true)}
                onExportVideo={()=>exportVideo()}
                onClose={()=>setShowGameOverModal(false)}
                leaderboard={leaderboard}
                lastEntryDate={lastEntryDate}
                killerName={mpKillerName}
                killerIsSelf={mpKillerIsSelf}
            />}
            {(mpRoomId||isFullscreen||showExportToast)&&<ToastStack toasts={isFullscreen&&statusToast&&!showExportToast?[...mpToasts,statusToast]:mpToasts} vote={mpRoomId?mpResetVote:null} selfId={mpPlayerId} onVote={(id,yes)=>Net.vote(id,yes)}>
                {showExportToast&&<window.ExportProgressToast key="export" task={exportTask}/>}
            </ToastStack>}
            {showSettings&&<SettingsModal
                hints={hints} setHints={setHints}
                uiSettings={uiSettings} setUiSettings={setUiSettings}
                viewMode={viewMode} changeView={changeView}
                cellSize={cellSize} setCellSize={setCellSize}
                onClose={()=>setShowSettings(false)}
            />}
            {exportTask&&!showExportToast&&!exportTask.result&&window.ExportProgressModal&&<window.ExportProgressModal task={exportTask}/>}
            <div className="hdr" style={{position:'relative',paddingRight:46}}>
                {uiSettings.showLeaderboard&&<LeaderboardDropdown entries={leaderboard} currentScore={clearedCount}/>}
                {mpRoomId
                    ?<>
                        <MultiplayerBadge status={mpStatus} backoff={mpBackoff} onCopyInvite={handleCopyInvite} onLeave={handleLeaveRoom}/>
                        <PlayerListDropdown players={mpPlayers} selfId={mpPlayerId} founderId={mpFounderId} onGoTo={handleGoToPlayer}/>
                    </>
                    :<button className="hb" onClick={()=>openMenu('create')} title="Create a session from this game and invite someone">👥 Play with a friend</button>}
                <div className="flex items-center gap-1">
                    {uiSettings.showSeed&&uiSettings.showSeedBox&&<input className="hi" value={seedInput} onChange={e=>setSeedInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')startOver('new',seedInput)}} placeholder="seed" disabled={!!mpRoomId}/>}
                    <button onClick={()=>openMenu('choose')} className="hb pr" title="New singleplayer or multiplayer game, restart, or new seed">☰ Menu</button>
                    {/* Undo stays reachable after closing the game-over popup to inspect the board. */}
                    {gameOver&&undoAvailable&&<button onClick={undoLosingMove} className="hb pr" title="Undo the move that hit the mine">↩ Undo</button>}
                    {uiSettings.showSeed&&uiSettings.showLockBtn&&<button className={`hb ${seedLocked?'act':''}`} onClick={()=>setSeedLocked(l=>!l)}>{seedLocked?'🔒':'🔓'}</button>}
                </div>
                <GameDropdown onExport={downloadSave} onImport={importSaveFile} onClear={clearSave} onExportImage={exportImage} onExportVideo={exportVideo} videoExporting={videoExporting}/>
                {uiSettings.showZoom&&<div className="flex items-center gap-1">
                    <button className="hb" onClick={()=>setCellSize(s=>Math.max(CELL_SIZE_MIN,s-CELL_SIZE_STEP))}>−</button>
                    <span className="text-gray-400 text-xs w-9 text-center">{zoomPct}%</span>
                    <button className="hb" onClick={()=>setCellSize(s=>Math.min(CELL_SIZE_MAX,s+CELL_SIZE_STEP))}>+</button>
                </div>}
                {uiSettings.showCoords&&<span className="text-gray-500 text-xs">({viewX},{viewY})</span>}
                {uiSettings.showScores&&<>
                    <span className="text-gray-300 text-xs" title="Mines Flagged">🚩{flags}</span>
                    <span className="text-gray-300 text-xs" title="Moves Made">👆{moves}</span>
                    <span className="text-gray-300 text-xs" title="Area Cleared">🟦{clearedCount}</span>
                </>}
                {hints.undoEnabled&&uiSettings.showUndo&&<span className="text-gray-300 text-xs" title={undoInfinite?'Infinite undo enabled':undoStack?`${undoStackCount} undo${undoStackCount===1?'':'s'} banked; ${clearedUntilNextUndo} more cleared until +1`:undoAvailable?'Free undo available':`${clearedUntilNextUndo} more cleared until next free undo`}>↩{undoInfinite?'∞':undoStack?`${undoStackCount} (${clearedUntilNextUndo})`:undoAvailable?1:`0 (${clearedUntilNextUndo})`}</span>}
                {gameOver&&<span className="text-red-400 font-bold text-xs animate-pulse">GAME OVER</span>}
                {uiSettings.showArrows&&<div className="flex gap-0.5">
                    <button onClick={()=>setViewY(v=>v-3)} className="hb px-1">▲</button>
                    <button onClick={()=>setViewX(v=>v-3)} className="hb px-1">◀</button>
                    <button onClick={()=>setViewX(v=>v+3)} className="hb px-1">▶</button>
                    <button onClick={()=>setViewY(v=>v+3)} className="hb px-1">▼</button>
                </div>}
                <button className="hb" title="Settings" style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)'}} onClick={()=>setShowSettings(true)}>⚙</button>
            </div>
            <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',width:'100%',overflow:'hidden'}}>
                <div ref={containerRef} className={'game-container'+(uiSettings.boardFx==='reduced'?' fx-reduced':uiSettings.boardFx==='off'?' fx-off':'')} style={{...containerStyle,position:'relative'}} onContextMenu={e=>e.preventDefault()} onWheel={handleWheel} onMouseDown={handleBoardMouseDown}>
                    {window.BoardGrid?<BoardGrid cols={cols} rows={rows} cellSize={cellSize}>{gridCells}</BoardGrid>
                        :<div style={{display:'grid',gridTemplateColumns:`repeat(${cols},${cellSize}px)`,gridTemplateRows:`repeat(${rows},${cellSize}px)`,width:gridW,height:gridH}}>{gridCells}</div>}
                    {mpRoomId&&window.PingOverlay&&uiSettings.pingQuality!=='off'&&<PingOverlay pings={mpPings} viewX={viewX} viewY={viewY} cellSize={cellSize} containerSize={containerSize} quality={uiSettings.pingQuality}/>}
                    {mpRoomId&&uiSettings.cursorSee!=='off'&&<CursorOverlay players={mpPlayers} selfId={mpPlayerId} viewX={viewX} viewY={viewY} cellSize={cellSize} containerSize={containerSize} glideMs={CURSOR_GLIDE_MS[uiSettings.cursorSee]??120}/>}
                </div>
            </div>
            {!isFullscreen&&<div className="text-xs py-1" style={{color:'#9ca3af'}}>WASD/Arrows pan · Scroll zoom · Right-click flag{mpRoomId&&' · Middle-click ping'} · Click numbers to chord · First click always safe{status&&<span style={{color:'#c4b5fd',marginLeft:8}}>{status}</span>}</div>}
        </div>);
}

// The service worker falls back to its cache file by file, so a slow load can pair this app.js with an older game.js.
if(typeof window.createBoard==='function')ReactDOM.render(<App/>,document.getElementById('root'));
else{
    let reloaded=false;try{reloaded=sessionStorage.getItem('minesweeper_stale_reload')==='1';sessionStorage.setItem('minesweeper_stale_reload','1')}catch(e){}
    if(!reloaded)location.reload();
    else ReactDOM.render(<div style={{color:'#ccc',padding:24,textAlign:'center'}}>InfiniSweeper is updating. Refresh the page in a moment.</div>,document.getElementById('root'));
}
try{if(typeof window.createBoard==='function')sessionStorage.removeItem('minesweeper_stale_reload')}catch(e){}
