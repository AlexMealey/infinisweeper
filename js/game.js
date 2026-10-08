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
                ring++;salt++;if(ring>20)break;
            }
            ring=2;salt++;
        }
        return relocated;
    }
    function isMine(x,y){
        if(firstClick){
            if(Math.abs(x-firstClick[0])<=1&&Math.abs(y-firstClick[1])<=1)return false;
            if(relocatedMines().has(`${x},${y}`))return true;
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
// Flags all of a number's hidden neighbours when they must all be mines.
window.applyChordFlag=function(cells,x,y,mutate){
    const state=cells[`${x},${y}`],noChange={next:cells,diff:[],flagsDelta:0,changed:false};
    if(!state||state[0]!=='r')return noChange;
    const count=+state[1];
    if(!count)return noChange;
    let flagged=0;const hidden=[];
    for(const[dx,dy]of NEIGHBOR_OFFSETS){
        const key=`${x+dx},${y+dy}`,neighbor=cells[key];
        if(neighbor==='flag')flagged++;
        else if(!neighbor)hidden.push(key);
    }
    if(flagged+hidden.length!==count||hidden.length===0)return noChange;
    const next=mutate?cells:{...cells},diff=[];
    for(const key of hidden){next[key]='flag';diff.push([key,'flag'])}
    return{next,diff,flagsDelta:hidden.length,changed:true};
};
// Rebuilds a board from its move log. losingMoveIndex is the reveal that hit a mine (-1 if none), which an undo
// rewrites; in a room, other players' clicks can be logged after it.
window.replayMoveLog=function(seed,moveLog,showWrongFlags){
    const out={cells:{},moves:0,flags:0,gameOver:false,losingMoveIndex:-1,firstClick:null,clearedAtLastUndo:null,undoUsedCount:0,finalFlags:{}};
    if(!moveLog||!moveLog.length)return out;
    const first=moveLog[0];
    out.firstClick=first&&first[0]==='r'?[first[1],first[2]]:null;
    const minefield=createMinefield(hashSeed(seed),out.firstClick);
    const cells={},flags={};let cleared=0;
    for(let i=0;i<moveLog.length&&!out.gameOver;i++){
        const entry=moveLog[i];
        if(!entry||entry.length<3)continue;
        const[type,x,y]=entry;
        if(type==='r'){
            const{diff,movesDelta,gameOver}=applyReveal(cells,x,y,minefield,showWrongFlags,true);
            if(!diff.length)continue;
            applyDiffToFlags(flags,diff);
            for(const[,state]of diff)if(state&&state[0]==='r')cleared++;
            out.moves+=movesDelta;
            if(gameOver){out.gameOver=true;out.losingMoveIndex=i}
        }else if(type==='f'){
            const{diff,flagsDelta,changed}=applyFlag(cells,x,y,true);
            if(changed){applyDiffToFlags(flags,diff);out.flags+=flagsDelta}
        }else if(type==='u'){out.clearedAtLastUndo=cleared;out.undoUsedCount++}
    }
    out.cells=cells;out.finalFlags=flags;return out;
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
