// Branch-only staging transform for DEF-1 / DEF-2 / DEF-3A validation.
// Applies the approved client changes to the ephemeral staging artifact only.
// Fails closed unless every target function/callsite is uniquely identified.

function replaceExactlyOnce(src, oldText, newText, label) {
  const first = src.indexOf(oldText);
  if (first < 0) throw new Error(`[patch-def1-def2-def3a] missing anchor: ${label}`);
  if (src.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`[patch-def1-def2-def3a] duplicate anchor: ${label}`);
  return src.slice(0, first) + newText + src.slice(first + oldText.length);
}

function findFunctionRange(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const matches = [...src.matchAll(re)];
  if (matches.length !== 1) throw new Error(`[patch-def1-def2-def3a] expected exactly one function ${name}, found ${matches.length}`);
  const start = matches[0].index;
  const brace = src.indexOf('{', start + matches[0][0].length);
  if (brace < 0) throw new Error(`[patch-def1-def2-def3a] opening brace not found for ${name}`);

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
  throw new Error(`[patch-def1-def2-def3a] closing brace not found for ${name}`);
}

function replaceFunction(src, name, replacement) {
  const { start, end } = findFunctionRange(src, name);
  return src.slice(0, start) + replacement + src.slice(end);
}

const NEW_CDP = `async function cdpPickLesson(id){
  closeM('mLessonPicker');
  const l=window._lessonCache&&window._lessonCache[id];
  if(!l){showToast('Ошибка: урок не найден в кэше','error');return;}

  let _assignOk=false;
  try{
    const{data:cs}=await sb.from('class_students').select('student_id').eq('class_id',S.currentClassId).eq('school_id',S.schoolId);
    const stuIds=(cs||[]).map(c=>c.student_id).filter(Boolean);
    if(stuIds.length){
      const rows=stuIds.map(sid=>({school_id:S.schoolId,lesson_id:l.id,student_id:sid,class_id:S.currentClassId,completed:false}));
      const{error:_upErr}=await sb.from('lesson_assignments').upsert(rows,{onConflict:'class_id,lesson_id,student_id',ignoreDuplicates:true});
      if(_upErr)throw _upErr;
      const{error:_bumpErr}=await sb.from('lesson_assignments').update({assigned_at:new Date().toISOString()}).eq('lesson_id',l.id).eq('class_id',S.currentClassId).eq('school_id',S.schoolId).in('student_id',stuIds);
      if(_bumpErr)throw _bumpErr;
    }
    _assignOk=true;
  }catch(e){console.warn('auto-assign lesson:',e);}
  if(!_assignOk){
    showToast(t('Не удалось сохранить назначение урока для учеников — урок не запущен, попробуйте ещё раз'),'error');
    return;
  }

  const className=S._currentClassData?.name||'Класс';
  const{sections:_s,materials:_m}=_parseLessonContent(l.content);
  openClassroomView(l.title,_s,null,className,_m,l.id);
  LV.lessonId=l.id;
  startLiveLesson(l.id,l.title);
}`;

const NEW_SWITCH = `async function cvSwitchTo(lessonId){
  closeM('mLessonPicker');
  const{data:l}=await sb.from('lessons').select('*').eq('id',lessonId).eq('school_id',S.schoolId).maybeSingle();
  if(!l){showToast(t('Урок не найден'),'error');return;}

  let _durableOk=false;
  try{
    const{data:cs}=await sb.from('class_students').select('student_id').eq('class_id',S.currentClassId).eq('school_id',S.schoolId);
    const stuIds=(cs||[]).map(c=>c.student_id).filter(Boolean);
    if(stuIds.length){
      const rows=stuIds.map(sid=>({school_id:S.schoolId,lesson_id:l.id,student_id:sid,class_id:S.currentClassId,completed:false}));
      const{error:_upErr}=await sb.from('lesson_assignments').upsert(rows,{onConflict:'class_id,lesson_id,student_id',ignoreDuplicates:true});
      if(_upErr)throw _upErr;
      const{error:_bumpErr}=await sb.from('lesson_assignments').update({assigned_at:new Date().toISOString()}).eq('lesson_id',l.id).eq('class_id',S.currentClassId).eq('school_id',S.schoolId).in('student_id',stuIds);
      if(_bumpErr)throw _bumpErr;
    }
    _durableOk=true;
  }catch(e){console.warn('[cvSwitchTo] durable assign:',e);}
  if(!_durableOk){showToast(t('Не удалось сохранить смену урока — попробуйте ещё раз'),'error');return;}

  window._lessonCache=window._lessonCache||{};window._lessonCache[l.id]=l;
  const{sections:_s,materials:_m}=_parseLessonContent(l.content);
  LV.sections=_s;LV.materials=Array.isArray(_m)?_m:[];LV.curSec=0;LV.curEx=0;LV.lessonId=l.id;window._matchState={};lvFilterForStudent();
  const matBtn=C('cv_matBtn');if(matBtn)matBtn.style.display=LV.materials.length?'':'none';
  C('cv_lessonName').textContent=l.title;
  lvRender();
  if(S._liveId){sb.from('class_live').update({lesson_id:l.id}).eq('id',S._liveId).eq('school_id',S.schoolId).then(({error})=>{if(error)console.warn('[live switch]',error);});}
  lvSyncSend('lesson','lesson',l.id);
  showToast('🔄 '+t('Материалы урока заменены')+': '+l.title);
}`;

