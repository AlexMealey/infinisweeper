// mapimage.js – PNG export of the board. Rows are assembled from one pre-rendered tile per cell state and
// compressed as they're made, so the full bitmap is never in memory. Indexed colour keeps files about 8× smaller.

window.MapImage=(function(){
const AUTO_LIMIT_BYTES=8000000;
const TILE_STATES=[undefined,'r0','r1','r2','r3','r4','r5','r6','r7','r8','flag','quest','flag-ok','flag-bad','mine','exp'];
const AUTO_CELL_SIZES=[32,28,24,20,16,12,10,8,6,5,4,3,2,1];
const ESTIMATE_SAMPLE_PIXELS=10000000;
const CRC_TABLE=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;CRC_TABLE[n]=c}
function pngChunk(type,data){const b=new Uint8Array(12+data.length),dv=new DataView(b.buffer);dv.setUint32(0,data.length);for(let i=0;i<4;i++)b[4+i]=type.charCodeAt(i);b.set(data,8);let crc=-1;for(let i=4;i<8+data.length;i++)crc=CRC_TABLE[(crc^b[i])&255]^(crc>>>8);dv.setUint32(8+data.length,~crc>>>0);return b}

// The board as a grid of tile indices, with a 2-cell border.
function buildTileGrid(cells){
    const keys=Object.keys(cells),xs=new Int32Array(keys.length),ys=new Int32Array(keys.length);
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    keys.forEach((k,i)=>{const c=k.indexOf(','),x=+k.slice(0,c),y=+k.slice(c+1);xs[i]=x;ys[i]=y;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y});
    const border=2;minX-=border;maxX+=border;minY-=border;maxY+=border;
    const cols=maxX-minX+1,rows=maxY-minY+1,grid=new Uint8Array(cols*rows),usedTiles=new Set([0]),tileIndex=new Map(TILE_STATES.map((s,i)=>[s,i]));
    keys.forEach((k,i)=>{const t=tileIndex.get(cells[k])||0;grid[(ys[i]-minY)*cols+xs[i]-minX]=t;usedTiles.add(t)});
    return{cols,rows,grid,usedTiles,tileCache:new Map()};
}

// RGBA for each tile state, cut from the middle of a 3×3 block so it picks up its neighbours' grid lines.
// Below 16px text and grid lines turn to mush, so small tiles are drawn at 32px and scaled down.
function renderTiles(size){
    const drawSize=size>=16?size:32;
    const canvas=document.createElement('canvas');canvas.width=canvas.height=drawSize*3;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    return TILE_STATES.map(state=>{
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,drawSize*3,drawSize*3);
        for(let y=0;y<3;y++)for(let x=0;x<3;x++)drawCellToCanvas(ctx,state,x*drawSize,y*drawSize,drawSize);
        if(drawSize===size)return ctx.getImageData(size,size,size,size).data;
        let src=canvas,srcOffset=drawSize,srcSize=drawSize;
        while(srcSize>size){const n=Math.max(size,srcSize>>1),t=document.createElement('canvas');t.width=t.height=n;const tc=t.getContext('2d');tc.imageSmoothingQuality='high';tc.drawImage(src,srcOffset,srcOffset,srcSize,srcSize,0,0,n,n);src=t;srcOffset=0;srcSize=n}
        return src.getContext('2d').getImageData(0,0,size,size).data;
    });
}
function tilesAtSize(board,size){if(!board.tileCache.has(size))board.tileCache.set(size,renderTiles(size));return board.tileCache.get(size)}

