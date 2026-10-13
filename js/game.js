// game.js – game rules, constants and cell drawing, shared through window with the other scripts.

window.NEIGHBOR_OFFSETS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
// Board sizes in windowed mode, in any CSS length (the board measures its container).
window.VIEW_SIZES={Small:{w:'45vw',h:'60vh'},Medium:{w:'60vw',h:'70vh'},Large:{w:'85vw',h:'85vh'}};
window.CELL_SIZE_MIN=16;window.CELL_SIZE_MAX=64;window.CELL_SIZE_DEFAULT=36;window.CELL_SIZE_STEP=4;
window.FLAG_STATES=new Set(['flag','quest','flag-ok','flag-bad']);
window.NUMBER_COLORS={1:'#5b9bd5',2:'#6bab42',3:'#ef4444',4:'#a855f7',5:'#7f1d1d',6:'#06b6d4',7:'#d4d4d4',8:'#9ca3af'};
const MINE_DENSITY=0.18;
const LOSS_REVEAL_RADIUS_X=35,LOSS_REVEAL_RADIUS_Y=30; // mines shown around the losing click

window.hashSeed=function(s){let h=0;for(let i=0;i<s.length;i++)h=Math.imul(31,h)+s.charCodeAt(i)|0;return h>>>0};
window.randomSeed=function(){return Math.random().toString(36).slice(2,10)};
window.newRunId=function(){return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`};
window.getSeedFromURL=function(){return new URLSearchParams(window.location.search).get('seed')};
window.setSeedInURL=function(seed){const u=new URL(window.location);u.searchParams.set('seed',seed);window.history.replaceState({},'',u)};
window.seededRandom=function(x,y,seed){let h=seed^(x*374761393)^(y*668265263);h=Math.imul(h^(h>>>15),h|1);h^=h+Math.imul(h^(h>>>7),h|61);return((h^(h>>>14))>>>0)/4294967296};
// Fills in hint settings that older saves lack (freeUndo became undoEnabled).
window.migrateHints=function(saved){
    const defaults={wrongFlags:false,pulseNeighbors:false,undoEnabled:false,undoMode:'refill',chordFlag:false};
    if(!saved)return defaults;
    const undoEnabled='undoEnabled'in saved?!!saved.undoEnabled:!!saved.freeUndo;
    const undoMode=saved.undoMode==='infinite'||saved.undoMode==='stack'?saved.undoMode:'refill';
    return{...defaults,...saved,undoEnabled,undoMode,chordFlag:!!saved.chordFlag};
};
window.extractFlags=function(cells){const flags={};for(const k in cells){if(FLAG_STATES.has(cells[k]))flags[k]=cells[k]}return flags};
window.applyDiffToFlags=function(flags,diff){for(const[k,v]of diff){if(v===undefined)delete flags[k];else if(FLAG_STATES.has(v))flags[k]=v;else if(k in flags)delete flags[k]}};
// Version 1 saves keep a frame per move instead of a move log; framesRef.current is that array, or null.
window.recordV1Frame=function(framesRef,diff,flags){applyDiffToFlags(flags,diff);if(framesRef.current&&diff.length)framesRef.current.push({diff,flags:{...flags}})};
// Move logs as text: "r5,3;f5,4;u6,3;" (reveal, flag, undone reveal).
window.encodeMoveLog=function(log){let s='';for(const[type,x,y]of log)s+=type+x+','+y+';';return s};
window.decodeMoveLog=function(str){const out=[];if(!str)return out;for(const p of str.split(';')){if(!p)continue;const comma=p.indexOf(',',1);if(comma<0)continue;out.push([p[0],+p.slice(1,comma),+p.slice(comma+1)])}return out};

// Mines come from the seed. The first click's 3×3 is kept clear, and the mines it held move to nearby cells.
const RELOCATE_MAX_RING=20; // how far from the first click a moved mine can land
window.createMinefield=function(seedNum,firstClick){
    let relocated=null;
    function relocatedMines(){
        if(relocated!==null)return relocated;
        relocated=new Set();if(!firstClick)return relocated;
        const[fx,fy]=firstClick;let displaced=0;
        for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)if(seededRandom(fx+dx,fy+dy,seedNum)<MINE_DENSITY)displaced++;
        let ring=2,salt=0;
        for(let i=0;i<displaced;i++){
            let placed=false;
            while(!placed){
                for(let dx=-ring;dx<=ring&&!placed;dx++)for(let dy=-ring;dy<=ring&&!placed;dy++){
                    if(Math.abs(dx)<ring&&Math.abs(dy)<ring)continue;
                    const rx=fx+dx,ry=fy+dy,key=`${rx},${ry}`;
                    if(seededRandom(rx,ry,seedNum)>=MINE_DENSITY&&!relocated.has(key)){
                        if(seededRandom(rx+salt*7,ry+salt*13,seedNum+salt+1)<0.35||ring>3){relocated.add(key);placed=true}
                    }
                }
                ring++;salt++;if(ring>RELOCATE_MAX_RING)break;
            }
            ring=2;salt++;
        }
        return relocated;
    }
    function isMine(x,y){
        if(firstClick){
            const dx=x-firstClick[0],dy=y-firstClick[1];
            if(dx>=-1&&dx<=1&&dy>=-1&&dy<=1)return false;
            // Only near the first click can a mine have moved, so most calls skip building the key.
            if(dx>=-RELOCATE_MAX_RING&&dx<=RELOCATE_MAX_RING&&dy>=-RELOCATE_MAX_RING&&dy<=RELOCATE_MAX_RING&&relocatedMines().has(`${x},${y}`))return true;
        }
        return seededRandom(x,y,seedNum)<MINE_DENSITY;
    }
    function countAdjacentMines(x,y){let n=0;for(const[dx,dy]of NEIGHBOR_OFFSETS)if(isMine(x+dx,y+dy))n++;return n}
    return{isMine,countAdjacentMines};
};

function floodReveal(cells,diff,x,y,minefield){
    const stack=[[x,y]];
    while(stack.length){
        const[cx,cy]=stack.pop(),key=`${cx},${cy}`;
        if(cells[key]||minefield.isMine(cx,cy))continue;
        const count=minefield.countAdjacentMines(cx,cy);
        cells[key]='r'+count;diff.push([key,'r'+count]);
        if(!count)for(const[dx,dy]of NEIGHBOR_OFFSETS)stack.push([cx+dx,cy+dy]);
    }
}
function revealAfterLoss(cells,diff,x,y,minefield,showWrongFlags){
    if(showWrongFlags)for(const key in cells){
        if(cells[key]!=='flag')continue;
        const[fx,fy]=key.split(',').map(Number),state=minefield.isMine(fx,fy)?'flag-ok':'flag-bad';
        cells[key]=state;diff.push([key,state]);
    }
    for(let dx=-LOSS_REVEAL_RADIUS_X;dx<=LOSS_REVEAL_RADIUS_X;dx++)for(let dy=-LOSS_REVEAL_RADIUS_Y;dy<=LOSS_REVEAL_RADIUS_Y;dy++){
        const mx=x+dx,my=y+dy,key=`${mx},${my}`;
        if(minefield.isMine(mx,my)&&!cells[key]){cells[key]='mine';diff.push([key,'mine'])}
    }
}
// Reveals a hidden cell, or chords a number whose flags are all placed. mutate edits cells in place.
window.applyReveal=function(cells,x,y,minefield,showWrongFlags,mutate){
    const key=`${x},${y}`,state=cells[key];
    if(state&&state[0]==='r'){
        const count=+state[1];
        if(!count)return{next:cells,diff:[],movesDelta:0,gameOver:false};
        let flagged=0;for(const[dx,dy]of NEIGHBOR_OFFSETS)if(cells[`${x+dx},${y+dy}`]==='flag')flagged++;
        if(flagged!==count)return{next:cells,diff:[],movesDelta:0,gameOver:false};
        const next=mutate?cells:{...cells},diff=[],safe=[];let hitMine=false;
        for(const[dx,dy]of NEIGHBOR_OFFSETS){
            const nx=x+dx,ny=y+dy,nkey=`${nx},${ny}`;
            if(next[nkey])continue;
            if(minefield.isMine(nx,ny)){hitMine=true;next[nkey]='exp';diff.push([nkey,'exp'])}
            else safe.push([nx,ny]);
        }
        if(hitMine){revealAfterLoss(next,diff,x,y,minefield,showWrongFlags);return{next,diff,movesDelta:0,gameOver:true}}
        for(const[sx,sy]of safe)floodReveal(next,diff,sx,sy,minefield);
        return{next,diff,movesDelta:1,gameOver:false};
    }
    if(state)return{next:cells,diff:[],movesDelta:0,gameOver:false};
    const next=mutate?cells:{...cells},diff=[];
    if(minefield.isMine(x,y)){
        next[key]='exp';diff.push([key,'exp']);
        revealAfterLoss(next,diff,x,y,minefield,showWrongFlags);
        return{next,diff,movesDelta:0,gameOver:true};
    }
    floodReveal(next,diff,x,y,minefield);
    return{next,diff,movesDelta:1,gameOver:false};
};
// Cycles a hidden cell through flag, question mark and back to hidden.
window.applyFlag=function(cells,x,y,mutate){
    const key=`${x},${y}`,state=cells[key];
    const nextState=!state?'flag':state==='flag'?'quest':state==='quest'?undefined:null;
    if(nextState===null)return{next:cells,diff:[],flagsDelta:0,changed:false};
    const next=mutate?cells:{...cells};
    if(nextState===undefined)delete next[key];else next[key]=nextState;
    return{next,diff:[[key,nextState]],flagsDelta:nextState==='flag'?1:nextState==='quest'?-1:0,changed:true};
};
// A number's hidden neighbours when they must all be mines (its flags plus them make its count), otherwise none.
window.chordFlagTargets=function(cells,x,y){
    const state=cells[`${x},${y}`];
    if(!state||state[0]!=='r')return[];
    const count=+state[1];
    if(!count)return[];
    let flagged=0;const hidden=[];
    for(const[dx,dy]of NEIGHBOR_OFFSETS){
        const key=`${x+dx},${y+dy}`,neighbor=cells[key];
        if(neighbor==='flag')flagged++;
        else if(!neighbor)hidden.push(key);
    }
    return flagged+hidden.length===count?hidden:[];
};
// Flags all of a number's hidden neighbours when they must all be mines.
window.applyChordFlag=function(cells,x,y,mutate){
    const hidden=chordFlagTargets(cells,x,y);
    if(!hidden.length)return{next:cells,diff:[],flagsDelta:0,changed:false};
    const next=mutate?cells:{...cells},diff=[];
    for(const key of hidden){next[key]='flag';diff.push([key,'flag'])}
    return{next,diff,flagsDelta:hidden.length,changed:true};
};

// A board built from its move log one entry at a time, in place, so a new move costs only what it changes.
// losingMoveIndex is the reveal that hit a mine (-1 if none), which an undo rewrites; in a room, other players'
// clicks can be logged after it. preset: a version 1 save's {cells, firstClick, moves, flags, gameOver}, which has no log.
const BOARD_FIELDS=['moves','flags','cleared','gameOver','losingMoveIndex','firstClick','minefield','clearedAtLastUndo','undoUsedCount','length'];
window.createBoard=function(seed,showWrongFlags,preset){
    const p=preset||{},seedNum=hashSeed(seed),firstClick=p.firstClick||null;
    const board={seed,seedNum,showWrongFlags:!!showWrongFlags,cells:p.cells||{},moves:p.moves||0,flags:p.flags||0,cleared:0,gameOver:!!p.gameOver,
        losingMoveIndex:-1,firstClick,minefield:createMinefield(seedNum,firstClick),clearedAtLastUndo:null,undoUsedCount:0,length:0,journal:null,dirty:false};
    for(const key in board.cells){const s=board.cells[key];if(s&&s[0]==='r')board.cleared++}
    return board;
};
// Plays the next log entry as a replay does: entry 0 places the minefield if it's a reveal, and nothing after a game
// over counts. Returns the diff, or null if nothing changed. journal starts journaling: every entry from then on is
// kept until rollbackBoard takes them all back off.
window.applyLogEntry=function(board,entry,journal){
    if(journal&&!board.journal){const before={};for(const k of BOARD_FIELDS)before[k]=board[k];board.journal={before,diffs:[]}}
    const index=board.length++;
    if(board.gameOver)return null;
    if(index===0&&!board.firstClick&&entry&&entry[0]==='r'){board.firstClick=[entry[1],entry[2]];board.minefield=createMinefield(board.seedNum,board.firstClick)}
    if(!entry||entry.length<3)return null;
    const[type,x,y]=entry;
    let diff=null;
    if(type==='r'){
        const r=applyReveal(board.cells,x,y,board.minefield,board.showWrongFlags,true);
        if(!r.diff.length)return null;
        diff=r.diff;
        for(const[,state]of diff)if(state&&state[0]==='r')board.cleared++;
        board.moves+=r.movesDelta;
        if(r.gameOver){board.gameOver=true;board.losingMoveIndex=index}
    }else if(type==='f'){
        const r=applyFlag(board.cells,x,y,true);
        if(!r.changed)return null;
        diff=r.diff;
        board.flags+=r.flagsDelta;
    }else{
        if(type==='u'){board.clearedAtLastUndo=board.cleared;board.undoUsedCount++}
        return null;
    }
    if(board.journal)board.journal.diffs.push(diff);
    return diff;
};
// What a change replaced. The rules only make these changes: hidden to a number, 'exp', 'mine' or 'flag'; 'flag' to
// 'quest', 'flag-ok' or 'flag-bad'; 'quest' to hidden. A new kind of change needs a case here.
const stateBefore=state=>state==='quest'||state==='flag-ok'||state==='flag-bad'?'flag':state===undefined?'quest':undefined;
window.rollbackBoard=function(board){
    const journal=board.journal;
    if(!journal)return;
    for(let i=journal.diffs.length-1;i>=0;i--)for(const[key,state]of journal.diffs[i]){
        const before=stateBefore(state);
        if(before===undefined)delete board.cells[key];else board.cells[key]=before;
    }
    Object.assign(board,journal.before);
    board.journal=null;
};
// A click is kept only if it changed the board; one that does nothing isn't logged or sent.
window.applyMove=function(board,entry,journal){
    const diff=applyLogEntry(board,entry,journal);
    if(!diff)board.length--;
    return diff;
};
window.boardFromLog=function(seed,moveLog,showWrongFlags){
    const board=createBoard(seed,showWrongFlags);
    for(const entry of moveLog||[])applyLogEntry(board,entry);
    return board;
};
// The whole-log replay as an object, for a cached app.js from before the board API.
window.replayMoveLog=function(seed,moveLog,showWrongFlags){
    const b=boardFromLog(seed,moveLog,showWrongFlags);
    return{cells:b.cells,moves:b.moves,flags:b.flags,gameOver:b.gameOver,losingMoveIndex:b.losingMoveIndex,firstClick:b.firstClick,
        clearedAtLastUndo:b.clearedAtLastUndo,undoUsedCount:b.undoUsedCount,finalFlags:extractFlags(b.cells)};
};
// Lays our moves the server hasn't had yet over its log, as the server will: an undo rewrites the latest reveal of
// its cell (unless that's already undone), anything else goes on the end. Changes log in place.
window.mergePendingMoves=function(log,pending){
    for(const m of pending){
        if(m[0]!=='u'){log.push([m[0],m[1],m[2]]);continue}
        for(let i=log.length-1;i>=0;i--){
            const entry=log[i];
            if((entry[0]==='r'||entry[0]==='u')&&entry[1]===m[1]&&entry[2]===m[2]){if(entry[0]==='r')log[i]=['u',m[1],m[2]];break}
        }
    }
    return log;
};
// A room's board after a sync: the server's log with our moves it hasn't had yet (pending) on top, as replaying both
// would give. added: the server's entries since the last sync. It rebuilds only when it must (the server sent its
// whole log, the seed or wrong-flag setting changed, or an undo is involved); otherwise our moves come back off, the
// server's go on (ours among them, in its order) and the ones it hasn't had go back on top. log is the move log the
// board was built from, kept the same length as the board. Returns {board, log}, or null if nothing changed.
window.syncBoard=function(board,log,serverLog,added,fullLog,seed,showWrongFlags,pending){
    const rebuild=fullLog||board.dirty||board.seed!==seed||board.showWrongFlags!==!!showWrongFlags;
    if(!rebuild&&!added.length)return null;
    const undoPending=pending.some(m=>m[0]==='u');
    if(rebuild||undoPending){
        log=serverLog.slice();board=createBoard(seed,showWrongFlags);
        if(undoPending){
            // An undo rewrites an earlier entry, so the next sync rebuilds again rather than taking it back off.
            mergePendingMoves(log,pending);
            for(const entry of log)applyLogEntry(board,entry);
            board.dirty=true;
        }else{
            for(const entry of log)applyLogEntry(board,entry);
            for(const m of pending){const entry=[m[0],m[1],m[2]];log.push(entry);applyLogEntry(board,entry,true)}
        }
        return{board,log};
    }
    rollbackBoard(board);
    log.length=board.length;
    for(const entry of added){applyLogEntry(board,entry);log.push(entry)}
    for(const m of pending){const entry=[m[0],m[1],m[2]];applyLogEntry(board,entry,true);log.push(entry)}
    return{board,log};
};
// Draws a cell as the board shows it, for image and video exports.
window.drawCellToCanvas=function(ctx,state,x,y,size){
    const fill=style=>{ctx.fillStyle=style;ctx.fillRect(x,y,size,size)};
    const gradient=(from,to)=>{const g=ctx.createLinearGradient(x,y,x+size,y+size);g.addColorStop(0,from);g.addColorStop(1,to);return g};
    const drawCentred=(text,font)=>{ctx.font=font;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,x+size/2,y+size/2)};
    const iconFont=`${size*0.6}px serif`;
    ctx.strokeStyle='rgba(55,55,95,0.5)';ctx.lineWidth=1;
    if(state==='exp'){fill('#e02020');drawCentred('💥',iconFont)}
    else if(state==='mine'){fill('#1e1218');drawCentred('💣',iconFont)}
    else if(state==='flag'){fill(gradient('#4a2828','#381818'));drawCentred('🚩',iconFont)}
    else if(state==='flag-ok'){fill(gradient('#1a4a2a','#153d22'));drawCentred('🚩',iconFont)}
    else if(state==='flag-bad'){
        fill(gradient('#5a1a1a','#4a1010'));
        ctx.globalAlpha=0.7;drawCentred('🚩',iconFont);ctx.globalAlpha=1;
        ctx.fillStyle='#ff3333';ctx.shadowColor='rgba(255,0,0,0.5)';ctx.shadowBlur=3;drawCentred('✕',`900 ${size*0.5}px sans-serif`);ctx.shadowBlur=0;
    }
    else if(state==='quest'){fill(gradient('#38385a','#2c2c4a'));drawCentred('❓',iconFont)}
    else if(state&&state[0]==='r'){
        fill('#12122a');
        const count=+state[1];
        if(count){ctx.fillStyle=NUMBER_COLORS[count]||'#fff';drawCentred(count,`bold ${size*0.45}px sans-serif`)}
    }
    else fill(gradient('#38385a','#2c2c4a'));
    ctx.strokeRect(x,y,size,size);
};
// Firefox's H.264 decoder config (avcC) repeats the first byte of each parameter set and leaves reserved bits
// clear. Browsers cope but Windows' player doesn't, so a malformed one is rebuilt from the keyframe's SPS and PPS.
window.repairAvcDecoderConfig=function(config,keyframe){
    const avcC=config instanceof ArrayBuffer?new Uint8Array(config):new Uint8Array(config.buffer,config.byteOffset,config.byteLength);
    const wellFormed=avcC.length>9&&avcC[0]===1&&(avcC[4]&0xFC)===0xFC&&(avcC[5]&0xE0)===0xE0&&(avcC[8]&31)===7&&avcC[9]===avcC[1];
    if(wellFormed)return config;
    const lengthSize=(avcC[4]&3)+1,sps=[],pps=[];
    for(let pos=0;pos+lengthSize<=keyframe.length;){
        let len=0;for(let b=0;b<lengthSize;b++)len=len*256+keyframe[pos+b];
        const nal=keyframe.subarray(pos+lengthSize,pos+lengthSize+len),type=nal[0]&31;
        if(type===7)sps.push(nal);else if(type===8)pps.push(nal);
        pos+=lengthSize+len;
    }
    if(!sps.length||!pps.length||sps[0].length<4)return config; // nothing to rebuild it from
    const profile=sps[0][1],out=[1,profile,sps[0][2],sps[0][3],0xFC|(lengthSize-1),0xE0|sps.length];
    for(const nal of sps)out.push(nal.length>>8,nal.length&255,...nal);
    out.push(pps.length);for(const nal of pps)out.push(nal.length>>8,nal.length&255,...nal);
    if([100,110,122,144].includes(profile))out.push(0xFD,0xF8,0xF8,0); // High profiles: 4:2:0, 8-bit, no SPS extensions
    return new Uint8Array(out);
};
// The stats footer along the bottom of an in-memory timelapse frame.
window.drawVideoFooter=function(ctx,width,height,footerH,movesShown,totalMoves,cleared,flagged){
    ctx.fillStyle='#111128';ctx.fillRect(0,height-footerH,width,footerH);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(footerH/48));ctx.strokeRect(0,height-footerH,width,footerH);
    const fontSize=Math.round(footerH*0.3),iconSize=Math.round(footerH*0.35),midY=height-footerH/2;ctx.textBaseline='middle';
    let penX=footerH*0.4;
    const drawStat=(label,icon,value)=>{
        ctx.textAlign='left';ctx.fillStyle='#aaa';ctx.font=`bold ${fontSize}px sans-serif`;ctx.fillText(label,penX,midY);penX+=ctx.measureText(label).width+footerH*0.1;
        ctx.font=`${iconSize}px serif`;ctx.fillText(icon,penX,midY);penX+=footerH*0.45;
        ctx.fillStyle='#fff';ctx.font=`bold ${fontSize}px sans-serif`;const text=String(value);ctx.fillText(text,penX,midY);penX+=ctx.measureText(text).width+footerH*0.5;
    };
    drawStat('Flagged:','🚩',flagged);drawStat('Moves:','👆',movesShown);drawStat('Cleared:','🟦',cleared);
    ctx.fillStyle='#888';ctx.font=`bold ${fontSize}px sans-serif`;ctx.textAlign='right';ctx.fillText(`${movesShown} / ${totalMoves}`,width-footerH*0.4,midY);
};
