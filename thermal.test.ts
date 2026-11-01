import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThermalConfig,ThermalNetwork } from './thermal.ts';

const isolated=()=>normalizeThermalConfig({wallToCoolantWK:0,wallToOilWK:0,wallToExhaustWK:0,exhaustToCoolantWK:0,coolantToAmbientWK:0,oilToAmbientWK:0,exhaustToAmbientWK:0,coolantMassFlowKgs:0,oilMassFlowKgs:0,exhaustHeatTransferEffectiveness:0});
const close=(a:number,b:number,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('isolated thermal nodes obey Q=C deltaT and split friction without losing energy',()=>{
 const cfg=isolated(),model=new ThermalNetwork(cfg),before=model.getState();
 const state=model.step(2,{gasHeatW:1000,frictionHeatW:500,exhaustHeatW:200});
 close(state.wallTemperatureK-before.wallTemperatureK,2000/cfg.wallHeatCapacityJK);
 close(state.oilTemperatureK-before.oilTemperatureK,1000*cfg.frictionToOilFraction/cfg.oilHeatCapacityJK);
 close(state.coolantTemperatureK-before.coolantTemperatureK,1000*(1-cfg.frictionToOilFraction)/cfg.coolantHeatCapacityJK);
 close(state.deltaStoredEnergyJ,3400);close(state.energyResidualJ,0,1e-6);
 assert.equal(state.status,'unvalidated-lumped-model');
});
test('internal exchange stays between initial temperatures and conserves total energy',()=>{
 const cfg={...isolated(),initialWallTemperatureK:800,initialCoolantTemperatureK:300,initialOilTemperatureK:300,initialExhaustWallTemperatureK:300,wallToCoolantWK:20000};
 const model=new ThermalNetwork(cfg),initial=model.getState().storedEnergyJ;
 const state=model.step(20);
 assert.ok(state.wallTemperatureK<800&&state.wallTemperatureK>300);
 assert.ok(state.coolantTemperatureK>300&&state.coolantTemperatureK<800);
 close(state.storedEnergyJ,initial);close(state.energyResidualJ,0,1e-6);
});
test('fluid and ambient boundary rejection is recorded with its physical sign',()=>{
 const cfg={...isolated(),initialCoolantTemperatureK:400,coolantInletTemperatureK:300,coolantMassFlowKgs:.2,coolantToAmbientWK:30};
 const model=new ThermalNetwork(cfg),state=model.step(10);
 assert.ok(state.coolantTemperatureK<400);assert.ok(state.fluidRejectedJ>0&&state.ambientRejectedJ>0);close(state.deltaStoredEnergyJ,-state.cumulativeRejectedJ);close(state.energyResidualJ,0,1e-6);
 const cold=new ThermalNetwork({...isolated(),initialCoolantTemperatureK:250,coolantInletTemperatureK:350,coolantMassFlowKgs:.2});
 assert.ok(cold.step(1).fluidRejectedJ<0);
});
test('exhaust gas boundary and wall have separate temperatures and equal heat ledger',()=>{
 const cfg={...isolated(),exhaustHeatTransferEffectiveness:.4},model=new ThermalNetwork(cfg),before=model.getState();
 const state=model.step(1,{exhaustGasTemperatureK:1000,exhaustMassFlowKgs:.1});
 assert.equal(state.exhaustGasTemperatureK,1000);assert.ok(state.exhaustWallTemperatureK>before.exhaustWallTemperatureK&&state.exhaustWallTemperatureK<1000);
 close(state.cumulativeInputJ,state.exhaustGasToWallHeatW);close(state.deltaStoredEnergyJ,state.cumulativeInputJ);close(state.energyResidualJ,0,1e-6);
});
test('explicit coupled exhaust exchange enters the wall once and exposes the same signed heat',()=>{
 const model=new ThermalNetwork(isolated());
 const state=model.step(2,{coupledExhaustGasHeatW:300,exhaustGasTemperatureK:800});
 close(state.exhaustGasToWallHeatW,300);close(state.cumulativeInputJ,600);close(state.deltaStoredEnergyJ,600);close(state.energyResidualJ,0,1e-6);
 const back=model.step(1,{coupledExhaustGasHeatW:-100});close(back.exhaustGasToWallHeatW,-100);close(back.cumulativeInputJ,500);
});

test('normalization and rejected loads do not leak nonfinite or corrupted thermal state',()=>{
 const cfg=normalizeThermalConfig({wallHeatCapacityJK:NaN,frictionToOilFraction:2,ambientTemperatureK:Infinity});
 assert.ok(Number.isFinite(cfg.wallHeatCapacityJK));assert.equal(cfg.frictionToOilFraction,1);
 const model=new ThermalNetwork(cfg),before=model.getState();
 assert.deepEqual(model.step(NaN,{gasHeatW:NaN}),before);
 assert.throws(()=>model.step(1,{gasHeatW:NaN}));assert.deepEqual(model.getState(),before);
 assert.throws(()=>model.step(1,{frictionHeatW:-1}));assert.throws(()=>model.step(1,{gasHeatW:-1e12}));assert.deepEqual(model.getState(),before);
 assert.throws(()=>model.step(61));
});
test('repeated dynamics are deterministic; changing capacities rebases but initial states reset',()=>{
 const cfg=normalizeThermalConfig(),a=new ThermalNetwork(cfg),b=new ThermalNetwork(cfg);
 for(let i=0;i<100;i++)assert.deepEqual(a.step(.1,{gasHeatW:20000,frictionHeatW:4000,exhaustGasTemperatureK:900,exhaustMassFlowKgs:.04}),b.step(.1,{gasHeatW:20000,frictionHeatW:4000,exhaustGasTemperatureK:900,exhaustMassFlowKgs:.04}));
 const before=a.getState().wallTemperatureK;a.setConfig({...cfg,wallHeatCapacityJK:30000});close(a.getState().wallTemperatureK,before);close(a.getState().energyResidualJ,0);
 const recorded=a.getState();a.setConfig({provenance:'fitted',source:'Explicit test-source update'});assert.deepEqual(a.getState(),recorded);
 a.setConfig({...cfg,initialWallTemperatureK:400});assert.equal(a.getState().wallTemperatureK,400);assert.equal(a.getState().elapsedSeconds,0);
});
