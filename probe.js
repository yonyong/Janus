const http = require("http");
function get(url){return new Promise((res)=>{const rq=http.get(url,(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res({code:r.statusCode,len:d.length,head:d.slice(0,120)}));});rq.on("error",e=>res({err:e.message}));rq.setTimeout(6000,()=>{rq.destroy();res({err:"timeout"});});});}
(async()=>{
  const a=await get("http://127.0.0.1:5173/");
  const b=await get("http://127.0.0.1:8000/api/admin/state");
  const lines=[];
  lines.push("5173: "+(a.err?("ERR "+a.err):("HTTP "+a.code+" len="+a.len+" "+a.head.replace(/\n/g," "))));
  lines.push("admin/state: "+(b.err?("ERR "+b.err):("HTTP "+b.code+" len="+b.len+" body="+b.head.replace(/\n/g," "))));
  require("fs").writeFileSync("D:/develop/project/Janus/http_probe.txt",lines.join("\n"),"utf8");
})();
