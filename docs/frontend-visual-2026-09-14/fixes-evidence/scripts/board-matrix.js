async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const results = [];
  for (const size of [{width:1280,height:720},{width:1280,height:600},{width:768,height:1024},{width:390,height:844}]) {
    await page.setViewportSize(size);
    await page.goto('http://127.0.0.1:5178/?project=dense-visual&page=roadmap');
    await page.getByRole('main', {name:'按开始日期排列的任务看板'}).waitFor();
    assert(await page.locator('.date-column').count() === 4, 'same-day tasks split into duplicate columns');
    assert(await page.locator('.board-task').count() === 16, 'tasks missing');
    const dimensions = await page.locator('.date-board-scroll').evaluate(el => {
      const frame=el.getBoundingClientRect();
      return Array.from(el.querySelectorAll('.date-column')).map(column => {
        const c=column.getBoundingClientRect(), list=column.querySelector('.date-task-list');
        const cards=Array.from(list.children).map(item=>item.getBoundingClientRect());
        return {height:c.height, max:frame.height-parseFloat(getComputedStyle(el).paddingBottom), fits:c.bottom<=frame.bottom+1, overlaps:cards.some((r,i)=>i>0&&r.top<cards[i-1].bottom-1), scrollable:list.scrollHeight>list.clientHeight};
      });
    });
    assert(dimensions.every(d=>d.fits&&!d.overlaps&&Math.abs(d.height-d.max)<2), 'column height or overlap failed ' + JSON.stringify({size,dimensions}));
    const list=page.locator('.date-task-list').first();
    const bounds=await list.boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,5000);
    await page.waitForFunction(()=>{const e=document.querySelector('.date-task-list');return e.scrollTop>0;});
    const lastVisible=await list.evaluate(el=>el.lastElementChild.getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom+2);
    assert(lastVisible,'last task inaccessible after vertical scroll');
    await page.screenshot({path:'output/playwright/dogfood-fixes/webkit-board-'+size.width+'x'+size.height+'.png'});
    const b=await page.locator('.date-board-scroll').boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+8);await page.mouse.wheel(10000,0);
    await page.waitForFunction(()=>{const e=document.querySelector('.date-board-scroll');return e.scrollLeft>=e.scrollWidth-e.clientWidth-2 && Math.abs(e.scrollLeft-document.querySelector('.date-timeline-scroll').scrollLeft)<2;});
    const end=await page.evaluate(()=>{const board=document.querySelector('.date-board-scroll'),timeline=document.querySelector('.date-timeline-scroll');return {sync:Math.abs(board.scrollLeft-timeline.scrollLeft)<2,goal:document.querySelector('.board-goal').getBoundingClientRect().right<=board.getBoundingClientRect().right};});
    assert(end.sync&&end.goal,'horizontal end or timeline sync failed');
    await page.getByRole('button',{name:'回到起点',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.date-board-scroll').scrollLeft===0);
    await page.locator('.board-task-open').first().click();
    assert(await page.evaluate(()=>Boolean(document.activeElement.closest('dialog[open]'))),'focus not in dialog');
    for(let i=0;i<18;i++) {await page.keyboard.press('Tab');assert(await page.evaluate(()=>Boolean(document.activeElement.closest('dialog[open]'))),'Tab escaped modal');}
    await page.keyboard.press('Escape');
    assert(await page.getByRole('dialog').count()===0,'Escape did not close dialog');
    results.push({viewport:size,groupCount:4,taskCount:16,columnHeights:dimensions.map(d=>d.height),scrollToLastTask:true,scrollToGoal:true,timelineSync:true,focusAndEscape:true});
  }
  return results;
}
