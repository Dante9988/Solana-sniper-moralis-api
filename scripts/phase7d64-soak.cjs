require('dotenv').config({quiet:true});
const fs=require('node:fs');const {PrismaClient}=require('@prisma/client');const WebSocket=require('ws');const {execFileSync}=require('node:child_process');
const db=new PrismaClient();const token='0xa67a3eebf0ae8a935848bb47993b9a6d68751a23';
const out='/root/only-pump-me/docs/phase-7d6/evidence/7d6.4/soak.jsonl';const start=new Date();const duration=3600000;let stopped=false,ws,received=0,duplicates=0,reconnects=0;const revisions=new Map();
const write=row=>fs.appendFileSync(out,JSON.stringify({at:new Date().toISOString(),...row},(_,v)=>typeof v==='bigint'?v.toString():v)+'\n');
const connect=()=>{ws=new WebSocket('ws://127.0.0.1:8787/api/v1/realtime/market');ws.on('message',raw=>{try{const f=JSON.parse(raw);if(f.type==='connection.ready')ws.send(JSON.stringify({type:'subscribeCandles',chain:'robinhood',tokenAddress:token,resolution:'1m'}));if(f.type==='token.candle.updated'){received++;const k=f.data.candle.startTime;if((revisions.get(k)||0)>=f.data.sequence)duplicates++;revisions.set(k,f.data.sequence);write({kind:'candle',receivedAt:Date.now(),...f});}}catch{}});ws.on('error',()=>{});ws.on('close',()=>{if(!stopped){reconnects++;setTimeout(connect,1000);}})};
(async()=>{write({kind:'start',token,durationMs:duration});connect();while(Date.now()-start<duration){
 const trades=await db.$queryRaw`SELECT "canonicalStatus",count(*) AS count,percentile_cont(0.5) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM("observedAt"-"sourceTimestamp"))*1000) AS "lagP50Ms",percentile_cont(0.95) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM("observedAt"-"sourceTimestamp"))*1000) AS "lagP95Ms",max(EXTRACT(EPOCH FROM("observedAt"-"sourceTimestamp"))*1000) AS "lagMaxMs" FROM "ChainTrade" WHERE chain='robinhood' AND "sourceTimestamp">${start} GROUP BY "canonicalStatus"`;
 const checkpoints=await db.chainIngestionCheckpoint.findMany({where:{updatedAt:{gte:start}},select:{source:true,lastHeight:true,lastObservedChainHeight:true,lastHeightTimestamp:true,lastErrorAt:true,reorgUnresolvedAt:true}});
 const invalidations=await db.candleInvalidation.count({where:{processedAt:null}});
 const memory=execFileSync('ps',['-eo','pid,comm,rss'],{encoding:'utf8'}).split('\n').filter(l=>/node|PID/.test(l));
 write({kind:'sample',elapsedMs:Date.now()-start,received,duplicates,reconnects,trades,checkpoints,pendingCandleInvalidations:invalidations,memory,queueDepth:null,queueDepthReason:'Live head wakeups coalesce into one pending flag; no exported queue-depth counter.'});
 await new Promise(r=>setTimeout(r,30000));}
 write({kind:'complete',elapsedMs:Date.now()-start,received,duplicates,reconnects});
})().catch(e=>{write({kind:'error',message:e.message});process.exitCode=1}).finally(async()=>{stopped=true;ws?.close();await db.$disconnect()});
