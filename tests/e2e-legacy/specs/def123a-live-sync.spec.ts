import { test, expect, type Page } from '@playwright/test';
import { login, requireTeacherCredentials, requireStudentCredentials } from '../helpers/auth';

const teacherCreds = requireTeacherCredentials();
const studentCreds = requireStudentCredentials();

async function appEval<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate((expr) => (0, eval)(expr), expression) as Promise<T>;
}

async function setRealtimeAuth(page: Page) {
  await appEval(page, `(async()=>{
    const {data,error}=await sb.auth.getSession();
    if(error)throw error;
    const token=data&&data.session&&data.session.access_token;
    if(!token)throw new Error('no access token for realtime.setAuth probe');
    await sb.realtime.setAuth(token);
    return true;
  })()`);
}

async function waitSync(page: Page) {
  await expect.poll(async () => appEval<boolean>(page, 'LV._syncReady===true'), { timeout: 15_000 }).toBe(true);
}

async function enterTeacherClass(page: Page) {
  const card = page.locator('.ev-class-card:not(.ev-class-create)').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('#classroomView')).toHaveClass(/open/);
}

async function enterStudentClass(page: Page) {
  await page.locator('#nav_s_classes').click();
  const enter = page.getByRole('button', { name: /В урок/ }).first();
  await expect(enter).toBeVisible();
  await enter.click();
  await expect(page.locator('#classroomView')).toHaveClass(/open/);
}

async function reloadAndEnterStudent(page: Page) {
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await setRealtimeAuth(page);
  await enterStudentClass(page);
}

