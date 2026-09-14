async (page) => {
 const assert=(v,m)=>{if(!v)throw new Error(m);};
 const base='http://127.0.0.1:5178/api/projects/project-39e7d158';
 const read=async()=>{const r=await page.request.get(base);return r.json();};
 await page.setViewportSize({width:1280,height:720});
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/baseline/apply')),page.getByRole('button',{name:'确认计划，生成路线图→',exact:true}).click()]);
 await page.getByRole('main',{name:'按开始日期排列的任务看板'}).waitFor();
 await page.getByRole('button',{name:'打开计划菜单',exact:true}).click();
 await page.getByRole('button',{name:'＋ 新路标',exact:true}).click();
 const title='导出走查：鼠标改期任务';
 await page.getByLabel('路标名称',{exact:true}).fill(title);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith(base+'/nodes')&&r.request().method()==='POST'),page.getByRole('button',{name:'创建路标',exact:true}).click()]);
 await page.getByLabel('开始日期',{exact:true}).fill('2026-09-15');
 await page.getByLabel('截止日期',{exact:true}).fill('2026-09-17');
 await Promise.all([page.waitForResponse(r=>r.url().includes(base+'/nodes/')&&r.request().method()==='PATCH'),page.getByRole('button',{name:'保存修改',exact:true}).click()]);
 await page.getByText('修改名称、日期或状态后，点击保存修改。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 const before=await read(),task=before.plan.nodes.find(n=>n.title===title);
 const handle=page.getByRole('button',{name:'改期：'+title,exact:true});
 const rect=await handle.boundingBox();
 await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await page.mouse.down();
 await page.mouse.move(rect.x+rect.width/2+72,rect.y+rect.height/2,{steps:10});
 await page.getByText('顺延 1 周 · 松开保存',{exact:true}).waitFor();
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/nodes/'+task.id)&&r.request().method()==='PATCH'),page.mouse.up()]);
 await page.reload();await handle.waitFor();
 let state=await read(),saved=state.plan.nodes.find(n=>n.id===task.id);
 assert(saved.startDate==='2026-09-22'&&saved.endDate==='2026-09-24','pointer drag did not persist one week');
 const version=state.plan.version;
 const header=await page.locator('.date-column-head').first().boundingBox();
 await page.mouse.move(header.x+header.width-15,header.y+15);await page.mouse.down();await page.mouse.move(30,header.y+15,{steps:8});await page.mouse.up();
 assert((await read()).plan.version===version,'panning rescheduled a task');
 await page.getByRole('button',{name:'打开计划菜单',exact:true}).click();
 const downloads=[];
 for(const [label,extension] of [['结构化数据（JSON）','json'],['可读文档（Markdown）','md'],['完整计划包（ZIP）','zip']]) {
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:label,exact:true}).click()]);
  assert(await download.failure()===null,'download failed '+extension);
  await download.saveAs('/tmp/zhilu-fixes-qa/download.'+extension);
  downloads.push({format:extension,filename:download.suggestedFilename()});
 }
 await page.getByRole('button',{name:'关闭计划菜单',exact:true}).click();
 return {pointerDrag:{startDate:saved.startDate,endDate:saved.endDate,persistedAfterReload:true},panDoesNotChangeDates:true,downloads,projectId:state.plan.projectId,version:state.plan.version,currentCommitId:state.plan.currentCommitId};
}
