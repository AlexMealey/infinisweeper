// timelapse.js – MP4 timelapse export.
// Replays the move log one step at a time and encodes as it goes: no per-move history is kept, and
// the encoded video is handed off in Blob pieces (Chrome keeps those out of the page's memory), so
// memory stays flat however long the game is. Output is H.264 in MP4 at a standard profile and level,
// which Windows 11's built-in player decodes without any extra codecs.

window.Timelapse=(function(){
const PAD=2;
const TILE_STATES=[undefined,'r0','r1','r2','r3','r4','r5','r6','r7','r8','flag','quest','flag-ok','flag-bad','mine','exp'];
const TILE_INDEX=new Map(TILE_STATES.map((s,i)=>[s,i]));
const SPEEDS=[1,2,4,8,16,32]; // moves per frame
// Pixels per size option. Frames take the board's shape rather than a fixed 16:9, so these set the total, not the sides.
const BUDGETS={'720':1280*720,'1080':1920*1080,'1440':2560*1440,'2160':3840*2160};
const MIN_SIDE=480,MAX_SIDE=4096; // 4096px is the longest side hardware encoders and decoders reliably take
const BUFFER=0.05; // unopened border around the finished board, as a share of its longer side
// H.264 levels as [level_idc, max macroblocks per frame, max macroblocks per second, max kbit/s].
// They stop at 5.1 (4K at 30 fps): higher levels aren't guaranteed on every decoder.
const LEVELS=[[30,1620,40500,10000],[31,3600,108000,14000],[32,5120,216000,20000],[40,8192,245760,20000],[42,8704,522240,50000],[50,22080,589824,135000],[51,36864,983040,240000]];
// Main, High, then Constrained Baseline for encoders that only do that. All three play on Windows out of the box.
const PROFILES=['4d00','6400','42e0'];
// Frames are converted to YUV here, so they're labelled with the matrix used; players then convert back exactly.
const COLOR_SPACE={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
const even=n=>n+(n&1);
// Yields to the event loop. Unlike setTimeout, MessageChannel isn't clamped to 4ms or throttled in background
// tabs, so a long export keeps its speed when the user switches away.
const yieldPort=typeof MessageChannel!=='undefined'?new MessageChannel():null,yieldQueue=[];
if(yieldPort)yieldPort.port1.onmessage=()=>{const r=yieldQueue.shift();if(r)r()};
const tick=()=>new Promise(r=>{if(yieldPort){yieldQueue.push(r);yieldPort.port2.postMessage(0)}else setTimeout(r,0)});

function* replaySteps(seed,moveLog,wrongFlags){
    // Mirrors replayMoveLog, yielding each move that changed the board instead of recording it.
    const first=moveLog[0],firstClick=first&&first[0]==='r'?[first[1],first[2]]:null;
    const checker=mkChecker(hashSeed(seed),firstClick),cells={};
    for(const entry of moveLog){
        if(!entry||entry.length<3)continue;const[t,x,y]=entry;
        if(t==='r'){const{diff,gameOver}=applyReveal(cells,x,y,checker,wrongFlags,true);if(diff.length)yield{diff,flagsDelta:0};if(gameOver)return}
        else if(t==='f'){const{diff,flagsDelta,changed}=applyFlag(cells,x,y,true);if(changed)yield{diff,flagsDelta}}
    }
}
// Version 1 saves have no move log, only recorded frames of {diff, flags snapshot}.
function* frameSteps(frames){
    let prev={};
    for(const fr of frames){
        const diff=fr.diff.slice(),seen=new Set(diff.map(d=>d[0])),flags=fr.flags||{};
        for(const k of new Set([...Object.keys(prev),...Object.keys(flags)]))if(!seen.has(k)&&flags[k]!==prev[k])diff.push([k,flags[k]]);
        let flagged=0;for(const k in flags)if(flags[k]!=='quest')flagged++;
        prev=flags;yield{diff,flagged};
    }
}
const stepsOf=src=>src.frames?frameSteps(src.frames):replaySteps(src.seed,src.moveLog,src.wrongFlags);
const keyXY=k=>{const c=k.indexOf(',');return[+k.slice(0,c),+k.slice(c+1)]};

// One canvas per cell state, cut from the middle of a 3×3 block so grid lines match a full render.
// Below 16px text and grid lines turn to mush, so small tiles are drawn at 32px and downscaled.
function renderTiles(S){
    const src=S>=16?S:32,c=document.createElement('canvas');c.width=c.height=src*3;const ctx=c.getContext('2d');
    return TILE_STATES.map(st=>{
        ctx.fillStyle='#0c0c1e';ctx.fillRect(0,0,src*3,src*3);
        for(let y=0;y<3;y++)for(let x=0;x<3;x++)drawCellToCanvas(ctx,st,x*src,y*src,src);
        let cur=c,off=src,s=src;
        do{const n=Math.max(S,s>>1),t=document.createElement('canvas');t.width=t.height=n;const tc=t.getContext('2d');tc.imageSmoothingQuality='high';tc.drawImage(cur,off,off,s,s,0,0,n,n);cur=t;off=0;s=n}while(s>S);
        return cur;
    });
}
function tileColours(){
    const tiles=renderTiles(32);
    return tiles.map(t=>{const d=t.getContext('2d').getImageData(0,0,32,32).data;let r=0,g=0,b=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2]}const n=d.length/4;return[r/n,g/n,b/n]});
}

function pickLevel(W,H,fps,bitrate){
    const mbw=Math.ceil(W/16),mbh=Math.ceil(H/16),mbs=mbw*mbh;
    return LEVELS.find(([,fs,mbps,br])=>mbs<=fs&&mbs*fps<=mbps&&bitrate<=br*1000&&Math.max(mbw,mbh)<=Math.sqrt(8*fs))||null;
}
// Target bitrate. Frames barely change, so encoders use a fraction of it on all but keyframes; what the target
// really sets is how big a keyframe may be, and a starved keyframe leaves the whole board blurred until the
// next. 0.1 bits a pixel gave keyframes 3-15× the size of the old 0.02, for files 5-25% bigger. An encoder
// that does spend it all is caught by the size guard in render().
const bitrateFor=(W,H,fps)=>Math.round(Math.min(30e6,Math.max(5e5,W*H*fps*0.1)));
const SIZE_CAP=50e6; // hard limit on an exported video, in bytes
const KEYFRAME_SECONDS=10; // keyframes are most of the file; every 10s halves it versus every 2s and still seeks fine
// Frame size, cell size and board placement. bw/bh are the board size in cells, border included.
function planFrame(bw,bh,res,fps){
    // Auto uses the 1080p budget but keeps cells at 24px or less; fixed sizes allow up to 64px.
    const budget=BUDGETS[res]||BUDGETS['1080'],maxS=BUDGETS[res]?64:24;
    let s=Math.min(maxS,Math.sqrt(budget*0.96/(bw*bh)),MAX_SIDE/bw,MAX_SIDE*0.96/bh);
    if(s>=1)s=Math.floor(s);
    for(;;){
        const boardW=Math.ceil(bw*s),boardH=Math.ceil(bh*s),footerH=Math.max(48,Math.round(boardH/24));
        // A small board still gets a usable frame; the extra space fills with unopened cells.
        const W=even(Math.max(MIN_SIDE,boardW)),H=even(Math.max(MIN_SIDE,boardH+footerH));
        const bitrate=bitrateFor(W,H,fps),level=pickLevel(W,H,fps,bitrate);
        if(level){
            const p={W,H,footerH,level:level[0],bitrate};
            if(s>=1){p.S=s;p.pw=bw*s;p.ph=bh*s}
            else{p.f=s;p.pw=Math.floor((bw-1)*s)+1;p.ph=Math.floor((bh-1)*s)+1} // under a pixel per cell: a minimap
            // Even offsets keep each cell's colour in its own 2×2 chroma blocks, so edges don't bleed into neighbours.
            p.ox=((W-p.pw)>>1)&~1;p.oy=((H-footerH-p.ph)>>1)&~1;
            return p;
        }
        s=s>1?s-1:s*0.95; // over H.264 level 5.1 (4K at 60 fps): shrink the cells
    }
}
async function pickCodec(p,fps){
    for(const prof of PROFILES){
        const cfg={codec:`avc1.${prof}${p.level.toString(16)}`,width:p.W,height:p.H,bitrate:p.bitrate,framerate:fps,avc:{format:'avc'}};
        try{const s=await VideoEncoder.isConfigSupported(cfg);if(s&&s.supported)return cfg}catch(e){console.error('Codec support check failed for',cfg.codec,e)}
    }
    return null;
}

// The frame is kept twice: as RGBA, which tiles and text are drawn into, and as I420 (BT.709, limited range),
// which is what encoders take. Only rectangles that changed are converted. Handing the encoder I420 copies
// 1.5 bytes a pixel per frame instead of 4, and it no longer converts colour itself.
function frameBuffers(W,H){
    const pix=new Uint8ClampedArray(W*H*4),yuv=new Uint8Array(W*H*3/2),cw=W>>1,U=W*H,V=U+cw*(H>>1);
    // Converts [x0,x1)×[y0,y1), widened to whole 2×2 chroma blocks. Uint8Array stores truncate, hence the +0.5s.
    const convert=(x0,y0,x1,y1)=>{
        x0=Math.max(0,x0&~1);y0=Math.max(0,y0&~1);x1=Math.min(W,x1+(x1&1));y1=Math.min(H,y1+(y1&1));
        for(let y=y0;y<y1;y+=2){
            for(let x=x0,o=(y*W+x0)*4,q=o+W*4,i=y*W+x0,c=(y>>1)*cw+(x0>>1);x<x1;x+=2,o+=8,q+=8,i+=2,c++){
                const r0=pix[o],g0=pix[o+1],b0=pix[o+2],r1=pix[o+4],g1=pix[o+5],b1=pix[o+6];
                const r2=pix[q],g2=pix[q+1],b2=pix[q+2],r3=pix[q+4],g3=pix[q+5],b3=pix[q+6];
                yuv[i]=16.5+0.18259*r0+0.61423*g0+0.06201*b0;yuv[i+1]=16.5+0.18259*r1+0.61423*g1+0.06201*b1;
                yuv[i+W]=16.5+0.18259*r2+0.61423*g2+0.06201*b2;yuv[i+W+1]=16.5+0.18259*r3+0.61423*g3+0.06201*b3;
                const r=r0+r1+r2+r3,g=g0+g1+g2+g3,b=b0+b1+b2+b3;
                yuv[U+c]=128.5+(-0.10067*r-0.33856*g+0.43922*b)*0.25;
                yuv[V+c]=128.5+(0.43922*r-0.39894*g-0.04027*b)*0.25;
            }
        }
    };
    return{pix,px32:new Uint32Array(pix.buffer),yuv,convert};
}

// The HUD under the board. It's laid out once for the whole video, with each number in a slot wide enough for
// its largest value, so labels don't shift as the numbers grow, and everything shrinks together if the frame is
// too narrow. Per frame only numbers that changed are redrawn, from glyphs rendered once, straight into the
// frame: drawing the HUD on a canvas and reading it back every frame took most of the export time.
function makeFooter(buf,W,top,fh,{moves,maxCleared,maxFlagged,stamp}){
    const c=document.createElement('canvas');c.width=W;c.height=fh;
    const ctx=c.getContext('2d',{willReadFrequently:true});
    const groups=[['Flagged:','🚩',maxFlagged],['Moves:','👆',moves],['Cleared:','🟦',maxCleared]];
    const counterMax=`${moves} / ${moves}`,digits=v=>String(Math.max(0,v)).length;
    const layout=k=>{
        const fs=Math.round(fh*0.3*k),font=`bold ${fs}px sans-serif`,cfs=stamp?Math.round(fh*0.24*k):fs,cfont=`bold ${cfs}px sans-serif`;
        ctx.font=font;let digitW=0;for(let d=0;d<10;d++)digitW=Math.max(digitW,ctx.measureText(String(d)).width);
        let x=fh*0.4;const slots=[];
        for(const[label,,max]of groups){const lx=x;x+=ctx.measureText(label).width+fh*0.1*k;const ex=x;x+=fh*0.45*k;slots.push({lx,ex,x,w:digits(max)*digitW});x+=digits(max)*digitW+fh*0.5*k}
        ctx.font=cfont;const right=Math.max(ctx.measureText(counterMax).width,stamp?ctx.measureText(stamp).width:0);
        return{k,fs,font,cfs,cfont,slots,need:x+right+fh*0.4};
    };
    let L=layout(1);
    for(let k=0.95;L.need>W&&k>0.4;k-=0.05)L=layout(k);
    const rx=W-fh*0.4,cy=fh/2,ccy=stamp?cy-fh*0.18:cy;
    // The parts that never change: background, border, labels, icons and the timestamp.
    ctx.fillStyle='#111128';ctx.fillRect(0,0,W,fh);
    ctx.strokeStyle='#2a2a4a';ctx.lineWidth=Math.max(1,Math.round(fh/48));ctx.strokeRect(0,0,W,fh);
    ctx.textBaseline='middle';ctx.textAlign='left';
    groups.forEach(([label,icon],i)=>{const s=L.slots[i];ctx.fillStyle='#aaa';ctx.font=L.font;ctx.fillText(label,s.lx,cy);ctx.font=`${Math.round(fh*0.35*L.k)}px serif`;ctx.fillText(icon,s.ex,cy)});
    if(stamp){ctx.fillStyle='#888';ctx.font=L.cfont;ctx.textAlign='right';ctx.fillText(stamp,rx,cy+fh*0.18)}
    const base=ctx.getImageData(0,0,W,fh).data;
    // Glyph coverage masks, cut to the rows that have ink. G pads each side for antialiasing that spills past the advance.
    const G=3;
    const glyphs=(font,y,chars,rgb)=>{
        const set={rgb,g:{}};
        for(const ch of chars){
            ctx.font=font;const adv=ctx.measureText(ch).width,w=Math.ceil(adv)+G*2;
            ctx.clearRect(0,0,w,fh);ctx.fillStyle='#fff';ctx.textAlign='left';ctx.fillText(ch,G,y);
            const d=ctx.getImageData(0,0,w,fh).data;let y0=fh,y1=0;
            for(let r=0;r<fh;r++)for(let x=0;x<w;x++)if(d[(r*w+x)*4+3]){if(r<y0)y0=r;y1=r+1;break}
            const a=new Uint8Array(w*Math.max(0,y1-y0));for(let r=y0;r<y1;r++)for(let x=0;x<w;x++)a[(r-y0)*w+x]=d[(r*w+x)*4+3];
            set.g[ch]={adv,w,y0,a};
        }
        return set;
    };
    const vals=glyphs(L.font,cy,'0123456789',[255,255,255]),cnt=glyphs(L.cfont,ccy,'0123456789 /',[136,136,136]);
    const textW=(set,s)=>{let w=0;for(const ch of s)w+=set.g[ch].adv;return w};
    // Each slot is restored from the static footer, its text blended in, and its rectangle converted to YUV.
    const draw=(set,s,x0,x1,penX)=>{
        x0=Math.max(0,Math.floor(x0));x1=Math.min(W,Math.ceil(x1));
        for(let y=0;y<fh;y++)buf.pix.set(base.subarray((y*W+x0)*4,(y*W+x1)*4),((top+y)*W+x0)*4);
        const[R,Gc,B]=set.rgb,pix=buf.pix;
        for(const ch of s){
            const g=set.g[ch],gx=Math.round(penX)-G,h=g.a.length/g.w;
            for(let r=0;r<h;r++){let o=((top+g.y0+r)*W+gx)*4;for(let x=0,ai=r*g.w;x<g.w;x++,ai++,o+=4){const a=g.a[ai];if(a){const t=a/255;pix[o]+=(R-pix[o])*t;pix[o+1]+=(Gc-pix[o+1])*t;pix[o+2]+=(B-pix[o+2])*t}}}
            penX+=g.adv;
        }
        buf.convert(x0,top,x1,top+fh);
    };
    const shown=['','','',''],counterW=textW(cnt,counterMax);
    for(let y=0;y<fh;y++)buf.pix.set(base.subarray(y*W*4,(y+1)*W*4),(top+y)*W*4);
    buf.convert(0,top,W,top+fh);
    return{update(done,cleared,flagged){
        [flagged,done,cleared].forEach((v,i)=>{const s=String(v);if(s===shown[i])return;shown[i]=s;const sl=L.slots[i];draw(vals,s,sl.x-G,sl.x+sl.w+G*2,sl.x)});
        const s=`${done} / ${moves}`;if(s!==shown[3]){shown[3]=s;draw(cnt,s,rx-counterW-G*2,rx+G*2,rx-textW(cnt,s))}
    }};
}

// MP4 bytes as Blob pieces. The muxer only ever rewrites its header region (ftyp, the space it reserved
// for moov, and the mdat header), so that stays an editable buffer and everything after it is append-only.
function blobTarget(){
    const parts=[],early=[];let head=null,tail=0;
    const target=new Mp4Muxer.StreamTarget({onData:(data,pos)=>{
        if(!head){early.push([data.slice(),pos]);return}
        if(pos<head.length){if(pos+data.byteLength>head.length)throw new Error('MP4 header overflow');head.set(data,pos);return}
        if(pos!==tail)throw new Error('MP4 data written out of order');
        parts.push(new Blob([data]));tail+=data.byteLength;
    }});
    return{target,
        sealHeader(){head=new Uint8Array(Math.max(...early.map(([d,p])=>p+d.byteLength)));for(const[d,p]of early)head.set(d,p);tail=head.length},
        blob:()=>new Blob([head,...parts],{type:'video/mp4'})};
}

const frameTs=(i,fps)=>Math.round(i*1e6/fps);

// Browser H.264 encoder (WebCodecs) for one segment of the video. Encoded chunks go to onChunk(chunk, meta).
function webCodecsSink(cfg,bitrate,W,H,fps,buf,onChunk){
    let canvas=null;
    const makeFrame=(timestamp,duration)=>{
        if(!canvas){
            try{return new VideoFrame(buf.yuv,{format:'I420',codedWidth:W,codedHeight:H,timestamp,duration,colorSpace:COLOR_SPACE})}
            catch(e){console.error('YUV video frames unsupported, drawing through a canvas instead',e);const c=document.createElement('canvas');c.width=W;c.height=H;canvas={c,ctx:c.getContext('2d',{alpha:false})}}
        }
        canvas.ctx.putImageData(new ImageData(buf.pix,W,H),0,0);
        return new VideoFrame(canvas.c,{timestamp,duration,alpha:'discard'});
    };
    let encErr=null;
    const encoder=new VideoEncoder({output:(chunk,meta)=>{try{onChunk(chunk,meta)}catch(e){encErr=encErr||e}},error:e=>{encErr=encErr||e}});
    encoder.configure({...cfg,bitrate});
    // Wait for the encoder to take a frame. 'dequeue' is event-driven; older browsers poll.
    const hasDequeue='ondequeue' in encoder;
    const drained=()=>new Promise(r=>{const t=setTimeout(r,hasDequeue?50:2);if(hasDequeue)encoder.addEventListener('dequeue',()=>{clearTimeout(t);r()},{once:true})});
    return{
        async add(frame,key){
            const vf=makeFrame(frameTs(frame,fps),frameTs(frame+1,fps)-frameTs(frame,fps));
            encoder.encode(vf,{keyFrame:key||frame%(fps*KEYFRAME_SECONDS)===0});vf.close();
            while(encoder.encodeQueueSize>4&&!encErr)await drained();
            if(encErr)throw encErr;
        },
        async finish(){await encoder.flush();if(encErr)throw encErr},
        close(){if(encoder.state!=='closed')encoder.close()},
    };
}

// Browsers only expose VideoEncoder on secure pages (https:// or localhost), so on plain http:// a
// WebAssembly H.264 encoder (h264-mp4-encoder, MIT) takes over. It's slower, and loaded only when needed.
const WASM_ENCODER_SRC=['lib/h264-mp4-encoder.web.js','https://cdn.jsdelivr.net/npm/h264-mp4-encoder@1.0.12/embuild/dist/h264-mp4-encoder.web.js'];
let wasmLoading=null;
function loadWasmEncoder(){
    if(window.HME)return Promise.resolve(window.HME);
    if(!wasmLoading)wasmLoading=(async()=>{
        for(const src of WASM_ENCODER_SRC){
            try{
                await new Promise((res,rej)=>{const el=document.createElement('script');el.src=src;el.onload=res;el.onerror=()=>{el.remove();rej(new Error('could not load '+src))};document.head.appendChild(el)});
                if(window.HME)return window.HME;
            }catch(e){console.error('WebAssembly video encoder failed to load from',src,e)}
        }
        wasmLoading=null;throw new Error('The video encoder could not be loaded');
    })();
    return wasmLoading;
}
// Reads the encoder's own MP4 just far enough to get each H.264 sample and the avcC decoder config.
function readEncoderMp4(d){
    const dv=new DataView(d.buffer,d.byteOffset,d.byteLength);
    const find=(p,end,type)=>{
        while(p+8<=end){
            let size=dv.getUint32(p),head=8;
            if(size===1){size=Number(dv.getBigUint64(p+8));head=16}else if(size===0)size=end-p;
            if(String.fromCharCode(d[p+4],d[p+5],d[p+6],d[p+7])===type)return{start:p+head,end:p+size};
            p+=size;
        }
        return null;
    };
    let stbl={start:0,end:d.length};
    for(const t of ['moov','trak','mdia','minf','stbl']){stbl=find(stbl.start,stbl.end,t);if(!stbl)throw new Error('Encoder output has no '+t+' box')}
    const inStbl=t=>find(stbl.start,stbl.end,t);
    const stsd=inStbl('stsd'),avc1=find(stsd.start+8,stsd.end,'avc1'),avcC=avc1&&find(avc1.start+78,avc1.end,'avcC'); // 78: VisualSampleEntry fields
    const stsz=inStbl('stsz'),stsc=inStbl('stsc'),stco=inStbl('stco'),co64=inStbl('co64');
    if(!avcC||!stsz||!stsc||!(stco||co64))throw new Error('Encoder output is missing its sample tables');
    const fixed=dv.getUint32(stsz.start+4),n=dv.getUint32(stsz.start+8),sizes=new Uint32Array(n);
    for(let i=0;i<n;i++)sizes[i]=fixed||dv.getUint32(stsz.start+12+i*4);
    const co=stco||co64,nc=dv.getUint32(co.start+4),runs=[];
    for(let i=0,k=dv.getUint32(stsc.start+4);i<k;i++)runs.push([dv.getUint32(stsc.start+8+i*12),dv.getUint32(stsc.start+12+i*12)]);
    const offsets=new Float64Array(n);
    for(let c=0,i=0;c<nc&&i<n;c++){
        let per=0;for(const[first,count]of runs)if(c+1>=first)per=count;
        let o=stco?dv.getUint32(co.start+8+c*4):Number(dv.getBigUint64(co.start+8+c*8));
        for(let j=0;j<per&&i<n;j++,i++){offsets[i]=o;o+=sizes[i]}
    }
    return{avcC:d.slice(avcC.start,avcC.end),sizes,offsets,n};
}
// The WebAssembly encoder's MP4 has no sync-sample table, so players take every frame for a keyframe and seeking
// breaks (Windows won't decode past the first few seconds), and it declares a fixed H.264 level. Its samples are
// re-muxed with mp4-muxer, like the WebCodecs path, with the real keyframes marked and the level corrected.
function remuxEncoderMp4(d,W,H,fps,level){
    const{avcC,sizes,offsets,n}=readEncoderMp4(d),nalLen=(avcC[4]&3)+1;
    avcC[3]=level;if(((avcC[6]<<8)|avcC[7])>3)avcC[11]=level; // AVCLevelIndication, and level_idc in the SPS
    const hex=b=>b.toString(16).padStart(2,'0');
    const meta={decoderConfig:{codec:`avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(level)}`,codedWidth:W,codedHeight:H,description:avcC,colorSpace:COLOR_SPACE}};
    const out=blobTarget();
    const muxer=new Mp4Muxer.Muxer({target:out.target,video:{codec:'avc',width:W,height:H,frameRate:fps},fastStart:{expectedVideoChunks:n},firstTimestampBehavior:'offset'});
    out.sealHeader();
    for(let i=0;i<n;i++){
        const sample=d.subarray(offsets[i],offsets[i]+sizes[i]);let key=false;
        for(let q=0;q+nalLen<sample.length;){
            let len=0;for(let b=0;b<nalLen;b++)len=len*256+sample[q+b];
            const type=sample[q+nalLen]&31;
            if(type===5)key=true;
            if(type===7&&len>3)sample[q+nalLen+3]=level; // an in-band SPS
            q+=nalLen+len;
        }
        muxer.addVideoChunkRaw(sample,key?'key':'delta',frameTs(i,fps),frameTs(i+1,fps)-frameTs(i,fps),i===0?meta:undefined);
    }
    muxer.finalize();
    return out.blob();
}
async function wasmSink(bitrate,W,H,fps,level,buf){
    const HME=await loadWasmEncoder(),enc=await HME.createH264MP4Encoder();
    enc.width=W;enc.height=H;enc.frameRate=fps;enc.kbps=Math.max(50,Math.round(bitrate/1000));
    enc.groupOfPictures=fps*KEYFRAME_SECONDS;enc.speed=10; // fastest; it's already far slower than WebCodecs
    enc.initialize();
    // Hand it the YUV frame where it takes one, so it skips its own colour conversion.
    const yuv=typeof enc.addFrameYuv==='function';
    let live=true,finalized=false;
    // Freeing an encoder that was never finalized aborts the whole WebAssembly module (it's shared by every
    // export in the page), so a cancelled export finalizes first and throws the partial file away.
    const drop=()=>{
        if(!live)return;live=false;
        try{if(!finalized)enc.finalize();enc.delete()}catch(e){console.error('Could not free the video encoder',e)}
        try{enc.FS.unlink(enc.outputFilename)}catch(e){}
    };
    return{
        async add(){if(yuv)enc.addFrameYuv(buf.yuv);else enc.addFrameRgba(buf.pix)},
        async finish(){enc.finalize();finalized=true;const d=enc.FS.readFile(enc.outputFilename);drop();return remuxEncoderMp4(d,W,H,fps,level)},
        close:drop,
    };
}

// src: {seed, moveLog, wrongFlags} or {frames} (version 1 saves).
// opts: {fps: 30|60, movesPerFrame: 1|2|4|8|16|32, res: 'auto'|'720'|'1080'|'1440'|'2160', stamp?: text shown in the footer}.
// hooks.confirmPlan(plan) may return (or resolve to) false to cancel, or {movesPerFrame} to change speed.
// hooks.onProgress({phase: 'prepare'|'encode'|'retry'|'finish', done, total}) is called at most every 100ms.
// Resolves to {blob, ...}, {empty: true}, {tooBig: true, limit} if it can't get under SIZE_CAP, or null when cancelled.
// hooks.signal is an AbortSignal; an aborted export resolves to null.
async function render(src,opts,hooks={}){
    const fps=+opts.fps===30?30:60;
    let perFrame=SPEEDS.includes(+opts.movesPerFrame)?+opts.movesPerFrame:1;
    const res=BUDGETS[opts.res]?opts.res:'auto',stamp=typeof opts.stamp==='string'?opts.stamp:'',signal=hooks.signal,ABORT={};
    let lastReport=0;
    const report=(phase,done,total,force)=>{const t=performance.now();if(hooks.onProgress&&(force||t-lastReport>100)){lastReport=t;hooks.onProgress({phase,done,total})}};
    const checkAbort=()=>{if(signal&&signal.aborted)throw ABORT};
    try{
    // Pass 1: board bounds, move count and the largest HUD numbers. The replay is thrown away, so it's the only extra memory.
    const entries=src.frames?src.frames.length:src.moveLog.length;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,moves=0,maxCleared=0,maxFlagged=0,lastYield=performance.now();
    report('prepare',0,entries,true);
    {let cleared=0,flagged=0;
    for(const st of stepsOf(src)){
        moves++;for(const[k,v]of st.diff){const[x,y]=keyXY(k);if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(v&&v[0]==='r')cleared++}
        flagged=st.flagged!==undefined?st.flagged:flagged+st.flagsDelta;if(flagged>maxFlagged)maxFlagged=flagged;
        if(performance.now()-lastYield>40){await tick();lastYield=performance.now();checkAbort();report('prepare',moves,entries)}
    }
    maxCleared=cleared}
    if(!moves)return{empty:true};
    const m=Math.max(PAD,Math.ceil(Math.max(maxX-minX+1,maxY-minY+1)*BUFFER));
    minX-=m;maxX+=m;minY-=m;maxY+=m;
    const bw=maxX-minX+1,bh=maxY-minY+1;

    let p=null,cfg=null;
    // If the browser's encoder refuses this size, fall back to smaller budgets; without one, use WebAssembly.
    if(typeof VideoEncoder!=='undefined')for(const r of [res,...['1440','1080','720'].filter(r=>BUDGETS[r]<(BUDGETS[res]||BUDGETS['1080']))]){
        p=planFrame(bw,bh,r,fps);cfg=await pickCodec(p,fps);if(cfg)break;
    }
    const slow=!cfg;
    if(slow){
        if(typeof WebAssembly==='undefined')throw new Error('This device cannot encode H.264 video');
        p=planFrame(bw,bh,res,fps);
    }
    if(hooks.confirmPlan){
        // msPerFrame: a rough export-time guide for the WebAssembly encoder (about 8ms a frame at 1600×1132).
        const ok=await hooks.confirmPlan({moves,fps,movesPerFrame:perFrame,speeds:SPEEDS,frames:Math.ceil(moves/perFrame)+fps,seconds:(Math.ceil(moves/perFrame)+fps)/fps,width:p.W,height:p.H,slow,msPerFrame:slow?2+6.5*p.W*p.H/(1600*1132):0});
        if(ok===false)return null;
        if(ok&&SPEEDS.includes(+ok.movesPerFrame))perFrame=+ok.movesPerFrame;
    }
    checkAbort();
    const frames=Math.ceil(moves/perFrame),hold=fps,total=frames+hold; // hold the final board for a second
    const W=p.W,H=p.H,areaH=H-p.footerH;
    const tiles=p.S?renderTiles(p.S).map(c=>new Uint32Array(c.getContext('2d').getImageData(0,0,p.S,p.S).data.buffer)):null;
    const col=p.S?null:tileColours();

    // A frame buffer with the starting board and HUD drawn in, and drawChange(x, y, tile) to update a cell.
    // Frames are drawn into plain buffers rather than a canvas: encoding a canvas-backed VideoFrame blocks
    // the page for a GPU readback on every frame, which dominated long exports. While `live` is off, cells
    // are drawn but not converted to YUV, for replaying up to the start of a later segment.
    const makeBoard=()=>{
        const buf=frameBuffers(W,H),{pix,px32,convert}=buf,b={buf,live:true};
        if(p.S){
            const S=p.S;
            // Unopened cells fill the whole frame, lined up with the board, so any spare space reads as more board.
            const rows=[];for(let r=0;r<S;r++){const row=new Uint32Array(W);for(let x=0;x<W;x++)row[x]=tiles[0][r*S+(((x-p.ox)%S)+S)%S];rows.push(row)}
            for(let y=0;y<areaH;y++)px32.set(rows[(((y-p.oy)%S)+S)%S],y*W);
            b.drawChange=(x,y,t)=>{
                const tile=tiles[t],px=p.ox+(x-minX)*S,py=p.oy+(y-minY)*S,o=py*W+px;
                if(S===1)px32[o]=tile[0];else for(let r=0;r<S;r++)px32.set(tile.subarray(r*S,r*S+S),o+r*W);
                if(b.live)convert(px,py,px+S,py+S);
            };
        }else{
            // Each pixel shows the average colour of the cells that land on it, kept as running sums.
            const n=p.pw*p.ph,cnt=new Uint32Array(n),sum=new Float32Array(n*3),shown=new Uint8Array(bw*bh);
            const px=(cx,cy)=>Math.floor(cy*p.f)*p.pw+Math.floor(cx*p.f);
            for(let cy=0;cy<bh;cy++)for(let cx=0;cx<bw;cx++)cnt[px(cx,cy)]++;
            const bg=col[0].map(Math.round);
            for(let i=0;i<W*areaH;i++){pix[i*4]=bg[0];pix[i*4+1]=bg[1];pix[i*4+2]=bg[2];pix[i*4+3]=255}
            for(let i=0;i<n;i++)for(let c=0;c<3;c++)sum[i*3+c]=cnt[i]*col[0][c];
            b.drawChange=(x,y,t)=>{
                const cx=x-minX,cy=y-minY,ci=cy*bw+cx,old=shown[ci];if(old===t)return;shown[ci]=t;
                const i=px(cx,cy),a=col[old],c2=col[t],fx=p.ox+i%p.pw,fy=p.oy+((i/p.pw)|0),o=(fy*W+fx)*4;
                for(let c=0;c<3;c++){sum[i*3+c]+=c2[c]-a[c];pix[o+c]=sum[i*3+c]/cnt[i]}
                if(b.live)convert(fx,fy,fx+1,fy+1);
            };
        }
        convert(0,0,W,areaH);
        b.footer=makeFooter(buf,W,areaH,p.footerH,{moves,maxCleared,maxFlagged,stamp});
        return b;
    };

    // Software encoders use about one core each, so long videos are cut in two at a frame boundary and both
    // halves encode side by side (1.6× faster in testing); the second starts on a keyframe and its chunks are
    // held until the first is in the file. Hardware encoders are fast already and may cap how many run at once.
    let parallel=!slow&&frames>=1200&&(navigator.hardwareConcurrency||1)>=4;
    if(parallel)try{const hw=await VideoEncoder.isConfigSupported({...cfg,hardwareAcceleration:'prefer-hardware'});parallel=!(hw&&hw.supported)}catch(e){parallel=false}
    const OVERSIZE=e=>e&&e.oversize,MISMATCH={};

    // One full encode at the given bitrate; the board is redrawn from scratch each time.
    const encodeAt=async(bitrate,phase,segments)=>{
        report(phase,0,total,true);
        const bounds=segments>1?[[0,Math.floor(frames/2)],[Math.floor(frames/2),total]]:[[0,total]];
        const out=slow?null:blobTarget(),muxer=slow?null:new Mp4Muxer.Muxer({target:out.target,video:{codec:'avc',width:W,height:H,frameRate:fps},fastStart:{expectedVideoChunks:total},firstTimestampBehavior:'offset'});
        if(out)out.sealHeader();
        const segs=bounds.map(([f0,f1],k)=>({f0,f1,k,held:k?[]:null,config:null,bytes:0,sink:null}));
        let encoded=0,stop=false;
        const sameBytes=(a,b)=>{if(!a||!b)return!a&&!b;const x=new Uint8Array(a.buffer||a,a.byteOffset||0,a.byteLength),y=new Uint8Array(b.buffer||b,b.byteOffset||0,b.byteLength);if(x.length!==y.length)return false;for(let i=0;i<x.length;i++)if(x[i]!==y[i])return false;return true};
        // A file heading past SIZE_CAP is abandoned as soon as that's clear and re-encoded at a bitrate scaled
        // to fit, rather than after the whole export.
        const guard=()=>{
            const bytes=segs.reduce((a,s)=>a+s.bytes,0),proj=bytes*total/Math.max(1,encoded);
            if(bytes>SIZE_CAP||(encoded>total*0.1&&bytes>SIZE_CAP*0.25&&proj>SIZE_CAP*1.05))throw{oversize:Math.max(proj,bytes)};
        };
        const run=async seg=>{
            const board=makeBoard(),{drawChange,footer}=board;board.live=seg.f0===0;
            seg.sink=slow?await wasmSink(bitrate,W,H,fps,p.level,board.buf):webCodecsSink(cfg,bitrate,W,H,fps,board.buf,(chunk,meta)=>{
                seg.bytes+=chunk.byteLength;
                if(!seg.config&&meta&&meta.decoderConfig)seg.config=meta.decoderConfig;
                if(!seg.held){muxer.addVideoChunk(chunk,meta);return}
                const d=new Uint8Array(chunk.byteLength);chunk.copyTo(d);seg.held.push([d,chunk.type,chunk.timestamp,chunk.duration??frameTs(1,fps)]);
            });
            let frame=0,done=0,cleared=0,flagged=0;
            const emit=async()=>{
                if(frame<seg.f0){frame++;return}
                if(!board.live){board.live=true;board.buf.convert(0,0,W,areaH)}
                footer.update(done,cleared,flagged);
                await seg.sink.add(frame,frame===seg.f0);frame++;encoded++;
                if(performance.now()-lastYield>40){await tick();lastYield=performance.now()}
                if(stop)throw ABORT;
                checkAbort();if(!slow)guard();report(phase,encoded,total);
            };
            for(const st of stepsOf(src)){
                if(frame>=seg.f1)break;
                for(const[k,v]of st.diff){const[x,y]=keyXY(k);drawChange(x,y,TILE_INDEX.get(v)||0);if(v&&v[0]==='r')cleared++}
                flagged=st.flagged!==undefined?st.flagged:flagged+st.flagsDelta;
                done++;if(done%perFrame===0||done===moves)await emit();
            }
            while(frame<seg.f1)await emit();
            return seg.sink.finish();
        };
        try{
            const results=await Promise.all(segs.map(s=>run(s).catch(e=>{stop=true;throw e})));
            report('finish',total,total,true);
            if(slow)return results[0];
            // The halves only make one stream if both encoders described it identically (they do in practice);
            // if not, the export starts over as a single segment.
            const c0=segs[0].config;
            for(const seg of segs.slice(1))if(!c0||!seg.config||seg.config.codec!==c0.codec||!sameBytes(seg.config.description,c0.description))throw MISMATCH;
            for(const seg of segs.slice(1))for(const[d,type,ts,dur]of seg.held)muxer.addVideoChunkRaw(d,type,ts,dur);
            muxer.finalize();
            return out.blob();
        }finally{stop=true;for(const s of segs)if(s.sink)s.sink.close()}
    };

    let bitrate=p.bitrate,blob=null;
    for(let attempt=0;attempt<3&&!blob;attempt++){
        try{blob=await encodeAt(bitrate,attempt?'retry':'encode',parallel?2:1)}
        catch(e){
            if(e===MISMATCH){parallel=false;attempt--;continue}
            if(!OVERSIZE(e))throw e;
            bitrate=Math.floor(bitrate*SIZE_CAP*0.85/e.oversize);continue;
        }
        // Encoders can still overshoot, so an oversized file is re-encoded at a proportionally lower bitrate.
        if(blob.size>SIZE_CAP){bitrate=Math.floor(bitrate*SIZE_CAP*0.85/blob.size);blob=null}
    }
    if(!blob)return{tooBig:true,limit:SIZE_CAP};
    return{blob,width:W,height:H,seconds:total/fps,moves,movesPerFrame:perFrame,codec:slow?'wasm':cfg.codec,slow,bitrate,segments:parallel?2:1};
    }catch(e){if(e===ABORT)return null;throw e}
}
return{render,SPEEDS};
})();
