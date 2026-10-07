// game.js – constants, utilities, game logic, canvas drawing
// All items assigned to window so Babel-compiled component scripts can access them.

window.NB=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
// Board sizes in windowed mode, as shares of the window: in a 1920×1080 one, Small is 800×600 and Medium
// 1100×750. Any CSS length works; the board measures its container.
window.VIEWS={Small:{w:'45vw',h:'60vh'},Medium:{w:'60vw',h:'70vh'},Large:{w:'85vw',h:'85vh'}};
window.ZMIN=16;window.ZMAX=64;window.ZDEF=36;window.ZSTEP=4;
window.FLAG_STATES=new Set(['flag','quest','flag-ok','flag-bad']);
window.N_COLORS={1:'#5b9bd5',2:'#6bab42',3:'#ef4444',4:'#a855f7',5:'#7f1d1d',6:'#06b6d4',7:'#d4d4d4',8:'#9ca3af'};

window.hashSeed=function(s){let h=0;for(let i=0;i<s.length;i++)h=Math.imul(31,h)+s.charCodeAt(i)|0;return h>>>0};
window.rndSeed=function(){return Math.random().toString(36).slice(2,10)};
window.genRunId=function(){return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`};
window.getURLSeed=function(){return new URLSearchParams(window.location.search).get('seed')};
window.setURL=function(seed){const u=new URL(window.location);u.searchParams.set('seed',seed);window.history.replaceState({},'',u)};
window.seededRnd=function(x,y,seed){let h=seed^(x*374761393)^(y*668265263);h=Math.imul(h^(h>>>15),h|1);h^=h+Math.imul(h^(h>>>7),h|61);return((h^(h>>>14))>>>0)/4294967296};
window.migrateHints=function(h){const base={wrongFlags:false,pulseNeighbors:false,undoEnabled:false,undoMode:'refill',chordFlag:false};if(!h)return base;const undoEnabled='undoEnabled'in h?!!h.undoEnabled:!!h.freeUndo;const undoMode=h.undoMode==='infinite'||h.undoMode==='stack'?h.undoMode:'refill';return{...base,...h,undoEnabled,undoMode,chordFlag:!!h.chordFlag}};
window.extractFlags=function(cellsObj){const f={};for(const k in cellsObj){if(FLAG_STATES.has(cellsObj[k]))f[k]=cellsObj[k]}return f};
window.applyDiffToFlags=function(flagsObj,diff){for(const[k,v]of diff){if(v===undefined)delete flagsObj[k];else if(FLAG_STATES.has(v))flagsObj[k]=v;else if(k in flagsObj)delete flagsObj[k]}};
window.recordFrame=function(historyRef,diff,curFlags){applyDiffToFlags(curFlags,diff);if(historyRef&&historyRef.current&&diff.length)historyRef.current.push({diff,flags:{...curFlags}})};
window.encodeMoveLog=function(log){let s='';for(const[t,x,y]of log)s+=t+x+','+y+';';return s};
window.decodeMoveLog=function(str){const out=[];if(!str)return out;for(const p of str.split(';')){if(!p)continue;const comma=p.indexOf(',',1);if(comma<0)continue;out.push([p[0],+p.slice(1,comma),+p.slice(comma+1)])}return out};
window.mkChecker=function(seedNum,firstClick){
    let relocSet=null;
    function getReloc(){if(relocSet!==null)return relocSet;relocSet=new Set();if(!firstClick)return relocSet;const[fx,fy]=firstClick;const excMines=[];for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){if(seededRnd(fx+dx,fy+dy,seedNum)<0.18)excMines.push([fx+dx,fy+dy])}let ring=2,idx=0;for(const m of excMines){let placed=false;while(!placed){for(let dx=-ring;dx<=ring&&!placed;dx++)for(let dy=-ring;dy<=ring&&!placed;dy++){if(Math.abs(dx)<ring&&Math.abs(dy)<ring)continue;const rx=firstClick[0]+dx,ry=firstClick[1]+dy,rk=`${rx},${ry}`;if(seededRnd(rx,ry,seedNum)>=0.18&&!relocSet.has(rk)){if(seededRnd(rx+idx*7,ry+idx*13,seedNum+idx+1)<0.35||ring>3){relocSet.add(rk);placed=true}}}ring++;idx++;if(ring>20)break}ring=2;idx++}return relocSet}
    function isMine(x,y){if(firstClick){if(Math.abs(x-firstClick[0])<=1&&Math.abs(y-firstClick[1])<=1)return false;if(getReloc().has(`${x},${y}`))return true}return seededRnd(x,y,seedNum)<0.18}
    function countMines(x,y){let c=0;for(const[dx,dy]of NB)if(isMine(x+dx,y+dy))c++;return c}
    return{isMine,countMines}
};
window.applyReveal=function(prev,x,y,checker,wrongFlags,mutate){
    const key=`${x},${y}`;const st=prev[key];
    if(st&&st[0]==='r'){const c=+st[1];if(!c)return{next:prev,diff:[],movesDelta:0,gameOver:false};let fc=0;for(const[dx,dy]of NB)if(prev[`${x+dx},${y+dy}`]==='flag')fc++;if(fc!==c)return{next:prev,diff:[],movesDelta:0,gameOver:false};const next=mutate?prev:{...prev};const diff=[];let hit=false;const flood=[];for(const[dx,dy]of NB){const nx=x+dx,ny=y+dy,nk=`${nx},${ny}`;if(next[nk])continue;if(checker.isMine(nx,ny)){hit=true;next[nk]='exp';diff.push([nk,'exp'])}else flood.push([nx,ny])}if(hit){if(wrongFlags){for(const k2 in next){if(next[k2]==='flag'){const[a,b]=k2.split(',').map(Number);const nv=checker.isMine(a,b)?'flag-ok':'flag-bad';next[k2]=nv;diff.push([k2,nv])}}}for(let dx2=-35;dx2<=35;dx2++)for(let dy2=-30;dy2<=30;dy2++){const cx2=x+dx2,cy2=y+dy2;const ck2=`${cx2},${cy2}`;if(checker.isMine(cx2,cy2)&&!next[ck2]){next[ck2]='mine';diff.push([ck2,'mine'])}}return{next,diff,movesDelta:0,gameOver:true}}for(const[sx,sy]of flood){const q=[[sx,sy]];while(q.length){const[cx,cy]=q.pop();const ck=`${cx},${cy}`;if(next[ck]||checker.isMine(cx,cy))continue;const mc=checker.countMines(cx,cy);next[ck]='r'+mc;diff.push([ck,'r'+mc]);if(!mc)for(const[dx2,dy2]of NB)q.push([cx+dx2,cy+dy2])}}return{next,diff,movesDelta:1,gameOver:false}}
    if(prev[key])return{next:prev,diff:[],movesDelta:0,gameOver:false};
    const next=mutate?prev:{...prev};const diff=[];
    if(checker.isMine(x,y)){next[key]='exp';diff.push([key,'exp']);if(wrongFlags){for(const k in next){if(next[k]==='flag'){const[a,b]=k.split(',').map(Number);const nv=checker.isMine(a,b)?'flag-ok':'flag-bad';next[k]=nv;diff.push([k,nv])}}}for(let dx=-35;dx<=35;dx++)for(let dy=-30;dy<=30;dy++){const cx=x+dx,cy=y+dy,ck=`${cx},${cy}`;if(checker.isMine(cx,cy)&&!next[ck]){next[ck]='mine';diff.push([ck,'mine'])}}return{next,diff,movesDelta:0,gameOver:true}}
    const q=[[x,y]];while(q.length){const[cx,cy]=q.pop();const ck=`${cx},${cy}`;if(next[ck]||checker.isMine(cx,cy))continue;const mc=checker.countMines(cx,cy);next[ck]='r'+mc;diff.push([ck,'r'+mc]);if(!mc)for(const[dx,dy]of NB)q.push([cx+dx,cy+dy])}
    return{next,diff,movesDelta:1,gameOver:false}
};
window.applyFlag=function(prev,x,y,mutate){const key=`${x},${y}`;const cur=prev[key];if(cur&&cur[0]==='r')return{next:prev,diff:[],flagsDelta:0,changed:false};if(!cur){const next=mutate?prev:{...prev};next[key]='flag';return{next,diff:[[key,'flag']],flagsDelta:1,changed:true}}if(cur==='flag'){const next=mutate?prev:{...prev};next[key]='quest';return{next,diff:[[key,'quest']],flagsDelta:-1,changed:true}}if(cur==='quest'){const next=mutate?prev:{...prev};delete next[key];return{next,diff:[[key,undefined]],flagsDelta:0,changed:true}}return{next:prev,diff:[],flagsDelta:0,changed:false}};
window.applyChordFlag=function(prev,x,y,mutate){
    const key=`${x},${y}`;const st=prev[key];
    if(!st||st[0]!=='r')return{next:prev,diff:[],flagsDelta:0,changed:false};
    const c=+st[1];
    if(!c)return{next:prev,diff:[],flagsDelta:0,changed:false};
    let flagged=0;const toFlag=[];
    for(const[dx,dy]of NB){
        const nk=`${x+dx},${y+dy}`;const ns=prev[nk];
        if(ns==='flag')flagged++;
        else if(!ns)toFlag.push(nk);
    }
    if(flagged+toFlag.length!==c||toFlag.length===0)return{next:prev,diff:[],flagsDelta:0,changed:false};
    const next=mutate?prev:{...prev};const diff=[];
    for(const nk of toFlag){next[nk]='flag';diff.push([nk,'flag'])}
    return{next,diff,flagsDelta:toFlag.length,changed:true};
};
window.replayMoveLog=function(activeSeed,moveLog,wrongFlags,historyRef){
    // fatalIndex: log index of the reveal that hit a mine (-1 if none) — the entry an undo rewrites.
    // It isn't always the last entry: a room can log other players' clicks after it.
    const out={cells:{},moves:0,flags:0,gameOver:false,fatalIndex:-1,firstClick:null,clearedAtLastUndo:null,undoUsedCount:0,finalFlags:{}};
    if(!moveLog||!moveLog.length)return out;
    const seedNum=hashSeed(activeSeed);
    const first=moveLog[0];
    out.firstClick=first&&first[0]==='r'?[first[1],first[2]]:null;
    const checker=mkChecker(seedNum,out.firstClick);
    const cells={};const curFlags={};let clearedRunning=0;
    for(let i=0;i<moveLog.length;i++){const entry=moveLog[i];if(out.gameOver)break;if(!entry||entry.length<3)continue;const[t,x,y]=entry;if(t==='r'){const{diff,movesDelta,gameOver:go}=applyReveal(cells,x,y,checker,wrongFlags,true);if(diff.length){recordFrame(historyRef,diff,curFlags);for(const[,v]of diff){if(v&&v[0]==='r')clearedRunning++}out.moves+=movesDelta;if(go){out.gameOver=true;out.fatalIndex=i}}}else if(t==='f'){const{diff,flagsDelta,changed}=applyFlag(cells,x,y,true);if(changed){applyDiffToFlags(curFlags,diff);out.flags+=flagsDelta}}else if(t==='u'){out.clearedAtLastUndo=clearedRunning;out.undoUsedCount++}}
    out.cells=cells;out.finalFlags=curFlags;return out
};
window.drawCellToCanvas=function(ctx,st,dx,dy,sz){
    ctx.strokeStyle='rgba(55,55,95,0.5)';ctx.lineWidth=1;
    if(st==='exp'){ctx.fillStyle='#e02020';ctx.fillRect(dx,dy,sz,sz);ctx.font=`${sz*0.6}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('💥',dx+sz/2,dy+sz/2)}
    else if(st==='mine'){ctx.fillStyle='#1e1218';ctx.fillRect(dx,dy,sz,sz);ctx.font=`${sz*0.6}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('💣',dx+sz/2,dy+sz/2)}
    else if(st==='flag-ok'||st==='flag-bad'||st==='flag'){let g=ctx.createLinearGradient(dx,dy,dx+sz,dy+sz);if(st==='flag-ok'){g.addColorStop(0,'#1a4a2a');g.addColorStop(1,'#153d22')}else if(st==='flag-bad'){g.addColorStop(0,'#5a1a1a');g.addColorStop(1,'#4a1010')}else{g.addColorStop(0,'#4a2828');g.addColorStop(1,'#381818')}ctx.fillStyle=g;ctx.fillRect(dx,dy,sz,sz);ctx.font=`${sz*0.6}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';if(st==='flag-bad')ctx.globalAlpha=0.7;ctx.fillText('🚩',dx+sz/2,dy+sz/2);if(st==='flag-bad'){ctx.globalAlpha=1;ctx.fillStyle='#ff3333';ctx.font=`900 ${sz*0.5}px sans-serif`;ctx.shadowColor='rgba(255,0,0,0.5)';ctx.shadowBlur=3;ctx.fillText('✕',dx+sz/2,dy+sz/2);ctx.shadowBlur=0}}
    else if(st==='quest'){let g=ctx.createLinearGradient(dx,dy,dx+sz,dy+sz);g.addColorStop(0,'#38385a');g.addColorStop(1,'#2c2c4a');ctx.fillStyle=g;ctx.fillRect(dx,dy,sz,sz);ctx.font=`${sz*0.6}px serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('❓',dx+sz/2,dy+sz/2)}
    else if(st&&st[0]==='r'){ctx.fillStyle='#12122a';ctx.fillRect(dx,dy,sz,sz);const c=+st[1];if(c){ctx.fillStyle=N_COLORS[c]||'#fff';ctx.font=`bold ${sz*0.45}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(c,dx+sz/2,dy+sz/2)}}
    else{let g=ctx.createLinearGradient(dx,dy,dx+sz,dy+sz);g.addColorStop(0,'#38385a');g.addColorStop(1,'#2c2c4a');ctx.fillStyle=g;ctx.fillRect(dx,dy,sz,sz)}
    ctx.strokeRect(dx,dy,sz,sz)
};
window.drawFooterHUD=function(ctx,canvasW,canvasH,footerH,move,total,cleared,flagged){
    ctx.fillStyle='#111128';ctx.fillRect(0,canvasH-footerH,canvasW,footerH);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(footerH/48));ctx.strokeRect(0,canvasH-footerH,canvasW,footerH);
    const fs=Math.round(footerH*0.3),emojiFs=Math.round(footerH*0.35);ctx.textBaseline='middle';
    const cy=canvasH-footerH/2;let ox=footerH*0.4;
    const draw=(label,icon,val)=>{ctx.textAlign='left';ctx.fillStyle='#aaa';ctx.font=`bold ${fs}px sans-serif`;ctx.fillText(label,ox,cy);ox+=ctx.measureText(label).width+footerH*0.1;ctx.font=`${emojiFs}px serif`;ctx.fillText(icon,ox,cy);ox+=footerH*0.45;ctx.fillStyle='#fff';ctx.font=`bold ${fs}px sans-serif`;const s=String(val);ctx.fillText(s,ox,cy);ox+=ctx.measureText(s).width+footerH*0.5};
    draw('Flagged:','🚩',flagged);draw('Moves:','👆',move);draw('Cleared:','🟦',cleared);
    ctx.fillStyle='#888';ctx.font=`bold ${fs}px sans-serif`;ctx.textAlign='right';ctx.fillText(`${move} / ${total}`,canvasW-footerH*0.4,cy)
};
