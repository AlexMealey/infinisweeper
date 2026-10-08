// timelapse.js – MP4 timelapse export. Replays the move log and encodes as it goes, handing the video off in Blob
// pieces, so memory stays flat however long the game. H.264 at a standard profile and level, so Windows' player opens it.

window.Timelapse=(function(){
const MIN_BORDER_CELLS=2;
const BORDER_SHARE=0.05; // unopened border around the board, as a share of its longer side
const TILE_STATES=[undefined,'r0','r1','r2','r3','r4','r5','r6','r7','r8','flag','quest','flag-ok','flag-bad','mine','exp'];
const TILE_INDEX=new Map(TILE_STATES.map((s,i)=>[s,i]));
const SPEEDS=[1,2,4,8,16,32]; // moves per frame
// Total pixels for each size option; frames take the board's shape rather than 16:9.
const PIXEL_BUDGETS={'720':1280*720,'1080':1920*1080,'1440':2560*1440,'2160':3840*2160};
const MIN_SIDE=480,MAX_SIDE=4096; // 4096px is the longest side hardware encoders and decoders reliably take
// [level_idc, max macroblocks per frame, max macroblocks per second, max kbit/s], up to 5.1, which every decoder supports.
const H264_LEVELS=[[30,1620,40500,10000],[31,3600,108000,14000],[32,5120,216000,20000],[40,8192,245760,20000],[42,8704,522240,50000],[50,22080,589824,135000],[51,36864,983040,240000]];
const H264_PROFILES=['4d00','6400','42e0']; // Main, High, Constrained Baseline: all play on Windows out of the box
// Frames are converted to YUV here (see createFrameBuffers), so they're labelled with the matrix used.
const COLOR_SPACE={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
const MAX_FILE_BYTES=50e6;
const KEYFRAME_SECONDS=10; // keyframes are most of the file; every 10s halves it versus every 2s and still seeks fine
const roundUpToEven=n=>n+(n&1);
const frameTime=(frame,fps)=>Math.round(frame*1e6/fps); // in microseconds
// Yields to the event loop. Unlike setTimeout, MessageChannel isn't clamped or throttled in background tabs,
// so a long export keeps its speed when the user switches away.
const yieldChannel=typeof MessageChannel!=='undefined'?new MessageChannel():null,yieldQueue=[];
if(yieldChannel)yieldChannel.port1.onmessage=()=>{const resume=yieldQueue.shift();if(resume)resume()};
const yieldToBrowser=()=>new Promise(resolve=>{if(yieldChannel){yieldQueue.push(resolve);yieldChannel.port2.postMessage(0)}else setTimeout(resolve,0)});

// Each move that changed the board, as {diff, flagsDelta}. Mirrors replayMoveLog in game.js.
function* replaySteps(seed,moveLog,showWrongFlags){
    const first=moveLog[0],firstClick=first&&first[0]==='r'?[first[1],first[2]]:null;
    const minefield=createMinefield(hashSeed(seed),firstClick),cells={};
    for(const entry of moveLog){
        if(!entry||entry.length<3)continue;const[type,x,y]=entry;
        if(type==='r'){const{diff,gameOver}=applyReveal(cells,x,y,minefield,showWrongFlags,true);if(diff.length)yield{diff,flagsDelta:0};if(gameOver)return}
        else if(type==='f'){const{diff,flagsDelta,changed}=applyFlag(cells,x,y,true);if(changed)yield{diff,flagsDelta}}
    }
}
// Version 1 saves have no move log, only recorded frames of {diff, flags snapshot}. Yields {diff, flagged}.
function* v1FrameSteps(frames){
    let prevFlags={};
    for(const frame of frames){
        const diff=frame.diff.slice(),inDiff=new Set(diff.map(d=>d[0])),flags=frame.flags||{};
        for(const k of new Set([...Object.keys(prevFlags),...Object.keys(flags)]))if(!inDiff.has(k)&&flags[k]!==prevFlags[k])diff.push([k,flags[k]]);
        let flagged=0;for(const k in flags)if(flags[k]!=='quest')flagged++;
        prevFlags=flags;yield{diff,flagged};
    }
}
const boardSteps=source=>source.frames?v1FrameSteps(source.frames):replaySteps(source.seed,source.moveLog,source.wrongFlags);
const parseKey=key=>{const c=key.indexOf(',');return[+key.slice(0,c),+key.slice(c+1)]};

// A canvas per tile state, cut from the middle of a 3×3 block so grid lines match a full render.
// Below 16px text and grid lines turn to mush, so small tiles are drawn at 32px and scaled down.
function renderTiles(size){
    const drawSize=size>=16?size:32,canvas=document.createElement('canvas');canvas.width=canvas.height=drawSize*3;const ctx=canvas.getContext('2d');
    return TILE_STATES.map(state=>{
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,drawSize*3,drawSize*3);
        for(let y=0;y<3;y++)for(let x=0;x<3;x++)drawCellToCanvas(ctx,state,x*drawSize,y*drawSize,drawSize);
        let src=canvas,srcOffset=drawSize,srcSize=drawSize;
        do{const n=Math.max(size,srcSize>>1),t=document.createElement('canvas');t.width=t.height=n;const tc=t.getContext('2d');tc.imageSmoothingQuality='high';tc.drawImage(src,srcOffset,srcOffset,srcSize,srcSize,0,0,n,n);src=t;srcOffset=0;srcSize=n}while(srcSize>size);
        return src;
    });
}
// Each tile's average colour, for boards drawn at under a pixel per cell.
function averageTileColours(){
    return renderTiles(32).map(tile=>{const d=tile.getContext('2d').getImageData(0,0,32,32).data;let r=0,g=0,b=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2]}const n=d.length/4;return[r/n,g/n,b/n]});
}

