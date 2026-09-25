const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const OUT='/root/only-pump-me/docs/phase-7d6/evidence/7d6.4/screener';
(async()=>{fs.mkdirSync(OUT,{recursive:true});const browser=await chromium.launch({headless:true});const report=[];
try{for(const mobile of [false,true]){
 const name=mobile?'mobile':'desktop';const ctx=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,recordVideo:{dir:OUT}});await ctx.tracing.start({screenshots:true,snapshots:true});const page=await ctx.newPage();const errors=[],responses=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{const u=new URL(r.url());if(u.pathname==='/api/v1/tokens/robinhood'){try{responses.push({at:new Date().toISOString(),query:u.search,status:r.status(),body:await r.json()});}catch{}}});
 await page.goto('http://localhost:8080/explore?chain=robinhood',{waitUntil:'domcontentloaded'});
 await page.getByTestId('screener-controls').locator('summary').click();
 const fields={'FDV min (USD)':'1000','FDV max (USD)':'1000000000','Liquidity min (USD)':'100','Liquidity max (USD)':'10000000','Volume 5m min (USD)':'1','Volume 1h min (USD)':'10','Transactions 1h min':'10','Buys 1h min':'1','Sells 1h min':'1','Traders 1h min':'3'};
 for(const [label,value] of Object.entries(fields))await page.getByLabel(label,{exact:true}).fill(value);
 const read=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/tokens/robinhood'&&r.url().includes('fdvMin=1000')&&r.status()===200);
 await page.getByRole('button',{name:'Apply filters',exact:true}).click();const result=await (await read).json();const filteredUrl=page.url();assert(filteredUrl.includes('traders1hMin=3'));assert(result.tokens.length>0,'live filtered set must be nonempty for this acceptance');
 const checkBounds = tokens => {for(const t of tokens){const m=t.market;assert(Number(m.marketCapUsd)>=1000&&Number(m.marketCapUsd)<=1e9);assert(Number(m.liquidityUsd)>=100&&Number(m.liquidityUsd)<=1e7);assert(Number(m.volume5mUsd)>=1&&Number(m.volume1hUsd)>=10);assert(m.trades1h>=10&&m.buys1h>=1&&m.sells1h>=1&&m.traders1h>=3);}};checkBounds(result.tokens);
 await page.screenshot({path:path.join(OUT,`${name}-filters.png`)});
 let pagination = {available:!!result.nextCursor};
 if(result.nextCursor){
   const nextRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/tokens/robinhood'&&new URL(r.url()).searchParams.has('cursor')&&r.status()===200);
   await page.getByRole('button',{name:/Load more/}).click();const next=await(await nextRead).json();checkBounds(next.tokens);
   const addresses=[...result.tokens,...next.tokens].map(t=>t.tokenAddress);
   assert.equal(new Set(addresses).size,addresses.length);pagination={available:true,additional:next.tokens.length,noDuplicates:true};
 }
 const sortedRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/tokens/robinhood'&&r.url().includes('sort=marketCap')&&r.status()===200);
 await page.getByRole('combobox',{name:'Sort tokens'}).click();await page.getByRole('option',{name:'Market cap',exact:true}).click();
 const sorted=await(await sortedRead).json();checkBounds(sorted.tokens);
 for(let i=1;i<sorted.tokens.length;i++)assert(Number(sorted.tokens[i-1].market.marketCapUsd)>=Number(sorted.tokens[i].market.marketCapUsd));
 const lifecycleRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/tokens/robinhood'&&r.url().includes('lifecycle=graduated')&&r.status()===200);
 await page.getByRole('tab',{name:'Graduated',exact:true}).click();const graduated=await(await lifecycleRead).json();checkBounds(graduated.tokens);assert(graduated.tokens.every(t=>t.graduated));
 assert(page.url().includes('tab=graduated')&&page.url().includes('fdvMin=1000'));
 await page.goto(filteredUrl);
 await page.reload();await page.getByTestId('screener-controls').locator('summary').click();assert.equal(await page.getByLabel('FDV min (USD)',{exact:true}).inputValue(),'1000');
 await page.getByLabel('FDV min (USD)',{exact:true}).fill('2000000000');await page.getByRole('button',{name:'Apply filters',exact:true}).click();await page.getByRole('alert').filter({hasText:'Minimum must not exceed maximum.'}).waitFor();assert.equal(page.url(),filteredUrl);
 await page.getByRole('button',{name:'Clear numeric filters',exact:true}).click();assert(!page.url().includes('fdvMin='));await page.goBack();await page.waitForURL(filteredUrl);assert.equal(await page.getByLabel('FDV min (USD)',{exact:true}).inputValue(),'1000');await page.goForward();assert(!page.url().includes('fdvMin='));
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false,'no horizontal page overflow');assert.deepEqual(errors,[]);assert(!responses.some(r=>r.status===429));
 report.push({name,filteredUrl,total:result.total,shown:result.tokens.length,pagination,sorted:sorted.tokens.length,graduated:graduated.tokens.length,errors,overflow,responses});
 await ctx.tracing.stop({path:path.join(OUT,`${name}-trace.zip`)});await ctx.close();console.log(JSON.stringify({name,total:result.total,shown:result.tokens.length,errors,overflow}));
}fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1});