function drawFooter(ctx,width,height,stats){
    ctx.fillStyle='#111128';ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(height/48));ctx.strokeRect(0,0,width,height);
    const fontSize=Math.round(height*0.3),iconSize=Math.round(height*0.35),midY=height/2;
    ctx.textAlign='left';ctx.textBaseline='middle';let penX=height*0.4;
    const drawStat=(label,icon,value)=>{
        ctx.fillStyle='#aaa';ctx.font=`bold ${fontSize}px sans-serif`;ctx.fillText(label,penX,midY);penX+=ctx.measureText(label).width+height*0.1;
        ctx.font=`${iconSize}px serif`;ctx.fillText(icon,penX,midY);penX+=height*0.45;
        ctx.fillStyle='#fff';ctx.font=`bold ${fontSize}px sans-serif`;ctx.fillText(value,penX,midY);penX+=ctx.measureText(value).width+height*0.6};
    drawStat('Mines Flagged:','🚩',String(stats.flags));drawStat('Moves Made:','👆',String(stats.moves));drawStat('Squares Cleared:','🟦',String(stats.cleared));
}
// Drawn in vertical slices of at most ~4MP (iOS refuses canvases over 16MP); onSlice(rgba, x, width) gets each.
function renderFooterSlices(width,height,stats,onSlice){
    const sliceW=Math.max(1,Math.min(width,Math.floor(4000000/height))),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});
    for(let x0=0;x0<width;x0+=sliceW){const w=Math.min(sliceW,width-x0);canvas.width=w;canvas.height=height;ctx.setTransform(1,0,0,1,-x0,0);drawFooter(ctx,width,height,stats);onSlice(ctx.getImageData(0,0,w,height).data,x0,w)}
}

// Weighted k-means down to 256 colours. Each tile type counts equally, so rare tiles (💥) keep their colours,
// and a cluster dominated by one colour snaps to it, so flat fills stay exact.
function buildPalette(weights){
    const colours=[...weights.keys()];
    if(colours.length<=256)return{palette:colours,index:new Map(colours.map((c,i)=>[c,i]))};
    const n=colours.length,k=256,R=new Float64Array(n),G=new Float64Array(n),B=new Float64Array(n),W=new Float64Array(n);
    const distToCentre=new Float64Array(n).fill(Infinity),cluster=new Int32Array(n),centres=[];
    colours.forEach((c,i)=>{R[i]=c>>16;G[i]=c>>8&255;B[i]=c&255;W[i]=weights.get(c)});
    const addCentre=j=>{centres.push([R[j],G[j],B[j]]);for(let i=0;i<n;i++){const d=(R[i]-R[j])**2+(G[i]-G[j])**2+(B[i]-B[j])**2;if(d<distToCentre[i])distToCentre[i]=d}};
    // Seeded with the heaviest colour, then the one weighing most against its distance from any centre.
    let heaviest=0;for(let i=1;i<n;i++)if(W[i]>W[heaviest])heaviest=i;
    addCentre(heaviest);while(centres.length<k){let best=0,bestScore=-1;for(let i=0;i<n;i++){const s=distToCentre[i]*Math.sqrt(W[i]);if(s>bestScore){bestScore=s;best=i}}addCentre(best)}
    for(let iter=0;iter<12;iter++){
        for(let i=0;i<n;i++){let bestDist=Infinity,best=0;for(let j=0;j<k;j++){const c=centres[j],d=(R[i]-c[0])**2+(G[i]-c[1])**2+(B[i]-c[2])**2;if(d<bestDist){bestDist=d;best=j}}cluster[i]=best}
        const sums=centres.map(()=>[0,0,0,0]);for(let i=0;i<n;i++){const s=sums[cluster[i]];s[0]+=R[i]*W[i];s[1]+=G[i]*W[i];s[2]+=B[i]*W[i];s[3]+=W[i]}
        sums.forEach((s,j)=>{if(s[3])centres[j]=[s[0]/s[3],s[1]/s[3],s[2]/s[3]]});
    }
    const topColour=new Int32Array(k).fill(-1),clusterWeight=new Float64Array(k);
    for(let i=0;i<n;i++){const j=cluster[i];clusterWeight[j]+=W[i];if(topColour[j]<0||W[i]>W[topColour[j]])topColour[j]=i}
    const palette=centres.map((c,j)=>topColour[j]>=0&&W[topColour[j]]*2>=clusterWeight[j]?colours[topColour[j]]:Math.round(c[0])<<16|Math.round(c[1])<<8|Math.round(c[2]));
    return{palette,index:new Map(colours.map((c,i)=>[c,cluster[i]]))};
}
function addColourWeights(weights,rgba,weight){for(let i=0;i<rgba.length;i+=4){const c=rgba[i]<<16|rgba[i+1]<<8|rgba[i+2];weights.set(c,(weights.get(c)||0)+weight)}}
function toPaletteIndices(rgba,index){const out=new Uint8Array(rgba.length/4);let last=-1,lastIndex=0;for(let i=0,j=0;i<rgba.length;i+=4,j++){const c=rgba[i]<<16|rgba[i+1]<<8|rgba[i+2];if(c!==last){last=c;lastIndex=index.get(c)}out[j]=lastIndex}return out}

