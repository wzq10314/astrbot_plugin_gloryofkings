import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';

export function browserOptions(){
 const options={headless:true,args:['--disable-dev-shm-usage'],timeout:30000};
 if(fs.existsSync(chromium.executablePath())) return options;
 for(const dir of (process.env.PATH||'').split(path.delimiter)){
  for(const name of ['chromium','chromium-browser','google-chrome','google-chrome-stable']){
   const file=path.join(dir,name);
   try {fs.accessSync(file,fs.constants.X_OK);if(fs.statSync(file).isFile())return {...options,executablePath:file}}catch{}
  }
 }
 return options;
}

export function renderFailure(error,stage='launch'){
 const message=String(error?.message||error);
 if(/Executable doesn't exist|browserType.launch: Executable/i.test(message))return 'browser_missing';
 if(/Host system is missing dependencies|error while loading shared libraries|lib\S+\.so.*not found/i.test(message))return 'system_libraries';
 if(stage==='template')return 'template_error';
 if(/timeout/i.test(message))return 'render_timeout';
 return stage==='launch'?'browser_launch':'render_error';
}

export async function checkBrowser(){
 let browser;
 try{
  browser=await chromium.launch(browserOptions());
  const page=await browser.newPage();
  await page.setContent('<div style="width:200px;height:80px">RConsole 渲染检查</div>');
  const image=await page.screenshot({timeout:10000});
  return {ok:image.length>0,code:'ready'};
 }catch(error){return {ok:false,code:renderFailure(error)}}
 finally{await browser?.close()}
}
