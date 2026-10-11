// AstrBot worker-local counterpart of the Yunzai task loader.
// A runtime cron change only reschedules this worker's own tasks.
export function createTaskLoader({scheduleJob, contextOf, run, report, onJobs}) {
  const running = new WeakSet();
  let scheduled = [];
  const loader = {
    task: [],
    createTask() {
      for (const job of scheduled) job.cancel();
      scheduled = [];
      try {
        for (const task of new Set(loader.task)) {
          const context = contextOf(task);
          if (!context || !String(task.cron || '').trim() || !task.fnc) continue;
          const job = scheduleJob({rule:task.cron, tz:'Asia/Shanghai'}, async () => {
            if (running.has(task)) return;
            running.add(task);
            try { await run(context, task); }
            catch { report(context); }
            finally { running.delete(task); }
          });
          if (!job) throw Error('InvalidCron:' + context.file);
          task.job = job;
          scheduled.push(job);
        }
      } catch (error) {
        for (const job of scheduled) job.cancel();
        scheduled = [];
        onJobs(scheduled);
        throw error;
      }
      onJobs(scheduled);
      return scheduled.length;
    },
  };
  return loader;
}