// Lets the page paint and take clicks mid-export; awaiting the compressor alone only runs microtasks.
// MessageChannel, unlike setTimeout, isn't throttled in background tabs.
const yieldChannel=typeof MessageChannel!=='undefined'?new MessageChannel():null,yieldQueue=[];
if(yieldChannel)yieldChannel.port1.onmessage=()=>{const resume=yieldQueue.shift();if(resume)resume()};
const yieldToBrowser=()=>new Promise(resolve=>{if(yieldChannel){yieldQueue.push(resolve);yieldChannel.port2.postMessage(0)}else setTimeout(resolve,0)});

// rows yields each scanline as palette indices. onProgress(fraction) runs after each ~1MB and may throw to abort.
async function encodePng(width,height,palette,rows,onProgress){
    const ihdr=new Uint8Array(13),dv=new DataView(ihdr.buffer);dv.setUint32(0,width);dv.setUint32(4,height);ihdr[8]=8;ihdr[9]=3;
    const plte=new Uint8Array(palette.length*3);palette.forEach((c,i)=>{plte[i*3]=c>>16;plte[i*3+1]=c>>8&255;plte[i*3+2]=c&255});
    const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('PLTE',plte)];
    const deflate=new CompressionStream('deflate'),writer=deflate.writable.getWriter(),reader=deflate.readable.getReader();
    const collectOutput=(async()=>{for(;;){const{done,value}=await reader.read();if(done)return;parts.push(pngChunk('IDAT',value))}})();
    // Filter type 0 on every row: tiles repeat, so deflate's back-references already beat PNG's prediction filters.
    let batch=new Uint8Array(Math.max(1<<20,width+1)),batchLen=0,rowsDone=0,lastYield=performance.now();
    try{
        for(const row of rows){
            if(batchLen+width+1>batch.length){
                await writer.write(batch.subarray(0,batchLen));batch=new Uint8Array(batch.length);batchLen=0;
                if(performance.now()-lastYield>40){await yieldToBrowser();lastYield=performance.now()}
                if(onProgress)onProgress(rowsDone/height);
            }
            batch[batchLen]=0;batch.set(row,batchLen+1);batchLen+=width+1;rowsDone++;
        }
        if(batchLen)await writer.write(batch.subarray(0,batchLen));
        await writer.close();await collectOutput;
    }catch(e){collectOutput.catch(()=>{});writer.abort(e).catch(()=>{});throw e}
    parts.push(pngChunk('IEND',new Uint8Array(0)));
    return new Blob(parts,{type:'image/png'});
}
// Scanlines of every rowStep-th tile row, starting mid-stride.
function* boardScanlines(board,size,tiles,rowStep){
    const{cols,rows,grid}=board,line=new Uint8Array(cols*size);
    for(let ty=rowStep>>1;ty<rows;ty+=rowStep){const g=ty*cols;for(let r=0,off=0;r<size;r++,off+=size){
        if(size>=8)for(let tx=0;tx<cols;tx++)line.set(tiles[grid[g+tx]].subarray(off,off+size),tx*size);
        else for(let tx=0,o=0;tx<cols;tx++){const t=tiles[grid[g+tx]];for(let i=0;i<size;i++)line[o++]=t[off+i]}
        yield line}}
}
function* footerScanlines(indices,width,height){for(let y=0;y<height;y++)yield indices.subarray(y*width,(y+1)*width)}

