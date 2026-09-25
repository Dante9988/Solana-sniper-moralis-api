require('dotenv').config({quiet:true});const fs=require('node:fs'),path=require('node:path');const {PrismaClient}=require('@prisma/client');const {chromium}=require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');const db=new PrismaClient();const assert=require('node:assert/strict');
const RBD='0xb41c7ac9d46a980f8bdf1894b392a2a07ec9992a', OUT='/root/only-pump-me/docs/phase-7d6/evidence/7d6.4/history';const api='http://localhost:8787/api/v1/tokens/robinhood';let browser;
(async()=>{fs.mkdirSync(OUT,{recursive:true});const report={at:new Date().toISOString(),token:RBD,backfillRuns:[],bars:[],errors:[]};
 const initial=await (await fetch(`${api}/${RBD}/history`)).json();report.initial=initial;
 for(let attempt=0;attempt<8;attempt++){
   const state=await (await fetch(`${api}/${RBD}/history`)).json();if(state.status==='COMPLETE'&&state.coveredVenues.includes('UNISWAP_V4_POOL'))break;
   const response=await fetch(`${api}/${RBD}/history`,{method:'POST'});const result=await response.json();report.backfillRuns.push({at:new Date().toISOString(),status:response.status,result});console.log(JSON.stringify({attempt,status:result.status,cursor:result.cursor,reason:result.stoppedReason}));fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));
   if(response.status!==200||result.status==='FAILED')break;await new Promise(r=>setTimeout(r,1500));
 }
 report.final=await (await fetch(`${api}/${RBD}/history`)).json();
 const target=await db.chainTrade.findFirst({where:{chain:'robinhood',tokenAddress:RBD,canonicalStatus:'CANONICAL'},orderBy:[{sourceHeight:'desc'},{sourceIndex:'desc'}],select:{sourceHeight:true,sourceIndex:true}});
 for(let i=0;i<60;i++){
   const checkpoint=await db.candleAggregationCheckpoint.findUnique({where:{chain_tokenAddress:{chain:'robinhood',tokenAddress:RBD}}});
   if(target&&checkpoint&&(checkpoint.lastSourceHeight>target.sourceHeight||(checkpoint.lastSourceHeight===target.sourceHeight&&checkpoint.lastSourceIndex>=target.sourceIndex))){report.candlesCaughtUp=true;break;}
   await new Promise(r=>setTimeout(r,2000));
 }
 report.candlesCaughtUp=report.candlesCaughtUp??false;
 for(const resolution of ['1s','5s','15s','1m','5m','15m']){const r=await fetch(`${api}/${RBD}/candles?resolution=${resolution}&direction=backward&limit=300`);const body=await r.json();report.bars.push({resolution,status:r.status,count:body.candles?.length,first:body.candles?.[0]?.startTime,last:body.candles?.at(-1)?.startTime,nextCursor:body.nextCursor});await new Promise(r=>setTimeout(r,100));}
 report.checkpoint=await db.tokenTradeBackfill.findUnique({where:{chain_tokenAddress:{chain:'robinhood',tokenAddress:RBD}}});
 browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:OUT}});await ctx.tracing.start({screenshots:true,snapshots:true});const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`http://localhost:8080/token/robinhood/${RBD}`);await page.getByTestId('ohlcv-legend').waitFor({timeout:60000});await page.getByTestId('resolution-5s').click();await page.waitForTimeout(2500);await page.screenshot({path:path.join(OUT,'rbd-5s.png'),fullPage:true});
 const historyPages=[];
 page.on('response',async r=>{const url=new URL(r.url());if(url.pathname.endsWith('/candles')&&url.searchParams.get('resolution')==='5s'&&Number(url.searchParams.get('to'))<report.bars.find(b=>b.resolution==='5s').last-60&&r.status()===200){try{const body=await r.json();historyPages.push({cursor:url.searchParams.get('to'),resolution:body.resolution,count:body.candles.length,first:body.candles[0]?.startTime,last:body.candles.at(-1)?.startTime});}catch{}}});
 const box=await page.getByTestId('candlestick-chart').boundingBox();assert(box);
 for(let drag=0;drag<5&&historyPages.length===0;drag++){
   await page.mouse.move(box.x+box.width*.2,box.y+box.height*.4);await page.mouse.down();await page.mouse.move(box.x+box.width*.85,box.y+box.height*.4,{steps:30});await page.mouse.up();await page.waitForTimeout(1500);
 }
 assert(historyPages.length>0,'user pan must retrieve older genuine candles');
 assert(historyPages.every(p=>p.count>0&&p.last<=Number(p.cursor)),'older page must precede cursor');
 report.historyPages=historyPages;await page.screenshot({path:path.join(OUT,'rbd-5s-panned.png')});
 assert(report.candlesCaughtUp);assert(report.bars.every(b=>b.count===300));assert.equal(report.final.status,'COMPLETE');
 // Find a genuinely sparse token from canonical stored candles, never fabricate data.
 const recent=await db.discoveredToken.findMany({where:{chain:'robinhood',canonicalStatus:'CANONICAL'},orderBy:{observedAt:'desc'},take:100,select:{tokenAddress:true,symbol:true}});
 for(const token of recent){const count=await db.marketCandle.count({where:{chain:'robinhood',tokenAddress:token.tokenAddress,resolution:'S5'}});if(count<1||count>3)continue;report.sparse={...token,storedBars:count};await page.goto(`http://localhost:8080/token/robinhood/${token.tokenAddress}`);await page.getByTestId('resolution-5s').click();await page.getByTestId('ohlcv-legend').waitFor({timeout:60000});await page.waitForTimeout(1500);report.sparse.legend=JSON.parse(await page.getByTestId('ohlcv-legend').getAttribute('data-candle'));await page.screenshot({path:path.join(OUT,'sparse-5s.png'),fullPage:true});break;}
 assert.deepEqual(report.errors,[]);
 await ctx.tracing.stop({path:path.join(OUT,'trace.zip')});await ctx.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,recordVideo:{dir:path.join(OUT,'mobile')}});
 const mobilePage=await mobile.newPage();mobilePage.on('pageerror',e=>report.errors.push(e.message));
 await mobilePage.goto(`http://localhost:8080/token/robinhood/${RBD}`);await mobilePage.getByTestId('resolution-5s').click();await mobilePage.getByTestId('ohlcv-legend').waitFor();await mobilePage.waitForTimeout(1500);
 report.mobileOverflow=await mobilePage.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(report.mobileOverflow,false,'terminal chart controls must fit mobile width');
 await mobilePage.screenshot({path:path.join(OUT,'mobile-rbd-5s.png'),fullPage:true});await mobile.close();assert.deepEqual(report.errors,[]);
 fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2));console.log(JSON.stringify({final:report.final,bars:report.bars,sparse:report.sparse,errors:report.errors}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{await browser?.close();await db.$disconnect()});
