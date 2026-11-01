import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationSnapshot, createAssumedVeMap, normalizeCalibrationMap, parseCalibrationBundle, sampleCalibrationMap } from './maps.ts';

function fixture() {
	return { schema: 'carlab-calibration-map-1', kind: 've', rpm: [1000, 3000], pressureBar: [0.5, 1.5],
		values: [[0.4, 0.6], [0.8, 1]], axisUnits: { rpm: 'rpm', pressure: 'bar-absolute' }, valueUnit: 'fraction', extrapolation: 'clamp',
		provenance: { source: 'measured', label: 'Declared fixture measurements', version: 'test-1', engineId: 'original-test-engine', calibratedAt: '2026-10-31', validation: { label: 'Separate operating points', independent: true, date: '2026-10-31' } } };
}
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-12,`${a} differs from ${b}`);

test('bilinear interpolation preserves knots and linear midpoints with source provenance',()=>{
	const map=normalizeCalibrationMap(fixture(),'ve');
	close(sampleCalibrationMap(map,1000,.5).value,.4);close(sampleCalibrationMap(map,3000,1.5).value,1);
	const middle=sampleCalibrationMap(map,2000,1);close(middle.value,.7);
	assert.equal(middle.extrapolated,false);assert.equal(middle.source,'measured');
	assert.equal(middle.provenance.validation?.independent,true);
});

test('queries outside the stated domain clamp once and report each affected axis',()=>{
	const map=normalizeCalibrationMap(fixture(),'ve'),outside=sampleCalibrationMap(map,9000,.1);
	close(outside.value,.8);assert.equal(outside.clampedRpm,3000);assert.equal(outside.clampedPressureBar,.5);
	assert.deepEqual(outside.extrapolatedAxes,['rpm','pressure']);assert.equal(outside.extrapolated,true);
	assert.throws(()=>sampleCalibrationMap(map,NaN,1));
});

test('map normalization clones and freezes data; malformed supplied maps do not use a fallback',()=>{
	const input=fixture(),map=normalizeCalibrationMap(input,'ve');input.values[0][0]=1.2;input.provenance.label='changed';
	close(map.values[0][0],.4);assert.equal(map.provenance.label,'Declared fixture measurements');
	assert.ok(Object.isFrozen(map)&&Object.isFrozen(map.values)&&Object.isFrozen(map.values[0])&&Object.isFrozen(map.provenance));
	const fallback=createAssumedVeMap(800,7000,.9);assert.equal(normalizeCalibrationMap(undefined,'ve',fallback).provenance.source,'assumed');
	assert.throws(()=>normalizeCalibrationMap({...fixture(),valueUnit:'percent'},'ve',fallback));
});

test('sparse axes/grids, duplicates, wrong units and unsupported values are rejected',()=>{
	for(const change of [
		{rpm:new Array(2)},{rpm:[1000,1000]},{rpm:[3000,1000]},{pressureBar:[0,1]},
		{values:new Array(2)},{values:[[.5,.6],new Array(2)]},{values:[[.5,NaN],[.8,1]]},
		{values:[[.5,1.4],[.8,1]]},{axisUnits:{rpm:'rad/s',pressure:'bar-gauge'}},
		{provenance:{source:'measured',label:'No version'}},
	])assert.throws(()=>normalizeCalibrationMap({...fixture(),...change},'ve'));
	assert.throws(()=>normalizeCalibrationMap(fixture(),'fmep'));
});

test('assumed maps stay explicitly assumed and shaped curves peak inside the RPM range',()=>{
	const shaped=createAssumedVeMap(800,7200,.9),uniform=createAssumedVeMap(800,7200,.9,'uniform');
	assert.equal(shaped.provenance.source,'assumed');assert.equal(shaped.provenance.validation,undefined);
	const peak=sampleCalibrationMap(shaped,shaped.rpm[2],1).value;
	assert.ok(peak>sampleCalibrationMap(shaped,800,1).value&&peak>sampleCalibrationMap(shaped,7200,1).value);
	for(const row of uniform.values)for(const value of row)close(value,.9);
	assert.throws(()=>createAssumedVeMap(1000,900,.9));
});

test('bundle JSON round-trips kinds, units and declared validation without changing the original',()=>{
	const ve=normalizeCalibrationMap(fixture(),'ve');
	const fmep=normalizeCalibrationMap({...fixture(),kind:'fmep',valueUnit:'bar',values:[[.5,.8],[1,1.4]]},'fmep');
	const snapshot=calibrationSnapshot({ve,fmep}),parsed=parseCalibrationBundle(JSON.stringify(snapshot));
	assert.deepEqual(parsed,snapshot);assert.notEqual(parsed.maps.ve,ve);
	assert.equal(parsed.maps.fmep?.valueUnit,'bar');
	assert.throws(()=>parseCalibrationBundle('{'));
	assert.throws(()=>parseCalibrationBundle({schema:'carlab-calibration-bundle-1',maps:{unknown:ve}}));
});
