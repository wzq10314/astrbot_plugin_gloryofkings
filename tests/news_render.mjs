import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import renderer,{render,screenshotOptions} from '../engine/renderer.mjs';

const root=path.resolve(process.argv[2]);
globalThis.gok={root,call:async()=>{throw Error('UnexpectedRemoteImage')},emit:()=>{}};
let checks=0;
const folder=path.join(root,'plugins/GloryOfKings-Plugin/resources/html');
const fixture=path.join(folder,'news-quality-fixture.html');
try {
  assert.deepEqual(screenshotOptions({imgType:'png',quality:40}),{type:'png',timeout:45000});checks++;
  assert.equal(screenshotOptions({imgType:'jpg',quality:40.5}).quality,41);checks++;
  assert.equal(screenshotOptions({imgType:'webp',quality:120}).quality,100);checks++;
  assert.equal(screenshotOptions({imgType:'jpeg',quality:NaN}).quality,undefined);checks++;
  fs.writeFileSync(fixture,`<canvas id="container" width="512" height="512"></canvas><script>
    const c=document.querySelector('canvas'),ctx=c.getContext('2d'),p=ctx.createImageData(512,512);
    let x=71;for(let i=0;i<p.data.length;i+=4){for(let j=0;j<3;j++){x=(1664525*x+1013904223)>>>0;p.data[i+j]=x>>>24}p.data[i+3]=255}ctx.putImageData(p,0,0);
  </script>`);
  for(const imgType of ['jpeg','webp']) {
    const args={tplFile:'plugins/GloryOfKings-Plugin/resources/html/news-quality-fixture.html',imgType};
    const high=await render('quality',{...args,quality:82});
    const low=await render('quality',{...args,quality:40});
    assert.ok(low.length<high.length*0.9,`${imgType}: upstream quality retries must actually reduce size`);checks++;
  }
  const news={title:'版本更新公告 · 适配测试',category:'版本更新',color:'#f5d76e',timeText:'10-01 12:00',cover:'',top:true};
  const list=await render('GameNews',{tplFile:'plugins/GloryOfKings-Plugin/resources/html/GameNews.html',list:[news],pushMode:false},async page=>{
    assert.equal(await page.$eval('.news-title',e=>e.textContent.trim()),news.title);checks++;
  });
  assert.ok(list.length>10000);checks++;
  const detail=await render('GameNewsDetail',{
    ...news,tplFile:'plugins/GloryOfKings-Plugin/resources/html/GameNewsDetail.html',headCover:'',
    page:'<h2>公告正文测试</h2><p>正式服公告现在支持查询、分页出图和群订阅。</p><p>这是一份离线测试数据。</p>',
    pageNo:1,pageCount:2,totalPages:2,isLast:false,truncated:false,url:'https://pvp.qq.com/',imgType:'jpeg',quality:82
  },async page=>{
    assert.ok((await page.$eval('.content',e=>e.textContent)).includes('离线测试数据'));checks++;
    assert.equal(await page.$eval('.page-no',e=>e.textContent.trim()),'1 / 2');checks++;
    assert.ok(await page.$eval('body',e=>e.getBoundingClientRect().height<600),'short notice has no blank viewport tail');checks++;
  });
  assert.ok(detail.length>15000);checks++;
  if(process.argv[3])fs.writeFileSync(process.argv[3],detail);
  console.log(JSON.stringify({ok:true,checks,templates:['GameNews','GameNewsDetail']}));
}finally{
  if(fs.existsSync(fixture))fs.unlinkSync(fixture);
  await renderer.shutdown();
}
