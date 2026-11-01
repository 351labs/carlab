/** Deterministic helpers for the declared model-3 fits. No randomness. */

/** Bounded Nelder-Mead on the unit cube (x clamped to [0,1]); standard coefficients 1/2/0.5/0.5. */
export function nelderMead(f,start,{step=.1,maxEvaluations=100,tolerance=1e-9}={}){
 const n=start.length,clamp=x=>x.map(v=>Math.min(1,Math.max(0,v)));
 let evaluations=0;const value=x=>{evaluations++;return f(x);};
 let simplex=[clamp(start),...start.map((_,i)=>clamp(start.map((v,j)=>i===j?(v+step<=1?v+step:v-step):v)))].map(x=>({x,f:value(x)}));
 const mix=(a,b,t)=>clamp(a.map((v,i)=>v+t*(b[i]-v)));
 while(evaluations<maxEvaluations){
  simplex.sort((a,b)=>a.f-b.f);
  if(Math.abs(simplex[n].f-simplex[0].f)<=tolerance*(Math.abs(simplex[0].f)+tolerance))break;
  const centroid=simplex[0].x.map((_,i)=>simplex.slice(0,n).reduce((s,p)=>s+p.x[i],0)/n),worst=simplex[n];
  const r=mix(centroid,worst.x,-1),fr=value(r);
  if(fr<simplex[0].f){const e=mix(centroid,worst.x,-2),fe=value(e);simplex[n]=fe<fr?{x:e,f:fe}:{x:r,f:fr};continue;}
  if(fr<simplex[n-1].f){simplex[n]={x:r,f:fr};continue;}
  const c=fr<worst.f?mix(centroid,r,.5):mix(centroid,worst.x,.5),fc=value(c);
  if(fc<Math.min(fr,worst.f)){simplex[n]={x:c,f:fc};continue;}
  simplex=simplex.map((p,i)=>i===0?p:{x:mix(simplex[0].x,p.x,.5),f:value(mix(simplex[0].x,p.x,.5))});
 }
 simplex.sort((a,b)=>a.f-b.f);
 return {x:simplex[0].x,f:simplex[0].f,evaluations};
}

/** Singular values of an m x n matrix (rows of numbers) via cyclic Jacobi on J^T J, descending. */
export function singularValues(rows){
 const n=rows[0]?.length??0,a=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>rows.reduce((s,r)=>s+r[i]*r[j],0)));
 for(let sweep=0;sweep<100;sweep++){
  let off=0;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)off+=a[i][j]**2;
  if(off<1e-30*Math.max(1,...a.map((r,i)=>r[i]**2)))break;
  for(let p=0;p<n;p++)for(let q=p+1;q<n;q++){
   if(a[p][q]===0)continue;
   const theta=(a[q][q]-a[p][p])/(2*a[p][q]),t=Math.sign(theta||1)/(Math.abs(theta)+Math.sqrt(theta*theta+1)),c=1/Math.sqrt(t*t+1),s=t*c;
   for(let k=0;k<n;k++){const akp=a[k][p],akq=a[k][q];a[k][p]=c*akp-s*akq;a[k][q]=s*akp+c*akq;}
   for(let k=0;k<n;k++){const apk=a[p][k],aqk=a[q][k];a[p][k]=c*apk-s*aqk;a[q][k]=s*apk+c*aqk;}
  }
 }
 return a.map((r,i)=>Math.sqrt(Math.max(0,r[i]))).sort((x,y)=>y-x);
}
