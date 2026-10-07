// mapimage.js – PNG export of the board.
// Scanlines are assembled from one pre-rendered tile per cell state and streamed through CompressionStream,
// so the full bitmap is never held in memory and exports aren't bound by canvas size limits.
// Output is indexed colour (≤256, visually lossless): about 8× smaller than canvas.toBlob('image/png').

window.MapImage=(function(){
const SIZE_LIMIT=8000000; // bytes; 'auto' exports stay under this
const TILE_STATES=[undefined,'r0','r1','r2','r3','r4','r5','r6','r7','r8','flag','quest','flag-ok','flag-bad','mine','exp'];
const AUTO_SIZES=[32,28,24,20,16,12,10,8,6,5,4,3,2,1];
const SAMPLE_PX=10000000; // estimates encode about this many pixels of evenly spaced tile rows
const CRC=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CRC[n]=c}
function pngChunk(type,data){const b=new Uint8Array(12+data.length),dv=new DataView(b.buffer);dv.setUint32(0,data.length);for(let i=0;i<4;i++)b[4+i]=type.charCodeAt(i);b.set(data,8);let c=-1;for(let i=4;i<8+data.length;i++)c=CRC[(c^b[i])&255]^(c>>>8);dv.setUint32(8+data.length,~c>>>0);return b}

function prepareBoard(cells){
    const keys=Object.keys(cells),xs=new Int32Array(keys.length),ys=new Int32Array(keys.length);
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    keys.forEach((k,i)=>{const c=k.indexOf(','),x=+k.slice(0,c),y=+k.slice(c+1);xs[i]=x;ys[i]=y;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y});
    const pad=2;minX-=pad;maxX+=pad;minY-=pad;maxY+=pad;
    const w=maxX-minX+1,h=maxY-minY+1,grid=new Uint8Array(w*h),used=new Set([0]),idx=new Map(TILE_STATES.map((s,i)=>[s,i]));
    keys.forEach((k,i)=>{const t=idx.get(cells[k])||0;grid[(ys[i]-minY)*w+xs[i]-minX]=t;used.add(t)});
    return{w,h,grid,used,tiles:new Map()};
}

// Each tile is cut from the middle of a 3×3 block so it picks up its neighbours' grid strokes, like a full-canvas render.
// Below 16px text and grid lines turn to mush, so small tiles are drawn at 32px and downscaled instead.
function renderTiles(sz){
    const src=sz>=16?sz:32;
    const c=document.createElement('canvas');c.width=c.height=src*3;const ctx=c.getContext('2d',{willReadFrequently:true});
    return TILE_STATES.map(st=>{
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,src*3,src*3);
        for(let y=0;y<3;y++)for(let x=0;x<3;x++)drawCellToCanvas(ctx,st,x*src,y*src,src);
        if(src===sz)return ctx.getImageData(sz,sz,sz,sz).data;
        let cur=c,off=src,s=src;
        while(s>sz){const n=Math.max(sz,s>>1),t=document.createElement('canvas');t.width=t.height=n;const tc=t.getContext('2d');tc.imageSmoothingQuality='high';tc.drawImage(cur,off,off,s,s,0,0,n,n);cur=t;off=0;s=n}
        return cur.getContext('2d').getImageData(0,0,sz,sz).data;
    });
}
function boardTiles(board,sz){if(!board.tiles.has(sz))board.tiles.set(sz,renderTiles(sz));return board.tiles.get(sz)}

function drawFooter(ctx,W,fh,stats){
    ctx.fillStyle='#111128';ctx.fillRect(0,0,W,fh);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(fh/48));ctx.strokeRect(0,0,W,fh);
    const fs=Math.round(fh*0.3),emojiFs=Math.round(fh*0.35),cy=fh/2;
    ctx.textAlign='left';ctx.textBaseline='middle';let ox=fh*0.4;
    const draw=(l,i,v)=>{
        ctx.fillStyle='#aaa';ctx.font=`bold ${fs}px sans-serif`;ctx.fillText(l,ox,cy);ox+=ctx.measureText(l).width+fh*0.1;
        ctx.font=`${emojiFs}px serif`;ctx.fillText(i,ox,cy);ox+=fh*0.45;
        ctx.fillStyle='#fff';ctx.font=`bold ${fs}px sans-serif`;ctx.fillText(v,ox,cy);ox+=ctx.measureText(v).width+fh*0.6};
    draw('Mines Flagged:','🚩',String(stats.flags));draw('Moves Made:','👆',String(stats.moves));draw('Squares Cleared:','🟦',String(stats.cleared));
}
// Drawn in vertical slices so no canvas exceeds ~4MP (iOS refuses canvases over 16MP); onSlice(rgba,x0,w) gets each one.
function renderFooter(W,fh,stats,onSlice){
    const sw=Math.max(1,Math.min(W,Math.floor(4000000/fh))),c=document.createElement('canvas'),ctx=c.getContext('2d',{willReadFrequently:true});
    for(let x0=0;x0<W;x0+=sw){const w=Math.min(sw,W-x0);c.width=w;c.height=fh;ctx.setTransform(1,0,0,1,-x0,0);drawFooter(ctx,W,fh,stats);onSlice(ctx.getImageData(0,0,w,fh).data,x0,w)}
}

