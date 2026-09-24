import renderer from './renderer.mjs';
import {renderFailure} from './browser-runtime.mjs';
try {
  const browser=await renderer.browserInit();
  const page=await browser.newPage();
  await page.setContent('<div style="width:200px;height:80px">王者营地渲染检查</div>');
  const image=await page.screenshot();
  await page.close();
  console.log(JSON.stringify({ok:image.length>0,code:'ready'}));
} catch(error){
  console.log(JSON.stringify({ok:false,code:error.message==='ChromiumMissing'?'browser_missing':renderFailure(error)}));
  process.exitCode=1;
} finally {await renderer.shutdown();}