function pickH264Level(width,height,fps,bitrate){
    const mbCols=Math.ceil(width/16),mbRows=Math.ceil(height/16),macroblocks=mbCols*mbRows;
    return H264_LEVELS.find(([,maxPerFrame,maxPerSecond,maxKbps])=>macroblocks<=maxPerFrame&&macroblocks*fps<=maxPerSecond&&bitrate<=maxKbps*1000&&Math.max(mbCols,mbRows)<=Math.sqrt(8*maxPerFrame))||null;
}
// 0.1 bits a pixel. Frames barely change, so this mostly sets how big a keyframe may be, and a starved keyframe
// leaves the board blurred until the next. An encoder that does spend it all is caught by the size cap.
const targetBitrate=(width,height,fps)=>Math.round(Math.min(30e6,Math.max(5e5,width*height*fps*0.1)));
// Frame size, cell size and board placement for a board of cols × rows cells, border included.
function planFrame(cols,rows,res,fps){
    // Auto uses the 1080p budget with cells up to 24px; fixed sizes allow up to 64px.
    const budget=PIXEL_BUDGETS[res]||PIXEL_BUDGETS['1080'],maxCellSize=PIXEL_BUDGETS[res]?64:24;
    let cellSize=Math.min(maxCellSize,Math.sqrt(budget*0.96/(cols*rows)),MAX_SIDE/cols,MAX_SIDE*0.96/rows);
    if(cellSize>=1)cellSize=Math.floor(cellSize);
    for(;;){
        const scaledW=Math.ceil(cols*cellSize),scaledH=Math.ceil(rows*cellSize),footerH=Math.max(48,Math.round(scaledH/24));
        // A small board still gets a usable frame; the extra space fills with unopened cells.
        const width=roundUpToEven(Math.max(MIN_SIDE,scaledW)),height=roundUpToEven(Math.max(MIN_SIDE,scaledH+footerH));
        const bitrate=targetBitrate(width,height,fps),level=pickH264Level(width,height,fps,bitrate);
        if(level){
            const layout={width,height,footerH,level:level[0],bitrate};
            if(cellSize>=1){layout.tileSize=cellSize;layout.boardW=cols*cellSize;layout.boardH=rows*cellSize}
            else{layout.minimapScale=cellSize;layout.boardW=Math.floor((cols-1)*cellSize)+1;layout.boardH=Math.floor((rows-1)*cellSize)+1}
            // Even offsets keep each cell's colour in its own 2×2 chroma blocks, so edges don't bleed into neighbours.
            layout.offsetX=((width-layout.boardW)>>1)&~1;layout.offsetY=((height-footerH-layout.boardH)>>1)&~1;
            return layout;
        }
        cellSize=cellSize>1?cellSize-1:cellSize*0.95; // too big for H.264 level 5.1
    }
}
async function findSupportedCodec(layout,fps){
    for(const profile of H264_PROFILES){
        const config={codec:`avc1.${profile}${layout.level.toString(16)}`,width:layout.width,height:layout.height,bitrate:layout.bitrate,framerate:fps,avc:{format:'avc'}};
        try{const support=await VideoEncoder.isConfigSupported(config);if(support&&support.supported)return config}catch(e){console.error('Codec support check failed for',config.codec,e)}
    }
    return null;
}

// A frame as RGBA, which tiles and text are drawn into, and as I420 (BT.709 limited range), which encoders take
// without converting it themselves. convertToYuv(x0, y0, x1, y1) converts a changed rectangle.
function createFrameBuffers(width,height){
    const rgba=new Uint8ClampedArray(width*height*4),yuv=new Uint8Array(width*height*3/2),chromaW=width>>1,uStart=width*height,vStart=uStart+chromaW*(height>>1);
    // Widened to whole 2×2 chroma blocks. Uint8Array stores truncate, hence the +0.5s.
    const convertToYuv=(x0,y0,x1,y1)=>{
        x0=Math.max(0,x0&~1);y0=Math.max(0,y0&~1);x1=Math.min(width,x1+(x1&1));y1=Math.min(height,y1+(y1&1));
        for(let y=y0;y<y1;y+=2){
            for(let x=x0,top=(y*width+x0)*4,bottom=top+width*4,luma=y*width+x0,chroma=(y>>1)*chromaW+(x0>>1);x<x1;x+=2,top+=8,bottom+=8,luma+=2,chroma++){
                const r0=rgba[top],g0=rgba[top+1],b0=rgba[top+2],r1=rgba[top+4],g1=rgba[top+5],b1=rgba[top+6];
                const r2=rgba[bottom],g2=rgba[bottom+1],b2=rgba[bottom+2],r3=rgba[bottom+4],g3=rgba[bottom+5],b3=rgba[bottom+6];
                yuv[luma]=16.5+0.18259*r0+0.61423*g0+0.06201*b0;yuv[luma+1]=16.5+0.18259*r1+0.61423*g1+0.06201*b1;
                yuv[luma+width]=16.5+0.18259*r2+0.61423*g2+0.06201*b2;yuv[luma+width+1]=16.5+0.18259*r3+0.61423*g3+0.06201*b3;
                const r=r0+r1+r2+r3,g=g0+g1+g2+g3,b=b0+b1+b2+b3;
                yuv[uStart+chroma]=128.5+(-0.10067*r-0.33856*g+0.43922*b)*0.25;
                yuv[vStart+chroma]=128.5+(0.43922*r-0.39894*g-0.04027*b)*0.25;
            }
        }
    };
    return{rgba,rgba32:new Uint32Array(rgba.buffer),yuv,convertToYuv};
}

