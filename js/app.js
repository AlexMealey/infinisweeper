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
        }catch(e){}
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
    const[hints,setHints]=useState(()=>{try{const s=localStorage.getItem('minesweeper_hints');if(s)return migrateHints(JSON.parse(s))}catch(e){}return{wrongFlags:false,pulseNeighbors:false,undoEnabled:false,undoMode:'refill',chordFlag:false}});
    const dfltUI={showArrows:true,showScores:true,showLeaderboard:true,showUndo:true,showZoom:true,showCoords:true,showSeed:true,showSeedBox:true,showLockBtn:true,defaultCellSize:ZDEF};
    const[uiSettings,setUiSettings]=useState(()=>{try{const s=localStorage.getItem('minesweeper_ui');if(s)return{...dfltUI,...JSON.parse(s)}}catch(e){}return dfltUI});
    const[showSettings,setShowSettings]=useState(false);
    const[status,setStatus]=useState('');
    const[videoExporting,setVideoExporting]=useState(false);
    const[clearedAtLastUndo,setClearedAtLastUndo]=useState(null);
    const[undoUsedCount,setUndoUsedCount]=useState(0);
    const[showGameOverModal,setShowGameOverModal]=useState(false);
    const[leaderboard,setLeaderboard]=useState(()=>{
        try{const s=localStorage.getItem('minesweeper_leaderboard');const arr=s?JSON.parse(s):[];return Array.isArray(arr)?arr:[]}catch(e){return[]}
    });
    const[lastEntryDate,setLastEntryDate]=useState(null);
    const leaderboardRecordedRef=useRef(false);
    const runIdRef=useRef(genRunId());
    const timelapseRef=useRef([]);
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

    useEffect(()=>{try{localStorage.setItem('minesweeper_hints',JSON.stringify(hints))}catch(e){}},[hints]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_ui',JSON.stringify(uiSettings))}catch(e){}},[uiSettings]);
    useEffect(()=>{try{localStorage.setItem('minesweeper_view',viewMode)}catch(e){}},[viewMode]);

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
            timelapseRef.current=log.length?null:[];
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
            timelapseRef.current=(data.cells&&Object.keys(data.cells).length>0)?[{diff:Object.entries(data.cells),flags:flagsNow}]:[];
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
                if(data.version===1||data.version===2||data.version===3){
                    if(moves>0&&!confirm('Overwrite current progress?'))return;
                    if(loadGameState(data)){
                        lastSave.current=JSON.stringify(data);
                        lastSaveSig.current=sigOfState(data);
                        showStatus('Save file loaded successfully');
                    }else showStatus('Invalid save file')}
                else showStatus('Incompatible save version')}
            catch(err){showStatus('Invalid save file')}};
        reader.readAsText(file);e.target.value=''};

    const clearSave=()=>{localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current='';showStatus('Cache cleared')};

    const handleExportImage=(withStats=true)=>{
        const keys=Object.keys(cells);
        if(keys.length===0){showStatus('No progress to export');return}
        let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
        keys.forEach(k=>{const[x,y]=k.split(',').map(Number);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y)});
        const pad=2;
        minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
        const w=maxX-minX+1,h=maxY-minY+1;
        const sz=32, gridH=h*sz, footerH=withStats?Math.round(gridH*0.04/0.96):0;
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

    const handleExportVideo=async()=>{
        if(videoExporting)return;
        if(timelapseRef.current===null){
            if(!moveLogRef.current.length){showStatus('No progress to export');return}
            setVideoExporting(true);showStatus('Preparing timelapse…');
            timelapseRef.current=[];
            replayMoveLog(activeSeed,moveLogRef.current,hints.wrongFlags,timelapseRef);
            setVideoExporting(false);
        }
        const moveFrames=timelapseRef.current;
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
                    if(support&&support.supported){chosen=c;break}}catch(e){}}
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

    useEffect(()=>{
        // In multiplayer mode, initial state comes from sync.php, not localStorage.
        if(mpRoomId)return;
        const saved=localStorage.getItem('minesweeper_save');
        if(saved){try{const data=JSON.parse(saved);if(data&&(data.version===1||data.version===2||data.version===3)){if(loadGameState(data)){lastSave.current=saved;lastSaveSig.current=sigOfState(data);showStatus('Progress restored')}}}catch(e){}}
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
        const canonical=mpCanonicalMovesRef.current;
        const out=replayMoveLog(seed,canonical,!!wrongFlags,null);
        curFlagsRef.current=out.finalFlags;
        timelapseRef.current=canonical.length?null:[];
        moveLogRef.current=canonical.slice();
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
            setMpGameOverBy(idx>=0?(mpMoveOwnersRef.current[idx]||''):'');
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
                        const msg={undo:'used an undo',restart:'restarted the board',new:'started a new game'}[ev.type];
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
            onError:e=>console.warn('sync error',e),
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

    const applySeed=s=>{const ns=s.trim()||rndSeed();runIdRef.current=genRunId();setSeedStr(ns);setActiveSeed(ns);setCells({});setGameOver(false);setMoves(0);setFlags(0);setViewX(0);setViewY(0);setCellSize(uiSettings.defaultCellSize);setFirstClick(null);fcProcessed.current=false;timelapseRef.current=[];moveLogRef.current=[];curFlagsRef.current={};setClearedAtLastUndo(null);setUndoUsedCount(0);setShowGameOverModal(false);localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current=''};
    const restart=()=>{runIdRef.current=genRunId();setCells({});setGameOver(false);setMoves(0);setFlags(0);setViewX(0);setViewY(0);setCellSize(uiSettings.defaultCellSize);setFirstClick(null);fcProcessed.current=false;timelapseRef.current=[];moveLogRef.current=[];curFlagsRef.current={};setClearedAtLastUndo(null);setUndoUsedCount(0);setShowGameOverModal(false);localStorage.removeItem('minesweeper_save');lastSave.current='';lastSaveSig.current=''};
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
    // Restart ('restart', same seed) or start a new game ('new', seed defaults to random).
    // Asks first when there's something to lose: a game in progress, or a lost game an undo could
    // still rescue. In a room the founder decides alone; anyone else's request goes to a vote
    // that needs 51% of the room (enforced server-side).
    const startOver=(kind,seed)=>{
        const atStake=moveLogRef.current.length>0&&(!gameOver||undoAvailable);
        const act=kind==='new'?'start a new game with a new seed':'restart this board';
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
        Net.requestReset(kind,kind==='new'?(seed||rndSeed()):null,needsVote);
        showStatus(needsVote?'Vote started — waiting for the room':'Starting over…');
    };
    const startOverTip=mpRoomId&&!mpIsFounder?'Mid-game, needs 51% of the room to agree':undefined;

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
            try{localStorage.setItem('minesweeper_leaderboard',JSON.stringify(next))}catch(e){}
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
        const log=moveLogRef.current;
        if(log.length===0)return;
        const last=log[log.length-1];
        if(!last||last[0]!=='r')return;
        // In a room, tell the server to rewrite that fatal 'r' entry as 'u'. The next
        // sync response will echo a full moveLog rebuild (logRevision bumps), which
        // reconciles across all clients. We still apply the change locally for zero-latency
        // feedback — the sync-driven rebuild should produce the same state.
        if(mpNetActiveRef.current){
            Net.sendMove(['u',last[1],last[2]]);
            if(mpCanonicalMovesRef.current.length){
                const ci=mpCanonicalMovesRef.current.length-1;
                mpCanonicalMovesRef.current[ci]=['u',last[1],last[2]];
            }
        }
        log[log.length-1]=['u',last[1],last[2]];
        const out=replayMoveLog(activeSeed,log,hints.wrongFlags,null);
        curFlagsRef.current=out.finalFlags;
        timelapseRef.current=log.length?null:[];
        setCells(out.cells);setMoves(out.moves);setFlags(out.flags);setGameOver(out.gameOver);setFirstClick(out.firstClick);
        setClearedAtLastUndo(out.clearedAtLastUndo);
        setUndoUsedCount(out.undoUsedCount);
        setShowGameOverModal(false);
        setMpGameOverBy(null);
        showStatus(mpNetActiveRef.current?'Undo applied — syncing with room':'Free undo used');
    },[activeSeed,hints.wrongFlags,showStatus]);


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

    // --- Multiplayer helpers used by header buttons ---
    // Resolves true only if the link actually reached the clipboard.
    const handleCopyInvite=useCallback(async()=>{
        const url=window.location.href;
        let ok=false;
        if(navigator.clipboard&&navigator.clipboard.writeText){
            try{await navigator.clipboard.writeText(url);ok=true}catch(e){}
        }
        // navigator.clipboard only exists on HTTPS/localhost — plain-HTTP deploys need the legacy path.
        if(!ok){
            const ta=document.createElement('textarea');
            ta.value=url;ta.setAttribute('readonly','');
            ta.style.cssText='position:fixed;top:0;left:0;opacity:0';
            document.body.appendChild(ta);
            ta.focus();ta.select();ta.setSelectionRange(0,url.length); // setSelectionRange for iOS Safari
            try{ok=document.execCommand('copy')}catch(e){}
            document.body.removeChild(ta);
        }
        if(ok)showStatus('Invite link copied');
        else window.prompt('Copy this invite link:',url);
        return ok;
    },[showStatus]);
    const handleLeaveRoom=useCallback(()=>{
        // Bounce back to the base URL — drops ?room, single-player takes over from there.
        window.location.href=window.location.pathname;
    },[]);
    const handleCreateRoom=useCallback(async()=>{
        try{
            showStatus('Creating room…');
            const res=await fetch('./php/create-room.php',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({seed:activeSeed,hints}),
                cache:'no-store',
            });
            if(!res.ok)throw new Error('HTTP '+res.status);
            const data=await res.json();
            if(!data.roomId)throw new Error('no roomId in response');
            localStorage.setItem('minesweeper_room_'+data.roomId,data.playerId);
            window.location.search='?room='+data.roomId;
        }catch(e){
            console.error(e);
            showStatus('Room creation failed — is php/ served?');
        }
    },[activeSeed,hints,showStatus]);
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
            <div className="hdr" style={{position:'relative',paddingRight:46}}>
                {uiSettings.showLeaderboard&&<LeaderboardDropdown entries={leaderboard} currentScore={clearedCount}/>}
                {mpRoomId
                    ?<>
                        <MultiplayerBadge status={mpStatus} backoff={mpBackoff} onCopyInvite={handleCopyInvite} onLeave={handleLeaveRoom}/>
                        <PlayerListDropdown players={mpPlayers} selfId={mpPlayerId} founderId={mpFounderId} onGoTo={handleGoToPlayer}/>
                    </>
                    :<button className="hb" onClick={handleCreateRoom} title="Create a shared room and invite someone">👥 Play with a friend</button>}
                <div className="flex items-center gap-1">
                    {uiSettings.showSeed&&uiSettings.showSeedBox&&<input className="hi" value={seedStr} onChange={e=>setSeedStr(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')startOver('new',seedStr)}} placeholder="seed" disabled={!!mpRoomId}/>}
                    <button onClick={()=>startOver('new')} className="hb pr" title={startOverTip}>New Seed</button>
                    <button onClick={()=>startOver('restart')} className="hb pr" title={startOverTip}>{gameOver?'New Game':'Restart'}</button>
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
