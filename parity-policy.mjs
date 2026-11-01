/** Cross-runtime comparison floors, in each field's physical unit.
 * The all-33-point diagnostics, immutable baseline comparison and step
 * refinement establish these numerical comparison bounds. Net/gross work,
 * brake torque/power,
 * inputs, geometry, conservation tests and PCM retain their stricter gates.
 * Instantaneous near-equilibrium valve flows are not claimed to pass this gate.
 */
export const DERIVED_ABSOLUTE_FLOORS=Object.freeze({
 exhaustTemperatureK:.02,wallHeatLossW:.05,
 // M4 Max reproduces these small differences with BOTH the old 0.5 and new
 // sources/WASM. See efi/proof/legacy-comparison.json; disabled values are exact.
 pumpingTorqueNm:1e-6,'cycle.pumpingWorkJ':5e-6,
 idealPeakGasTemperatureK:.003,'cycle.peakTemperatureK':.003,
 'cycle.residualFraction':1e-6,veTargetResidual:1e-6,
 'cycle.periodicMassRelativeError':1.2e-5,'cycle.periodicEnergyRelativeError':5e-7,
});
export const DYNAMIC_ABSOLUTE_FLOORS=Object.freeze({'thermal.deltaStoredEnergyJ':.01});
export function fieldAbsoluteFloor(path,floors,ordinary){
 let result=ordinary;
 for(const [field,value]of Object.entries(floors??{}))if(path===field||path.endsWith(`.${field}`))result=Math.max(result,value);
 return result;
}