// The stats footer under the board, laid out once with each number in a slot wide enough for its largest value.
// Each frame redraws only the numbers that changed, from pre-rendered glyphs, straight into the frame buffers.
function createFooter(frame,width,top,height,{moves,maxCleared,maxFlagged}){
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const stats=[['Flagged:','🚩',maxFlagged],['Moves:','👆',moves],['Cleared:','🟦',maxCleared]];
    const widestCounter=`${moves} / ${moves}`,digitCount=v=>String(Math.max(0,v)).length;
    const layoutAtScale=scale=>{
        const fontSize=Math.round(height*0.3*scale),font=`bold ${fontSize}px sans-serif`;
        ctx.font=font;let digitW=0;for(let d=0;d<10;d++)digitW=Math.max(digitW,ctx.measureText(String(d)).width);
        let x=height*0.4;const slots=[];
        for(const[label,,max]of stats){const labelX=x;x+=ctx.measureText(label).width+height*0.1*scale;const iconX=x;x+=height*0.45*scale;slots.push({labelX,iconX,valueX:x,valueW:digitCount(max)*digitW});x+=digitCount(max)*digitW+height*0.5*scale}
        return{scale,font,slots,widthNeeded:x+ctx.measureText(widestCounter).width+height*0.4};
    };
    let layout=layoutAtScale(1);
    for(let scale=0.95;layout.widthNeeded>width&&scale>0.4;scale-=0.05)layout=layoutAtScale(scale); // shrink to fit a narrow frame
    const counterRight=width-height*0.4,midY=height/2;
    // The parts that never change: background, border, labels and icons.
    ctx.fillStyle='#111128';ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(height/48));ctx.strokeRect(0,0,width,height);
    ctx.textBaseline='middle';ctx.textAlign='left';
    stats.forEach(([label,icon],i)=>{const slot=layout.slots[i];ctx.fillStyle='#aaa';ctx.font=layout.font;ctx.fillText(label,slot.labelX,midY);ctx.font=`${Math.round(height*0.35*layout.scale)}px serif`;ctx.fillText(icon,slot.iconX,midY)});
    const background=ctx.getImageData(0,0,width,height).data;
    // Glyph coverage masks, cut to the rows that have ink. GLYPH_PAD covers antialiasing that spills past the advance.
    const GLYPH_PAD=3;
    const renderGlyphs=(font,chars,rgb)=>{
        const glyphs={};
        for(const ch of chars){
            ctx.font=font;const advance=ctx.measureText(ch).width,w=Math.ceil(advance)+GLYPH_PAD*2;
            ctx.clearRect(0,0,w,height);ctx.fillStyle='#fff';ctx.textAlign='left';ctx.fillText(ch,GLYPH_PAD,midY);
            const d=ctx.getImageData(0,0,w,height).data;let inkTop=height,inkBottom=0;
            for(let r=0;r<height;r++)for(let x=0;x<w;x++)if(d[(r*w+x)*4+3]){if(r<inkTop)inkTop=r;inkBottom=r+1;break}
            const alpha=new Uint8Array(w*Math.max(0,inkBottom-inkTop));for(let r=inkTop;r<inkBottom;r++)for(let x=0;x<w;x++)alpha[(r-inkTop)*w+x]=d[(r*w+x)*4+3];
            glyphs[ch]={advance,w,top:inkTop,alpha};
        }
        return{rgb,glyphs};
    };
    const valueGlyphs=renderGlyphs(layout.font,'0123456789',[255,255,255]),counterGlyphs=renderGlyphs(layout.font,'0123456789 /',[136,136,136]);
    const textWidth=(glyphSet,text)=>{let w=0;for(const ch of text)w+=glyphSet.glyphs[ch].advance;return w};
    // Restores a slot from the static footer, blends its text in, and converts the slot to YUV.
    const drawSlot=(glyphSet,text,x0,x1,penX)=>{
        x0=Math.max(0,Math.floor(x0));x1=Math.min(width,Math.ceil(x1));
        for(let y=0;y<height;y++)frame.rgba.set(background.subarray((y*width+x0)*4,(y*width+x1)*4),((top+y)*width+x0)*4);
        const[R,G,B]=glyphSet.rgb,px=frame.rgba;
        for(const ch of text){
            const glyph=glyphSet.glyphs[ch],gx=Math.round(penX)-GLYPH_PAD,rows=glyph.alpha.length/glyph.w;
            for(let r=0;r<rows;r++){let o=((top+glyph.top+r)*width+gx)*4;for(let x=0,ai=r*glyph.w;x<glyph.w;x++,ai++,o+=4){const a=glyph.alpha[ai];if(a){const t=a/255;px[o]+=(R-px[o])*t;px[o+1]+=(G-px[o+1])*t;px[o+2]+=(B-px[o+2])*t}}}
            penX+=glyph.advance;
        }
        frame.convertToYuv(x0,top,x1,top+height);
    };
    const shownText=['','','',''],counterW=textWidth(counterGlyphs,widestCounter);
    for(let y=0;y<height;y++)frame.rgba.set(background.subarray(y*width*4,(y+1)*width*4),(top+y)*width*4);
    frame.convertToYuv(0,top,width,top+height);
    return{update(movesDone,cleared,flagged){
        [flagged,movesDone,cleared].forEach((value,i)=>{const text=String(value);if(text===shownText[i])return;shownText[i]=text;const slot=layout.slots[i];drawSlot(valueGlyphs,text,slot.valueX-GLYPH_PAD,slot.valueX+slot.valueW+GLYPH_PAD*2,slot.valueX)});
        const counter=`${movesDone} / ${moves}`;if(counter!==shownText[3]){shownText[3]=counter;drawSlot(counterGlyphs,counter,counterRight-counterW-GLYPH_PAD*2,counterRight+GLYPH_PAD*2,counterRight-textWidth(counterGlyphs,counter))}
    }};
}

