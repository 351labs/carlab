import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEcuObservations } from './ecu-ui.ts';

test('EFI CSV preserves explicit observation roles, session and applied closed-loop multiplier',()=>{
 const [row]=parseEcuObservations('\uFEFF# original synthetic fixture\nrpm,map_bar_abs,observed_lambda,applied_fuel_multiplier,closed_loop_active,split,capture_session_id\n3000,0.8,1.02,1.17,true,validation,session-b\n',true);
 assert.equal(row.rpm,3000);assert.equal(row.mapBar,.8);assert.equal(row.observedLambda,1.02);
 assert.equal(row.appliedFuelMultiplier,1.17);assert.equal(row.closedLoopActive,true);
 assert.equal(row.split,'validation');assert.equal(row.captureSessionId,'session-b');
 assert.equal(row.steady,true);assert.equal(row.valid,true);
 assert.equal(row.injectorCut,false);assert.equal(row.transient,false);
});
test('EFI CSV does not silently declare unknown observations warm, steady or valid',()=>{
 const [row]=parseEcuObservations('rpm;map_bar_abs;observed_lambda\n2000;1.1;0.95\n');
 assert.equal(row.steady,false);assert.equal(row.valid,false);assert.equal(row.split,'train');
 assert.equal(row.appliedFuelMultiplier,undefined);
});
test('EFI CSV rejects invalid measured values, row shape, flags and role instead of reusing a previous dataset',()=>{
 for(const csv of [
  'rpm,map_bar_abs,lambda\n2000,1,1',
  'rpm,map_bar_abs,observed_lambda\n2000,1',
  'rpm,map_bar_abs,observed_lambda\n2000,1,Infinity',
  'rpm,map_bar_abs,observed_lambda\n2000,0,1',
  'rpm,map_bar_abs,observed_lambda,steady\n2000,1,1,perhaps',
  'rpm,map_bar_abs,observed_lambda,split\n2000,1,1,random',
  'rpm,map_bar_abs,observed_lambda,applied_fuel_multiplier\n2000,1,1,-1',
 ])assert.throws(()=>parseEcuObservations(csv));
});
