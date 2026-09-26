import { test, expect, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

type Wire = { dir:'sent'|'recv'; topic:string|null; event:string|null; status:string|null; reason:string|null; kind:string|null; value:string|null };

function parse(raw: string): Wire | null {
  try {
    const x = JSON.parse(raw);
    const obj = Array.isArray(x)
      ? { topic:x[2], event:x[3], payload:x[4] }
      : x;
    const topic = obj?.topic != null ? String(obj.topic) : null;
    if (!topic || !topic.startsWith('realtime:exsync-')) return null;
    const p = obj?.payload ?? null;
    const inner = p?.payload ?? null;
    return {
      dir:'recv', topic,
      event: obj?.event != null ? String(obj.event) : null,
      status: p?.status != null ? String(p.status) : null,
      reason: p?.response?.reason != null ? String(p.response.reason) : (p?.response?.error != null ? String(p.response.error) : null),
      kind: inner?.kind != null ? String(inner.kind) : null,
      value: inner?.value != null ? String(inner.value) : null,
    };
  } catch { return null; }
}

function capture(page: Page, sink: Wire[]) {
  page.on('websocket', ws => {
    if (!ws.url().includes('/realtime/')) return;
    ws.on('framesent', f => {
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const w = parse(raw); if (w) sink.push({...w, dir:'sent'});
    });
    ws.on('framereceived', f => {
      const raw = typeof f.payload === 'string' ? f.payload : String(f.payload);
      const w = parse(raw); if (w) sink.push({...w, dir:'recv'});
    });
  });
}

async function app<T>(page: Page, expr: string): Promise<T> {
  return page.evaluate(e => (0,eval)(e), expr) as Promise<T>;
}
async function setAuth(page: Page) {
  await app(page, `(async()=>{const {data,error}=await sb.auth.getSession();if(error)throw error;if(!data?.session?.access_token)throw new Error('no token');await sb.realtime.setAuth(data.session.access_token);return true})()`);
}

async function enterTeacher(page: Page) {
  const card=page.locator('.ev-class-card:not(.ev-class-create)').first(); await expect(card).toBeVisible(); await card.click(); await expect(page.locator('#classroomView')).toHaveClass(/open/);
}
async function enterStudent(page: Page) {
  await page.locator('#nav_s_classes').click(); const b=page.getByRole('button',{name:/В урок/}).first(); await expect(b).toBeVisible(); await b.click(); await expect(page.locator('#classroomView')).toHaveClass(/open/);
}

test('wire: private exsync broadcast reaches peer', async ({browser}) => {
  test.setTimeout(90_000);
  const tc=await browser.newContext(), sc=await browser.newContext();
  const t=await tc.newPage(), s=await sc.newPage();
  const tw:Wire[]=[], sw:Wire[]=[]; capture(t,tw); capture(s,sw);
  let classId:string|null=null, lessonId:string|null=null;
  try {
    await login(t,teacherCreds); await login(s,studentCreds); await setAuth(t); await setAuth(s);
    const fx=await app<{classId:string;lessonId:string}>(t,`(async()=>{const {data:c,error:ce}=await sb.from('classes').select('id').eq('school_id',S.schoolId).eq('teacher_id',S.profile.id).limit(1);if(ce)throw ce;if(!c?.length)throw new Error('no class');const classId=c[0].id;const {data:l,error:le}=await sb.from('lessons').insert({school_id:S.schoolId,teacher_id:S.profile.id,title:'E2E EXSYNC WIRE '+Date.now(),language:'English',level:'B1',published:true,exercise_count:0,content:{sections:[{title:'One',exercises:[]},{title:'Two',exercises:[]}],materials:[]}}).select('id').single();if(le)throw le;const {error:pe}=await sb.from('class_lessons').insert({school_id:S.schoolId,class_id:classId,lesson_id:l.id,position:1});if(pe)throw pe;return {classId,lessonId:l.id}})()`);
    classId=fx.classId; lessonId=fx.lessonId;
    await enterTeacher(t); await enterStudent(s);
    await expect.poll(()=>app<boolean>(t,'LV._syncReady===true'),{timeout:15000}).toBe(true);
    await expect.poll(()=>app<boolean>(s,'LV._syncReady===true'),{timeout:15000}).toBe(true);
    const state=await Promise.all([app<any>(t,'({room:LV._syncRoomKey,state:LV._syncCh?.state,ready:LV._syncReady})'),app<any>(s,'({room:LV._syncRoomKey,state:LV._syncCh?.state,ready:LV._syncReady})')]);
    console.log('[wire state]',JSON.stringify(state));
    expect(state[0].room).toBe(state[1].room);
    const result=await app<any>(t,`(async()=>await LV._syncCh.send({type:'broadcast',event:'ex',payload:{id:'wire-${Date.now()}',kind:'section',value:'1',from:S.profile.id}}))()`);
    console.log('[wire send]',JSON.stringify(result));
    await s.waitForTimeout(3000);
    console.log('[wire teacher]',JSON.stringify(tw.slice(-20)));
    console.log('[wire student]',JSON.stringify(sw.slice(-20)));
    expect(await app<number>(s,'LV.curSec')).toBe(1);
  } finally {
    if(classId&&lessonId){await app(t,`(async()=>{await sb.from('lesson_assignments').delete().eq('class_id','${classId}').eq('lesson_id','${lessonId}');await sb.from('class_lessons').delete().eq('class_id','${classId}').eq('lesson_id','${lessonId}');await sb.from('lessons').delete().eq('id','${lessonId}').eq('school_id',S.schoolId)})()`).catch(()=>{});}
    await tc.close(); await sc.close();
  }
});
