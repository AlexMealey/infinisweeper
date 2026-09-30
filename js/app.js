// app.js – App component and ReactDOM render (JSX, processed by Babel)
const{useState,useCallback,useMemo,useEffect,useRef}=React;

function App(){
    const initS=getURLSeed()||rndSeed();
    const[seedStr,setSeedStr]=useState(initS);
    const[activeSeed,setActiveSeed]=useState(initS);
    const[locked,setLocked]=useState(!!getURLSeed());
    // View size is a per-browser preference, kept apart from game saves so it survives refreshes
    // in multiplayer rooms and on boards with no moves yet (neither writes minesweeper_save).
    const[viewMode,setViewMode]=useState(()=>{
        const ok=v=>v==='Fullscreen'||VIEWS.hasOwnProperty(v);
        try{
            const v=localStorage.getItem('minesweeper_view');if(ok(v))return v;
            // Older builds only kept the view inside the game save.
            const s=JSON.parse(localStorage.getItem('minesweeper_save')||'null');if(s&&ok(s.viewMode))return s.viewMode;
        }catch(e){console.error('Failed to read saved view mode',e)}
        return'Large'});
    const[cellSize,setCellSize]=useState(ZDEF);
    const[viewX,setViewX]=useState(0);
    const[viewY,setViewY]=useState(0);
    const[cells,setCells]=useState({});
    const[gameOver,setGameOver]=useState(false);
    const[moves,setMoves]=useState(0);
    const[flags,setFlags]=useState(0);
    const[hover,setHover]=useState(null);
    const[gridDims,setGridDims]=useState({cols:20,rows:15});
    const[containerSize,setContainerSize]=useState({w:800,h:600});
    const[firstClick,setFirstClick]=useState(null);
    const[hints,setHints]=useState(()=>{try{const s=localStorage.getItem('minesweeper_hints');if(s)return migrateHints(JSON.parse(s))}catch(e){console.error('Failed to read saved hints',e)}return{wrongFlags:false,pulseNeighbors:false,undoEnabled:false,undoMode:'refill',chordFlag:false}});
    const dfltUI={showArrows:true,showScores:true,showLeaderboard:true,showUndo:true,showZoom:true,showCoords:true,showSeed:true,showSeedBox:true,showLockBtn:true,defaultCellSize:ZDEF,exportRes:'auto',tlMovesPerFrame:1,tlFps:60,tlRes:'auto'};
    const[uiSettings,setUiSettings]=useState(()=>{try{const s=localStorage.getItem('minesweeper_ui');if(s)return{...dfltUI,...JSON.parse(s)}}catch(e){console.error('Failed to read saved UI settings',e)}return dfltUI});
    const[showSettings,setShowSettings]=useState(false);
    const[status,setStatus]=useState('');
    const[videoExporting,setVideoExporting]=useState(false);
    const[clearedAtLastUndo,setClearedAtLastUndo]=useState(null);
    const[undoUsedCount,setUndoUsedCount]=useState(0);
    const[showGameOverModal,setShowGameOverModal]=useState(false);
    const[leaderboard,setLeaderboard]=useState(()=>{
        try{const s=localStorage.getItem('minesweeper_leaderboard');const arr=s?JSON.parse(s):[];return Array.isArray(arr)?arr:[]}catch(e){console.error('Failed to read saved leaderboard',e);return[]}
    });
    const[lastEntryDate,setLastEntryDate]=useState(null);
    const leaderboardRecordedRef=useRef(false);
    const runIdRef=useRef(genRunId());
    // null: the timelapse is rebuilt from moveLogRef. An array only for version 1 saves, which have no move log.
    const timelapseRef=useRef(null);
    const moveLogRef=useRef([]);
    const curFlagsRef=useRef({});
    const clearedCount = useMemo(() => Object.values(cells).filter(s => s && s[0] === 'r').length, [cells]);
    const totalArea = useMemo(() => {
        const keys = Object.keys(cells);
        if (keys.length === 0) return 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        keys.forEach(k => {
            const [x, y] = k.split(',').map(Number);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        });
        return (maxX - minX + 1) * (maxY - minY + 1);
    }, [cells]);
    const containerRef=useRef(null);
    const prevMode=useRef('Medium');
    const fcProcessed=useRef(false);

    // --- Multiplayer state ---
    // roomId comes from ?room= in the URL. Everything else stays inert in single-player mode.
    const mpRoomId=useMemo(()=>new URLSearchParams(window.location.search).get('room'),[]);
    // playerId is state (not a ref) so the Net-start effect re-runs once it's assigned.
    const[mpPlayerId,setMpPlayerId]=useState(null);
    const mpSelfIdShort=useMemo(()=>mpPlayerId?mpPlayerId.slice(0,8):null,[mpPlayerId]);
    const[mpName,setMpName]=useState(()=>localStorage.getItem('minesweeper_name')||'');
    const[mpNamePromptOpen,setMpNamePromptOpen]=useState(!!mpRoomId&&!localStorage.getItem('minesweeper_name'));
    // Start menu: {step, closable} or null. Opens by itself on a fresh visit (not in a room, no saved
    // game to restore, no singleplayer start queued from a room), and from the header's Menu button.
    const[startMenu,setStartMenu]=useState(()=>{
        const fresh={step:'choose',closable:false};
        if(mpRoomId||localStorage.getItem('minesweeper_pending_start'))return null;
        try{
            const s=JSON.parse(localStorage.getItem('minesweeper_save')||'null');
            if(s&&(s.version===1?s.cells&&Object.keys(s.cells).length:s.moveLog&&s.moveLog.length))return null;
        }catch(e){console.error('Failed to read saved game',e)}
        return fresh});
    const[mpPlayers,setMpPlayers]=useState({});
    const[mpStatus,setMpStatus]=useState('connecting');
    // Canonical, server-ordered move log for this room. Rebuilt state comes from replaying this.
    const mpCanonicalMovesRef=useRef([]);
    // Parallel array of owner tags (first 8 hex of playerId) — used only for game-over attribution.
    const mpMoveOwnersRef=useRef([]);
    // Guards local move handlers from calling into Net before it's actually started.
    const mpNetActiveRef=useRef(false);
    // Owner tag (short pid) of whoever triggered the current gameOver, or null.
    const[mpGameOverBy,setMpGameOverBy]=useState(null);
    // Last hints snapshot received from the server — see the hint-sync effect below.
    const mpLastSyncedHintsRef=useRef(null);
    // Backoff signal from Net.js (populated only while sync is failing).
    const[mpBackoff,setMpBackoff]=useState(null);
    // Room creator's playerId — they can start over without a vote.
    const[mpFounderId,setMpFounderId]=useState(null);
    // Open (or just-resolved) start-over vote from the server, or null.
    const[mpResetVote,setMpResetVote]=useState(null);
    // Last server round seen; a change means the room started over. null until the first sync.
    const mpRoundRef=useRef(null);
    // Top-right notices about what other players did ("Alex used an undo").
    const[mpToasts,setMpToasts]=useState([]);
    const mpToastIdRef=useRef(0);
    // Highest room event seq already handled; null until the first sync.
    const mpEventSeqRef=useRef(null);
    const pushToast=useCallback(text=>{
        const id=++mpToastIdRef.current;
        setMpToasts(ts=>[...ts.slice(-3),{id,text}]);
        setTimeout(()=>setMpToasts(ts=>ts.filter(t=>t.id!==id)),5000);
    },[]);

    const lastSave=useRef('');
    const lastSaveSig=useRef('');
    const sigOfState=s=>{
        const ml=typeof s.moveLog==='string'?s.moveLog.length:(Array.isArray(s.moveLog)?s.moveLog.length:0);
        return ml+'|'+s.activeSeed+'|'+s.locked+'|'+s.viewMode+'|'+s.cellSize+'|'+s.viewX+'|'+s.viewY+'|'+JSON.stringify(s.hints);
    };

    useEffect(()=>{try{localStorage.setItem('minesweeper_hints',JSON.stringify(hints))}catch(e){console.error('Failed to save hints',e)}},[hints]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_ui',JSON.stringify(uiSettings))}catch(e){console.error('Failed to save UI settings',e)}},[uiSettings]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_view',viewMode)}catch(e){console.error('Failed to save view mode',e)}},[viewMode]);

    const showStatus=useCallback(msg=>setStatus(msg),[]);

    const getGameState=useCallback(()=>({
        version:3,activeSeed,locked,viewMode,cellSize,viewX,viewY,hints,moveLog:encodeMoveLog(moveLogRef.current),timestamp:Date.now(),runId:runIdRef.current
    }),[activeSeed,locked,viewMode,cellSize,viewX,viewY,hints,cells,gameOver,moves,flags,firstClick]);

    // Saves still carry viewMode, but it's ignored here — the minesweeper_view preference wins.
    const loadGameState=useCallback(data=>{
        if(!data)return false;
        if(data.version===3||data.version===2){
            const log=data.version===3
                ?decodeMoveLog(typeof data.moveLog==='string'?data.moveLog:'')
                :(Array.isArray(data.moveLog)?data.moveLog.slice():[]);
            setActiveSeed(data.activeSeed);setSeedStr(data.activeSeed);setLocked(data.locked);
            setCellSize(data.cellSize);setViewX(data.viewX);setViewY(data.viewY);
            setHints(migrateHints(data.hints));
            runIdRef.current=data.runId||genRunId();
            moveLogRef.current=log;
            timelapseRef.current=null;
            const out=replayMoveLog(data.activeSeed,log,!!(data.hints&&data.hints.wrongFlags),null);
            curFlagsRef.current=out.finalFlags;
            setCells(out.cells);setMoves(out.moves);setFlags(out.flags);setGameOver(out.gameOver);setFirstClick(out.firstClick);
            setClearedAtLastUndo(out.clearedAtLastUndo);
            setUndoUsedCount(out.undoUsedCount);
            setShowGameOverModal(!!out.gameOver);
            fcProcessed.current=log.length>0;
            return true;
        }
        if(data.version===1){
            setActiveSeed(data.activeSeed);setSeedStr(data.activeSeed);setLocked(data.locked);
            setCellSize(data.cellSize);setViewX(data.viewX);setViewY(data.viewY);
            setCells(data.cells);setGameOver(data.gameOver);setMoves(data.moves);setFlags(data.flags);
            setFirstClick(data.firstClick);setHints(migrateHints(data.hints));
            runIdRef.current=data.runId||genRunId();
            fcProcessed.current=!!(data.cells&&Object.keys(data.cells).length>0);
            moveLogRef.current=[];
            const flagsNow=extractFlags(data.cells||{});
            curFlagsRef.current=flagsNow;
            timelapseRef.current=(data.cells&&Object.keys(data.cells).length>0)?[{diff:Object.entries(data.cells),flags:flagsNow}]:null;
            setClearedAtLastUndo(null);
            setUndoUsedCount(0);
            setShowGameOverModal(!!data.gameOver);
            return true;
        }
        return false;
    },[]);

    const handleExport=()=>{
        const state=getGameState();
        const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob);const a=document.createElement('a');
        const date=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
        a.href=url;a.download=`${date}-minesweeper-save.json`;a.click();
        URL.revokeObjectURL(url);
        lastSave.current=JSON.stringify(state);
        lastSaveSig.current=sigOfState(state);
        showStatus('Save file downloaded')};

    const handleImport=e=>{
        const file=e.target.files[0];if(!file)return;
        const reader=new FileReader();
        reader.onload=ev=>{
            try{const data=JSON.parse(ev.target.result);
                if(mpRoomId){importIntoRoom(data);return}
                if(data.version===1||data.version===2||data.version===3){
                    if(moves>0&&!confirm('Overwrite current progress?'))return;
                    if(loadGameState(data)){
                        lastSave.current=JSON.stringify(data);
                        lastSaveSig.current=sigOfState(data);
                        showStatus('Save file loaded successfully');
                    }else showStatus('Invalid save file')}
                else showStatus('Incompatible save version')}
            catch(err){console.error('Failed to import save file',err);showStatus('Invalid save file')}};
        reader.onerror=()=>{console.error('Failed to read save file',reader.error);showStatus('Could not read file')};
        reader.readAsText(file);e.target.value=''};

    const clearSave=()=>{localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current='';showStatus('Cache cleared')};

    // The original full-canvas export. Still used when mapimage.js didn't load, the browser lacks CompressionStream, or the streamed export fails.
    const exportImageCanvas=(withStats,sz)=>{
        const keys=Object.keys(cells);
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        keys.forEach(k=>{const[x,y]=k.split(',').map(Number);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)});
        const pad=2;
        minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
        const w=maxX-minX+1,h=maxY-minY+1;
        const gridH=h*sz, footerH=withStats?Math.round(gridH*0.04/0.96):0;
        const canvasW=w*sz, canvasH=gridH+footerH;
        if(canvasW*canvasH>16000000){if(!confirm('The exported image will be very large. Continue?'))return}
        const canvas=document.createElement('canvas');canvas.width=canvasW;canvas.height=canvasH;
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,canvasW,canvasH);
        for(let y=minY;y<=maxY;y++){
            for(let x=minX;x<=maxX;x++){
                drawCellToCanvas(ctx,cells[`${x},${y}`],(x-minX)*sz,(y-minY)*sz,sz);}}
        if(withStats && footerH > 0){
            ctx.fillStyle='#111128';ctx.fillRect(0,canvasH-footerH,canvasW,footerH);
            ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1, Math.round(footerH/48));ctx.strokeRect(0,canvasH-footerH,canvasW,footerH);
            const fs=Math.round(footerH*0.3), emojiFs=Math.round(footerH*0.35);
            ctx.font=`bold ${fs}px sans-serif`;ctx.textAlign='left';ctx.textBaseline='middle';
            let ox=footerH*0.4;
            const draw=(l,i,v)=>{
                ctx.fillStyle='#aaa';ctx.font=`bold ${fs}px sans-serif`;ctx.fillText(l,ox,canvasH-footerH/2);ox+=ctx.measureText(l).width+footerH*0.1;
                ctx.font=`${emojiFs}px serif`;ctx.fillText(i,ox,canvasH-footerH/2);ox+=footerH*0.45;
                ctx.fillStyle='#fff';ctx.font=`bold ${fs}px sans-serif`;ctx.fillText(v,ox,canvasH-footerH/2);
                ox+=ctx.measureText(v).width+footerH*0.6};
            draw('Mines Flagged:','🚩',flags);
            draw('Moves Made:','👆',moves);
            draw('Squares Cleared:','🟦',`${clearedCount}`);
        }
        const link=document.createElement('a');link.download=`minesweeper-seed-${activeSeed}-run.png`;
        link.href=canvas.toDataURL('image/png');link.click();showStatus('Progress image exported')};
    const[exportTask,setExportTask]=useState(null);
    // Progress goes through a tiny store that ExportProgressModal subscribes to, so ticks don't re-render the board.
    const beginExportTask=(kind,title)=>{
        let v={},resolvePlan=null,timer=null;const subs=new Set(),ctrl=new AbortController();
        const task={kind,title,startedAt:Date.now(),plan:null,
            progress:{get:()=>v,set:x=>{v={...v,...x};subs.forEach(f=>f(v))},sub:f=>{subs.add(f);return()=>{subs.delete(f)}}},
            cancel:()=>{if(resolvePlan){resolvePlan(false);resolvePlan=null}ctrl.abort()},
            start:n=>{if(resolvePlan){resolvePlan({movesPerFrame:n});resolvePlan=null}setExportTask(t=>t&&{...t,plan:null})}};
        // Opened after 300ms so quick exports don't flash it. Absent if components.js is from an older build.
        const hasModal=!!window.ExportProgressModal;
        if(hasModal)timer=setTimeout(()=>setExportTask(task),300);
        return{signal:ctrl.signal,onProgress:x=>task.progress.set(x),hasModal,
            askPlan:pl=>new Promise(r=>{resolvePlan=r;clearTimeout(timer);setExportTask({...task,plan:pl})}),
            end:()=>{clearTimeout(timer);setExportTask(null)}};
    };
    const imageExportingRef=useRef(false);
    const handleExportImage=async(withStats=true)=>{
        if(imageExportingRef.current)return;
        if(Object.keys(cells).length===0){showStatus('No progress to export');return}
        const res=uiSettings.exportRes||'auto';
        const canvasExport=()=>{try{exportImageCanvas(withStats,res==='auto'?32:Math.max(1,Math.min(32,parseInt(res,10)||32)))}
            catch(err){console.error('Canvas image export failed',err);showStatus('Image export failed: '+(err&&err.message?err.message:'unknown error'))}};
        if(!window.MapImage||!window.CompressionStream){canvasExport();return}
        imageExportingRef.current=true;showStatus('Exporting image…');
        const ex=beginExportTask('image','Exporting image');
        try{
            const stats=withStats?{flags,moves,cleared:clearedCount}:null;
            const out=await MapImage.render(cells,stats,res,bytes=>confirm(`The exported image will be about ${Math.ceil(bytes/1e6)} MB. Continue?`),undefined,{signal:ex.signal,onProgress:ex.onProgress});
            if(!out){showStatus('Image export cancelled');return}
            const url=URL.createObjectURL(out.blob);
            const link=document.createElement('a');link.download=`minesweeper-seed-${activeSeed}-run.png`;link.href=url;link.click();
            setTimeout(()=>URL.revokeObjectURL(url),10000);
            const kb=out.blob.size/1e3;showStatus(`Progress image exported (${kb<1000?Math.ceil(kb)+' KB':(kb/1e3).toFixed(1)+' MB'}, ${out.sz}px per cell)`);
        }catch(err){
            if(err&&err.name==='AbortError'){showStatus('Image export cancelled');return}
            console.error('Image export failed, falling back to canvas export',err);canvasExport()}
        finally{imageExportingRef.current=false;ex.end()}};

    const fmtDuration=sec=>{const t=Math.round(sec);return`${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`};
    // Frames for the in-memory exporter: version 1 saves carry their own, otherwise replay the move log.
    const legacyVideoFrames=()=>{
        if(Array.isArray(timelapseRef.current)&&timelapseRef.current.length)return timelapseRef.current;
        const ref={current:[]};replayMoveLog(activeSeed,moveLogRef.current,hints.wrongFlags,ref);return ref.current};
    // The original exporter, which holds every frame and the whole file in memory.
    // Still used when timelapse.js didn't load, or its streamed export fails.
    const exportVideoInMemory=async moveFrames=>{
        if(!moveFrames.length){showStatus('No progress to export');return}
        if(typeof window.VideoEncoder==='undefined'||typeof window.VideoFrame==='undefined'||typeof window.Mp4Muxer==='undefined'){
            showStatus('Video export needs a browser with WebCodecs (try Chrome or Edge)');return}
        if(moveFrames.length>4000&&!confirm(`This timelapse has ${moveFrames.length} moves and may take a while to encode. Continue?`))return;

        setVideoExporting(true);showStatus('Preparing timelapse…');
        try{
            const finalCells={};
            for(const frame of moveFrames){
                for(const[k,v]of frame.diff)finalCells[k]=v;
                for(const k in frame.flags)if(!(k in finalCells))finalCells[k]=frame.flags[k];
            }
            const keys=Object.keys(finalCells);
            let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
            keys.forEach(k=>{const[x,y]=k.split(',').map(Number);if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y});
            const pad=2;minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
            const w=maxX-minX+1,h=maxY-minY+1;

            const maxDim=1400;
            let sz=24;
            if(w*sz>maxDim||h*sz>maxDim)sz=Math.max(4,Math.floor(maxDim/Math.max(w,h)));
            const footerH=Math.max(48,Math.round(h*sz*0.04/0.96));
            let canvasW=Math.max(480,w*sz), canvasH=Math.max(480,h*sz+footerH);
            if(canvasW%2)canvasW++;
            if(canvasH%2)canvasH++;

            const codecCandidates=[
                {type:'avc',codec:'avc1.4d0028'},{type:'avc',codec:'avc1.42001f'},{type:'avc',codec:'avc1.64001f'}
            ];
            let chosen=null;
            for(const c of codecCandidates){
                try{const support=await VideoEncoder.isConfigSupported({codec:c.codec,width:canvasW,height:canvasH});
                    if(support&&support.supported){chosen=c;break}}catch(e){console.error('Codec support check failed for',c.codec,e)}}
            if(!chosen){showStatus('This device cannot encode H.264/H.265 video');setVideoExporting(false);return}

            const canvas=document.createElement('canvas');canvas.width=canvasW;canvas.height=canvasH;
            const ctx=canvas.getContext('2d');
            ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,canvasW,canvasH);
            for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)drawCellToCanvas(ctx,null,(x-minX)*sz,(y-minY)*sz,sz);

            const muxer=new Mp4Muxer.Muxer({
                target:new Mp4Muxer.ArrayBufferTarget(),
                video:{codec:chosen.type,width:canvasW,height:canvasH},
                fastStart:'in-memory'
            });
            const videoEncoder=new VideoEncoder({
                output:(chunk,meta)=>muxer.addVideoChunk(chunk,meta),
                error:e=>console.error('Timelapse encode error',e)
            });
            const bitrate=Math.round(Math.min(8000000,Math.max(350000,canvasW*canvasH*5)));
            const fps=60;
            videoEncoder.configure({codec:chosen.codec,width:canvasW,height:canvasH,bitrate,framerate:fps});

            const frameDurationUs=Math.round(1e6/fps), total=moveFrames.length;
            let prevFlags={};
            let clearedRunning=0;
            for(let i=0;i<total;i++){
                const{diff,flags:curFlags}=moveFrames[i];
                const diffKeys=new Set();
                for(const[k,v]of diff){
                    diffKeys.add(k);
                    if(v&&v[0]==='r')clearedRunning++;
                    const[cx,cy]=k.split(',').map(Number);
                    if(cx>=minX&&cx<=maxX&&cy>=minY&&cy<=maxY)drawCellToCanvas(ctx,v,(cx-minX)*sz,(cy-minY)*sz,sz);
                }
                const flagKeys=new Set([...Object.keys(prevFlags),...Object.keys(curFlags)]);
                for(const k of flagKeys){
                    if(diffKeys.has(k)||curFlags[k]===prevFlags[k])continue;
                    const[fx,fy]=k.split(',').map(Number);
                    if(fx>=minX&&fx<=maxX&&fy>=minY&&fy<=maxY)drawCellToCanvas(ctx,curFlags[k]||null,(fx-minX)*sz,(fy-minY)*sz,sz);
                }
                prevFlags=curFlags;
                let flaggedRunning=0;
                for(const k in curFlags)if(curFlags[k]!=='quest')flaggedRunning++;
                drawFooterHUD(ctx,canvasW,canvasH,footerH,i+1,total,clearedRunning,flaggedRunning);
                const frame=new VideoFrame(canvas,{timestamp:i*frameDurationUs,duration:frameDurationUs});
                videoEncoder.encode(frame,{keyFrame:i===0});
                frame.close();
                if(videoEncoder.encodeQueueSize>4)await new Promise(r=>setTimeout(r,0));
                if(i%25===0||i===total-1){showStatus(`Encoding timelapse… ${i+1}/${total}`);await new Promise(r=>setTimeout(r,0))}
            }
            for(let j=0;j<fps;j++){
                const frame=new VideoFrame(canvas,{timestamp:(total+j)*frameDurationUs,duration:frameDurationUs});
                videoEncoder.encode(frame);frame.close();
            }

            await videoEncoder.flush();
            muxer.finalize();
            const{buffer}=muxer.target;
            const blob=new Blob([buffer],{type:'video/mp4'});
            const url=URL.createObjectURL(blob);
            const a=document.createElement('a');
            const date=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
            a.href=url;a.download=`${date}-minesweeper-seed-${activeSeed}-timelapse.mp4`;a.click();
            URL.revokeObjectURL(url);
            showStatus('Timelapse video exported');
        }catch(err){
            console.error(err);
            showStatus('Video export failed: '+(err&&err.message?err.message:'unknown error'));
        }finally{
            setVideoExporting(false);
        }
    };
    const handleExportVideo=async()=>{
        if(videoExporting)return;
        const v1Frames=Array.isArray(timelapseRef.current)&&timelapseRef.current.length?timelapseRef.current:null;
        if(!v1Frames&&!moveLogRef.current.length){showStatus('No progress to export');return}
        if(typeof window.VideoEncoder==='undefined'||typeof window.VideoFrame==='undefined'||typeof window.Mp4Muxer==='undefined'){
            showStatus('Video export needs a browser with WebCodecs (try Chrome or Edge)');return}
        if(!window.Timelapse||!Mp4Muxer.StreamTarget){await exportVideoInMemory(legacyVideoFrames());return}
        setVideoExporting(true);showStatus('Preparing timelapse…');
        const ex=beginExportTask('video','Exporting timelapse');
        let failed=null,wake=null;
        // Long exports run for minutes; stop the screen sleeping (and pausing the tab) meanwhile.
        try{if(navigator.wakeLock)wake=await navigator.wakeLock.request('screen')}catch(e){console.error('Screen wake lock unavailable',e)}
        try{
            // In multiplayer moveLogRef is the room's full log from the server, with every player's moves.
            const src=v1Frames?{frames:v1Frames}:{seed:activeSeed,moveLog:moveLogRef.current.slice(),wrongFlags:!!hints.wrongFlags};
            // Over 4000 frames the modal first offers a faster speed; without it, fall back to a confirm().
            const out=await Timelapse.render(src,{fps:uiSettings.tlFps,movesPerFrame:uiSettings.tlMovesPerFrame,res:uiSettings.tlRes},{
                signal:ex.signal,onProgress:ex.onProgress,
                confirmPlan:pl=>pl.frames<=4000||(ex.hasModal?ex.askPlan(pl):confirm(`This timelapse is ${fmtDuration(pl.seconds)} long (${pl.moves} moves) and may take a while to encode. Continue?`))});
            if(!out)showStatus('Timelapse export cancelled');
            else if(out.empty)showStatus('No progress to export');
            else{
                const url=URL.createObjectURL(out.blob);
                const a=document.createElement('a');
                const date=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
                a.href=url;a.download=`${date}-minesweeper-seed-${activeSeed}-timelapse.mp4`;a.click();
                setTimeout(()=>URL.revokeObjectURL(url),60000);
                showStatus(`Timelapse video exported (${fmtDuration(out.seconds)}, ${out.width}×${out.height}, ${(out.blob.size/1e6).toFixed(1)} MB)`);
            }
        }catch(err){failed=err}
        finally{setVideoExporting(false);ex.end();if(wake)wake.release().catch(e=>console.error('Screen wake lock release failed',e))}
        if(failed){console.error('Timelapse export failed, retrying with the in-memory exporter',failed);await exportVideoInMemory(legacyVideoFrames())}
    };

    useEffect(()=>{
        // In multiplayer mode, initial state comes from sync.php, not localStorage.
        if(mpRoomId)return;
        // A singleplayer game started from the menu inside a room, carried across the page load.
        let pending=null;
        try{pending=JSON.parse(localStorage.getItem('minesweeper_pending_start')||'null')}catch(e){console.error('Failed to read pending start',e)}
        if(pending){
            localStorage.removeItem('minesweeper_pending_start');
            if(pending.hints)setHints(migrateHints(pending.hints));
            applySeed(typeof pending.seed==='string'?pending.seed:'');
            return;
        }
        const saved=localStorage.getItem('minesweeper_save');
        if(saved){try{const data=JSON.parse(saved);if(data&&(data.version===1||data.version===2||data.version===3)){if(loadGameState(data)){lastSave.current=saved;lastSaveSig.current=sigOfState(data);showStatus('Progress restored')}}}catch(e){console.error('Failed to restore saved game',e)}}
    },[loadGameState,showStatus,mpRoomId]);

    useEffect(()=>{
        // Skip localStorage auto-save in multiplayer — the server holds canonical state and
        // reloading in a room re-syncs from there. Auto-saving would race with sync rebuilds.
        if(mpRoomId)return;
        const t=setTimeout(()=>{
            const state=getGameState();
            if(!state.moveLog)return;
            const sig=sigOfState(state);
            if(sig===lastSaveSig.current)return;
            const stateStr=JSON.stringify(state);
            localStorage.setItem('minesweeper_save',stateStr);
            lastSave.current=stateStr;
            lastSaveSig.current=sig;
            showStatus('Progress auto-saved');
        },1200);
        return()=>clearTimeout(t)},[getGameState,showStatus,mpRoomId]);

    const seedNum=useMemo(()=>hashSeed(activeSeed),[activeSeed]);
    const checker=useMemo(()=>mkChecker(seedNum,firstClick),[seedNum,firstClick]);

    useEffect(()=>{
        // Don't overwrite ?room=... in the URL with ?seed=... — the room is the active identifier here.
        if(mpRoomId)return;
        setURL(activeSeed);
    },[activeSeed,mpRoomId]);

    // --- Multiplayer: assign a stable playerId for this room ---
    useEffect(()=>{
        if(!mpRoomId){setMpPlayerId(null);return}
        const key='minesweeper_room_'+mpRoomId;
        let pid=localStorage.getItem(key);
        // Same rule as the server's valid_id(). Also replaces non-hex ids stored by older builds,
        // which the server rejects with 400 forever.
        if(!pid||!/^[a-f0-9]{16,64}$/.test(pid)){
            // 16 hex chars is enough — server tags moves with the first 8 for attribution.
            // getRandomValues, not randomUUID: randomUUID only exists on HTTPS/localhost.
            pid=Array.from(crypto.getRandomValues(new Uint8Array(8)),b=>b.toString(16).padStart(2,'0')).join('');
            localStorage.setItem(key,pid);
        }
        setMpPlayerId(pid);
    },[mpRoomId]);

    // --- Multiplayer: apply authoritative state from the server ---
    // Two shapes:
    //   (a) tail delta — newMoves is a list of entries to append to our canonical log.
    //   (b) full rebuild — server sent moveLog + moveOwners because logRevision jumped
    //       (an undo rewrote past entries and our tail cache is invalid).
    // Either way we replay the canonical log to derive cells/moves/flags/firstClick/gameOver
    // via the exact same path used for load-from-save.
    const applyServerMoves=useCallback((seed,data,wrongFlags)=>{
        const{newMoves,moveLog,moveOwners}=data;
        let changed=false;
        if(typeof moveLog==='string'){
            // Full rebuild path.
            mpCanonicalMovesRef.current=decodeMoveLog(moveLog);
            // moveOwners is parallel to canonical moves; split by ';' and preserve empty
            // slots so indices line up. An empty input becomes [] (not ['']).
            const trimmed=(typeof moveOwners==='string')?moveOwners.replace(/;$/,''):'';
            mpMoveOwnersRef.current=trimmed.length===0?[]:trimmed.split(';');
            changed=true;
        }else if(newMoves&&newMoves.length){
            for(const m of newMoves){
                if(!m||m.length<3)continue;
                mpCanonicalMovesRef.current.push([m[0],m[1],m[2]]);
                mpMoveOwnersRef.current.push(m[3]||'');
            }
            changed=true;
        }
        if(!changed)return;
        // Our clicks made while this sync was in flight aren't in the server's log yet. Lay them on
        // top (the server appends them in this same order next sync) so our own moves never blink out.
        const canonical=mpCanonicalMovesRef.current.slice();
        const owners=mpMoveOwnersRef.current.slice();
        for(const m of Net.pendingMoves()){
            if(m[0]==='u'){
                // Same rule as sync.php: rewrite the latest reveal at that cell, unless it's already undone.
                for(let i=canonical.length-1;i>=0;i--){
                    const c=canonical[i];
                    if((c[0]==='r'||c[0]==='u')&&c[1]===m[1]&&c[2]===m[2]){if(c[0]==='r')canonical[i]=['u',m[1],m[2]];break}
                }
            }else{canonical.push([m[0],m[1],m[2]]);owners.push(m[3])}
        }
        const out=replayMoveLog(seed,canonical,!!wrongFlags,null);
        curFlagsRef.current=out.finalFlags;
        timelapseRef.current=null;
        moveLogRef.current=canonical;
        setCells(out.cells);
        setMoves(out.moves);
        setFlags(out.flags);
        setGameOver(out.gameOver);
        setFirstClick(out.firstClick);
        setClearedAtLastUndo(out.clearedAtLastUndo);
        setUndoUsedCount(out.undoUsedCount);
        fcProcessed.current=out.firstClick!==null;
        // Attribution: whoever made the last 'r' entry in the canonical log caused this game-over.
        if(out.gameOver){
            let idx=-1;
            for(let i=canonical.length-1;i>=0;i--){if(canonical[i][0]==='r'){idx=i;break}}
            setMpGameOverBy(idx>=0?(owners[idx]||''):'');
        }else{
            setMpGameOverBy(null);
        }
    },[]);

    // --- Multiplayer: start the sync loop once we have a room + name + player id ---
    useEffect(()=>{
        if(!mpRoomId||!mpName||!mpPlayerId)return;
        mpNetActiveRef.current=true;
        mpRoundRef.current=null;
        mpEventSeqRef.current=null;
        Net.start({
            roomId:mpRoomId,
            playerId:mpPlayerId,
            name:mpName,
            onStatus:s=>{setMpStatus(s);if(s==='connected')setMpBackoff(null)},
            onBackoff:info=>setMpBackoff(info),
            onSync:data=>{
                if(data.players)setMpPlayers(data.players);
                setMpFounderId(data.founderId||null);
                setMpResetVote(data.resetVote||null);
                if(typeof data.round==='number'){
                    // Someone started over. The replay below clears the board; this covers the
                    // per-run bits it doesn't: a fresh leaderboard run and a recentred view.
                    if(mpRoundRef.current!==null&&data.round!==mpRoundRef.current){
                        runIdRef.current=genRunId();
                        setViewX(0);setViewY(0);
                        showStatus('New round started');
                    }
                    mpRoundRef.current=data.round;
                }
                if(Array.isArray(data.events)){
                    // Announce each of the other players' actions once. The server only sends the
                    // last few seconds of events; ones already there when we joined are skipped.
                    const seen=mpEventSeqRef.current;
                    let max=seen===null?0:seen;
                    for(const ev of data.events){
                        if(ev.seq>max)max=ev.seq;
                        if(seen===null||ev.seq<=seen||ev.by===mpPlayerId)continue;
                        const msg={undo:'used an undo',restart:'restarted the board',new:'started a new game',load:'loaded a save file'}[ev.type];
                        if(msg)pushToast(`${ev.byName} ${msg}`);
                    }
                    mpEventSeqRef.current=max;
                }
                if(data.seed&&data.seed!==activeSeed){setActiveSeed(data.seed);setSeedStr(data.seed);}
                if(data.hints){
                    // Cache the server value BEFORE calling setHints so the hint-sync effect
                    // recognizes the incoming change as a no-op and doesn't bounce it back.
                    mpLastSyncedHintsRef.current={...data.hints};
                    setHints(prev=>({...prev,...data.hints}));
                }
                applyServerMoves(data.seed||activeSeed,data,data.hints&&data.hints.wrongFlags);
            },
            onError:e=>{
                console.error('sync error',e);
                // A mistyped session code, or a session that expired (rooms are deleted after a day idle).
                if(e&&e.message==='HTTP 404')showStatus('Session not found. Check the code, or create a new session.');
            },
        });
        return()=>{Net.stop();mpNetActiveRef.current=false};
    // activeSeed intentionally omitted from deps — Net starts once per (room, name, playerId).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    },[mpRoomId,mpName,mpPlayerId,applyServerMoves,pushToast]);

    // --- Multiplayer: track own cursor and forward at ~10 Hz to the server ---
    useEffect(()=>{
        if(!mpRoomId||!containerRef.current)return;
        const el=containerRef.current;
        let last=0,lastX=null,lastY=null;
        const onMove=e=>{
            const now=Date.now();
            if(now-last<100)return;
            const rect=el.getBoundingClientRect();
            const cols=Math.floor(rect.width/cellSize),rows=Math.floor(rect.height/cellSize);
            const padX=(rect.width-cols*cellSize)/2,padY=(rect.height-rows*cellSize)/2;
            const mx=(e.clientX-rect.left-padX)/cellSize;
            const my=(e.clientY-rect.top-padY)/cellSize;
            const wx=viewX-Math.floor(cols/2)+mx,wy=viewY-Math.floor(rows/2)+my;
            if(lastX!==null&&Math.abs(wx-lastX)<0.1&&Math.abs(wy-lastY)<0.1)return;
            last=now;lastX=wx;lastY=wy;
            Net.sendCursor(wx,wy,cellSize);
        };
        el.addEventListener('mousemove',onMove);
        return()=>el.removeEventListener('mousemove',onMove);
    },[mpRoomId,cellSize,viewX,viewY]);

    // Keep the server-side display name in sync if the user changes it mid-session.
    useEffect(()=>{if(mpName&&Net.isRunning())Net.updateName(mpName)},[mpName]);

    // Push our viewport center to Net every time it changes so other players' "go to"
    // navigation lands them on the same view we're looking at.
    useEffect(()=>{
        if(!mpRoomId||!Net.isRunning())return;
        Net.setView(viewX,viewY);
    },[viewX,viewY,mpRoomId]);

    // Push local hint changes to the room. Skips echoes from the server by comparing
    // against the last-synced snapshot (set in onSync just before setHints).
    useEffect(()=>{
        if(!mpRoomId||!mpNetActiveRef.current)return;
        const shared={
            wrongFlags:hints.wrongFlags,pulseNeighbors:hints.pulseNeighbors,
            undoEnabled:hints.undoEnabled,undoMode:hints.undoMode,chordFlag:hints.chordFlag,
        };
        const last=mpLastSyncedHintsRef.current;
        if(last){
            let same=true;
            for(const k in shared){if(shared[k]!==last[k]){same=false;break}}
            if(same)return;
        }
        Net.sendHints(shared);
    },[hints,mpRoomId]);

    useEffect(()=>{
        if(!containerRef.current)return;let t;
        const ro=new ResizeObserver(entries=>{clearTimeout(t);t=setTimeout(()=>{
            const{width,height}=entries[0].contentRect;
            if(width>0&&height>0)setContainerSize({w:Math.floor(width),h:Math.floor(height)})},50)});
        ro.observe(containerRef.current);return()=>{ro.disconnect();clearTimeout(t)}},[]);

    useEffect(()=>{const c=Math.floor(containerSize.w/cellSize),r=Math.floor(containerSize.h/cellSize);
        if(c>0&&r>0)setGridDims({cols:c,rows:r})},[containerSize,cellSize]);

    useEffect(()=>{
        const handler=e=>{
            if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
            const pan={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]};
            if(pan[e.key]){e.preventDefault();const[dx,dy]=pan[e.key];setViewX(v=>v+dx*3);setViewY(v=>v+dy*3);return}
            if(e.key==='Escape'&&viewMode==='Fullscreen'){setViewMode(prevMode.current||'Medium');return}
            if(e.ctrlKey&&(e.key==='='||e.key==='+')){e.preventDefault();setCellSize(s=>Math.min(ZMAX,s+ZSTEP))}
            if(e.ctrlKey&&e.key==='-'){e.preventDefault();setCellSize(s=>Math.max(ZMIN,s-ZSTEP))}};
        window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler)},[viewMode]);

    const handleWheel=useCallback(e=>{
        e.preventDefault();const rect=containerRef.current?.getBoundingClientRect();if(!rect)return;
        const cols=Math.floor(rect.width/cellSize),rows=Math.floor(rect.height/cellSize);
        const padX=(rect.width-cols*cellSize)/2,padY=(rect.height-rows*cellSize)/2;
        const mx=(e.clientX-rect.left-padX)/cellSize,my=(e.clientY-rect.top-padY)/cellSize;
        const sX=viewX-Math.floor(cols/2),sY=viewY-Math.floor(rows/2);
        const cux=sX+mx,cuy=sY+my;
        const nz=e.deltaY<0?Math.min(ZMAX,cellSize+ZSTEP):Math.max(ZMIN,cellSize-ZSTEP);
        if(nz===cellSize)return;
        const nC=Math.floor(rect.width/nz),nR=Math.floor(rect.height/nz);
        const nPx=(rect.width-nC*nz)/2,nPy=(rect.height-nR*nz)/2;
        const nmx=(e.clientX-rect.left-nPx)/nz,nmy=(e.clientY-rect.top-nPy)/nz;
        setCellSize(nz);setViewX(Math.round(cux-nmx+nC/2));setViewY(Math.round(cuy-nmy+nR/2))},[cellSize,viewX,viewY]);

    const applySeed=s=>{const ns=s.trim()||rndSeed();runIdRef.current=genRunId();setSeedStr(ns);setActiveSeed(ns);setCells({});setGameOver(false);setMoves(0);setFlags(0);setViewX(0);setViewY(0);setCellSize(uiSettings.defaultCellSize);setFirstClick(null);fcProcessed.current=false;timelapseRef.current=null;moveLogRef.current=[];curFlagsRef.current={};setClearedAtLastUndo(null);setUndoUsedCount(0);setShowGameOverModal(false);localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current=''};
    const restart=()=>{runIdRef.current=genRunId();setCells({});setGameOver(false);setMoves(0);setFlags(0);setViewX(0);setViewY(0);setCellSize(uiSettings.defaultCellSize);setFirstClick(null);fcProcessed.current=false;timelapseRef.current=null;moveLogRef.current=[];curFlagsRef.current={};setClearedAtLastUndo(null);setUndoUsedCount(0);setShowGameOverModal(false);localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current=''};
    const changeView=v=>{if(v==='Fullscreen')prevMode.current=viewMode;setViewMode(v)};

    const undoInfinite=hints.undoEnabled&&hints.undoMode==='infinite';
    const undoStack=hints.undoEnabled&&hints.undoMode==='stack';
    const undoStackCount=Math.max(0,Math.floor(clearedCount/1000)+1-undoUsedCount);
    const undoAvailable=hints.undoEnabled&&(
        undoInfinite||
        (undoStack?undoStackCount>0:(clearedAtLastUndo===null||clearedCount-clearedAtLastUndo>=1000))
    );
    const clearedUntilNextUndo=undoStack
        ?(1000-(clearedCount%1000))
        :(clearedAtLastUndo===null?0:Math.max(0,1000-(clearedCount-clearedAtLastUndo)));

    const mpIsFounder=!!(mpRoomId&&mpPlayerId&&mpFounderId===mpPlayerId);
    // Restart ('restart', same seed), start a new game ('new', seed defaults to random), or in a room,
    // replace the board with a save file ('load', its seed + encoded moveLog).
    // Asks first when there's something to lose: a game in progress, or a lost game an undo could
    // still rescue. In a room the founder decides alone; anyone else's request goes to a vote
    // that needs 51% of the room (enforced server-side).
    const startOver=(kind,seed,loadLog)=>{
        const atStake=moveLogRef.current.length>0&&(!gameOver||undoAvailable);
        const act=kind==='new'?'start a new game with a new seed':kind==='load'?'replace the board with this save file':'restart this board';
        if(!mpRoomId){
            if(atStake&&!confirm(`Are you sure you want to ${act}? Your current progress will be lost.`))return;
            if(kind==='new')applySeed(seed||rndSeed());else restart();
            return;
        }
        if(!mpNetActiveRef.current)return;
        const needsVote=atStake&&!mpIsFounder;
        if(atStake&&!confirm(needsVote
            ?`Start a vote to ${act}? At least 51% of the room must agree.`
            :`Are you sure you want to ${act} for everyone in the room? Current progress will be lost.`))return;
        Net.requestReset(kind,kind==='new'?(seed||rndSeed()):kind==='load'?seed:null,needsVote,loadLog);
        showStatus(needsVote?'Vote started — waiting for the room':'Starting over…');
    };
    // In a room a save file replaces the shared board (loading it locally would just be
    // overwritten by the next sync). Older saves without a move log can't be replayed there.
    const importIntoRoom=data=>{
        const entries=data&&data.version===3?decodeMoveLog(typeof data.moveLog==='string'?data.moveLog:'')
            :data&&data.version===2&&Array.isArray(data.moveLog)?data.moveLog:null;
        if(!entries){showStatus('This save is too old to load into a room');return}
        // Rooms only accept plain seeds; the server would change anything else, and the moves
        // would then replay on a different board.
        const seed=String(data.activeSeed||'');
        if(!/^[A-Za-z0-9_-]{1,32}$/.test(seed)){showStatus("This save's seed can't be used in a room");return}
        const clean=entries.filter(m=>Array.isArray(m)&&['r','f','u'].includes(m[0])&&Number.isInteger(m[1])&&Number.isInteger(m[2]));
        startOver('load',seed,encodeMoveLog(clean));
    };

    useEffect(()=>{
        if(gameOver)setShowGameOverModal(true);
        // In multiplayer, a shared undo can flip gameOver back to false — close the
        // modal automatically for players who weren't the one clicking Undo. In
        // single-player, gameOver never transitions back this way from replay.
        else setShowGameOverModal(false);
    },[gameOver]);

    const addLeaderboardEntry=useCallback(entry=>{
        setLeaderboard(prev=>{
            const filtered=prev.filter(e=>e.runId!==entry.runId);
            const next=[...filtered,entry].sort((a,b)=>b.cleared-a.cleared||a.moves-b.moves).slice(0,8);
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

    const doUndo=useCallback(()=>{
        if(!undoAvailable)return;
        const log=moveLogRef.current;
        // Undo the reveal that hit the mine, found by replay. It's usually the last entry, but not
        // always: a quick second click, or other players' clicks in a room, can be logged after it.
        const fi=replayMoveLog(activeSeed,log,hints.wrongFlags,null).fatalIndex;
        if(fi<0)return;
        const[,fx,fy]=log[fi];
        // In a room, tell the server to rewrite that fatal 'r' entry as 'u'. The next
        // sync response will echo a full moveLog rebuild (logRevision bumps), which
        // reconciles across all clients. We still apply the change locally for zero-latency
        // feedback; until the server has it, applyServerMoves lays the pending 'u' over its log.
        if(mpNetActiveRef.current)Net.sendMove(['u',fx,fy]);
        log[fi]=['u',fx,fy];
        const out=replayMoveLog(activeSeed,log,hints.wrongFlags,null);
        curFlagsRef.current=out.finalFlags;
        timelapseRef.current=null;
        setCells(out.cells);setMoves(out.moves);setFlags(out.flags);setGameOver(out.gameOver);setFirstClick(out.firstClick);
        setClearedAtLastUndo(out.clearedAtLastUndo);
        setUndoUsedCount(out.undoUsedCount);
        fcProcessed.current=out.firstClick!==null;
        setShowGameOverModal(!!out.gameOver);
        setMpGameOverBy(null);
        showStatus(mpNetActiveRef.current?'Undo applied — syncing with room':'Free undo used');
    },[undoAvailable,activeSeed,hints.wrongFlags,showStatus]);


    const hoverInfo=useMemo(()=>{
        if(!hover||gameOver)return{hl:new Set(),ck:null,pulse:new Set()};
        const[hx,hy]=hover;const k=`${hx},${hy}`;const st=cells[k];
        if(!st||st[0]!=='r')return{hl:new Set(),ck:null,pulse:new Set()};
        const c=+st[1];if(!c)return{hl:new Set(),ck:null,pulse:new Set()};
        let fc=0;const unrev=[];
        for(const[dx,dy]of NB){const nk=`${hx+dx},${hy+dy}`;const ns=cells[nk];if(ns==='flag')fc++;else if(!ns||ns==='quest')unrev.push(nk)}
        if(fc===c)return{hl:new Set(unrev),ck:k,pulse:new Set()};
        if(hints.pulseNeighbors)return{hl:new Set(),ck:null,pulse:new Set(unrev)};
        return{hl:new Set(),ck:null,pulse:new Set()};
    },[hover,cells,gameOver,hints.pulseNeighbors]);

    const revealCell=useCallback((x,y)=>{
        if(firstClick===null){
            moveLogRef.current.push(['r',x,y]);
            if(mpNetActiveRef.current)Net.sendMove(['r',x,y]);
            setFirstClick([x,y]);return;
        }
        setCells(prev=>{
            const{next,diff,movesDelta,gameOver:go}=applyReveal(prev,x,y,checker,hints.wrongFlags);
            if(next===prev)return prev;
            moveLogRef.current.push(['r',x,y]);
            if(mpNetActiveRef.current)Net.sendMove(['r',x,y]);
            recordFrame(timelapseRef,diff,curFlagsRef.current);
            if(movesDelta)setMoves(m=>m+movesDelta);
            if(go)setGameOver(true);
            return next;
        });
    },[firstClick,checker,hints.wrongFlags]);

    useEffect(()=>{
        if(firstClick&&!fcProcessed.current){fcProcessed.current=true;
            const[x,y]=firstClick;
            setCells(prev=>{
                const{next,diff,movesDelta}=applyReveal(prev,x,y,checker,hints.wrongFlags);
                if(next===prev)return prev;
                recordFrame(timelapseRef,diff,curFlagsRef.current);
                if(movesDelta)setMoves(m=>m+movesDelta);
                return next;
            });}
    },[firstClick,checker,hints.wrongFlags]);

    const flagCell=useCallback((x,y)=>{
        setCells(prev=>{
            const st=prev[`${x},${y}`];
            if(hints.chordFlag&&st&&st[0]==='r'){
                const{next,diff,flagsDelta,changed}=applyChordFlag(prev,x,y);
                if(changed){
                    for(const[k]of diff){
                        const[fx,fy]=k.split(',').map(Number);
                        moveLogRef.current.push(['f',fx,fy]);
                        if(mpNetActiveRef.current)Net.sendMove(['f',fx,fy]);
                    }
                    applyDiffToFlags(curFlagsRef.current,diff);
                    if(flagsDelta)setFlags(f=>f+flagsDelta);
                    return next;
                }
            }
            const{next,diff,flagsDelta,changed}=applyFlag(prev,x,y);
            if(!changed)return prev;
            moveLogRef.current.push(['f',x,y]);
            if(mpNetActiveRef.current)Net.sendMove(['f',x,y]);
            applyDiffToFlags(curFlagsRef.current,diff);
            if(flagsDelta)setFlags(f=>f+flagsDelta);
            return next;
        });
    },[hints.chordFlag]);

    const onH=useCallback((x,y)=>setHover([x,y]),[]);
    const onL=useCallback(()=>setHover(null),[]);

    const{cols,rows}=gridDims;
    const startX=viewX-Math.floor(cols/2),startY=viewY-Math.floor(rows/2);
    const gridW=cols*cellSize,gridH=rows*cellSize;
    const zoomPct=Math.round(cellSize/ZDEF*100);

    const grid=useMemo(()=>{
        const r=[];
        for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
            const cx=startX+col,cy=startY+row;const key=`${cx},${cy}`;
            r.push(<Cell key={key} x={cx} y={cy} state={cells[key]||null} go={gameOver}
                         hl={hoverInfo.hl.has(key)} cr={hoverInfo.ck===key} pulse={hoverInfo.pulse.has(key)} sz={cellSize}
                         onR={revealCell} onF={flagCell} onH={onH} onL={onL}/>)}
        return r},[startX,startY,rows,cols,cells,gameOver,cellSize,revealCell,flagCell,onH,onL,hoverInfo]);

    const isFS=viewMode==='Fullscreen';
    const cStyle=isFS?{width:'100vw',height:'calc(100vh - 42px)'}:{width:VIEWS[viewMode]?.w||800,height:VIEWS[viewMode]?.h||600,borderRadius:8,border:'1px solid #2a2a4a',boxShadow:'0 4px 30px rgba(0,0,0,.5)'};

    // --- Multiplayer helpers used by header buttons and the start menu ---
    // Resolves true only if the link actually reached the clipboard.
    const copyLink=useCallback(async url=>{
        let ok=false;
        if(navigator.clipboard&&navigator.clipboard.writeText){
            try{await navigator.clipboard.writeText(url);ok=true}catch(e){console.error('Clipboard write failed',e)}
        }
        // navigator.clipboard only exists on HTTPS/localhost — plain-HTTP deploys need the legacy path.
        if(!ok){
            const ta=document.createElement('textarea');
            ta.value=url;ta.setAttribute('readonly','');
            ta.style.cssText='position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.focus();ta.select();ta.setSelectionRange(0,url.length); // setSelectionRange for iOS Safari
            try{ok=document.execCommand('copy')}catch(e){console.error('Legacy copy failed',e)}
            document.body.removeChild(ta);
        }
        if(ok)showStatus('Invite link copied');
        else window.prompt('Copy this invite link:',url);
        return ok;
    },[showStatus]);
    const handleCopyInvite=useCallback(()=>copyLink(window.location.href),[copyLink]);
    const handleLeaveRoom=useCallback(()=>{
        // Bounce back to the base URL — drops ?room, single-player takes over from there.
        window.location.href=window.location.pathname;
    },[]);
    // Makes a room on the server and keeps our founder playerId for it. Resolves to the roomId.
    // moveLog (encoded) starts the room from an existing board instead of a blank one.
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
    // The board already on screen, which a new session can start from. Only seeds that survive the
    // server's sanitize_seed() unchanged can carry moves into a room.
    const menuCurrentGame=moveLogRef.current.length
        ?{moves:moveLogRef.current.length,seed:activeSeed,shareable:/^[A-Za-z0-9_-]{1,32}$/.test(activeSeed)}
        :null;
    const menuStartSingle=(seed,newHints)=>{
        if(mpRoomId){
            // Leaving the room reloads the page, so queue the new game for the other side of it.
            if(localStorage.getItem('minesweeper_save')&&!confirm('Leave this session and start a new singleplayer game? Your saved singleplayer game will be replaced.'))return;
            localStorage.setItem('minesweeper_pending_start',JSON.stringify({seed,hints:newHints}));
            window.location.href=window.location.pathname;
            return;
        }
        const atStake=moveLogRef.current.length>0&&(!gameOver||undoAvailable);
        if(atStake&&!confirm('Start a new game? Your current progress will be lost.'))return;
        setHints(newHints);
        applySeed(seed);
        setStartMenu(null);
    };
    const menuCreateSession=(name,seed,roomHints,fromCurrent)=>{
        localStorage.setItem('minesweeper_name',name);setMpName(name);
        return createRoom(seed,roomHints,fromCurrent?encodeMoveLog(moveLogRef.current):null);
    };
    // Name of whoever caused the current game-over (looked up by matching the short
    // owner tag against the first 8 hex of each player's full id).
    const mpKillerName=useMemo(()=>{
        if(!gameOver||!mpGameOverBy)return null;
        for(const pid in mpPlayers){if(pid.startsWith(mpGameOverBy))return mpPlayers[pid].name||'Player'}
        return null;
    },[gameOver,mpGameOverBy,mpPlayers]);
    const mpKillerIsSelf=!!(mpGameOverBy&&mpSelfIdShort&&mpGameOverBy===mpSelfIdShort);
    // Jump our viewport to another player's viewport center, so we see the same board region they do.
    const handleGoToPlayer=useCallback((x,y)=>{setViewX(Math.round(x));setViewY(Math.round(y))},[]);

    return(
        <div className="flex flex-col items-center" style={{width:'100vw',height:'100vh'}}>
            {startMenu&&<StartModal
                initialStep={startMenu.step}
                hints={hints}
                initialSeed={startMenu.closable?rndSeed():seedStr}
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
                onUndo={doUndo}
                onRestart={()=>startOver('restart')}
                onNewSeed={()=>startOver('new')}
                onExportImage={()=>handleExportImage(true)}
                onExportVideo={()=>handleExportVideo()}
                onClose={()=>setShowGameOverModal(false)}
                leaderboard={leaderboard}
                lastEntryDate={lastEntryDate}
                killerName={mpKillerName}
                killerIsSelf={mpKillerIsSelf}
            />}
            {mpRoomId&&<ToastStack toasts={mpToasts} vote={mpResetVote} selfId={mpPlayerId} onVote={(id,yes)=>Net.vote(id,yes)}/>}
            {showSettings&&<SettingsModal
                hints={hints} setHints={setHints}
                uiSettings={uiSettings} setUiSettings={setUiSettings}
                viewMode={viewMode} changeView={changeView}
                cellSize={cellSize} setCellSize={setCellSize}
                onClose={()=>setShowSettings(false)}
            />}
            {exportTask&&window.ExportProgressModal&&<window.ExportProgressModal task={exportTask}/>}
            <div className="hdr" style={{position:'relative',paddingRight:46}}>
                {uiSettings.showLeaderboard&&<LeaderboardDropdown entries={leaderboard} currentScore={clearedCount}/>}
                {mpRoomId
                    ?<>
                        <MultiplayerBadge status={mpStatus} backoff={mpBackoff} onCopyInvite={handleCopyInvite} onLeave={handleLeaveRoom}/>
                        <PlayerListDropdown players={mpPlayers} selfId={mpPlayerId} founderId={mpFounderId} onGoTo={handleGoToPlayer}/>
                    </>
                    :<button className="hb" onClick={()=>openMenu('create')} title="Create a session from this game and invite someone">👥 Play with a friend</button>}
                <div className="flex items-center gap-1">
                    {uiSettings.showSeed&&uiSettings.showSeedBox&&<input className="hi" value={seedStr} onChange={e=>setSeedStr(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')startOver('new',seedStr)}} placeholder="seed" disabled={!!mpRoomId}/>}
                    <button onClick={()=>openMenu('choose')} className="hb pr" title="New singleplayer or multiplayer game, restart, or new seed">☰ Menu</button>
                    {/* Undo stays reachable after closing the game-over popup to inspect the board. */}
                    {gameOver&&undoAvailable&&<button onClick={doUndo} className="hb pr" title="Undo the move that hit the mine">↩ Undo</button>}
                    {uiSettings.showSeed&&uiSettings.showLockBtn&&<button className={`hb ${locked?'act':''}`} onClick={()=>setLocked(l=>!l)}>{locked?'🔒':'🔓'}</button>}
                </div>
                <GameDropdown onExport={handleExport} onImport={handleImport} onClear={clearSave} onExportImage={handleExportImage} onExportVideo={handleExportVideo} videoExporting={videoExporting}/>
                {uiSettings.showZoom&&<div className="flex items-center gap-1">
                    <button className="hb" onClick={()=>setCellSize(s=>Math.max(ZMIN,s-ZSTEP))}>−</button>
                    <span className="text-gray-400 text-xs w-9 text-center">{zoomPct}%</span>
                    <button className="hb" onClick={()=>setCellSize(s=>Math.min(ZMAX,s+ZSTEP))}>+</button>
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
                <div ref={containerRef} className="game-container" style={{...cStyle,position:'relative'}} onContextMenu={e=>e.preventDefault()} onWheel={handleWheel}>
                    <div style={{display:'grid',gridTemplateColumns:`repeat(${cols},${cellSize}px)`,gridTemplateRows:`repeat(${rows},${cellSize}px)`,width:gridW,height:gridH}}>
                        {grid}
                    </div>
                    {mpRoomId&&<CursorOverlay players={mpPlayers} selfId={mpPlayerId} viewX={viewX} viewY={viewY} cellSize={cellSize} containerSize={containerSize}/>}
                </div>
            </div>
            {!isFS&&<div className="text-xs py-1" style={{color:'#9ca3af'}}>WASD/Arrows pan · Scroll zoom · Right-click flag · Click numbers to chord · First click always safe{status&&<span style={{color:'#c4b5fd',marginLeft:8}}>{status}</span>}</div>}
        </div>);
}

ReactDOM.render(<App/>,document.getElementById('root'));
