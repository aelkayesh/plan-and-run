#!/usr/bin/env node
import { main } from './runner.mjs';

main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`Plan runner: ${error.message}`);
  process.exitCode = 1;
});