async function encodeBoard(board,size,stats,rowStep=1,onProgress){
    const tilesRgba=tilesAtSize(board,size),weights=new Map();
    for(const t of board.usedTiles)addColourWeights(weights,tilesRgba[t],1);
    const width=board.cols*size,boardH=sampledRowCount(board.rows,rowStep)*size,footerH=stats?Math.round(board.rows*size*0.04/0.96):0;
    // The footer is drawn twice (count its colours, then index them) rather than held as RGBA. It weighs as much as two tile types.
    if(footerH>0)renderFooterSlices(width,footerH,stats,rgba=>addColourWeights(weights,rgba,2*size*size/(width*footerH)));
    const{palette,index}=buildPalette(weights);
    const tiles=tilesRgba.map((t,i)=>board.usedTiles.has(i)?toPaletteIndices(t,index):null);
    let footer=null;
    if(footerH>0){footer=new Uint8Array(width*footerH);renderFooterSlices(width,footerH,stats,(rgba,x0,w)=>{const s=toPaletteIndices(rgba,index);for(let y=0;y<footerH;y++)footer.set(s.subarray(y*w,(y+1)*w),y*width+x0)})}
    return encodePng(width,boardH+footerH,palette,(function*(){yield*boardScanlines(board,size,tiles,rowStep);if(footer)yield*footerScanlines(footer,width,footerH)})(),onProgress);
}
const sampledRowCount=(rows,rowStep)=>Math.ceil((rows-(rowStep>>1))/rowStep);
// PNG size of the board without its footer, scaled up from a sample of its tile rows.
async function estimateBytes(board,size,onProgress){
    const rowStep=Math.max(1,Math.ceil(board.cols*board.rows*size*size/ESTIMATE_SAMPLE_PIXELS));
    const blob=await encodeBoard(board,size,null,rowStep,onProgress);
    return blob.size*board.rows/sampledRowCount(board.rows,rowStep);
}

// res: a cell size in px, or 'auto' for the largest that fits in limit bytes. confirmLarge(bytes) is asked before a
// fixed-size export over the limit; declining resolves to null. hooks: {signal, onProgress({phase, sz, done})}.
async function render(cells,stats,res,confirmLarge,limit=AUTO_LIMIT_BYTES,hooks={}){
    const throwIfAborted=()=>{if(hooks.signal&&hooks.signal.aborted)throw new DOMException('Export cancelled','AbortError')};
    const report=(phase,size,done)=>{if(hooks.onProgress)hooks.onProgress({phase,sz:size,done})};
    const board=buildTileGrid(cells);
    const estimate=size=>{throwIfAborted();report('estimate',size,0);return estimateBytes(board,size,throwIfAborted)};
    const encode=size=>{throwIfAborted();report('encode',size,0);return encodeBoard(board,size,stats,1,fraction=>{throwIfAborted();report('encode',size,fraction)})};
    if(res!=='auto'){
        const size=Math.max(1,Math.min(32,parseInt(res,10)||32));
        if(confirmLarge){const bytes=await estimate(size);if(bytes>limit&&!confirmLarge(bytes))return null}
        return{blob:await encode(size),sz:size};
    }
    for(let i=0;;){
        const size=AUTO_CELL_SIZES[i],smallest=i===AUTO_CELL_SIZES.length-1,bytes=await estimate(size);
        if(bytes<=limit||smallest){const blob=await encode(size);if(blob.size<=limit||smallest)return{blob,sz:size}}
        // Compressed size never falls faster than pixel count, so skip sizes that can't fit even at that rate.
        i++;while(i<AUTO_CELL_SIZES.length-1&&bytes*(AUTO_CELL_SIZES[i]/size)**2>limit)i++;
    }
}
return{render};
})();