// MP4 output as Blob pieces. The muxer only rewrites its header region (ftyp, the space it reserved for moov,
// and the mdat header), so that stays an editable buffer and everything after it is append-only.
function createBlobTarget(){
    const pieces=[],headerWrites=[];let header=null,length=0;
    const target=new Mp4Muxer.StreamTarget({onData:(data,pos)=>{
        if(!header){headerWrites.push([data.slice(),pos]);return}
        if(pos<header.length){if(pos+data.byteLength>header.length)throw new Error('MP4 header overflow');header.set(data,pos);return}
        if(pos!==length)throw new Error('MP4 data written out of order');
        pieces.push(new Blob([data]));length+=data.byteLength;
    }});
    return{target,
        sealHeader(){header=new Uint8Array(Math.max(...headerWrites.map(([d,p])=>p+d.byteLength)));for(const[d,p]of headerWrites)header.set(d,p);length=header.length},
        blob:()=>new Blob([header,...pieces],{type:'video/mp4'})};
}

// Rebuilds decode times, which WebCodecs doesn't report. Encoders may reorder frames and shift their timestamps
// (Firefox's do both); chunks arrive in decode order, and the reordering depth is learnt from the first ones.
function createDecodeTimeline(fps,firstFrame,onChunk){
    const LEARN_CHUNKS=24,pending=[];let ptsShift=0,reorderDepth=-1,chunkCount=0;
    const emit=([chunk,meta])=>{
        const pts=chunk.timestamp;let dts=frameTime(firstFrame+chunkCount-reorderDepth,fps)+ptsShift;chunkCount++;
        // Encoders round to their own timebase, so a decode time can land a microsecond past its frame's.
        if(dts>pts){if(dts-pts>frameTime(1,fps)/2)throw new Error('The video encoder reorders frames more than expected');dts=pts}
        onChunk(chunk,meta,pts,pts-dts);
    };
    const learnReordering=()=>{
        ptsShift=pending[0][0].timestamp-frameTime(firstFrame,fps); // a segment starts on a keyframe, which is also its first frame shown
        reorderDepth=0;pending.forEach(([chunk],k)=>{const shown=Math.round((chunk.timestamp-ptsShift)*fps/1e6)-firstFrame;if(k-shown>reorderDepth)reorderDepth=k-shown});
        pending.splice(0).forEach(emit);
    };
    return{
        add(chunk,meta){if(reorderDepth>=0)emit([chunk,meta]);else{pending.push([chunk,meta]);if(pending.length>=LEARN_CHUNKS)learnReordering()}},
        flush(){if(reorderDepth<0&&pending.length)learnReordering()},
    };
}

// The browser's H.264 encoder (WebCodecs) for one segment of the video. Encoded chunks go to onChunk(chunk, meta).
function createWebCodecsEncoder(config,bitrate,width,height,fps,frame,onChunk){
    let fallbackCanvas=null;
    const makeVideoFrame=(timestamp,duration)=>{
        if(!fallbackCanvas){
            try{return new VideoFrame(frame.yuv,{format:'I420',codedWidth:width,codedHeight:height,timestamp,duration,colorSpace:COLOR_SPACE})}
            catch(e){console.error('YUV video frames unsupported, drawing through a canvas instead',e);const c=document.createElement('canvas');c.width=width;c.height=height;fallbackCanvas={canvas:c,ctx:c.getContext('2d',{alpha:false})}}
        }
        fallbackCanvas.ctx.putImageData(new ImageData(frame.rgba,width,height),0,0);
        return new VideoFrame(fallbackCanvas.canvas,{timestamp,duration,alpha:'discard'});
    };
    let encoderError=null;
    const encoder=new VideoEncoder({output:(chunk,meta)=>{try{onChunk(chunk,meta)}catch(e){encoderError=encoderError||e}},error:e=>{encoderError=encoderError||e}});
    encoder.configure({...config,bitrate});
    // 'dequeue' says when the encoder took a frame; older browsers poll.
    const hasDequeue='ondequeue' in encoder;
    const waitForDequeue=()=>new Promise(resolve=>{const t=setTimeout(resolve,hasDequeue?50:2);if(hasDequeue)encoder.addEventListener('dequeue',()=>{clearTimeout(t);resolve()},{once:true})});
    return{
        async add(frameNumber,keyFrame){
            const videoFrame=makeVideoFrame(frameTime(frameNumber,fps),frameTime(frameNumber+1,fps)-frameTime(frameNumber,fps));
            encoder.encode(videoFrame,{keyFrame:keyFrame||frameNumber%(fps*KEYFRAME_SECONDS)===0});videoFrame.close();
            while(encoder.encodeQueueSize>4&&!encoderError)await waitForDequeue();
            if(encoderError)throw encoderError;
        },
        async finish(){await encoder.flush();if(encoderError)throw encoderError},
        close(){if(encoder.state!=='closed')encoder.close()},
    };
}

