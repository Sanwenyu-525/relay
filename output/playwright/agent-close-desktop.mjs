const targets=await(await fetch('http://127.0.0.1:19329/json/list')).json();
const target=targets.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:5173'));
if(!target)throw Error('No audit page');
const ws=new WebSocket(target.webSocketDebuggerUrl);
ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'document.querySelector("[aria-label=\\"关闭窗口\\"]").click()'}}));
ws.onmessage=()=>ws.close();
setTimeout(()=>ws.close(),3000);