test('DEF-1/2/3A: exsync authorization + durable lesson/section switching', async ({ browser }) => {
  test.setTimeout(120_000);
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();

  let lessonA: string | null = null;
  let lessonB: string | null = null;
  let classId: string | null = null;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    await login(teacher, teacherCreds);
    await login(student, studentCreds);

    // Diagnostic only: explicitly arm Realtime Authorization with the current session token.
    await setRealtimeAuth(teacher);
    await setRealtimeAuth(student);

    const fixture = await appEval<{ classId: string; lessonA: string; lessonB: string }>(teacher, `(async()=>{
      const {data:classes,error:ce}=await sb.from('classes').select('id').eq('school_id',S.schoolId).eq('teacher_id',S.profile.id).limit(1);
      if(ce)throw ce;if(!classes||!classes.length)throw new Error('staging teacher fixture class missing');
      const classId=classes[0].id;
      const base={school_id:S.schoolId,teacher_id:S.profile.id,language:'English',level:'B1',published:true,exercise_count:0};
      const contentA={sections:[{title:'QA A Section 1',exercises:[]},{title:'QA A Section 2',exercises:[]}],materials:[]};
      const contentB={sections:[{title:'QA B Section 1',exercises:[]},{title:'QA B Section 2',exercises:[]}],materials:[]};
      const {data:a,error:ae}=await sb.from('lessons').insert({...base,title:'E2E DEF A ${suffix}',content:contentA}).select('id').single();if(ae)throw ae;
      const {data:b,error:be}=await sb.from('lessons').insert({...base,title:'E2E DEF B ${suffix}',content:contentB}).select('id').single();if(be)throw be;
      const {error:pe}=await sb.from('class_lessons').insert([
        {school_id:S.schoolId,class_id:classId,lesson_id:a.id,position:1},
        {school_id:S.schoolId,class_id:classId,lesson_id:b.id,position:2}
      ]);if(pe)throw pe;
      return {classId,lessonA:a.id,lessonB:b.id};
    })()`);
    classId = fixture.classId; lessonA = fixture.lessonA; lessonB = fixture.lessonB;

    await enterTeacherClass(teacher);
    await enterStudentClass(student);

    await waitSync(teacher);
    await waitSync(student);

    const teacherSync = await appEval<any>(teacher, `({room:LV._syncRoomKey,ready:LV._syncReady,state:LV._syncCh&&LV._syncCh.state,lesson:LV.lessonId,profile:S.profile&&S.profile.id})`);
    const studentSync = await appEval<any>(student, `({room:LV._syncRoomKey,ready:LV._syncReady,state:LV._syncCh&&LV._syncCh.state,lesson:LV.lessonId,profile:S.profile&&S.profile.id})`);
    console.log('[DEF123A sync diagnostic before]', JSON.stringify({teacherSync,studentSync,lessonA,lessonB}));
    expect(teacherSync.room).toBe(studentSync.room);
    expect(teacherSync.profile).not.toBe(studentSync.profile);

    const directSend = await appEval<any>(teacher, `(async()=>await LV._syncCh.send({type:'broadcast',event:'ex',payload:{id:'diag-section',kind:'section',value:'1',from:S.profile.id}}))()`);
    console.log('[DEF123A direct send result]', JSON.stringify(directSend));
    await expect.poll(() => appEval<number>(student, 'LV.curSec'), { timeout: 10_000 }).toBe(1);
    await appEval<any>(teacher, `(async()=>await LV._syncCh.send({type:'broadcast',event:'ex',payload:{id:'diag-section-reset',kind:'section',value:'0',from:S.profile.id}}))()`);
    await expect.poll(() => appEval<number>(student, 'LV.curSec'), { timeout: 10_000 }).toBe(0);

    await appEval(teacher, `(async()=>{await cvSwitchTo('${lessonB}')})()`);
    await expect.poll(() => appEval<string>(student, 'LV.lessonId')).toBe(lessonB);
    await reloadAndEnterStudent(student);
    await expect.poll(() => appEval<string>(student, 'LV.lessonId')).toBe(lessonB);
    await waitSync(student);

    await appEval(teacher, `(async()=>{await cvSwitchTo('${lessonA}')})()`);
    await expect.poll(() => appEval<string>(student, 'LV.lessonId')).toBe(lessonA);

    await appEval(teacher, `(async()=>{
      const {error}=await sb.from('lesson_assignments').update({completed:true}).eq('class_id','${classId}').eq('lesson_id','${lessonA}').eq('school_id',S.schoolId);if(error)throw error;
    })()`);
    await appEval(teacher, `(async()=>{await cvSwitchTo('${lessonB}');await cvSwitchTo('${lessonA}')})()`);
    const completed = await appEval<boolean>(teacher, `(async()=>{const {data,error}=await sb.from('lesson_assignments').select('completed').eq('class_id','${classId}').eq('lesson_id','${lessonA}').eq('school_id',S.schoolId).limit(1).single();if(error)throw error;return data.completed===true})()`);
    expect(completed).toBe(true);

    await reloadAndEnterStudent(student);
    await expect.poll(() => appEval<string>(student, 'LV.lessonId')).toBe(lessonA);
    await waitSync(student);

    await appEval(teacher, `(async()=>{LV.curSec=1;lvRender();await cvPushSection()})()`);
    await expect.poll(() => appEval<number>(student, 'LV.curSec')).toBe(1);
    await reloadAndEnterStudent(student);
    await expect.poll(() => appEval<string>(student, 'LV.lessonId')).toBe(lessonA);
    await expect.poll(() => appEval<number>(student, 'LV.curSec')).toBe(1);
  } finally {
    if (classId && lessonA && lessonB) {
      await appEval(teacher, `(async()=>{
        await sb.from('lesson_assignments').delete().eq('class_id','${classId}').in('lesson_id',['${lessonA}','${lessonB}']);
        await sb.from('class_lessons').delete().eq('class_id','${classId}').in('lesson_id',['${lessonA}','${lessonB}']);
        await sb.from('lessons').delete().in('id',['${lessonA}','${lessonB}']).eq('school_id',S.schoolId);
      })()`).catch(()=>{});
    }
    await teacherContext.close();
    await studentContext.close();
  }
});
