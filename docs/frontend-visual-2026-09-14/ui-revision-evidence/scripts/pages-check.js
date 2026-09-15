async(page)=>{
 const session={"id": "interview-bd2cad27-f9c5-4dbf-a690-3a726d726867", "goal": "回归测试：十二周内完成一个可演示的笔记网页", "backgroundNotes": "# 走查背景\n每周八小时，已有基础经验。此文件仅用于导入回归测试。", "questions": [{"id": "q-1", "type": "single", "question": "你目前的产品开发经验是什么？", "options": [{"id": "q-1-o-1", "label": "做过一个小项目", "allowsText": false}, {"id": "q-1-o-2", "label": "正在学习基础知识", "allowsText": false}, {"id": "q-1-o-3", "label": "其他", "allowsText": true}]}, {"id": "q-2", "type": "multiple", "question": "你希望优先完成哪些成果？", "options": [{"id": "q-2-o-1", "label": "可运行的网页", "allowsText": false}, {"id": "q-2-o-2", "label": "清晰的产品介绍", "allowsText": false}, {"id": "q-2-o-3", "label": "用户反馈记录", "allowsText": false}]}, {"id": "q-3", "type": "toggle", "question": "你希望计划的节奏如何？", "options": [{"id": "q-3-o-1", "label": "循序渐进", "allowsText": false}, {"id": "q-3-o-2", "label": "适度挑战", "allowsText": false}, {"id": "q-3-o-3", "label": "集中冲刺", "allowsText": false}]}, {"id": "q-4", "type": "text", "question": "还有什么现实限制需要考虑？", "options": []}], "answers": [{"questionId": "q-1", "optionIds": ["q-1-o-1"]}, {"questionId": "q-2", "optionIds": ["q-2-o-1", "q-2-o-3"]}, {"questionId": "q-3", "optionIds": ["q-3-o-1"]}, {"questionId": "q-4", "text": "每周八小时，优先完成可演示的小产品。"}], "status": "complete", "summary": {"userContext": {"currentSituation": "离线走查用合成背景：业余学习产品开发。", "weeklyHours": 8, "constraints": ["仅用于界面走查，非真实模型理解结果"], "backgroundNotes": "# 走查背景\n每周八小时，已有基础经验。此文件仅用于导入回归测试。", "confirmed": false}, "goalContract": {"goal": "回归测试：十二周内完成一个可演示的笔记网页", "targetDate": "2026-12-06", "successCriteria": ["完成可操作的产品演示"], "nonGoals": ["商业上线"], "mustHaveOutcomes": ["一个可演示的页面"], "tradeoffs": ["优先完成核心流程"], "reviewCadence": "weekly", "confirmed": false}, "adaptiveQuestion": "还有什么现实限制需要考虑？", "adaptiveAnswer": "每周八小时，优先完成可演示的小产品。"}};
 const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
 await page.unrouteAll({behavior:'wait'});
 const browserName=await page.evaluate(()=>navigator.userAgent.includes('Chrome')?'chrome':'webkit');
 const results=[];
 for(const size of [{width:1440,height:900},{width:390,height:844}]){
  await page.setViewportSize(size);
  await page.goto('http://127.0.0.1:5178/?page=interview');
  await page.getByRole('button',{name:'重新填写',exact:true}).click();
  await page.getByRole('heading',{name:'登记项目目标',exact:true}).waitFor();
  await page.screenshot({path:'output/playwright/ui-revision/'+browserName+'-onboarding-'+size.width+'.png'});
  const fresh={...session,id:'frontend-interview',answers:[],summary:undefined,status:'in_progress'};
  await page.route('**/api/interviews',route=>route.fulfill({json:fresh}));
  await page.route('**/api/interviews/frontend-interview/answers',async route=>{const body=route.request().postDataJSON();assert(body.answers.length===4,'answer count');await route.fulfill({json:{...session,id:'frontend-interview'}});});
  await page.getByLabel('项目目标',{exact:true}).fill('十二周内完成产品开发与发布');
  await page.getByRole('button',{name:'开始填写背景资料',exact:true}).click();
  await page.getByRole('radio',{name:'做过一个小项目',exact:true}).check();
  await page.getByRole('checkbox',{name:'可运行的网页',exact:true}).check();
  await page.getByRole('checkbox',{name:'用户反馈记录',exact:true}).check();
  await page.getByRole('button',{name:'循序渐进',exact:true}).click();
  await page.locator('.text-answer textarea').fill('每周投入八小时。');
  await page.screenshot({path:'output/playwright/ui-revision/'+browserName+'-interview-'+size.width+'.png'});
  await page.getByRole('button',{name:'提交本轮 4 题',exact:true}).click();await page.getByRole('heading',{name:'目标与背景确认',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.interview-page').scrollTop===0);
  const summaryFooter=await page.locator('.sticky-flow-actions').boundingBox();assert(summaryFooter.y+summaryFooter.height<=size.height,'summary actions hidden');
  await page.screenshot({path:'output/playwright/ui-revision/'+browserName+'-summary-'+size.width+'.png'});
  await page.getByRole('button',{name:'重新填写',exact:true}).click();
  for(const id of ['research-preview','plan-preview']){
   await page.goto('http://127.0.0.1:5178/?project='+id+'&page=plan');
   await page.getByRole('heading',{name:id==='research-preview'?'研究依据与计划编制':'候选方案审阅',exact:true}).waitFor();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page has horizontal overflow');
   if(id==='plan-preview'){
    const footer=await page.locator('.route-lab > footer').boundingBox();assert(footer.y+footer.height<=size.height+1,'plan confirmation hidden');
    const choices=page.locator('.route-choice > button');await choices.nth(1).click();assert(await choices.nth(1).getAttribute('aria-pressed')==='true','choice does not select');
   }
   await page.screenshot({path:'output/playwright/ui-revision/'+browserName+'-'+id+'-'+size.width+'.png'});
  }
  results.push({viewport:size,goalForm:true,mixedQuestions:true,summary:true,summaryFooter,researchEntry:true,candidateSwitch:true,planConfirmationVisible:true});
  await page.unrouteAll({behavior:'wait'});
 }
 return{mode:'Frontend fixtures and intercepted interview responses',results};
}
