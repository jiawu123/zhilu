async(page)=>{
 const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
 const results=[];const errors=[];page.on('pageerror',error=>errors.push(error.message));
 for(const size of [{width:1440,height:900},{width:1280,height:720},{width:1280,height:600},{width:768,height:1024},{width:390,height:844}]){
  await page.setViewportSize(size);
  await page.goto('http://127.0.0.1:5178/?project=hybrid-preview&page=roadmap');
  await page.getByRole('main',{name:'任务流程图'}).waitFor();
  assert(await page.locator('.date-column.is-multi').count()===1,'only the one exact-date group should be a board');
  assert(await page.locator('.flow-unit.is-single').count()===3,'single dates must remain independent');
  assert(await page.locator('.board-task').count()===11,'task count changed');
  const dimensions=await page.evaluate(()=>{
   const board=document.querySelector('.date-board-scroll'),col=document.querySelector('.date-column'),list=document.querySelector('.date-task-list');
   const b=board.getBoundingClientRect(),c=col.getBoundingClientRect(),style=getComputedStyle(board), cards=[...list.children].map(el=>el.getBoundingClientRect()),composer=document.querySelector('.change-composer').getBoundingClientRect(),timeline=document.querySelector('.board-timeline').getBoundingClientRect();
   return{height:c.height,available:b.height-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),header:col.querySelector('header').getBoundingClientRect().height,card:document.querySelector('.board-task').getBoundingClientRect().height,overlap:cards.some((r,i)=>i&&r.top<cards[i-1].bottom-1),scrollable:list.scrollHeight>list.clientHeight,composerFits:composer.bottom<=innerHeight&&composer.x>=0&&composer.right<=innerWidth,timelineClear:timeline.bottom<=composer.top,documentOverflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert(!dimensions.overlap && dimensions.scrollable && Math.abs(dimensions.height-dimensions.available)<2 && dimensions.header<=36 && dimensions.card<=84 && dimensions.composerFits && dimensions.timelineClear&&!dimensions.documentOverflow,'layout failure '+JSON.stringify({size,dimensions}));
  await page.locator('.date-task-list').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert(await page.locator('.date-task-list').evaluate(el=>el.lastElementChild.getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom+1),'last task inaccessible');
  await page.locator('.date-task-list').evaluate(el=>el.scrollTop=0);
  await page.screenshot({path:'output/playwright/ui-revision/hybrid-'+size.width+'x'+size.height+'.png'});
  const connector=page.locator('.flow-connector').first();await connector.scrollIntoViewIfNeeded();await connector.hover();
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.flow-connector button')).opacity)===1);
  await connector.getByRole('button').click();
  assert(await page.getByLabel('变更说明',{exact:true}).evaluate(el=>el===document.activeElement),'segment entry must focus composer');
  assert((await page.locator('.composer-scope').textContent()).includes('2026-09-15 — 2026-09-18'),'segment scope missing');
  await page.getByRole('button',{name:'取消变更范围',exact:true}).click();
  await page.getByRole('button',{name:'记录任务变更：确认产品需求范围',exact:true}).click();
  assert((await page.locator('.composer-scope').textContent()).includes('确认产品需求范围'),'task scope missing');
  await page.getByRole('button',{name:'取消变更范围',exact:true}).click();
  await page.getByRole('button',{name:'查看任务：确认产品需求范围',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'任务详情',exact:true});await dialog.waitFor();
  assert(await dialog.getByText('可核验的阶段成果',{exact:true}).count()===1,'details missing');
  for(let i=0;i<15;i++){await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement.closest('dialog[open]')),'focus escaped dialog');}
  await page.keyboard.press('Escape');assert(await page.getByRole('dialog').count()===0,'dialog did not close');
  await page.locator('.date-board-scroll').evaluate(el=>el.scrollLeft=el.scrollWidth);
  await page.waitForFunction(()=>Math.abs(document.querySelector('.date-board-scroll').scrollLeft-document.querySelector('.date-timeline-scroll').scrollLeft)<2);
  assert(await page.locator('.board-goal').evaluate(el=>el.getBoundingClientRect().right<=innerWidth+1),'goal inaccessible');
  await page.getByRole('button',{name:'返回起点',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.date-board-scroll').scrollLeft===0);
  results.push({viewport:size,...dimensions,connectorEntry:true,taskEntry:true,drawerFocus:true,scrollToGoal:true,timelineSync:true});
 }
 for(const id of ['missing-preview','empty-preview']){
  await page.goto('http://127.0.0.1:5178/?project='+id+'&page=roadmap');await page.getByRole('main',{name:'任务流程图'}).waitFor();
  assert(await page.locator('.date-column').count()===0,'unknown dates combined');
  assert(await page.locator('.board-task').count()===(id==='missing-preview'?3:0),'fallback count');
 }
 assert(errors.length===0,JSON.stringify(errors));return{results,missingDatesSeparate:true,emptyState:true,pageErrors:errors};
}