const NEW_PUSH = `async function cvPushSection(){
  if(!['teacher','admin','owner'].includes(S.role))return;
  let _durableOk=false;
  try{
    if(LV.lessonId&&S.currentClassId){
      const{data:cs}=await sb.from('class_students').select('student_id').eq('class_id',S.currentClassId).eq('school_id',S.schoolId);
      const stuIds=(cs||[]).map(c=>c.student_id).filter(Boolean);
      if(stuIds.length){
        const rows=stuIds.map(sid=>({school_id:S.schoolId,lesson_id:LV.lessonId,student_id:sid,class_id:S.currentClassId,completed:false}));
        const{error:_upErr}=await sb.from('lesson_assignments').upsert(rows,{onConflict:'class_id,lesson_id,student_id',ignoreDuplicates:true});
        if(_upErr)throw _upErr;
        const{error:_secErr}=await sb.from('lesson_assignments').update({assigned_at:new Date().toISOString(),current_section:LV.curSec||0}).eq('lesson_id',LV.lessonId).eq('class_id',S.currentClassId).eq('school_id',S.schoolId).in('student_id',stuIds);
        if(_secErr)throw _secErr;
      }
    }
    _durableOk=true;
  }catch(e){console.warn('[push section durable]:',e);}
  if(!_durableOk){showToast(t('Не удалось сохранить раздел — попробуйте ещё раз'),'error');return;}
  if(LV.lessonId&&S.currentClassId){
    sb.from('class_live').update({cur_section:LV.curSec||0}).eq('lesson_id',LV.lessonId).eq('class_id',S.currentClassId).eq('school_id',S.schoolId).eq('active',true).then(function(r){if(r&&r.error)console.warn('[push section persist]',r.error);});
  }
  lvSyncSend('section','section',LV.curSec||0);
  showToast('👥 '+t('Ученики переключены на этот раздел'));
}`;

const OLD_OPEN = `function openClassroomView(title,sections,assignId,studentName,materials,lessonId){\n  LV.sections=sections;LV.materials=Array.isArray(materials)?materials:[];LV.curSec=0;LV.curEx=0;LV.assignId=assignId;LV.lessonId=lessonId||null;LV.viewAll=false;`;
const NEW_OPEN = `function openClassroomView(title,sections,assignId,studentName,materials,lessonId,initSection){\n  LV.sections=sections;LV.materials=Array.isArray(materials)?materials:[];LV.curSec=(typeof initSection==='number'&&initSection>=0&&initSection<(sections||[]).length)?initSection:0;LV.curEx=0;LV.assignId=assignId;LV.lessonId=lessonId||null;LV.viewAll=false;`;
const OLD_OPEN_C = `openClassroomView(c.lesson?.title||'Урок',_s,assignId,null,_m,c.lesson?.id||null);`;
const NEW_OPEN_C = `openClassroomView(c.lesson?.title||'Урок',_s,assignId,null,_m,c.lesson?.id||null,c.current_section);`;
const OLD_OPEN_CACHED = `openClassroomView(cached.lesson?.title||'Урок',_s,assignId,null,_m,cached.lesson?.id||null);`;
const NEW_OPEN_CACHED = `openClassroomView(cached.lesson?.title||'Урок',_s,assignId,null,_m,cached.lesson?.id||null,cached.current_section);`;

export function applyDef123aPatch(src) {
  let out = src;
  out = replaceFunction(out, 'cdpPickLesson', NEW_CDP);
  out = replaceFunction(out, 'cvSwitchTo', NEW_SWITCH);
  out = replaceFunction(out, 'cvPushSection', NEW_PUSH);
  out = replaceExactlyOnce(out, OLD_OPEN, NEW_OPEN, 'openClassroomView signature/init');
  out = replaceExactlyOnce(out, OLD_OPEN_C, NEW_OPEN_C, 'openLessonView uncached call');
  out = replaceExactlyOnce(out, OLD_OPEN_CACHED, NEW_OPEN_CACHED, 'openLessonView cached call');
  return out;
}
