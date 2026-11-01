import test from 'node:test';
import assert from 'node:assert/strict';
import { nelderMead, singularValues } from './fit.mjs';

test('bounded Nelder-Mead finds an interior quadratic minimum and respects the unit cube',()=>{
 const inside=nelderMead(([a,b])=>(a-.3)**2+10*(b-.7)**2,[.5,.5],{maxEvaluations:400,tolerance:1e-14});
 assert.ok(Math.abs(inside.x[0]-.3)<1e-3&&Math.abs(inside.x[1]-.7)<1e-3,JSON.stringify(inside));
 const edge=nelderMead(([a])=>(a-2)**2,[.5],{maxEvaluations:200});
 assert.ok(edge.x[0]<=1&&edge.x[0]>.999,JSON.stringify(edge));
 assert.ok(nelderMead(()=>0,[.5,.5],{maxEvaluations:7}).evaluations<=9);
});

test('singular values match a known matrix and expose rank deficiency',()=>{
 const s=singularValues([[3,0],[0,4],[0,0]]);
 assert.deepEqual(s.map(v=>+v.toFixed(12)),[4,3]);
 const deficient=singularValues([[1,2],[2,4],[3,6]]);
 assert.ok(Math.abs(deficient[0]-Math.sqrt(70))<1e-9&&deficient[1]<1e-7,JSON.stringify(deficient));
 const rotated=singularValues([[1,1],[1,-1]]);
 assert.ok(rotated.every(v=>Math.abs(v-Math.SQRT2)<1e-12));
});