// Browsers only offer VideoEncoder on secure pages (https:// or localhost), so on plain http:// a WebAssembly
// H.264 encoder (h264-mp4-encoder, MIT) takes over. It's slower, and only loaded when needed.
const WASM_ENCODER_URLS=['lib/h264-mp4-encoder.web.js','https://cdn.jsdelivr.net/npm/h264-mp4-encoder@1.0.12/embuild/dist/h264-mp4-encoder.web.js'];
let wasmEncoderLoading=null;
function loadWasmEncoder(){
    if(window.HME)return Promise.resolve(window.HME);
    if(!wasmEncoderLoading)wasmEncoderLoading=(async()=>{
        for(const src of WASM_ENCODER_URLS){
            try{
                await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('could not load '+src))};document.head.appendChild(script)});
                if(window.HME)return window.HME;
            }catch(e){console.error('WebAssembly video encoder failed to load from',src,e)}
        }
        wasmEncoderLoading=null;throw new Error('The video encoder could not be loaded');
    })();
    return wasmEncoderLoading;
}
// Reads an MP4 just far enough to get each H.264 sample and the avcC decoder config.
function readMp4Samples(mp4){
    const dv=new DataView(mp4.buffer,mp4.byteOffset,mp4.byteLength);
    const findBox=(start,end,type)=>{
        for(let pos=start;pos+8<=end;){
            let size=dv.getUint32(pos),headerSize=8;
            if(size===1){size=Number(dv.getBigUint64(pos+8));headerSize=16}else if(size===0)size=end-pos;
            if(String.fromCharCode(mp4[pos+4],mp4[pos+5],mp4[pos+6],mp4[pos+7])===type)return{start:pos+headerSize,end:pos+size};
            pos+=size;
        }
        return null;
    };
    let stbl={start:0,end:mp4.length};
    for(const type of ['moov','trak','mdia','minf','stbl']){stbl=findBox(stbl.start,stbl.end,type);if(!stbl)throw new Error('Encoder output has no '+type+' box')}
    const inStbl=type=>findBox(stbl.start,stbl.end,type);
    const stsd=inStbl('stsd'),avc1=findBox(stsd.start+8,stsd.end,'avc1'),avcC=avc1&&findBox(avc1.start+78,avc1.end,'avcC'); // 78: VisualSampleEntry fields
    const stsz=inStbl('stsz'),stsc=inStbl('stsc'),stco=inStbl('stco'),co64=inStbl('co64');
    if(!avcC||!stsz||!stsc||!(stco||co64))throw new Error('Encoder output is missing its sample tables');
    const uniformSize=dv.getUint32(stsz.start+4),count=dv.getUint32(stsz.start+8),sizes=new Uint32Array(count);
    for(let i=0;i<count;i++)sizes[i]=uniformSize||dv.getUint32(stsz.start+12+i*4);
    const chunkOffsets=stco||co64,chunkCount=dv.getUint32(chunkOffsets.start+4),samplesPerChunk=[];
    for(let i=0,runs=dv.getUint32(stsc.start+4);i<runs;i++)samplesPerChunk.push([dv.getUint32(stsc.start+8+i*12),dv.getUint32(stsc.start+12+i*12)]);
    const offsets=new Float64Array(count);
    for(let c=0,i=0;c<chunkCount&&i<count;c++){
        let inChunk=0;for(const[firstChunk,samples]of samplesPerChunk)if(c+1>=firstChunk)inChunk=samples;
        let offset=stco?dv.getUint32(chunkOffsets.start+8+c*4):Number(dv.getBigUint64(chunkOffsets.start+8+c*8));
        for(let j=0;j<inChunk&&i<count;j++,i++){offsets[i]=offset;offset+=sizes[i]}
    }
    return{avcC:mp4.slice(avcC.start,avcC.end),sizes,offsets,count};
}
// The WebAssembly encoder's MP4 has no sync-sample table, so players can't seek it (Windows stops decoding after a
// few seconds), and it declares a fixed level. Its samples are remuxed with the real keyframes and level.
function remuxWasmOutput(mp4,width,height,fps,level){
    const{avcC,sizes,offsets,count}=readMp4Samples(mp4),lengthSize=(avcC[4]&3)+1;
    avcC[3]=level;if(((avcC[6]<<8)|avcC[7])>3)avcC[11]=level; // AVCLevelIndication, and level_idc in the SPS
    const hex=b=>b.toString(16).padStart(2,'0');
    const meta={decoderConfig:{codec:`avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(level)}`,codedWidth:width,codedHeight:height,description:avcC,colorSpace:COLOR_SPACE}};
    const out=createBlobTarget();
    const muxer=new Mp4Muxer.Muxer({target:out.target,video:{codec:'avc',width,height,frameRate:fps},fastStart:{expectedVideoChunks:count},firstTimestampBehavior:'offset'});
    out.sealHeader();
    for(let i=0;i<count;i++){
        const sample=mp4.subarray(offsets[i],offsets[i]+sizes[i]);let isKeyframe=false;
        for(let pos=0;pos+lengthSize<sample.length;){
            let len=0;for(let b=0;b<lengthSize;b++)len=len*256+sample[pos+b];
            const type=sample[pos+lengthSize]&31;
            if(type===5)isKeyframe=true;
            if(type===7&&len>3)sample[pos+lengthSize+3]=level; // an in-band SPS
            pos+=lengthSize+len;
        }
        muxer.addVideoChunkRaw(sample,isKeyframe?'key':'delta',frameTime(i,fps),frameTime(i+1,fps)-frameTime(i,fps),i===0?meta:undefined);
    }
    muxer.finalize();
    return out.blob();
}
async function createWasmEncoder(bitrate,width,height,fps,level,frame){
    const HME=await loadWasmEncoder(),encoder=await HME.createH264MP4Encoder();
    encoder.width=width;encoder.height=height;encoder.frameRate=fps;encoder.kbps=Math.max(50,Math.round(bitrate/1000));
    encoder.groupOfPictures=fps*KEYFRAME_SECONDS;encoder.speed=10; // fastest; it's already far slower than WebCodecs
    encoder.initialize();
    const takesYuv=typeof encoder.addFrameYuv==='function'; // then it skips its own colour conversion
    let alive=true,finalized=false;
    // Deleting an unfinalized encoder aborts the WebAssembly module, which every export in the page shares,
    // so a cancelled export finalizes first and throws the partial file away.
    const release=()=>{
        if(!alive)return;alive=false;
        try{if(!finalized)encoder.finalize();encoder.delete()}catch(e){console.error('Could not free the video encoder',e)}
        try{encoder.FS.unlink(encoder.outputFilename)}catch(e){}
    };
    return{
        async add(){if(takesYuv)encoder.addFrameYuv(frame.yuv);else encoder.addFrameRgba(frame.rgba)},
        async finish(){encoder.finalize();finalized=true;const mp4=encoder.FS.readFile(encoder.outputFilename);release();return remuxWasmOutput(mp4,width,height,fps,level)},
        close:release,
    };
}

