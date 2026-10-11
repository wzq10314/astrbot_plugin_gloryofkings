import assert from 'node:assert/strict';
import {createTaskLoader} from '../engine/task-scheduler.mjs';
const scheduled=[], contexts=new WeakMap(), reports=[], jobs=[];
let executions=0, release;
const task={cron:'0 30 7 * * *',fnc:'autoSign'};
contexts.set(task,{file:'signIn.js'});
const loader=createTaskLoader({
 scheduleJob(options,callback){const job={options,callback,cancelled:false,cancel(){this.cancelled=true}};scheduled.push(job);return job},
 contextOf:t=>contexts.get(t),
 run:async()=>{executions++;await new Promise(r=>release=r)},
 report:c=>reports.push(c.file),
 onJobs:rows=>jobs.splice(0,jobs.length,...rows),
});
assert.equal(loader.createTask(),0,'No task means no unattended sign-in');
loader.task.push(task);assert.equal(loader.createTask(),1);
assert.equal(jobs[0].options.tz,'Asia/Shanghai');
const pending=jobs[0].callback();await jobs[0].callback();assert.equal(executions,1,'No overlap');
loader.createTask();assert.equal(scheduled[0].cancelled,true,'Old job cancelled');
await jobs[0].callback();assert.equal(executions,1,'No overlap across reschedule');release();await pending;
task.job.cancel();task.cron='';loader.task.splice(loader.task.indexOf(task),1);loader.createTask();assert.equal(jobs.length,0);
task.cron='0 30 7 * * *';loader.task.push(task);loader.createTask();assert.equal(jobs.length,1,'Can turn on from disabled start');
assert.equal(reports.length,0);
console.log('AstrBot task scheduler: enable, disable, reschedule, timezone and non-overlap passed');
