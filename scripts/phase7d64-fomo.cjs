const { chromium } = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs = require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const evidence={at:new Date().toISOString(),responses:[]};
 page.on('response',async r=>{if(/json/.test(r.headers()['content-type']||'')&&r.status()===200){try{const url=new URL(r.url());if(/fomo/.test(url.hostname))evidence.responses.push({path:url.pathname,body:await r.json()});}catch{}}});
 await page.goto(process.env.FOMO_URL||'https://fomo.family',{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(3000); await page.getByRole('button',{name:'Start trading',exact:true}).first().click(); await page.waitForTimeout(3000);
 evidence.url=page.url();evidence.text=await page.locator('body').innerText();evidence.links=await page.locator('a').evaluateAll(as=>as.map(a=>({text:a.textContent,href:a.href})));
 const out='/root/only-pump-me/docs/phase-7d6/evidence/7d6.4';
 await page.screenshot({path:out+'/fomo-public.png',fullPage:true});fs.writeFileSync(out+'/fomo-public.json',JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({url:evidence.url,text:evidence.text.slice(0,16000),links:evidence.links,responses:evidence.responses.map(r=>r.path)}));await browser.close();
})().catch(e=>{console.error(e.message);process.exitCode=1});
