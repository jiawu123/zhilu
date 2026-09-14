async(page)=>{
 await page.unrouteAll({behavior:'wait'});
 await page.setViewportSize({width:1440,height:900});
 await page.goto('http://127.0.0.1:5178/?project=hybrid-preview&page=roadmap');await page.getByRole('main',{name:'任务流程图'}).waitFor();
 await page.locator('.flow-connector').first().hover();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.flow-connector button')).opacity==='1');
 await page.screenshot({path:'output/playwright/ui-revision/final-desktop.png'});
 await page.locator('.flow-connector').first().getByRole('button').click();
 await page.getByLabel('变更说明',{exact:true}).fill('本阶段的交付要求有所调整，请增加验收材料的核对范围。');
 await page.screenshot({path:'output/playwright/ui-revision/final-segment-composer.png'});
 await page.getByRole('button',{name:'查看任务：确认产品需求范围',exact:true}).click();await page.getByRole('dialog',{name:'任务详情',exact:true}).waitFor();
 await page.screenshot({path:'output/playwright/ui-revision/final-inspector.png'});await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});
 await page.goto('http://127.0.0.1:5178/?project=hybrid-preview&page=roadmap');await page.getByRole('main',{name:'任务流程图'}).waitFor();
 await page.locator('.date-timeline-tick').nth(1).click();await page.waitForFunction(()=>document.querySelector('.date-board-scroll').scrollLeft>0);
 await page.screenshot({path:'output/playwright/ui-revision/final-mobile-board.png'});
 await page.goto('http://127.0.0.1:5178/?project=plan-preview&page=plan');await page.getByRole('heading',{name:'候选方案审阅',exact:true}).waitFor();
 await page.locator('.route-choice > button').nth(1).click();
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.route-choice > button.is-selected')).backgroundColor==='rgb(244, 248, 255)');
 await page.locator('.plan-page').evaluate(el=>el.scrollTo(0,0));
 await page.screenshot({path:'output/playwright/ui-revision/final-mobile-plan.png'});
 await page.setViewportSize({width:1440,height:900});
 await page.goto('http://127.0.0.1:5178/?project=plan-preview&page=plan');await page.getByRole('heading',{name:'候选方案审阅',exact:true}).waitFor();
 await page.screenshot({path:'output/playwright/ui-revision/final-desktop-plan.png'});
 return{screenshots:6};
}
