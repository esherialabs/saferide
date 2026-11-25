const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(process.env.REPORT_CASES_OUTPUT || 'outputs/report-cases-harness');
fs.mkdirSync(output, {recursive:true});
const url = process.env.REPORT_CASES_PREVIEW_URL || 'http://127.0.0.1:8115/';
(async () => {
  const browser = await chromium.launch({ executablePath:process.env.BROWSER_EXECUTABLE_PATH,headless:true });
  try {
  const page = await browser.newPage({viewport:{width:375,height:812}});
  const errors=[];page.on('pageerror', error=>errors.push(error.message));
  const visible = text => page.getByRole('heading',{name:text,exact:true});
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
  await visible('Home').waitFor({timeout:60000});
  await page.getByRole('button',{name:'Open Cases',exact:true}).filter({visible:true}).click();
  await visible('Cases').waitFor();
  await page.getByRole('button',{name:'Close Cases',exact:true}).click();
  await visible('Home').waitFor();
  await page.getByRole('button',{name:'Open Cases',exact:true}).filter({visible:true}).click();
  await page.getByRole('button',{name:'Resume draft',exact:true}).click();
  await visible('Place and time').waitFor();
  const rootNames=await page.evaluate(()=>window.__NAV_STATE__.routes.map(r=>r.name));
  if(JSON.stringify(rootNames)!=='["MainTabs"]')throw new Error('Duplicate workspace after resume');
  await page.getByRole('button',{name:'Review report',exact:true}).filter({visible:true}).click();
  await page.getByRole('button',{name:'Complete synthetic report',exact:true}).click();
  await visible('Cases').waitFor();
  await page.getByRole('button',{name:'Close Cases',exact:true}).click();
  await visible('Report workspace').waitFor();
  await page.waitForTimeout(1000);
  if(await visible('Cases').isVisible())throw new Error('Cases reopened after close');
  await page.screenshot({path:output+'/close-after-completion.png'});
  await page.getByRole('button',{name:'Home tab',exact:true}).click();
  await visible('Home').waitFor();
  await page.getByRole('button',{name:'Open Cases',exact:true}).filter({visible:true}).click();
  await page.getByRole('button',{name:'New report',exact:true}).click();
  await visible('What happened').waitFor();
  await page.getByRole('button',{name:'Back to workspace',exact:true}).filter({visible:true}).click();
  await visible('Report workspace').waitFor();
  await page.goto(url+'?restored',{waitUntil:'domcontentloaded'});
  await visible('Cases').waitFor();
  await page.getByRole('button',{name:'Close Cases',exact:true}).click();
  await visible('Place and time').waitFor();
  await page.setViewportSize({width:812,height:375});
  await page.screenshot({path:output+'/restored-draft-landscape.png'});
  if(errors.length)throw new Error(errors.join('\n'));
  const result={scope:'Real React Navigation core and production helpers/hook; synthetic DOM screens',nativeHandsetVerified:false,checks:['Home/Cases/Close','Cases/resume/root identity','Complete/Cases/Close without reopen','Cases/new report/back workspace','Build20 duplicate history repair/incomplete draft preserved'],pageErrors:errors};
  fs.writeFileSync(output+'/browser-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});