// Weighted k-means down to 256 colours. Each tile type counts equally, so rare tiles (💥) keep their colours;
// a cluster dominated by one colour snaps to it, so flat fills stay exact.
function buildPalette(weights){
    const cols=[...weights.keys()];
    if(cols.length<=256)return{palette:cols,index:new Map(cols.map((c,i)=>[c,i]))};
    const n=cols.length,k=256,R=new Float64Array(n),G=new Float64Array(n),B=new Float64Array(n),W=new Float64Array(n),md=new Float64Array(n).fill(Infinity),as=new Int32Array(n),cen=[];
    cols.forEach((c,i)=>{R[i]=c>>16;G[i]=c>>8&255;B[i]=c&255;W[i]=weights.get(c)});
    const add=j=>{cen.push([R[j],G[j],B[j]]);for(let i=0;i<n;i++){const d=(R[i]-R[j])**2+(G[i]-G[j])**2+(B[i]-B[j])**2;if(d<md[i])md[i]=d}};
    let first=0;for(let i=1;i<n;i++)if(W[i]>W[first])first=i;
    add(first);while(cen.length<k){let bj=0,bs=-1;for(let i=0;i<n;i++){const s=md[i]*Math.sqrt(W[i]);if(s>bs){bs=s;bj=i}}add(bj)}
    for(let it=0;it<12;it++){
        for(let i=0;i<n;i++){let bd=Infinity,bj=0;for(let j=0;j<k;j++){const c=cen[j],d=(R[i]-c[0])**2+(G[i]-c[1])**2+(B[i]-c[2])**2;if(d<bd){bd=d;bj=j}}as[i]=bj}
        const acc=cen.map(()=>[0,0,0,0]);for(let i=0;i<n;i++){const a=acc[as[i]];a[0]+=R[i]*W[i];a[1]+=G[i]*W[i];a[2]+=B[i]*W[i];a[3]+=W[i]}
        acc.forEach((a,j)=>{if(a[3])cen[j]=[a[0]/a[3],a[1]/a[3],a[2]/a[3]]});
    }
    const top=new Int32Array(k).fill(-1),tot=new Float64Array(k);
    for(let i=0;i<n;i++){const j=as[i];tot[j]+=W[i];if(top[j]<0||W[i]>W[top[j]])top[j]=i}
    const palette=cen.map((c,j)=>top[j]>=0&&W[top[j]]*2>=tot[j]?cols[top[j]]:Math.round(c[0])<<16|Math.round(c[1])<<8|Math.round(c[2]));
    return{palette,index:new Map(cols.map((c,i)=>[c,as[i]]))};
}
function addWeights(weights,px,step,wt){for(let i=0;i<px.length;i+=step){const c=px[i]<<16|px[i+1]<<8|px[i+2];weights.set(c,(weights.get(c)||0)+wt)}}
function toIndices(px,step,index){const o=new Uint8Array(px.length/step);let last=-1,li=0;for(let i=0,j=0;i<px.length;i+=step,j++){const c=px[i]<<16|px[i+1]<<8|px[i+2];if(c!==last){last=c;li=index.get(c)}o[j]=li}return o}

// Awaiting the compressor only resolves microtasks, which never let the page paint or take a click. A
// MessageChannel message is a real task (and isn't throttled in background tabs like setTimeout).
const yieldPort=typeof MessageChannel!=='undefined'?new MessageChannel():null,yieldQueue=[];
if(yieldPort)yieldPort.port1.onmessage=()=>{const r=yieldQueue.shift();if(r)r()};
const yieldTask=()=>new Promise(r=>{if(yieldPort){yieldQueue.push(r);yieldPort.port2.postMessage(0)}else setTimeout(r,0)});

