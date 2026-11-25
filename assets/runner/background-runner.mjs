// Trusted adapter: the existing foreground runner remains the sole scheduler.
import {main} from './runner.mjs';
export async function run({args,signal,identity,ready,ownSession}) {
  if(!Array.isArray(args?.argv) || args.argv[0]!=='resume') throw new Error('Background handler requires a bound resume command.');
  let summary,cleaned=false,acquired=false;
  try {
    const code=await main(args.argv,{signal,identity,ready,ownSession,acquired:()=>{acquired=true;},cleaned:value=>{summary=value;cleaned=true;}});
    return {code,accepted:code===0&&summary?.accepted===true,cleanup_verified:!acquired||cleaned,summary:summary||{accepted:false,next_action:'Inspect startup report before resuming.'}};
  } catch(error) {
    return {code:1,accepted:false,cleanup_verified:!acquired||cleaned,summary:summary||{},diagnostic:error.message};
  }
}
