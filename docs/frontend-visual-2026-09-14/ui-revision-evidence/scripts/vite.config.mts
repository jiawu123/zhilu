import original from '/Users/norda/Development/zhilu-roadmapper/zhilu/apps/web/vite.config.ts';
import { readFile } from 'node:fs/promises';
export default { ...original, root:'/Users/norda/Development/zhilu-roadmapper/zhilu/apps/web', plugins:[...original.plugins, {name:'frontend-static-fixtures',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(!req.url?.startsWith('/api/')) return next();
 const match=req.url.match(/^\/api\/projects\/([a-z-]+)$/);
 if(req.method==='GET' && match){try{const data=await readFile('/tmp/zhilu-ui-revision/'+match[1]+'.json');res.setHeader('content-type','application/json');res.end(data);return;}catch{}}
 res.statusCode=405;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'前端界面样本：未连接业务服务'}));
});}}],server:{host:'127.0.0.1',port:5178,strictPort:true,proxy:{},fs:{allow:['/Users/norda/Development/zhilu-roadmapper/zhilu','/tmp/zhilu-ui-revision']}}};
