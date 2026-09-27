// Branch-only staging patch: make lvSyncSend() awaitable.
// Root cause: lvSyncSend() is not async and never returns/awaits the
// underlying channel.send() Promise, so cvSwitchTo's existing
// `await lvSyncSend(...)` resolves on a bare `undefined` and provides
// no ordering guarantee before the immediately-following
// lvSyncInit(newRoom) tears down/replaces the channel. In the
// LV._syncReady===false path this is worse: the real send() attempt is
// deferred 700ms, by which time lvSyncInit may have already replaced
// LV._syncCh, silently dropping the broadcast.
//
// This patch makes lvSyncSend always return a Promise that resolves
// only after the real send() attempt has been made (or explicitly
// skipped because the channel is stale), while preserving the exact
// existing no-op guard, payload shape, and fail-soft (never-throw)
// behavior for all existing non-awaited call sites.

function findFunctionRange(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const matches = [...src.matchAll(re)];
  if (matches.length !== 1) throw new Error(`[patch-lvsync-send-await] expected exactly one function ${name}, found ${matches.length}`);
  const start = matches[0].index;
  const brace = src.indexOf('{', start + matches[0][0].length);
  if (brace < 0) throw new Error(`[patch-lvsync-send-await] opening brace not found for ${name}`);

  let depth = 0;
  let quote = null;
  let escape = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && nx === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && nx === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && nx === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`[patch-lvsync-send-await] closing brace not found for ${name}`);
}

function replaceFunction(src, name, replacement) {
  const { start, end } = findFunctionRange(src, name);
  return src.slice(0, start) + replacement + src.slice(end);
}

const NEW_LVSYNCSEND = `function lvSyncSend(id,kind,value,extra){
  if(LV._syncApplying||!LV._syncCh)return Promise.resolve();
  var _pl={type:'broadcast',event:'ex',payload:{id,kind,value:String(value==null?'':value).slice(0,2000),from:S.profile?.id||'',extra:extra||null}};
  var _ch=LV._syncCh;
  try{
    if(LV._syncReady){
      return Promise.resolve(_ch.send(_pl)).catch(function(e){});
    }
    return new Promise(function(resolve){
      setTimeout(function(){
        try{
          if(LV._syncCh===_ch){Promise.resolve(_ch.send(_pl)).then(function(){resolve();},function(){resolve();});}
          else{resolve();}
        }catch(e){resolve();}
      },700);
    });
  }catch(e){return Promise.resolve();}
}`;

export function applyLvSyncSendAwaitPatch(src) {
  return replaceFunction(src, 'lvSyncSend', NEW_LVSYNCSEND);
}
