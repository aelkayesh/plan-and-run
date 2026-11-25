import { runBackgroundChild, publicProjection } from './background-control.mjs';
try { process.exitCode = await runBackgroundChild(process.argv[2]); }
catch (error) { console.error(publicProjection(error.message)); process.exitCode = 1; }
