// The parent journals our PID and fresh nonce before sending start. Until then
// the helper performs no mutations. A responsive main thread answers fresh
// ownership challenges while blocking validation runs in a worker thread.
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { captureHostValidation } from './host-validation.mjs';
import { writeHostJournal } from './automatic-host-validation.mjs';

if (isMainThread) {
  const [file, id] = process.argv.slice(2);
  let started = false;
  // A parent crash while the durable-start acknowledgement is pending must not
  // leave an idle, unjournaled helper. Running checks retain their challenge
  // responder so a replacement parent can reconcile them by exact ownership.
  process.once('disconnect', () => { if (!started) process.exit(0); });
  process.once('message', message => {
    if (message?.start !== true) process.exit(2);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.id !== id || journal.process?.pid !== process.pid || journal.phase !== 'running') process.exit(2);
    started = true;
    const request = file.replace('-journal.json', '-control-request.json');
    const response = file.replace('-journal.json', '-control-response.json');
    let last;
    const timer = setInterval(() => {
      try {
        const value = JSON.parse(fs.readFileSync(request, 'utf8'));
        if (value.id === id && typeof value.challenge === 'string' && value.challenge !== last) {
          last = value.challenge;
          writeHostJournal(response, { id, challenge: value.challenge, pid: process.pid });
        }
      } catch (error) { if (error.code !== 'ENOENT') { clearInterval(timer); process.exit(3); } }
    }, 25);
    const worker = new Worker(new URL(import.meta.url), { workerData: { file, id } });
    worker.once('error', () => { clearInterval(timer); process.exit(1); });
    worker.once('exit', code => { clearInterval(timer); process.exit(code); });
  });
} else {
  const { file, id } = workerData;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const update = event => { Object.assign(journal, event); writeHostJournal(file, journal); };
  try {
    const result = captureHostValidation({ root: journal.root, packageId: journal.package_id,
      planHash: journal.plan_hash, outputDir: path.dirname(file), mutablePaths: journal.mutable_paths,
      recipeId: journal.recipe_id,
      automatic: { id, dataDirectory: journal.data_directory, data: journal.data, recipeId: journal.recipe_id }, onJournal: update });
    update({ phase: 'captured', evidence_file: result.file });
  } catch (error) {
    update({ phase: 'helper_failed', diagnostic: error.message });
    process.exitCode = 1;
  }
}
