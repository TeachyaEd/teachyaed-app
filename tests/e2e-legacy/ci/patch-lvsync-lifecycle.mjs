// Branch-only staging patch for lvSyncInit channel lifecycle.
// Root cause: replacing LV._syncCh intentionally emits CLOSED on the old
// channel; the old callback scheduled lvSyncInit(roomKey) 1.5s later, which
// removed the new channel and created a self-sustaining leave/join loop.
// A generation guard lets only the current generation schedule a retry.

function replaceExactlyOnce(src, oldText, newText, label) {
  const first=src.indexOf(oldText);
  if(first<0)throw new Error(`[patch-lvsync-lifecycle] missing anchor: ${label}`);
  if(src.indexOf(oldText,first+oldText.length)>=0)throw new Error(`[patch-lvsync-lifecycle] duplicate anchor: ${label}`);
  return src.slice(0,first)+newText+src.slice(first+oldText.length);
}

export function applyLvSyncLifecyclePatch(src){
  let out=src;
  out=replaceExactlyOnce(
    out,
    `    if(!roomKey)return;\n    if(LV._syncCh){try{sb.removeChannel(LV._syncCh);}catch(e){}LV._syncCh=null;}`,
    `    if(!roomKey)return;\n    LV._syncGen=(LV._syncGen||0)+1;const _syncGen=LV._syncGen;\n    if(LV._syncCh){try{sb.removeChannel(LV._syncCh);}catch(e){}LV._syncCh=null;}`,
    'lvSyncInit generation start',
  );
  out=replaceExactlyOnce(
    out,
    `setTimeout(function(){if(LV._syncRoomKey===roomKey)lvSyncInit(roomKey);},1500);`,
    `setTimeout(function(){if(LV._syncGen===_syncGen&&LV._syncRoomKey===roomKey)lvSyncInit(roomKey);},1500);`,
    'lvSyncInit retry guard',
  );
  return out;
}
