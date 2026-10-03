import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import renderer, {render} from '../engine/renderer.mjs';

const root=path.resolve(process.argv[2]);
globalThis.gok={root,call:async()=>{throw Error('No remote requests in fixture')},emit:()=>{}};
const icon='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" rx="10" fill="#567ca4"/><circle cx="44" cy="44" r="20" fill="#bdd9dc"/></svg>').toString('base64');
const player=(team,index)=>({
  basicInfo:{isMe:team==='我方'&&index===0,roleName:`${team}测试玩家${index+1}`},
  battleRecords:{usedSkin:null,usedHero:{heroIcon:icon,heroName:'测试英雄'},skill:{skillIcon:icon},finalEquips:Array.from({length:6},()=>({equipIcon:icon}))},
  battleStats:{gradeGame:10.5,money:'15.8k',killCnt:8,deadCnt:2,assistCnt:10,heroHurtText:'88.8k',heroHurtRate:22,joinRate:60,behurtText:'50.1k',ctrlText:'12秒',soldierText:'99',maxTags:[]},
});
let checks=0;
try {
  for(const count of [5,10]) {
    const data={
      tplFile:'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      gameResult:'胜利',gameResultEn:'VICTORY',tips:'离线排版验证',mapName:`${count}v${count} 对局`,
      startTime:'2026-10-04 12:00',usedTime:22,matchDesc:'测试数据',myEconomyRate:55,myMoney:'158k',enemyMoney:'130k',
      myTowerCnt:6,enemyTowerCnt:3,myLdragon1:2,enemyLdragon1:1,myBdragon1:1,enemyBdragon1:0,
      myBdragon3:1,enemyBdragon3:0,myLdragon2:2,enemyLdragon2:1,myBdragon2:1,enemyBdragon2:0,
      hasMeDetail:false,hasBan:false,myKillDeadAssistCnt:'80 / 20 / 100',enemyKillDeadAssistCnt:'20 / 80 / 30',
      myRoles:Array.from({length:count},(_,i)=>player('我方',i)),enemyRoles:Array.from({length:count},(_,i)=>player('敌方',i)),
      imgType:'jpeg',quality:82,
    };
    const image=await render('QueryGameRecordDetails',data,async page=>{
      const layout=await page.evaluate(()=>({
        teams:[...document.querySelectorAll('.team-container')].map(team=>({
          columns:team.querySelectorAll('.player-column').length,
          cards:[...team.querySelectorAll('.player-card')].map(card=>({
            top:card.getBoundingClientRect().top,left:card.getBoundingClientRect().left,
            fits:card.scrollWidth<=card.clientWidth+2,
            equips:[...card.querySelectorAll('.equipment-item')].map(e=>({top:e.getBoundingClientRect().top,left:e.getBoundingClientRect().left})),
          })),
        })),
        width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,
      }));
      assert.equal(layout.teams.length,2);checks++;
      for(const team of layout.teams) {
        assert.equal(team.columns,1);checks++;
        assert.equal(team.cards.length,count);checks++;
        assert.ok(team.cards.every(c=>c.fits));checks++;
        assert.ok(team.cards.every((c,i)=>i===0||(c.top>team.cards[i-1].top&&Math.abs(c.left-team.cards[0].left)<1)));checks++;
        assert.ok(team.cards.every(c=>c.equips.length===7&&c.equips.every((e,i)=>Math.abs(e.top-c.equips[0].top)<1&&(i===0||e.left>c.equips[i-1].left))));checks++;
      }
      assert.equal(layout.width,1300);checks++;
      assert.ok(layout.height<5000);checks++;
    });
    assert.ok(image.length>20000);checks++;
    if(count===10&&process.argv[3]) fs.writeFileSync(process.argv[3],image);
  }
  console.log(JSON.stringify({ok:true,checks,modes:['5v5','10v10']}));
} finally {await renderer.shutdown()}