// source: {seed, moveLog, wrongFlags}, or {frames} from a version 1 save. hooks: {signal, onProgress, confirmPlan}, where
// confirmPlan(plan) may return false to cancel or {movesPerFrame}. Resolves to {blob, ...}, {empty}, {tooBig} or null.
async function render(source,options,hooks={}){
    const fps=+options.fps===30?30:60;
    let movesPerFrame=SPEEDS.includes(+options.movesPerFrame)?+options.movesPerFrame:1;
    const res=PIXEL_BUDGETS[options.res]?options.res:'auto',signal=hooks.signal,ABORTED={};
    let lastReport=0;
    const report=(phase,done,total,force)=>{const now=performance.now();if(hooks.onProgress&&(force||now-lastReport>100)){lastReport=now;hooks.onProgress({phase,done,total})}};
    const throwIfAborted=()=>{if(signal&&signal.aborted)throw ABORTED};
    try{
    // First pass: board bounds, move count and the largest footer numbers.
    const logLength=source.frames?source.frames.length:source.moveLog.length;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,moves=0,maxCleared=0,maxFlagged=0,lastYield=performance.now();
    report('prepare',0,logLength,true);
    {let cleared=0,flagged=0;
    for(const step of boardSteps(source)){
        moves++;for(const[key,state]of step.diff){const[x,y]=parseKey(key);if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(state&&state[0]==='r')cleared++}
        flagged=step.flagged!==undefined?step.flagged:flagged+step.flagsDelta;if(flagged>maxFlagged)maxFlagged=flagged;
        if(performance.now()-lastYield>40){await yieldToBrowser();lastYield=performance.now();throwIfAborted();report('prepare',moves,logLength)}
    }
    maxCleared=cleared}
    if(!moves)return{empty:true};
    const border=Math.max(MIN_BORDER_CELLS,Math.ceil(Math.max(maxX-minX+1,maxY-minY+1)*BORDER_SHARE));
    minX-=border;maxX+=border;minY-=border;maxY+=border;
    const cols=maxX-minX+1,rows=maxY-minY+1;

    let layout=null,codecConfig=null;
    // If the browser's encoder refuses this size, fall back to smaller budgets; without one, use WebAssembly.
    if(typeof VideoEncoder!=='undefined')for(const r of [res,...['1440','1080','720'].filter(r=>PIXEL_BUDGETS[r]<(PIXEL_BUDGETS[res]||PIXEL_BUDGETS['1080']))]){
        layout=planFrame(cols,rows,r,fps);codecConfig=await findSupportedCodec(layout,fps);if(codecConfig)break;
    }
    const useWasm=!codecConfig;
    if(useWasm){
        if(typeof WebAssembly==='undefined')throw new Error('This device cannot encode H.264 video');
        layout=planFrame(cols,rows,res,fps);
    }
    if(hooks.confirmPlan){
        // msPerFrame: a rough export-time guide for the WebAssembly encoder (about 8ms a frame at 1600×1132).
        const answer=await hooks.confirmPlan({moves,fps,movesPerFrame,speeds:SPEEDS,frames:Math.ceil(moves/movesPerFrame)+fps,seconds:(Math.ceil(moves/movesPerFrame)+fps)/fps,width:layout.width,height:layout.height,slow:useWasm,msPerFrame:useWasm?2+6.5*layout.width*layout.height/(1600*1132):0});
        if(answer===false)return null;
        if(answer&&SPEEDS.includes(+answer.movesPerFrame))movesPerFrame=+answer.movesPerFrame;
    }
    throwIfAborted();
    const moveFrames=Math.ceil(moves/movesPerFrame),totalFrames=moveFrames+fps; // then hold the final board for a second
    const{width,height}=layout,boardAreaH=height-layout.footerH;
    const tiles=layout.tileSize?renderTiles(layout.tileSize).map(c=>new Uint32Array(c.getContext('2d').getImageData(0,0,layout.tileSize,layout.tileSize).data.buffer)):null;
    const tileColours=layout.tileSize?null:averageTileColours();

    // Plain buffers rather than a canvas, since a canvas-backed VideoFrame costs a GPU readback per frame. While
    // board.live is off, drawCell skips the YUV conversion, for replaying up to the start of a later segment.
    const createBoardFrame=()=>{
        const frame=createFrameBuffers(width,height),{rgba,rgba32,convertToYuv}=frame,board={frame,live:true};
        if(layout.tileSize){
            const size=layout.tileSize;
            // Unopened cells fill the whole frame, lined up with the board, so any spare space reads as more board.
            const hiddenRows=[];for(let r=0;r<size;r++){const row=new Uint32Array(width);for(let x=0;x<width;x++)row[x]=tiles[0][r*size+(((x-layout.offsetX)%size)+size)%size];hiddenRows.push(row)}
            for(let y=0;y<boardAreaH;y++)rgba32.set(hiddenRows[(((y-layout.offsetY)%size)+size)%size],y*width);
            board.drawCell=(x,y,tile)=>{
                const pixels=tiles[tile],px=layout.offsetX+(x-minX)*size,py=layout.offsetY+(y-minY)*size,o=py*width+px;
                if(size===1)rgba32[o]=pixels[0];else for(let r=0;r<size;r++)rgba32.set(pixels.subarray(r*size,r*size+size),o+r*width);
                if(board.live)convertToYuv(px,py,px+size,py+size);
            };
        }else{
            // Each pixel shows the average colour of the cells that land on it, kept as running sums.
            const scale=layout.minimapScale,pixelCount=layout.boardW*layout.boardH,cellsInPixel=new Uint32Array(pixelCount),sums=new Float32Array(pixelCount*3),shownTile=new Uint8Array(cols*rows);
            const pixelOf=(cx,cy)=>Math.floor(cy*scale)*layout.boardW+Math.floor(cx*scale);
            for(let cy=0;cy<rows;cy++)for(let cx=0;cx<cols;cx++)cellsInPixel[pixelOf(cx,cy)]++;
            const hidden=tileColours[0].map(Math.round);
            for(let i=0;i<width*boardAreaH;i++){rgba[i*4]=hidden[0];rgba[i*4+1]=hidden[1];rgba[i*4+2]=hidden[2];rgba[i*4+3]=255}
            for(let i=0;i<pixelCount;i++)for(let c=0;c<3;c++)sums[i*3+c]=cellsInPixel[i]*tileColours[0][c];
            board.drawCell=(x,y,tile)=>{
                const cx=x-minX,cy=y-minY,ci=cy*cols+cx,oldTile=shownTile[ci];if(oldTile===tile)return;shownTile[ci]=tile;
                const i=pixelOf(cx,cy),oldColour=tileColours[oldTile],newColour=tileColours[tile],fx=layout.offsetX+i%layout.boardW,fy=layout.offsetY+((i/layout.boardW)|0),o=(fy*width+fx)*4;
                for(let c=0;c<3;c++){sums[i*3+c]+=newColour[c]-oldColour[c];rgba[o+c]=sums[i*3+c]/cellsInPixel[i]}
                if(board.live)convertToYuv(fx,fy,fx+1,fy+1);
            };
        }
        convertToYuv(0,0,width,boardAreaH);
        board.footer=createFooter(frame,width,boardAreaH,layout.footerH,{moves,maxCleared,maxFlagged});
        return board;
    };

    // Software encoders use about one core each, so long videos are cut in two and both halves encode side by
    // side (1.6× faster in testing). Hardware encoders are fast already and may cap how many run at once.
    let splitInTwo=!useWasm&&moveFrames>=1200&&(navigator.hardwareConcurrency||1)>=4;
    if(splitInTwo)try{const hw=await VideoEncoder.isConfigSupported({...codecConfig,hardwareAcceleration:'prefer-hardware'});splitInTwo=!(hw&&hw.supported)}catch(e){splitInTwo=false}
    const isOversize=e=>e&&e.oversize,HALVES_DIFFER={};

    // One full encode at the given bitrate, redrawing the board from scratch.
    const encodeVideo=async(bitrate,phase,segmentCount)=>{
        report(phase,0,totalFrames,true);
        const ranges=segmentCount>1?[[0,Math.floor(moveFrames/2)],[Math.floor(moveFrames/2),totalFrames]]:[[0,totalFrames]];
        const out=useWasm?null:createBlobTarget(),muxer=useWasm?null:new Mp4Muxer.Muxer({target:out.target,video:{codec:'avc',width,height,frameRate:fps},fastStart:{expectedVideoChunks:totalFrames},firstTimestampBehavior:'offset'});
        if(out)out.sealHeader();
        // A later segment starts on a keyframe, and its chunks are held until the segments before it are in the file.
        const segments=ranges.map(([start,end],k)=>({start,end,held:k?[]:null,config:null,bytes:0,encoder:null}));
        let framesEncoded=0,stopped=false;
        const sameBytes=(a,b)=>{if(!a||!b)return!a&&!b;const x=new Uint8Array(a.buffer||a,a.byteOffset||0,a.byteLength),y=new Uint8Array(b.buffer||b,b.byteOffset||0,b.byteLength);if(x.length!==y.length)return false;for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;return true};
        // Gives up on a file heading past the cap as soon as that's clear, to re-encode at a bitrate scaled to fit.
        const checkProjectedSize=()=>{
            const bytes=segments.reduce((sum,s)=>sum+s.bytes,0),projected=bytes*totalFrames/Math.max(1,framesEncoded);
            if(bytes>MAX_FILE_BYTES||(framesEncoded>totalFrames*0.1&&bytes>MAX_FILE_BYTES*0.25&&projected>MAX_FILE_BYTES*1.05))throw{oversize:Math.max(projected,bytes)};
        };
        const encodeSegment=async segment=>{
            const board=createBoardFrame(),{drawCell,footer}=board;board.live=segment.start===0;
            const timeline=useWasm?null:createDecodeTimeline(fps,segment.start,(chunk,meta,pts,compositionOffset)=>{
                const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
                if(segment.held)segment.held.push([data,chunk.type,pts,compositionOffset]);else muxer.addVideoChunkRaw(data,chunk.type,pts,frameTime(1,fps),meta,compositionOffset);
            });
            segment.encoder=useWasm?await createWasmEncoder(bitrate,width,height,fps,layout.level,board.frame):createWebCodecsEncoder(codecConfig,bitrate,width,height,fps,board.frame,(chunk,meta)=>{
                segment.bytes+=chunk.byteLength;
                const repair=window.repairAvcDecoderConfig;
                if(repair&&meta&&meta.decoderConfig&&meta.decoderConfig.description){
                    const keyframe=new Uint8Array(chunk.byteLength);chunk.copyTo(keyframe);
                    meta={...meta,decoderConfig:{...meta.decoderConfig,description:repair(meta.decoderConfig.description,keyframe)}};
                }
                if(!segment.config&&meta&&meta.decoderConfig)segment.config=meta.decoderConfig;
                timeline.add(chunk,meta);
            });
            let frameNumber=0,movesDone=0,cleared=0,flagged=0;
            const emitFrame=async()=>{
                if(frameNumber<segment.start){frameNumber++;return}
                if(!board.live){board.live=true;board.frame.convertToYuv(0,0,width,boardAreaH)}
                footer.update(movesDone,cleared,flagged);
                await segment.encoder.add(frameNumber,frameNumber===segment.start);frameNumber++;framesEncoded++;
                if(performance.now()-lastYield>40){await yieldToBrowser();lastYield=performance.now()}
                if(stopped)throw ABORTED;
                throwIfAborted();if(!useWasm)checkProjectedSize();report(phase,framesEncoded,totalFrames);
            };
            for(const step of boardSteps(source)){
                if(frameNumber>=segment.end)break;
                for(const[key,state]of step.diff){const[x,y]=parseKey(key);drawCell(x,y,TILE_INDEX.get(state)||0);if(state&&state[0]==='r')cleared++}
                flagged=step.flagged!==undefined?step.flagged:flagged+step.flagsDelta;
                movesDone++;if(movesDone%movesPerFrame===0||movesDone===moves)await emitFrame();
            }
            while(frameNumber<segment.end)await emitFrame();
            const result=await segment.encoder.finish();
            if(timeline)timeline.flush();
            return result;
        };
        try{
            const results=await Promise.all(segments.map(s=>encodeSegment(s).catch(e=>{stopped=true;throw e})));
            report('finish',totalFrames,totalFrames,true);
            if(useWasm)return results[0];
            // The halves only make one stream if both encoders described it identically (they do in practice);
            // if not, the export starts over in one piece.
            const firstConfig=segments[0].config;
            for(const segment of segments.slice(1))if(!firstConfig||!segment.config||segment.config.codec!==firstConfig.codec||!sameBytes(segment.config.description,firstConfig.description))throw HALVES_DIFFER;
            try{for(const segment of segments.slice(1))for(const[data,type,pts,compositionOffset]of segment.held)muxer.addVideoChunkRaw(data,type,pts,frameTime(1,fps),undefined,compositionOffset)}
            catch(e){console.error('Could not join the video halves, encoding in one piece instead',e);throw HALVES_DIFFER}
            muxer.finalize();
            return out.blob();
        }finally{stopped=true;for(const s of segments)if(s.encoder)s.encoder.close()}
    };

    // Scaled from the bitrate actually produced, not the target: some encoders (Firefox's) level off well below a
    // high target, so scaling the target alone could miss the cap again.
    const bitrateToFit=bytes=>Math.floor(Math.min(bitrate,bytes*8/(totalFrames/fps))*MAX_FILE_BYTES*0.85/bytes);
    let bitrate=layout.bitrate,blob=null;
    for(let attempt=0;attempt<3&&!blob;attempt++){
        try{blob=await encodeVideo(bitrate,attempt?'retry':'encode',splitInTwo?2:1)}
        catch(e){
            if(e===HALVES_DIFFER){splitInTwo=false;attempt--;continue}
            if(!isOversize(e))throw e;
            bitrate=bitrateToFit(e.oversize);continue;
        }
        if(blob.size>MAX_FILE_BYTES){bitrate=bitrateToFit(blob.size);blob=null} // encoders can still overshoot
    }
    if(!blob)return{tooBig:true,limit:MAX_FILE_BYTES};
    return{blob,width,height,seconds:totalFrames/fps,moves,movesPerFrame,codec:useWasm?'wasm':codecConfig.codec,slow:useWasm,bitrate,segments:splitInTwo?2:1};
    }catch(e){if(e===ABORTED)return null;throw e}
}
return{render,SPEEDS};
})();