// onChunk(fractionDone) runs after each ~1MB handed to the compressor; it may throw to abort.
async function encodePng(W,H,palette,rows,onChunk){
    const ihdr=new Uint8Array(13),dv=new DataView(ihdr.buffer);dv.setUint32(0,W);dv.setUint32(4,H);ihdr[8]=8;ihdr[9]=3;
    const plte=new Uint8Array(palette.length*3);palette.forEach((c,i)=>{plte[i*3]=c>>16;plte[i*3+1]=c>>8&255;plte[i*3+2]=c&255});
    const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('PLTE',plte)];
    const cs=new CompressionStream('deflate'),wr=cs.writable.getWriter(),rd=cs.readable.getReader();
    const reading=(async()=>{for(;;){const{done,value}=await rd.read();if(done)return;parts.push(pngChunk('IDAT',value))}})();
    // Filter type 0 on every row: tiles repeat, so deflate's back-references already beat PNG's prediction filters.
    let buf=new Uint8Array(Math.max(1<<20,W+1)),n=0,done=0,lastYield=performance.now();
    try{
        for(const row of rows){
            if(n+W+1>buf.length){
                await wr.write(buf.subarray(0,n));buf=new Uint8Array(buf.length);n=0;
                if(performance.now()-lastYield>40){await yieldTask();lastYield=performance.now()}
                if(onChunk)onChunk(done/H);
            }
            buf[n]=0;buf.set(row,n+1);n+=W+1;done++;
        }
        if(n)await wr.write(buf.subarray(0,n));
        await wr.close();await reading;
    }catch(e){reading.catch(()=>{});wr.abort(e).catch(()=>{});throw e}
    parts.push(pngChunk('IEND',new Uint8Array(0)));
    return new Blob(parts,{type:'image/png'});
}
function* gridRows(board,sz,tiles,step){
    const{w,h,grid}=board,row=new Uint8Array(w*sz);
    for(let ty=step>>1;ty<h;ty+=step){const g=ty*w;for(let r=0,off=0;r<sz;r++,off+=sz){
        if(sz>=8)for(let tx=0;tx<w;tx++)row.set(tiles[grid[g+tx]].subarray(off,off+sz),tx*sz);
        else for(let tx=0,o=0;tx<w;tx++){const t=tiles[grid[g+tx]];for(let i=0;i<sz;i++)row[o++]=t[off+i]}
        yield row}}
}
function* footerRows(idx,W,fh){for(let y=0;y<fh;y++)yield idx.subarray(y*W,(y+1)*W)}

async function encodeBoard(board,sz,stats,step=1,onChunk){
    const rgba=boardTiles(board,sz),weights=new Map();
    for(const t of board.used)addWeights(weights,rgba[t],4,1);
    const W=board.w*sz,gridH=sampledRows(board.h,step)*sz,fh=stats?Math.round(board.h*sz*0.04/0.96):0;
    // The footer is drawn twice (count colours, then map them) rather than holding its RGB; it weighs as much as two tile types.
    if(fh>0)renderFooter(W,fh,stats,d=>addWeights(weights,d,4,2*sz*sz/(W*fh)));
    const{palette,index}=buildPalette(weights);
    const tiles=rgba.map((t,i)=>board.used.has(i)?toIndices(t,4,index):null);
    let fidx=null;
    if(fh>0){fidx=new Uint8Array(W*fh);renderFooter(W,fh,stats,(d,x0,w)=>{const s=toIndices(d,4,index);for(let y=0;y<fh;y++)fidx.set(s.subarray(y*w,(y+1)*w),y*W+x0)})}
    return encodePng(W,gridH+fh,palette,(function*(){yield*gridRows(board,sz,tiles,step);if(fidx)yield*footerRows(fidx,W,fh)})(),onChunk);
}
// Compressed size of the grid alone, extrapolated from tile rows taken mid-stride (the edges are always blank padding).
const sampledRows=(h,step)=>Math.ceil((h-(step>>1))/step);
async function estimateBytes(board,sz,onChunk){
    const step=Math.max(1,Math.ceil(board.w*board.h*sz*sz/SAMPLE_PX));
    const blob=await encodeBoard(board,sz,null,step,onChunk);
    return blob.size*board.h/sampledRows(board.h,step);
}

// res: 'auto' picks the largest cell size whose PNG fits in limit bytes; otherwise a cell size in px.
// confirmLarge(bytes) is asked before a fixed-size export over the limit; returns null if it declines.
// hooks.onProgress({phase: 'estimate'|'encode', sz, done}) reports progress; hooks.signal (AbortSignal)
// cancels, rejecting with an AbortError.
async function render(cells,stats,res,confirmLarge,limit=SIZE_LIMIT,hooks={}){
    const check=()=>{if(hooks.signal&&hooks.signal.aborted)throw new DOMException('Export cancelled','AbortError')};
    const progress=(phase,sz,done)=>{if(hooks.onProgress)hooks.onProgress({phase,sz,done})};
    const board=prepareBoard(cells);
    const estimate=sz=>{check();progress('estimate',sz,0);return estimateBytes(board,sz,check)};
    const encode=sz=>{check();progress('encode',sz,0);return encodeBoard(board,sz,stats,1,f=>{check();progress('encode',sz,f)})};
    if(res!=='auto'){
        const sz=Math.max(1,Math.min(32,parseInt(res,10)||32));
        if(confirmLarge){const est=await estimate(sz);if(est>limit&&!confirmLarge(est))return null}
        return{blob:await encode(sz),sz};
    }
    for(let i=0;;){
        const sz=AUTO_SIZES[i],last=i===AUTO_SIZES.length-1,est=await estimate(sz);
        if(est<=limit||last){const blob=await encode(sz);if(blob.size<=limit||last)return{blob,sz}}
        // Compressed size never falls faster than pixel count, so skip sizes that can't fit even at that rate.
        i++;while(i<AUTO_SIZES.length-1&&est*(AUTO_SIZES[i]/sz)**2>limit)i++;
    }
}
return{render};
})();
