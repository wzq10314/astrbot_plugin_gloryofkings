import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import template from 'art-template';
import puppeteer from 'puppeteer-core';
import {chromium} from 'playwright';

let browser, opening, renderQueue = Promise.resolve();
export function executable() {
  const configured = process.env.GOK_BROWSER;
  if (configured && fs.existsSync(configured)) return configured;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['chromium','chromium-browser','google-chrome','google-chrome-stable','chrome.exe']) {
      const candidate = path.join(dir,name);
      try { fs.accessSync(candidate,fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  if (fs.existsSync(chromium.executablePath())) return chromium.executablePath();
  throw new Error('ChromiumMissing');
}
async function actualBrowser() {
  if (browser?.connected) return browser;
  if (!opening) opening = (async()=>{
    const candidates=[executable()];
    // Playwright also installs headless-shell; some Windows hosts cannot launch the full Chrome binary.
    const full=chromium.executablePath();
    const shell=full.replace(/chromium-(\d+)/,'chromium_headless_shell-$1')
      .replace('chrome-win64','chrome-headless-shell-win64').replace(/chrome\.exe$/,'chrome-headless-shell.exe')
      .replace('chrome-linux64','chrome-headless-shell-linux64').replace(/\/chrome$/,'/chrome-headless-shell');
    if(fs.existsSync(shell)&&shell!==full)candidates.push(shell);
    let last;
    for(const candidate of candidates)try{
      return browser=await puppeteer.launch({executablePath:candidate,headless:true,
        args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],timeout:30000});
    }catch(error){last=error}
    throw last;
  })().finally(()=>opening=null);
  return opening;
}
// QR authorization must use one continuous, isolated browser session per user.
async function newIsolatedPage() {
  const context = await (await actualBrowser()).createBrowserContext();
  const page = await context.newPage();
  const close = context.close.bind(context);
  page.close = close;
  return page;
}
export async function render(name, data, onReady) {
  const root = globalThis.gok.root;
  const sourceRoot = path.join(root,'plugins/GloryOfKings-Plugin');
  const file = path.resolve(root,data.tplFile || '');
  if (!file.startsWith(sourceRoot+path.sep) || !file.endsWith('.html')) throw Error('InvalidTemplate');
  const temp = path.join(root,'render'); fs.mkdirSync(temp,{recursive:true});
  const htmlFile = path.join(temp,randomUUID()+'.html');
  const resource = pathToFileURL(path.join(sourceRoot,'resources')+path.sep).href;
  let page;
  try {
    // Keep scripts: upstream draws trend/radar charts on canvas after fonts load.
    const base=`<base href="${pathToFileURL(path.dirname(file)+path.sep).href}">`;
    const html = base+template(file,{...data,_res_path:resource,resPath:resource});
    fs.writeFileSync(htmlFile,html);
    page = await newIsolatedPage();
    await page.setViewport({width:1440,height:1000,deviceScaleFactor:1});
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=request.url();
      if (url.startsWith('file:') || url.startsWith('data:') || url==='about:blank') {
        if (url.startsWith('file:')) {
          const allowed=[resource,pathToFileURL(path.join(sourceRoot,'data/imgCache')+path.sep).href,pathToFileURL(htmlFile).href];
          if (!allowed.some(prefix=>url.startsWith(prefix))) return request.abort().catch(()=>{});
        }
        return request.continue().catch(()=>{});
      }
      // Templates only need remote images. Their fetches are bounded and validated by Python.
      if (request.resourceType()!=='image' || request.method()!=='GET') return request.abort().catch(()=>{});
      gok.call('asset',{url}).then(r=>request.respond({status:200,contentType:r.mime,body:Buffer.from(r.base64,'base64')}))
        .catch(()=>request.abort()).catch(()=>{});
    });
    await page.goto(pathToFileURL(htmlFile).href,{waitUntil:'load',timeout:45000});
    await page.evaluate(async()=>{
      await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,6000))]);
      await Promise.all([...document.images].map(i=>i.complete?null:new Promise(r=>{i.onload=i.onerror=r;setTimeout(r,4000)})));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    });
    if(onReady)await onReady(page);
    const element=await page.$('#container') || await page.$('.container') || await page.$('body');
    const box=await element.boundingBox();
    if (!box || box.height>30000 || box.width>5000) throw Error('RenderSizeLimit');
    return Buffer.from(await element.screenshot({type:'png',timeout:45000}));
  } finally { await page?.close().catch(()=>{}); fs.rmSync(htmlFile,{force:true}); }
}
export default {
  async screenshot(name,data){
    const job=renderQueue.then(()=>render(name,data)); renderQueue=job.catch(()=>{});
    try {
      const result=segment.image(await job);
      const fields=['title','subText','emptyTitle','emptyDescription','nickname','username','current','deltaText','peak','winRate','win','lose','count','heroLabel'];
      result.bridge_summary=fields.filter(k=>typeof data[k]==='string'||typeof data[k]==='number')
        .map(k=>`${k}: ${String(data[k]).slice(0,300)}`).join('\n');
      return result;
    }
    catch(error){gok.emit({type:'diagnostic',code:'RenderFailed',detail:error.name}); throw Error('图片渲染失败，请发送 #王者依赖状态 检查 Chromium');}
  },
  async browserInit(){ await actualBrowser(); return {newPage:newIsolatedPage}; },
  async shutdown(){await browser?.close();browser=null;}
};
