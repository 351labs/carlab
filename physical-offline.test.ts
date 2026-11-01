import assert from 'node:assert/strict';
import test from 'node:test';
import { presets } from './presets.ts';
import { renderPhysicalClip, physicalContentKeySource } from './physical-offline.ts';

test('physical offline take uses deterministic bounded audio and fixed demand',()=>{
 const engine=presets[1].config,options={duration:.35,sampleRate:12000,throttle:.8,gear:0};
 const a=renderPhysicalClip(engine,{},options),b=renderPhysicalClip(engine,{},options);
 assert.equal(a.left.length,4200);assert.ok(a.peak>0&&a.peak<1);assert.deepEqual(a.left,b.left);assert.equal(a.left[0],0);assert.equal(a.right.at(-1),0);
 const c=renderPhysicalClip(engine,{}, {...options,throttle:0});assert.notDeepEqual(a.left,c.left);
});
test('physical render identity includes effective geometry, resistance and pedal',()=>{
 const engine=presets[1].config,base=physicalContentKeySource(engine,{},{});
 assert.notEqual(base,physicalContentKeySource(engine,{vehicleMassKg:2000},{}));
 assert.notEqual(base,physicalContentKeySource(engine,{}, {throttle:1}));
 assert.equal(physicalContentKeySource(engine,{}, {gear:8}),physicalContentKeySource(engine,{}, {gear:6}));
});
